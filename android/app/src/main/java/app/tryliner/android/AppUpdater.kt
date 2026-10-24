package app.tryliner.android

import android.app.DownloadManager
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Environment
import androidx.core.content.FileProvider
import okhttp3.OkHttpClient
import okhttp3.Request
import org.json.JSONObject
import java.io.File
import java.util.concurrent.TimeUnit

/**
 * In-app updater for the sideloaded APK.
 *
 * The release workflow publishes every build as a GitHub release asset, so the
 * newest signed APK always sits behind the same URL. A background refresh
 * compares that release with [BuildConfig.VERSION_NAME]; when it is newer the
 * renderer is notified through its regular updater dialogs. Installing hands
 * the APK to DownloadManager and then to the system package installer.
 */
object AppUpdater {
    private const val RELEASES_URL =
        "https://api.github.com/repos/koen-luv/desktop/releases/latest"
    private const val APK_FILE = "liner-update.apk"
    private const val CHECK_INTERVAL_MS = 30 * 60 * 1000L

    private val client = OkHttpClient.Builder()
        .connectTimeout(10, TimeUnit.SECONDS)
        .readTimeout(15, TimeUnit.SECONDS)
        .build()

    @Volatile private var lastResult = "{\"available\":false}"
    @Volatile private var lastCheckAt = 0L
    @Volatile private var checking = false
    @Volatile private var pendingApkUrl: String? = null
    @Volatile private var pendingVersion: String? = null

    /**
     * Returns the cached check result immediately and refreshes it in the
     * background when it is stale. A newer release is pushed to the renderer
     * as an `updateAvailable` event, which the updater store turns into the
     * usual update card.
     */
    fun check(context: Context): String {
        val now = System.currentTimeMillis()
        if (!checking && now - lastCheckAt > CHECK_INTERVAL_MS) {
            refresh(context.applicationContext)
        }
        return lastResult
    }

    /** Starts the download for the release found by [check]. */
    fun install(context: Context) {
        val url = pendingApkUrl ?: return
        val app = context.applicationContext
        val request = DownloadManager.Request(Uri.parse(url))
            .setTitle("Liner " + (pendingVersion ?: "update"))
            .setMimeType("application/vnd.android.package-archive")
            .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
            .setDestinationInExternalFilesDir(app, Environment.DIRECTORY_DOWNLOADS, APK_FILE)
        val manager = app.getSystemService(Context.DOWNLOAD_SERVICE) as DownloadManager
        val id = manager.enqueue(request)

        Thread {
            val target = File(app.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS), APK_FILE)
            val deadline = System.currentTimeMillis() + 10 * 60 * 1000L
            while (System.currentTimeMillis() < deadline) {
                Thread.sleep(700)
                val cursor = manager.query(DownloadManager.Query().setFilterById(id))
                cursor?.use {
                    if (!it.moveToFirst()) return@use
                    val status = it.getInt(it.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS))
                    if (status == DownloadManager.STATUS_FAILED) {
                        NativeEvents.emit(
                            "updateError",
                            JSONObject().put("message", "Update download failed").toString(),
                        )
                        return@Thread
                    }
                    if (status == DownloadManager.STATUS_SUCCESSFUL) {
                        launchInstaller(app, target)
                        return@Thread
                    }
                }
            }
        }.apply { isDaemon = true; name = "liner-updater-install" }.start()
    }

    private fun refresh(app: Context) {
        checking = true
        Thread {
            val result = try {
                fetchLatest()
            } finally {
                checking = false
                lastCheckAt = System.currentTimeMillis()
            }
            if (result == null) return@Thread
            lastResult = result.toString()
            if (result.optBoolean("available")) {
                NativeEvents.emit("updateAvailable", result.toString())
            }
        }.apply { isDaemon = true; name = "liner-updater" }.start()
    }

    private fun fetchLatest(): JSONObject? {
        val request = Request.Builder()
            .url(RELEASES_URL)
            .header("Accept", "application/vnd.github+json")
            .header("User-Agent", "Liner-Android")
            .build()
        return try {
            client.newCall(request).execute().use { response ->
                if (!response.isSuccessful) return null
                val body = response.body?.string().orEmpty()
                if (body.isBlank()) return null
                val release = JSONObject(body)
                val tag = release.optString("tag_name").ifBlank { release.optString("name") }
                val version = normalizeVersion(tag)
                if (version.isEmpty() || !isNewer(version, BuildConfig.VERSION_NAME)) {
                    return JSONObject().put("available", false)
                }

                val assets = release.optJSONArray("assets")
                var apkUrl = ""
                if (assets != null) {
                    for (index in 0 until assets.length()) {
                        val asset = assets.optJSONObject(index) ?: continue
                        val name = asset.optString("name")
                        val url = asset.optString("browser_download_url")
                        if (!name.endsWith(".apk", ignoreCase = true) || url.isBlank()) continue
                        if (name.contains("debug", ignoreCase = true)) continue
                        apkUrl = url
                        break
                    }
                }
                if (apkUrl.isBlank()) return JSONObject().put("available", false)

                pendingApkUrl = apkUrl
                pendingVersion = version
                JSONObject()
                    .put("available", true)
                    .put("version", version)
                    .put("url", apkUrl)
                    .put("releaseNotes", release.optString("body"))
            }
        } catch (_: Exception) {
            null
        }
    }

    private fun launchInstaller(app: Context, apk: File) {
        if (!apk.exists()) return
        val uri = FileProvider.getUriForFile(app, app.packageName + ".updates", apk)
        val intent = Intent(Intent.ACTION_VIEW).apply {
            setDataAndType(uri, "application/vnd.android.package-archive")
            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        }
        try {
            app.startActivity(intent)
            NativeEvents.emit(
                "updateDownloaded",
                JSONObject().put("version", pendingVersion ?: BuildConfig.VERSION_NAME).toString(),
            )
        } catch (_: Exception) {
            NativeEvents.emit(
                "updateError",
                JSONObject().put("message", "Could not open the installer").toString(),
            )
        }
    }

    private fun normalizeVersion(raw: String): String {
        val trimmed = raw.trim().removePrefix("v").removePrefix("V")
        return Regex("^\\d+(\\.\\d+){0,3}").find(trimmed)?.value.orEmpty()
    }

    private fun isNewer(candidate: String, installed: String): Boolean {
        val left = normalizeVersion(candidate).split(".").map { it.toIntOrNull() ?: 0 }
        val right = normalizeVersion(installed).split(".").map { it.toIntOrNull() ?: 0 }
        for (index in 0 until maxOf(left.size, right.size)) {
            val a = left.getOrElse(index) { 0 }
            val b = right.getOrElse(index) { 0 }
            if (a != b) return a > b
        }
        return false
    }
}
