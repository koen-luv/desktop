package app.tryliner.android

import android.os.Build
import android.os.Process
import android.util.Log
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONArray
import org.json.JSONObject
import java.net.URL
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.ScheduledFuture
import java.util.concurrent.TimeUnit

object DiscordRpc {
    private const val TAG = "LinerDiscordRpc"

    private const val APPLICATION_ID = "1462731846218416179"

    private const val ORIGIN = "https://localhost"

    private const val BASE_BACKOFF_MS = 2_000L
    private const val MAX_BACKOFF_MS = 60_000L
    private const val HANDSHAKE_FALLBACK_MS = 1_500L
    private const val READY_TIMEOUT_MS = 6_000L

    private const val SYNC_DEBOUNCE_MS = 1_000L
    private const val MIN_SYNC_INTERVAL_MS = 4_000L

    private const val MAX_TEXT_LENGTH = 128
    private const val MAX_IMAGE_URL_LENGTH = 256

    private val worker: ScheduledExecutorService =
        Executors.newSingleThreadScheduledExecutor { runnable ->
            Thread(runnable, "liner-discord-rpc").apply { isDaemon = true }
        }

    private val client = OkHttpClient.Builder()
        .connectTimeout(2, TimeUnit.SECONDS)
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .pingInterval(30, TimeUnit.SECONDS)
        .build()

    private val isEmulator by lazy {
        Build.FINGERPRINT.startsWith("generic") ||
            Build.FINGERPRINT.contains("emulator") ||
            Build.FINGERPRINT.contains("sdk_gphone") ||
            Build.HARDWARE.contains("goldfish") ||
            Build.HARDWARE.contains("ranchu") ||
            Build.MODEL.contains("Emulator") ||
            Build.PRODUCT.contains("emulator") ||
            Build.PRODUCT.contains("sdk_gphone")
    }

    private var generation = 0

    private var enabled = true
    private var statusDisplayType = "artist"
    private var showArtwork = true
    private var showArtistSmallImage = true
    private var showTime = true
    private var showPaused = true
    private var showButton = true
    private var showDownloadButton = true

    private val candidates: List<String> by lazy { buildCandidates() }
    private var candidateIndex = 0
    private var socket: WebSocket? = null
    private var connecting = false
    private var ready = false
    private var backoffMs = BASE_BACKOFF_MS
    private var reconnectScheduled = false
    private var nonce = 0
    private var lastSentJson: String? = null

    private var latestPayload: JSONObject? = null
    private var latestPayloadReceivedAt = 0L
    private var lastSyncAt = 0L
    private var syncFuture: ScheduledFuture<*>? = null

    @Volatile private var statusConnected = false
    @Volatile private var statusUsername: String? = null


    fun updateState(payloadJson: String) {
        worker.execute { doUpdateState(payloadJson) }
    }

    fun updateSettings(settingsJson: String) {
        worker.execute { doUpdateSettings(settingsJson) }
    }

    fun getStatus(): String =
        JSONObject()
            .put("connected", statusConnected)
            .putOpt("username", statusUsername)
            .toString()


    private fun doUpdateState(rawPayload: String) {
        val payload = try {
            JSONObject(rawPayload)
        } catch (_: Exception) {
            null
        } ?: return
        latestPayload = payload
        latestPayloadReceivedAt = System.currentTimeMillis()

        if (!enabled) return
        if (!connecting && socket == null) {
            connect()
            return
        }
        if (ready) scheduleSync()
    }

    private fun doUpdateSettings(rawPatch: String) {
        val patch = try {
            JSONObject(rawPatch)
        } catch (_: Exception) {
            null
        } ?: return

        val booleanFields = mapOf(
            "enabled" to { v: Boolean -> enabled = v },
            "showArtwork" to { v: Boolean -> showArtwork = v },
            "showArtistSmallImage" to { v: Boolean -> showArtistSmallImage = v },
            "showTime" to { v: Boolean -> showTime = v },
            "showPaused" to { v: Boolean -> showPaused = v },
            "showButton" to { v: Boolean -> showButton = v },
            "showDownloadButton" to { v: Boolean -> showDownloadButton = v },
        )
        for ((key, apply) in booleanFields) {
            if (patch.opt(key) is Boolean) apply(patch.getBoolean(key))
        }

        val validStatusTypes = setOf("artist", "title", "artist_title", "title_artist", "app")
        val requestedType = patch.optString("statusDisplayType", "")
        if (requestedType in validStatusTypes) statusDisplayType = requestedType

        if (!patch.has("enabled")) {
            if (enabled && ready) scheduleSync()
            return
        }
        if (!enabled) {
            generation += 1
            cancelSync()
            reconnectScheduled = false
            val old = socket
            val wasReady = ready
            socket = null
            connecting = false
            ready = false
            statusConnected = false
            statusUsername = null
            candidateIndex = 0
            lastSentJson = null
            backoffMs = BASE_BACKOFF_MS
            if (old != null) {
                if (wasReady) sendActivity(old, null, force = true)
                old.close(1000, "disabled")
            }
            Log.i(TAG, "disabled by settings")
        } else if (socket == null) {
            generation += 1
            backoffMs = BASE_BACKOFF_MS
            connect()
        } else if (ready) {
            scheduleSync()
        }
    }

    private fun buildCandidates(): List<String> {
        val hosts = if (isEmulator) listOf("127.0.0.1", "10.0.2.2") else listOf("127.0.0.1")
        return hosts.flatMap { host ->
            (6463..6472).map { port -> "ws://$host:$port/?v=1&client_id=$APPLICATION_ID&encoding=json" }
        }
    }

    private fun connect() {
        if (!enabled || connecting || socket != null) return
        val url = candidates.getOrNull(candidateIndex)
        if (url == null) {
            candidateIndex = 0
            scheduleReconnect()
            return
        }
        connecting = true
        val attempt = generation
        Log.i(TAG, "connecting (${candidateIndex + 1}/${candidates.size}) to ${url.substringBefore("?")}")
        val request = Request.Builder().url(url).header("Origin", ORIGIN).build()
        client.newWebSocket(request, listener(attempt))
    }

    private fun listener(attempt: Int) = object : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) {
            worker.execute { handleOpen(attempt, webSocket) }
        }

        override fun onMessage(webSocket: WebSocket, text: String) {
            worker.execute { handleMessage(attempt, webSocket, text) }
        }

        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            worker.execute { Log.i(TAG, "server closing: $code ${reason.ifBlank { "(no reason)" }}") }
            val safeCode = if (code in 1000..4999 && code != 1005 && code != 1006 && code != 1015) code else 1000
            try {
                webSocket.close(safeCode, null)
            } catch (_: Exception) {
            }
        }

        override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
            worker.execute {
                handleDown(attempt, webSocket, "closed $code ${reason.ifBlank { "(no reason)" }}")
            }
        }

        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
            worker.execute {
                handleDown(attempt, webSocket, "failed: ${t.javaClass.simpleName} ${t.message.orEmpty()}".trim())
            }
        }
    }

    private fun handleOpen(attempt: Int, ws: WebSocket) {
        if (attempt != generation || !enabled) {
            ws.close(1000, "stale")
            return
        }
        connecting = false
        if (socket != null && socket !== ws) {
            ws.close(1000, "superseded")
            return
        }
        socket = ws
        ready = false
        candidateIndex = 0
        lastSentJson = null
        Log.i(TAG, "socket open, waiting for READY")

        worker.schedule({
            if (attempt == generation && socket === ws && !ready) {
                ws.send(JSONObject().put("v", 1).put("client_id", APPLICATION_ID).toString())
            }
        }, HANDSHAKE_FALLBACK_MS, TimeUnit.MILLISECONDS)
        worker.schedule({
            if (attempt == generation && socket === ws && !ready) {
                Log.i(TAG, "no READY within ${READY_TIMEOUT_MS}ms; dropping socket")
                ws.cancel()
            }
        }, READY_TIMEOUT_MS, TimeUnit.MILLISECONDS)
    }

    private fun handleMessage(attempt: Int, ws: WebSocket, text: String) {
        if (attempt != generation || socket !== ws) return
        val message = try {
            JSONObject(text)
        } catch (_: Exception) {
            null
        } ?: return

        val evt = message.optString("evt")
        val cmd = message.optString("cmd")
        when {
            evt == "READY" -> handleReady(ws, message)
            evt == "ERROR" -> {
                val data = message.optJSONObject("data")
                Log.w(
                    TAG,
                    "RPC error for $cmd: code=${data?.optInt("code")} message=${data?.optString("message")}",
                )
            }
            cmd == "SET_ACTIVITY" -> {
                val data = message.opt("data")
                Log.i(TAG, "SET_ACTIVITY ack: ${data?.toString().orEmpty().take(200).ifBlank { "null" }}")
            }
            else -> Log.d(TAG, "ignored event ${evt.ifBlank { cmd }}")
        }
    }

    private fun handleReady(ws: WebSocket, message: JSONObject) {
        if (socket !== ws) return
        ready = true
        backoffMs = BASE_BACKOFF_MS
        val user = message.optJSONObject("data")?.optJSONObject("user")
        statusUsername = user?.optString("username", "")?.takeIf { it.isNotEmpty() }
        statusConnected = true
        Log.i(TAG, "READY — Discord session established${statusUsername?.let { " as $it" } ?: ""}")
        if (latestPayload != null) scheduleSync()
    }

    private fun handleDown(attempt: Int, ws: WebSocket, why: String) {
        if (attempt != generation) {
            Log.d(TAG, "stale attempt dropped: $why")
            return
        }
        val wasConnecting = connecting && socket !== ws
        val wasSocket = socket === ws
        if (wasConnecting) connecting = false
        if (wasSocket) {
            socket = null
            ready = false
            statusConnected = false
            statusUsername = null
        }
        if (!wasConnecting && !wasSocket) return
        if (!enabled) {
            Log.i(TAG, "connection down ($why); disabled")
            return
        }
        if (wasConnecting) {
            Log.d(TAG, "candidate refused: $why")
            candidateIndex += 1
            if (candidateIndex >= candidates.size) {
                candidateIndex = 0
                scheduleReconnect()
            } else {
                connect()
            }
        } else {
            Log.i(TAG, "disconnected ($why); retry in ${backoffMs}ms")
            scheduleReconnect()
        }
    }


    private fun scheduleSync() {
        syncFuture?.cancel(false)
        val now = System.currentTimeMillis()
        val wait = maxOf(SYNC_DEBOUNCE_MS, MIN_SYNC_INTERVAL_MS - (now - lastSyncAt))
        syncFuture = worker.schedule(
            {
                syncFuture = null
                lastSyncAt = System.currentTimeMillis()
                syncActivity()
            },
            wait,
            TimeUnit.MILLISECONDS,
        )
    }

    private fun cancelSync() {
        syncFuture?.cancel(false)
        syncFuture = null
    }

    private fun syncActivity() {
        val ws = socket ?: return
        if (!ready || !enabled) return

        val payload = latestPayload
        val track = payload?.optJSONObject("track")
        val status = payload?.optString("status", "idle") ?: "idle"
        if (payload == null || track == null || status == "idle" || status == "error") {
            sendActivity(ws, null)
            return
        }

        val isPlaying = status == "playing"
        val isPaused = status == "paused"
        if (isPaused && !showPaused) {
            sendActivity(ws, null)
            return
        }

        sendActivity(ws, buildActivity(payload, track, isPlaying, isPaused)?.toString())
    }

    private fun buildActivity(
        payload: JSONObject,
        track: JSONObject,
        isPlaying: Boolean,
        isPaused: Boolean,
    ): JSONObject? {
        val title = sanitize(track.optString("title")) ?: "Unknown Title"
        val artist = sanitize(track.optString("artist")) ?: "Unknown Artist"
        val durationMs = when {
            payload.optLong("durationMs") > 0 -> payload.optLong("durationMs")
            track.optLong("durationMs") > 0 -> track.optLong("durationMs")
            else -> 0L
        }

        var activityName = "Liner"
        var detailsText = title
        var stateText = if (isPaused) "$artist (Paused)" else artist
        var statusDisplay = 1
        when (statusDisplayType) {
            "title" -> {
                activityName = title
                statusDisplay = 2
                detailsText = if (isPaused) "$title (Paused)" else title
                stateText = artist
            }
            "app" -> {
                activityName = "Liner"
                statusDisplay = 0
                detailsText = title
                stateText = if (isPaused) "$artist (Paused)" else artist
            }
            "artist_title" -> {
                activityName = "$artist - $title"
                statusDisplay = 1
                detailsText = title
                stateText = if (isPaused) "$artist - $title (Paused)" else "$artist - $title"
            }
            "title_artist" -> {
                activityName = "$title - $artist"
                statusDisplay = 2
                detailsText = if (isPaused) "$title - $artist (Paused)" else "$title - $artist"
                stateText = artist
            }
            else -> {
                activityName = artist
                statusDisplay = 1
                detailsText = title
                stateText = if (isPaused) "$artist (Paused)" else artist
            }
        }

        val activity = try {
            JSONObject()
                .put("name", sanitize(activityName) ?: "Liner")
                .put("type", 2)
                .put("created_at", System.currentTimeMillis())
                .put("instance", false)
                .put("status_display_type", statusDisplay)
        } catch (_: Exception) {
            return null
        }
        sanitize(detailsText)?.let { activity.put("details", it) }
        sanitize(stateText)?.let { activity.put("state", it) }

        if (isPlaying && showTime && durationMs > 0) {
            val now = System.currentTimeMillis()
            val elapsedSincePayload = maxOf(0L, now - latestPayloadReceivedAt)
            val currentPos = minOf(durationMs, maxOf(0L, payload.optLong("positionMs") + elapsedSincePayload))
            activity.put(
                "timestamps",
                JSONObject()
                    .put("start", now - currentPos)
                    .put("end", now - currentPos + durationMs),
            )
        }

        val assets = JSONObject()
        val coverImage = toDiscordImageUrl(track.optString("coverUrl"))
        if (showArtwork && coverImage != null) {
            assets.put("large_image", coverImage)
            assets.put("large_text", sanitize(track.optString("album").ifBlank { title }) ?: "Liner")
        }
        val artistImage = toDiscordImageUrl(payload.optString("artistImageUrl"))
        if (showArtistSmallImage && artistImage != null) {
            assets.put("small_image", artistImage)
            assets.put("small_text", sanitize(track.optString("artist")) ?: "Artist")
        }
        if (assets.length() > 0) activity.put("assets", assets)

        val buttons = JSONArray()
        val trackId = track.optString("id", "")
        if (showButton && trackId.isNotEmpty()) {
            buttons.put(
                JSONObject()
                    .put("label", "Listen on Liner")
                    .put("url", "https://link.tryliner.fun/track?id=${java.net.URLEncoder.encode(trackId, "UTF-8")}"),
            )
        }
        if (showDownloadButton) {
            buttons.put(JSONObject().put("label", "Download Liner").put("url", "https://tryliner.fun"))
        }
        if (buttons.length() > 0) activity.put("buttons", buttons)

        return activity
    }

    private fun sanitize(text: String?): String? {
        if (text.isNullOrBlank()) return null
        val trimmed = text.trim()
        if (trimmed.isEmpty()) return null
        if (trimmed.length == 1) return "$trimmed "
        return if (trimmed.length > MAX_TEXT_LENGTH) trimmed.substring(0, MAX_TEXT_LENGTH) else trimmed
    }

    private fun toDiscordImageUrl(url: String?): String? {
        if (url.isNullOrEmpty() || url.length > MAX_IMAGE_URL_LENGTH) return null
        return try {
            if (URL(url).protocol == "https") url else null
        } catch (_: Exception) {
            null
        }
    }

    private fun sendActivity(ws: WebSocket, activityJson: String?, force: Boolean = false) {
        val normalized = activityJson ?: "null"
        if (!force && normalized == lastSentJson) return
        val payload = try {
            JSONObject()
                .put("cmd", "SET_ACTIVITY")
                .put(
                    "args",
                    JSONObject()
                        .put("pid", Process.myPid())
                        .put(
                            "activity",
                            if (activityJson == null) JSONObject.NULL else JSONObject(activityJson),
                        ),
                )
                .put("nonce", (++nonce).toString())
        } catch (error: Exception) {
            Log.w(TAG, "SET_ACTIVITY build failed: ${error.message}")
            return
        }
        lastSentJson = normalized
        val ok = ws.send(payload.toString())
        Log.i(
            TAG,
            "SET_ACTIVITY ${if (activityJson == null) "clear" else "update"} ok=$ok: " +
                normalized.take(200),
        )
    }

    private fun scheduleReconnect() {
        if (reconnectScheduled || !enabled) return
        reconnectScheduled = true
        val delay = backoffMs
        backoffMs = (backoffMs * 2).coerceAtMost(MAX_BACKOFF_MS)
        val scheduledFor = generation
        worker.schedule({
            if (scheduledFor != generation) return@schedule
            reconnectScheduled = false
            if (!enabled) return@schedule
            connect()
        }, delay, TimeUnit.MILLISECONDS)
    }
}
