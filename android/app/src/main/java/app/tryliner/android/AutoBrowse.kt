package app.tryliner.android

import android.os.Handler
import android.os.Looper
import com.google.common.util.concurrent.ListenableFuture
import com.google.common.util.concurrent.SettableFuture
import org.json.JSONObject
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap

object AutoBrowse {
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

    fun deliver(requestId: String, payloadJson: String) {
        val entry = pending.remove(requestId) ?: return
        main.removeCallbacks(entry.timeout)
        entry.future.set(payloadJson)
    }

    fun play(payload: JSONObject) {
        NativeEvents.emit("autoPlay", payload.toString())
    }

    data class BrowseEntry(
        val id: String,
        val title: String,
        val subtitle: String,
        val artwork: String,
        val playable: Boolean,
    )

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
