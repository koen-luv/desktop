package app.tryliner.android

import android.Manifest
import android.app.DownloadManager
import android.content.ClipData
import android.content.ClipboardManager
import android.content.ContentValues
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.provider.Settings
import android.view.WindowManager
import android.webkit.JavascriptInterface
import androidx.core.app.ActivityCompat
import androidx.core.content.ContextCompat
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONObject
import java.io.File
import java.util.Locale
import java.util.concurrent.Executors

/**
 * Native surface consumed by src/platform/index.ts. Every method performs a real
 * platform operation; none are stubs.
 */
class LinerBridge(private val activity: MainActivity) {
    @Volatile private var reportedLocalStorageBytes = 0L
    @Volatile private var reportedIndexedDbBytes = 0L
    private val httpExecutor = Executors.newFixedThreadPool(4) { runnable ->
        Thread(runnable, "liner-http").apply { isDaemon = true }
    }

    @JavascriptInterface
    fun getVersion(): String = BuildConfig.VERSION_NAME

    @JavascriptInterface
    fun getPlatform(): String = "android"

    @JavascriptInterface
    fun getInsets(): String = activity.insetsJson()

    @JavascriptInterface
    fun setLightSystemBars(light: Boolean) {
        activity.runOnUiThread { activity.applySystemBarAppearance(light) }
    }

    @JavascriptInterface
    fun openExternal(url: String) {
        if (!url.startsWith("https://") && !url.startsWith("http://")) return
        try {
            val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url))
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            activity.startActivity(intent)
        } catch (_: Exception) {
            // No browser installed.
        }
    }

    @JavascriptInterface
    fun shareText(text: String) {
        try {
            val intent = Intent(Intent.ACTION_SEND).apply {
                type = "text/plain"
                putExtra(Intent.EXTRA_TEXT, text)
            }
            activity.startActivity(Intent.createChooser(intent, null))
        } catch (_: Exception) {
        }
    }

    @JavascriptInterface
    fun copyText(text: String) {
        try {
            val clipboard = activity.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
            clipboard.setPrimaryClip(ClipData.newPlainText("Liner", text))
        } catch (_: Exception) {
        }
    }

    /**
     * Renderer-originated HTTP for endpoints whose browser requests fail CORS
     * (the production API also duplicates Access-Control-Allow-Origin) and for
     * hosts that are not CORS-enabled at all (YouTube visitorData + Innertube).
     *
     * Runs off the WebView thread and answers asynchronously through the
     * `httpResponse` event so page JavaScript never blocks. Only allowlisted
     * production hosts are reachable.
     */
    @JavascriptInterface
    fun httpRequest(requestId: String, method: String, url: String, headersJson: String, body: String?) {
        httpExecutor.execute {
            val payload = executeHttpRequest(requestId, method, url, headersJson, body)
            NativeEvents.emit("httpResponse", payload)
        }
    }

    private fun executeHttpRequest(
        requestId: String,
        method: String,
        url: String,
        headersJson: String,
        body: String?,
    ): String {
        return try {
            val uri = Uri.parse(url)
            val host = uri.host?.lowercase(Locale.ROOT) ?: ""
            if (uri.scheme != "https" || !isAllowedHost(host)) {
                return errorJson(requestId, "Blocked host: $host")
            }
            val builder = Request.Builder().url(url)
            var hasUserAgent = false
            var headers: JSONObject? = null
            try {
                headers = JSONObject(headersJson.ifBlank { "{}" })
            } catch (_: Exception) {
            }
            headers?.keys()?.forEach { key ->
                val value = headers.optString(key)
                val lower = key.lowercase(Locale.ROOT)
                if (lower in setOf(
                        "host", "connection", "content-length", "accept-encoding",
                        "origin", "referer", "cookie", "sec-fetch-mode", "sec-fetch-site",
                    )
                ) {
                    return@forEach
                }
                if (lower == "user-agent") hasUserAgent = true
                builder.header(key, value)
            }
            if (!hasUserAgent) builder.header("User-Agent", Http.userAgent)
            builder.header("Accept-Language", "en-US,en;q=0.9")
            // Innertube rejects a request whose Origin does not match the host it
            // was sent to ("Origin doesn't match Host"), so mirror the target's
            // own origin instead of a fixed one: music.youtube.com and
            // www.youtube.com are both valid player endpoints.
            if (host.endsWith("youtube.com")) {
                builder.header("Origin", "https://$host")
                builder.header("Referer", "https://$host/")
            }

            val upperMethod = method.uppercase(Locale.ROOT)
            when (upperMethod) {
                "GET", "HEAD" -> builder.method(upperMethod, null)
                else -> {
                    val mediaType = "application/json; charset=utf-8".toMediaType()
                    builder.method(upperMethod, (body ?: "").toRequestBody(mediaType))
                }
            }

            Http.client.newCall(builder.build()).execute().use { response ->
                val responseBody = response.body?.string().orEmpty()
                if (responseBody.length > 12_000_000) {
                    return errorJson(requestId, "Response too large")
                }
                val resultHeaders = JSONObject()
                    .put("content-type", response.header("Content-Type") ?: "")
                    .put("date", response.header("Date") ?: "")
                    .put("location", response.header("Location") ?: "")
                    .put("x-request-id", response.header("x-request-id") ?: "")
                    .put("x-liner-server-time", response.header("x-liner-server-time") ?: "")
                JSONObject()
                    .put("id", requestId)
                    .put("status", response.code)
                    .put("ok", response.isSuccessful)
                    .put("headers", resultHeaders)
                    .put("body", responseBody)
                    .toString()
            }
        } catch (error: Exception) {
            errorJson(requestId, error.message ?: "Network request failed")
        }
    }

    private fun isAllowedHost(host: String): Boolean {
        if (host in setOf(
                "api.tryliner.fun",
                "covers.tryliner.fun",
                "link.tryliner.fun",
                "www.youtube.com",
                "youtube.com",
                "music.youtube.com",
                "youtubei.googleapis.com",
            )
        ) {
            return true
        }
        return host.endsWith(".googlevideo.com") ||
            host.endsWith(".ytimg.com") ||
            host.endsWith(".googleusercontent.com") ||
            host.endsWith(".ggpht.com") ||
            host.endsWith(".sndcdn.com")
    }

    private fun errorJson(requestId: String, message: String): String =
        JSONObject()
            .put("id", requestId)
            .put("status", 0)
            .put("ok", false)
            .put("error", message)
            .toString()

    // ── Playback ────────────────────────────────────────────────────────────

    @JavascriptInterface
    fun audioLoad(payload: String) {
        PlaybackHolder.requestLoad(activity.applicationContext, payload)
    }

    @JavascriptInterface
    fun audioPause() = PlaybackHolder.pause()

    @JavascriptInterface
    fun audioResume() = PlaybackHolder.resume()

    @JavascriptInterface
    fun audioSeek(positionMs: Double) = PlaybackHolder.seek(positionMs.toLong())

    @JavascriptInterface
    fun audioStop() = PlaybackHolder.stop()

    @JavascriptInterface
    fun audioSetVolume(volume: Float) = PlaybackHolder.setVolume(volume)

    @JavascriptInterface
    fun audioSetSpeed(rate: Float) = PlaybackHolder.setSpeed(rate)

    @JavascriptInterface
    fun audioSetPitch(semitones: Float) = PlaybackHolder.setPitchSemitones(semitones)

    @JavascriptInterface
    fun audioSetReverb(level: Float) = PlaybackHolder.setReverb(level)

    @JavascriptInterface
    fun audioSleepAt(deadlineMs: Double) = PlaybackHolder.setSleepAt(deadlineMs.toLong())

    @JavascriptInterface
    fun audioState(): String = PlaybackHolder.stateJson()

    @JavascriptInterface
    fun audioCache(url: String, trackId: String, mimeType: String, limitBytes: Double) {
        AudioCache.cache(url, trackId, mimeType.ifBlank { null }, limitBytes.toLong())
    }

    @JavascriptInterface
    fun audioSetCacheLimit(limitBytes: Double) {
        AudioCache.enforceLimit(limitBytes.toLong())
    }

    @JavascriptInterface
    fun audioClearCache(): Boolean = AudioCache.clear()

    @JavascriptInterface
    fun requestNotificationPermission() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return
        activity.runOnUiThread {
            if (activity.notificationPermissionAsked) return@runOnUiThread
            val granted = ContextCompat.checkSelfPermission(
                activity,
                Manifest.permission.POST_NOTIFICATIONS,
            ) == PackageManager.PERMISSION_GRANTED
            if (!granted) {
                activity.notificationPermissionAsked = true
                ActivityCompat.requestPermissions(
                    activity,
                    arrayOf(Manifest.permission.POST_NOTIFICATIONS),
                    MainActivity.NOTIFICATION_PERMISSION_REQUEST,
                )
            }
        }
    }

    @JavascriptInterface
    fun setKeepScreenOn(on: Boolean) {
        activity.runOnUiThread {
            if (on) {
                activity.window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            } else {
                activity.window.clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
            }
        }
    }

    // ── Storage / files ─────────────────────────────────────────────────────

    @JavascriptInterface
    fun saveDump(filename: String, content: String): String {
        val safeName = safeFileName(filename) { "liner-dump-${System.currentTimeMillis()}.json" }
        return saveBytesToDownloads(safeName, "application/json", content.toByteArray(Charsets.UTF_8))
    }

    /**
     * Downloads an audio stream into the device's public Downloads/Liner folder.
     * Playback never writes song files by itself (streaming only), so this is
     * the one path that persists audio — triggered by the user's explicit
     * Download action for the current song.
     */
    @JavascriptInterface
    fun downloadAudio(requestId: String, url: String, filename: String, mimeType: String) {
        httpExecutor.execute {
            NativeEvents.emit(
                "audioDownload",
                executeAudioDownload(requestId, url, filename, mimeType),
            )
        }
    }

    private fun executeAudioDownload(
        requestId: String,
        url: String,
        filename: String,
        mimeType: String,
    ): String {
        return try {
            val uri = Uri.parse(url)
            val host = uri.host?.lowercase(Locale.ROOT) ?: ""
            if (uri.scheme != "https" || !isAllowedHost(host)) {
                return downloadError(requestId, "Blocked host: $host")
            }
            Http.client
                .newCall(
                    Request.Builder()
                        .url(url)
                        .header("User-Agent", Http.userAgent)
                        .build(),
                )
                .execute()
                .use { response ->
                    if (!response.isSuccessful) {
                        return downloadError(requestId, "Download failed (HTTP ${response.code})")
                    }
                    val bytes = response.body?.bytes()
                    if (bytes == null || bytes.isEmpty()) {
                        return downloadError(requestId, "Download returned no data")
                    }
                    val safeName = safeFileName(filename) {
                        "liner-audio-${System.currentTimeMillis()}.m4a"
                    }
                    val saved = saveBytesToDownloads(safeName, mimeType.ifBlank { "audio/mp4" }, bytes)
                    JSONObject(saved).put("id", requestId).toString()
                }
        } catch (error: Exception) {
            downloadError(requestId, error.message ?: "Could not download file")
        }
    }

    private fun downloadError(requestId: String, message: String): String =
        JSONObject()
            .put("id", requestId)
            .put("success", false)
            .put("error", message)
            .toString()

    private fun safeFileName(filename: String, fallback: () -> String): String =
        filename
            .replace(Regex("[^A-Za-z0-9._-]"), "_")
            .take(120)
            .ifBlank { fallback() }

    private fun saveBytesToDownloads(name: String, mimeType: String, bytes: ByteArray): String {
        return try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                val values = ContentValues().apply {
                    put(MediaStore.MediaColumns.DISPLAY_NAME, name)
                    put(MediaStore.MediaColumns.MIME_TYPE, mimeType)
                    put(
                        MediaStore.MediaColumns.RELATIVE_PATH,
                        Environment.DIRECTORY_DOWNLOADS + "/Liner",
                    )
                }
                val uri = activity.contentResolver.insert(
                    MediaStore.Downloads.EXTERNAL_CONTENT_URI,
                    values,
                )
                if (uri != null) {
                    activity.contentResolver.openOutputStream(uri)?.use { it.write(bytes) }
                    JSONObject()
                        .put("success", true)
                        .put("filePath", uri.toString())
                        .toString()
                } else {
                    writeToAppDownloads(name, bytes)
                }
            } else {
                writeToAppDownloads(name, bytes)
            }
        } catch (error: Exception) {
            JSONObject()
                .put("success", false)
                .put("error", error.message ?: "Could not save file")
                .toString()
        }
    }

    private fun writeToAppDownloads(name: String, bytes: ByteArray): String {
        val dir = activity.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS)
            ?: File(activity.filesDir, "exports").apply { mkdirs() }
        dir.mkdirs()
        val file = File(dir, name)
        file.writeBytes(bytes)
        return JSONObject()
            .put("success", true)
            .put("filePath", file.absolutePath)
            .toString()
    }

    @JavascriptInterface
    fun openAppStorageSettings() {
        try {
            val intent = Intent(
                Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                Uri.fromParts("package", activity.packageName, null),
            ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            activity.startActivity(intent)
        } catch (_: Exception) {
        }
    }

    @JavascriptInterface
    fun openDownloads() {
        try {
            val intent = Intent(DownloadManager.ACTION_VIEW_DOWNLOADS)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            activity.startActivity(intent)
        } catch (_: Exception) {
            openAppStorageSettings()
        }
    }

    @JavascriptInterface
    fun clearCoversCache(): Boolean {
        return try {
            Http.client.cache?.evictAll()
            true
        } catch (_: Exception) {
            false
        }
    }

    @JavascriptInterface
    fun clearHttpCache(): Boolean {
        return try {
            Http.client.cache?.evictAll()
            activity.runOnUiThread { activity.webView.clearCache(true) }
            true
        } catch (_: Exception) {
            false
        }
    }

    @JavascriptInterface
    fun reportStorageUsage(localStorageBytes: Double, indexedDbBytes: Double) {
        reportedLocalStorageBytes = localStorageBytes.toLong().coerceAtLeast(0L)
        reportedIndexedDbBytes = indexedDbBytes.toLong().coerceAtLeast(0L)
    }

    @JavascriptInterface
    fun getCacheStats(): String {
        val cacheDir = activity.cacheDir
        val dataDir = activity.dataDir
        val httpCache = File(cacheDir, "http_cache")
        val codeCache = File(dataDir, "app_webview/Default/Code Cache")
        val serviceWorker = File(dataDir, "app_webview/Default/Service Worker")
        val audio = AudioCache.sizeBytes()
        val http = dirSize(httpCache)
        val code = dirSize(codeCache)
        val sw = dirSize(serviceWorker)
        val indexed = reportedIndexedDbBytes
        val local = reportedLocalStorageBytes
        // navigator.storage.estimate().usage already covers IndexedDB/Cache
        // Storage/Service Worker, so do not add the native SW directory again.
        val total = audio + http + code + indexed + local
        return JSONObject()
            .put("cacheSize", total)
            .put("httpCacheSize", http)
            .put("codeCacheSize", code)
            .put("serviceWorkerSize", sw)
            .put("indexedDbSize", indexed)
            .put("localStorageSize", local)
            .put("blobStorageSize", 0L)
            .put("audioCacheSize", audio)
            .put("cachePath", File(activity.filesDir, "audio_cache").absolutePath)
            .toString()
    }

    private fun dirSize(dir: File): Long {
        if (!dir.exists()) return 0L
        return try {
            dir.walkTopDown().filter { it.isFile }.sumOf { it.length() }
        } catch (_: Exception) {
            0L
        }
    }

    // ── Discord Rich Presence ──────────────────────────────────────────────

    /**
     * Configures the Discord RPC client (application id + master switch).
     * Mirrors the Electron preload's `discordRpcConfigure` so the renderer's
     * settings store and sync hook run unchanged on Android.
     */
    @JavascriptInterface
    fun discordRpcConfigure(clientId: String, enabled: Boolean) {
        DiscordRpc.configure(clientId, enabled)
    }

    /** Sets the profile activity from its JSON string (the pre-serialized DiscordActivity). */
    @JavascriptInterface
    fun discordRpcSetPresence(activityJson: String) {
        DiscordRpc.setPresence(activityJson)
    }

    @JavascriptInterface
    fun discordRpcClear() {
        DiscordRpc.clear()
    }
}
