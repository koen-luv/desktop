package app.tryliner.android

import android.os.Build
import android.os.Process
import android.util.Log
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.util.concurrent.Executors
import java.util.concurrent.ScheduledExecutorService
import java.util.concurrent.TimeUnit

/**
 * Discord Rich Presence for the Android app — the Kotlin counterpart of
 * electron/discordRpc.ts.
 *
 * Discord's client serves a local RPC endpoint on localhost ports 6463..6472
 * (probed sequentially, as Discord's own docs prescribe). On desktop the
 * classic transport is a named pipe; the portable transport — and the only one
 * served over TCP — is WebSocket, which is also what the signed-in Discord
 * Android app accepts since Social SDK 1.10 shipped "Rich Presence via an
 * unauthenticated RPC transport". Both speak the same JSON protocol:
 * connect → READY dispatch → SET_ACTIVITY. SET_ACTIVITY needs no OAuth.
 *
 * Emulators have no Discord app, so the host loopback alias (10.0.2.2) is
 * probed as well; that reaches the Discord desktop client running on the
 * development machine and lets the debug build show real presence end to end.
 *
 * Every mutable field is confined to one daemon worker thread: entry points
 * post to it and OkHttp callbacks hop onto it, mirroring the single-threaded
 * event loop of the desktop manager. Everything fails soft — no Discord app,
 * a bad client id or a dropped link just logs and retries with the desktop's
 * 2s → 60s backoff. Presence is a nicety; it must never affect playback.
 */
object DiscordRpc {
    private const val TAG = "LinerDiscordRpc"

    /**
     * Origin sent with the WebSocket upgrade. Discord verifies it against the
     * RPC Origins registered for the application id and disconnects on a
     * mismatch; the RPC docs recommend `https://localhost` for local clients.
     */
    private const val ORIGIN = "https://localhost"

    private const val BASE_BACKOFF_MS = 2_000L
    private const val MAX_BACKOFF_MS = 60_000L
    /** READY normally arrives unsolicited; past this delay we send the v1 handshake message once. */
    private const val HANDSHAKE_FALLBACK_MS = 1_500L
    /** An open socket that never becomes READY within this window is treated as dead. */
    private const val READY_TIMEOUT_MS = 6_000L

    private val worker: ScheduledExecutorService =
        Executors.newSingleThreadScheduledExecutor { runnable ->
            Thread(runnable, "liner-discord-rpc").apply { isDaemon = true }
        }

    private val client = OkHttpClient.Builder()
        .connectTimeout(2, TimeUnit.SECONDS)
        // Long-lived socket: no read timeout; protocol-level pings keep it healthy.
        .readTimeout(0, TimeUnit.MILLISECONDS)
        .pingInterval(30, TimeUnit.SECONDS)
        .build()

    /** True on the Android emulator: no local Discord there, probe the host too. */
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

    // ── Worker-thread state ────────────────────────────────────────────────
    private var generation = 0
    private var clientId = ""
    private var enabled = false
    private var candidates: List<String> = emptyList()
    private var candidateIndex = 0
    private var socket: WebSocket? = null
    private var connecting = false
    private var ready = false
    private var backoffMs = BASE_BACKOFF_MS
    private var reconnectScheduled = false
    private var nonce = 0
    private var lastSentJson: String? = null
    private var pendingActivityJson: String? = null
    private var hasPending = false

    // ── API (called from the WebView thread) ───────────────────────────────

    /** Enables/disables presence and (re)connects when the client id changes. */
    fun configure(rawClientId: String, rawEnabled: Boolean) {
        worker.execute { doConfigure(rawClientId.trim(), rawEnabled) }
    }

    /** Sets (or clears, with null) the presence shown on the user's profile. */
    fun setPresence(activityJson: String?) {
        worker.execute { doSetPresence(activityJson) }
    }

    fun clear() = setPresence(null)

    // ── State machine (worker thread only) ─────────────────────────────────

    private fun doConfigure(nextClientId: String, nextEnabled: Boolean) {
        val nextActive = nextEnabled && nextClientId.isNotEmpty()
        if (nextClientId == clientId && nextActive == enabled) return
        clientId = nextClientId
        enabled = nextActive
        generation += 1

        val old = socket
        val wasReady = ready
        socket = null
        connecting = false
        ready = false
        reconnectScheduled = false
        candidateIndex = 0
        candidates = buildCandidates(nextClientId)
        lastSentJson = null
        backoffMs = BASE_BACKOFF_MS

        if (old != null) {
            if (!nextActive && wasReady) {
                // Best-effort clear so the previous track does not linger.
                sendActivity(old, null, force = true)
            }
            old.close(1000, if (nextActive) "reconfigured" else "disabled")
        }
        if (nextActive) startConnect()
    }

    private fun doSetPresence(activityJson: String?) {
        if (!enabled) return
        pendingActivityJson = activityJson
        hasPending = true
        val ws = socket
        if (ready && ws != null) {
            sendActivity(ws, activityJson)
        } else {
            // Flushed on READY; logged so "not showing on Discord" is debuggable.
            Log.i(TAG, "presence queued until READY: ${activityJson ?: "null"}".take(200))
        }
    }

    private fun buildCandidates(id: String): List<String> {
        if (id.isEmpty()) return emptyList()
        val hosts = if (isEmulator) listOf("127.0.0.1", "10.0.2.2") else listOf("127.0.0.1")
        return hosts.flatMap { host ->
            (6463..6472).map { port -> "ws://$host:$port/?v=1&client_id=$id&encoding=json" }
        }
    }

    private fun startConnect() {
        if (!enabled || connecting || socket != null) return
        val url = candidates.getOrNull(candidateIndex)
        if (url == null) {
            // Every candidate refused: start the walk over after a backoff pause.
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
            // Acknowledge the close so the handshake completes cleanly.
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
        candidateIndex = 0 // found a live listener; later drops retry through backoff
        lastSentJson = null
        Log.i(TAG, "socket open, waiting for READY")

        // READY usually arrives unsolicited — the URL already carries v and
        // client_id. If the server waits for the handshake message instead,
        // send it after a short beat.
        worker.schedule({
            if (attempt == generation && socket === ws && !ready) {
                ws.send(JSONObject().put("v", 1).put("client_id", clientId).toString())
            }
        }, HANDSHAKE_FALLBACK_MS, TimeUnit.MILLISECONDS)
        // Safety net: an open socket that never becomes READY is dead weight.
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
            evt == "READY" -> handleReady(ws)
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

    private fun handleReady(ws: WebSocket) {
        if (socket !== ws) return
        ready = true
        backoffMs = BASE_BACKOFF_MS
        Log.i(TAG, "READY — Discord session established")
        // Flush whatever the renderer last asked for (including a clear).
        if (hasPending) sendActivity(ws, pendingActivityJson)
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
        }
        if (!wasConnecting && !wasSocket) return // already accounted for
        if (!enabled) {
            Log.i(TAG, "connection down ($why); disabled")
            return
        }
        if (wasConnecting) {
            // Never opened: walk the candidate ports (refusals are instant locally).
            Log.d(TAG, "candidate refused: $why")
            candidateIndex += 1
            if (candidateIndex >= candidates.size) {
                candidateIndex = 0
                scheduleReconnect()
            } else {
                startConnect()
            }
        } else {
            Log.i(TAG, "disconnected ($why); retry in ${backoffMs}ms")
            scheduleReconnect()
        }
    }

    private fun sendActivity(ws: WebSocket, activityJson: String?, force: Boolean = false) {
        val normalized = activityJson ?: "null"
        if (!force && normalized == lastSentJson) return // avoid hammering Discord's limit
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
            if (scheduledFor != generation) return@schedule // reconfigured meanwhile
            reconnectScheduled = false
            if (!enabled) return@schedule
            startConnect()
        }, delay, TimeUnit.MILLISECONDS)
    }
}
