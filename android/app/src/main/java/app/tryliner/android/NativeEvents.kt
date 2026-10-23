package app.tryliner.android

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
            }
        }
    }
}
