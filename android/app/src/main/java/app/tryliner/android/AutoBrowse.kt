package app.tryliner.android

import android.os.Handler
import android.os.Looper
import com.google.common.util.concurrent.ListenableFuture
import com.google.common.util.concurrent.SettableFuture
import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

/**
 * Glue between the media library session (Android Auto and other
 * MediaBrowser clients) and the WebView renderer, which owns the library
 * data (history, playlists, queue, search index).
 *
 * Browse and search requests are forwarded to the renderer as events and
 * answered through [deliver] from the bridge. Queries time out after
 * [QUERY_TIMEOUT_MS] with a null payload so the caller can serve an empty
 * folder instead of hanging the client when the WebView is not ready.
 */
object AutoBrowse {
    /** Media id scheme shared with the renderer. */
    const val ROOT_ID = "liner.root"
    const val RECENTS_ID = "liner.recents"
    const val PLAYLISTS_ID = "liner.playlists"
    const val QUEUE_ID = "liner.queue"
    const val PLAYLIST_PREFIX = "liner.playlist:"
    const val TRACK_PREFIX = "liner.track:"

    private const val QUERY_TIMEOUT_MS = 3_000L

    private class Pending(val future: SettableFuture<String?>, val timeout: Runnable)

    private val main = Handler(Looper.getMainLooper())
    private val pending = ConcurrentHashMap<String, Pending>()

    /**
     * Asks the renderer for a browse list. [kind] is one of
     * recents|playlists|playlist|queue|search; the future resolves with the
     * raw JSON payload or null on timeout.
     */
    fun query(kind: String, arg: String): ListenableFuture<String?> {
        val future = SettableFuture.create<String?>()
        val id = UUID.randomUUID().toString()
        val timeout = Runnable { pending.remove(id)?.future?.set(null) }
        pending[id] = Pending(future, timeout)
        main.postDelayed(timeout, QUERY_TIMEOUT_MS)
        try {
            NativeEvents.emit(
                "autoBrowseQuery",
                JSONObject().put("id", id).put("kind", kind).put("arg", arg).toString(),
            )
        } catch (_: Exception) {
            pending.remove(id)?.future?.set(null)
        }
        return future
    }

    /** Completes a pending query. Called from the WebView JavaScript thread. */
    fun deliver(requestId: String, payloadJson: String) {
        val entry = pending.remove(requestId) ?: return
        main.removeCallbacks(entry.timeout)
        entry.future.set(payloadJson)
    }

    /** Forwards a playback request ({mediaId} or {query}) to the renderer. */
    fun play(payload: JSONObject) {
        NativeEvents.emit("autoPlay", payload.toString())
    }

    /** A single browsable or playable row as described by the renderer. */
    data class BrowseEntry(
        val id: String,
        val title: String,
        val subtitle: String,
        val artwork: String,
        val playable: Boolean,
    )

    /** Parses a renderer browse payload (`{items:[...]}`); null/invalid → empty. */
    fun parseEntries(payloadJson: String?): List<BrowseEntry> {
        if (payloadJson.isNullOrBlank()) return emptyList()
        return try {
            val items = JSONObject(payloadJson).optJSONArray("items") ?: return emptyList()
            val entries = ArrayList<BrowseEntry>(items.length())
            for (index in 0 until items.length()) {
                val entry = items.optJSONObject(index) ?: continue
                val id = entry.optString("id")
                if (id.isBlank()) continue
                entries.add(
                    BrowseEntry(
                        id = id,
                        title = entry.optString("title"),
                        subtitle = entry.optString("subtitle"),
                        artwork = entry.optString("artwork"),
                        playable = entry.optBoolean("playable", true),
                    ),
                )
            }
            entries
        } catch (_: Exception) {
            emptyList()
        }
    }
}
