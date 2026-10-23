package app.tryliner.android

import android.content.Context
import okhttp3.Request
import java.io.File
import java.util.concurrent.Executors

object AudioCache {
    private val io = Executors.newSingleThreadExecutor { r ->
        Thread(r, "liner-audio-cache").apply { isDaemon = true }
    }
    private lateinit var root: File
    private val inFlight = HashSet<String>()

    fun init(context: Context) {
        root = File(context.filesDir, "audio_cache").apply { mkdirs() }
    }

    private fun extensionFor(mime: String?): String = when {
        mime == null -> "bin"
        mime.contains("webm") || mime.contains("opus") -> "webm"
        mime.contains("mp4") || mime.contains("m4a") || mime.contains("aac") -> "m4a"
        mime.contains("mpeg") || mime.contains("mp3") -> "mp3"
        mime.contains("ogg") -> "ogg"
        else -> "bin"
    }

    private fun mimeFor(file: File): String = when (file.extension) {
        "webm" -> "audio/webm"
        "m4a" -> "audio/mp4"
        "mp3" -> "audio/mpeg"
        "ogg" -> "audio/ogg"
        else -> "application/octet-stream"
    }

    fun find(trackId: String): File? {
        if (!::root.isInitialized) return null
        val safe = trackId.replace(Regex("[^A-Za-z0-9_-]"), "_")
        return root.listFiles()?.firstOrNull { it.name.startsWith("$safe.") && it.length() > 8 * 1024 }
    }

    fun mimeOf(file: File): String = mimeFor(file)

    fun sizeBytes(): Long {
        if (!::root.isInitialized) return 0
        return root.listFiles()?.sumOf { it.length() } ?: 0
    }

    fun clear(): Boolean {
        if (!::root.isInitialized) return false
        root.listFiles()?.forEach { it.delete() }
        return true
    }

    fun cache(url: String, trackId: String, mime: String?, limitBytes: Long) {
        if (!::root.isInitialized || trackId.isBlank()) return
        val safe = trackId.replace(Regex("[^A-Za-z0-9_-]"), "_")
        if (find(trackId) != null) return
        synchronized(inFlight) {
            if (!inFlight.add(safe)) return
        }
        io.execute {
            val target = File(root, "$safe.${extensionFor(mime)}")
            val part = File(root, "$safe.part")
            try {
                val request = Request.Builder()
                    .url(url)
                    .header("User-Agent", Http.userAgent)
                    .build()
                Http.client.newCall(request).execute().use { response ->
                    if (!response.isSuccessful) return@execute
                    val body = response.body ?: return@execute
                    if (body.contentLength() > 96L * 1024 * 1024) return@execute
                    part.outputStream().use { output ->
                        body.byteStream().use { input -> input.copyTo(output, 128 * 1024) }
                    }
                }
                if (part.length() > 8 * 1024) {
                    if (target.exists()) target.delete()
                    if (part.renameTo(target)) {
                        enforceLimit(limitBytes)
                    }
                }
            } catch (_: Exception) {
                part.delete()
            } finally {
                part.delete()
                synchronized(inFlight) { inFlight.remove(safe) }
            }
        }
    }

    fun enforceLimit(limitBytes: Long) {
        if (!::root.isInitialized) return
        if (limitBytes <= 0) return
        val files = root.listFiles()?.sortedBy { it.lastModified() } ?: return
        var total = files.sumOf { it.length() }
        if (total <= limitBytes) return
        val target = (limitBytes * 0.9).toLong()
        for (file in files) {
            if (total <= target) break
            val size = file.length()
            if (file.delete()) total -= size
        }
    }
}
