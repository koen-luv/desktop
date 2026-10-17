package app.tryliner.android

/**
 * Bridges native playback events (ended, errors, notification next/previous)
 * into the WebView without coupling the media service to the Activity.
 */
object NativeEvents {
    @Volatile
    var emitter: ((String, String) -> Unit)? = null

    fun emit(type: String, payloadJson: String) {
        emitter?.invoke(type, payloadJson)
    }
}
