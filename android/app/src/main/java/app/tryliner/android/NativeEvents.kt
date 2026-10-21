package app.tryliner.android

/**
 * Bridges native playback events (ended, errors, notification next/previous)
 * into the WebView without coupling the media service to the Activity.
 *
 * Events emitted while no WebView is attached (cold start from Android Auto,
 * activity destroyed) are queued and flushed as soon as an emitter registers,
 * so an early play request still reaches the renderer. The queue is bounded;
 * the oldest events are dropped first.
 */
object NativeEvents {
    private const val MAX_PENDING = 32

    @Volatile
    var emitter: ((String, String) -> Unit)? = null
        set(value) {
            field = value
            if (value != null) flush(value)
        }

    private val lock = Any()
    private val pending = ArrayDeque<Pair<String, String>>()

    fun emit(type: String, payloadJson: String) {
        val target = emitter
        if (target != null) {
            target.invoke(type, payloadJson)
            return
        }
        synchronized(lock) {
            if (pending.size >= MAX_PENDING) pending.removeFirst()
            pending.addLast(type to payloadJson)
        }
        // The emitter may have attached between the check above and the queue
        // write; flush again so the event is not stranded until the next attach.
        emitter?.let(::flush)
    }

    private fun flush(target: (String, String) -> Unit) {
        val queued = synchronized(lock) {
            val copy = pending.toList()
            pending.clear()
            copy
        }
        for ((type, payload) in queued) {
            try {
                target.invoke(type, payload)
            } catch (_: Exception) {
                // A flush into a dying WebView is best effort.
            }
        }
    }
}
