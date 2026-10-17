package app.tryliner.android

import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.Handler
import android.os.Looper
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.PlaybackException
import androidx.media3.common.PlaybackParameters
import androidx.media3.common.Player
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.session.MediaSession
import android.media.audiofx.PresetReverb
import android.net.Uri
import org.json.JSONObject
import java.io.File

/**
 * Owns the single ExoPlayer instance and exposes a small JSON command surface to
 * the renderer. ExoPlayer is the source of truth for position/duration: the
 * WebView only mirrors it. All methods are safe to call before the service has
 * finished starting (commands are queued).
 */
object PlaybackHolder {
    private val main = Handler(Looper.getMainLooper())
    @Volatile private var player: ExoPlayer? = null
    @Volatile private var session: MediaSession? = null
    @Volatile var service: PlaybackService? = null
        internal set

    private var pendingLoad: String? = null
    private var pendingActions = mutableListOf<() -> Unit>()

    @Volatile private var volume = 1f
    @Volatile private var speed = 1f
    @Volatile private var pitch = 1f
    @Volatile private var reverbLevel = 0f
    private var reverb: PresetReverb? = null

    @Volatile private var currentTrackId: String? = null
    @Volatile private var loadedDurationMs = 0L
    @Volatile private var lastError: String? = null
    @Volatile private var lastState = "{}"
    @Volatile private var usingCache = false
    @Volatile private var playWhenReadyIntent = true
    private var ticker: Runnable? = null
    private var notifiedStatus: String? = null
    private var notifiedTrackId: String? = null

    fun ensureService(context: Context) {
        if (service != null) return
        val app = context.applicationContext
        val intent = Intent(app, PlaybackService::class.java)
        // Playback must not be killed while a stream is resolving, so the
        // service always starts as a foreground service and claims the slot
        // itself; Media3 then replaces that notification with the full media
        // notification once the player is playing.
        try {
            app.startForegroundService(
                intent.putExtra(PlaybackService.EXTRA_PROMOTE_TO_FOREGROUND, true),
            )
        } catch (_: Exception) {
            try {
                app.startService(intent)
            } catch (_: Exception) {
                // Service cannot be started right now; the bridge reports the
                // failure through the state poll as idle.
            }
        }
    }

    internal fun attach(service: PlaybackService, player: ExoPlayer, session: MediaSession) {
        this.service = service
        this.player = player
        this.session = session
        player.volume = volume
        applyPlaybackParams(player)
        player.addListener(object : Player.Listener {
            override fun onPlaybackStateChanged(playbackState: Int) {
                if (playbackState == Player.STATE_ENDED) {
                    val id = currentTrackId
                    if (id != null) {
                        NativeEvents.emit("playbackEnded", JSONObject.quote(id))
                    }
                }
                updateState()
            }

            override fun onIsPlayingChanged(isPlaying: Boolean) {
                updateState()
            }

            override fun onPlayerError(error: PlaybackException) {
                lastError = describePlaybackError(error)
                updateState()
                NativeEvents.emit("playbackError", stateJson())
            }

            override fun onPlaybackParametersChanged(playbackParameters: PlaybackParameters) {
                updateState()
            }
        })

        startTicker()
        val queued = pendingActions.toList()
        pendingActions.clear()
        queued.forEach { it() }
        pendingLoad?.let { json ->
            pendingLoad = null
            applyLoad(json)
        }
    }

    internal fun detach(player: ExoPlayer) {
        if (this.player === player) {
            this.player = null
            this.session = null
            this.service = null
            ticker?.let { main.removeCallbacks(it) }
            ticker = null
            releaseReverb()
        }
    }

    fun requestLoad(context: Context, payloadJson: String) {
        playWhenReadyIntent = true
        ensureService(context)
        val p = player
        if (p == null) {
            pendingLoad = payloadJson
            return
        }
        main.post { applyLoad(payloadJson) }
    }

    private fun runOnPlayer(action: (ExoPlayer) -> Unit) {
        val p = player
        if (p == null) {
            pendingActions.add { this.player?.let(action) }
            return
        }
        main.post { this.player?.let(action) }
    }

    fun pause() {
        playWhenReadyIntent = false
        runOnPlayer { it.pause() }
    }

    fun resume() {
        playWhenReadyIntent = true
        runOnPlayer { it.play() }
    }

    fun seek(positionMs: Long) = runOnPlayer { it.seekTo(positionMs.coerceAtLeast(0L)) }

    fun setVolume(next: Float) {
        volume = next.coerceIn(0f, 1f)
        runOnPlayer { it.volume = volume }
    }

    fun setSpeed(next: Float) {
        speed = next.coerceIn(0.25f, 4f)
        runOnPlayer { applyPlaybackParams(it) }
    }

    fun setPitchSemitones(next: Float) {
        pitch = Math.pow(2.0, (next.coerceIn(-12f, 12f) / 12f).toDouble()).toFloat()
        runOnPlayer { applyPlaybackParams(it) }
    }

    private fun applyPlaybackParams(p: ExoPlayer) {
        p.playbackParameters = PlaybackParameters(speed, pitch.coerceAtLeast(0.25f))
    }

    fun setReverb(level: Float) {
        reverbLevel = level.coerceIn(0f, 1f)
        runOnPlayer { ensureReverb(it) }
    }

    private fun ensureReverb(p: ExoPlayer) {
        if (reverbLevel <= 0.01f) {
            try { reverb?.enabled = false } catch (_: Exception) {}
            return
        }
        val sessionId = p.audioSessionId
        if (sessionId == C.AUDIO_SESSION_ID_UNSET || sessionId == 0) return
        if (reverb == null) {
            try {
                reverb = PresetReverb(0, sessionId).apply { enabled = true }
            } catch (_: Exception) {
                reverb = null
                return
            }
        }
        val preset = when {
            reverbLevel < 0.4f -> PresetReverb.PRESET_SMALLROOM
            reverbLevel < 0.7f -> PresetReverb.PRESET_MEDIUMROOM
            else -> PresetReverb.PRESET_LARGEROOM
        }
        try {
            reverb?.setPreset(preset)
            reverb?.enabled = true
        } catch (_: Exception) {
            // Effect not available on this device.
        }
    }

    private fun releaseReverb() {
        try { reverb?.release() } catch (_: Exception) {}
        reverb = null
    }

    fun stop() = runOnPlayer {
        playWhenReadyIntent = false
        it.stop()
        it.clearMediaItems()
        currentTrackId = null
        loadedDurationMs = 0L
        lastError = null
        usingCache = false
        updateState()
    }

    private fun applyLoad(json: String) {
        val p = player ?: run { pendingLoad = json; return }
        try {
            val payload = JSONObject(json)
            val url = payload.optString("url")
            val trackId = payload.optString("trackId")
            if (url.isBlank() || trackId.isBlank()) return
            val mime = payload.optString("mimeType").ifBlank { null }
            val metadata = MediaMetadata.Builder()
                .setTitle(payload.optString("title").ifBlank { null })
                .setArtist(payload.optString("artist").ifBlank { null })
                .setAlbumTitle(payload.optString("album").ifBlank { null })
                .setArtworkUri(
                    payload.optString("coverUrl").takeIf { it.startsWith("http") }?.let(Uri::parse)
                )
                .build()

            val cached: File? = AudioCache.find(trackId)
            val uri = if (cached != null) Uri.fromFile(cached) else Uri.parse(url)
            val resolvedMime = if (cached != null) AudioCache.mimeOf(cached) else mime

            val item = MediaItem.Builder()
                .setUri(uri)
                .setMediaMetadata(metadata)
                .apply { if (resolvedMime != null) setMimeType(resolvedMime) }
                .build()

            currentTrackId = trackId
            loadedDurationMs = payload.optLong("durationMs", 0L)
            lastError = null
            usingCache = cached != null
            p.setMediaItem(item, payload.optLong("startMs", 0L).coerceAtLeast(0L))
            p.prepare()
            p.playWhenReady = playWhenReadyIntent
            updateState()
        } catch (error: Exception) {
            lastError = "load failed: " + (error.message ?: "invalid payload")
            updateState()
            NativeEvents.emit("playbackError", stateJson())
        }
    }

    /**
     * PlaybackException only carries a generic message, so the underlying
     * data-source cause is folded in: the HTTP status and CDN host are what make
     * a stream failure actionable (expired URL vs. unsupported codec).
     */
    private fun describePlaybackError(error: PlaybackException): String {
        val cause = error.cause
        val builder = StringBuilder(error.errorCodeName)
        if (cause != null) {
            builder.append(": ").append(cause.javaClass.simpleName)
            cause.message?.takeIf { it.isNotBlank() }?.let { builder.append(" ").append(it) }
            if (cause is androidx.media3.datasource.HttpDataSource.InvalidResponseCodeException) {
                builder.append(" (HTTP ").append(cause.responseCode).append(", ")
                builder.append(cause.dataSpec?.uri?.host ?: "unknown host").append(")")
            }
        } else {
            error.message?.let { builder.append(": ").append(it) }
        }
        return builder.toString()
    }

    private fun startTicker() {
        if (ticker != null) return
        val runnable = object : Runnable {
            override fun run() {
                updateState()
                val p = player
                if (p != null && reverbLevel > 0.01f && reverb == null) ensureReverb(p)
                main.postDelayed(this, 250L)
            }
        }
        ticker = runnable
        main.post(runnable)
    }

    private fun updateState() {
        val p = player
        if (p == null) {
            lastState = JSONObject().put("status", "idle").toString()
            return
        }
        val status = when {
            lastError != null -> "error"
            p.mediaItemCount == 0 -> "idle"
            p.playbackState == Player.STATE_ENDED -> "ended"
            p.playbackState == Player.STATE_BUFFERING -> "buffering"
            p.playbackState == Player.STATE_IDLE -> "paused"
            p.playWhenReady -> "playing"
            else -> "paused"
        }
        val duration = p.duration.takeIf { it > 0 && it != C.TIME_UNSET } ?: loadedDurationMs
        val state = JSONObject()
            .put("status", status)
            .put("trackId", currentTrackId ?: JSONObject.NULL)
            .put("positionMs", p.currentPosition.coerceAtLeast(0L))
            .put("durationMs", duration)
            .put("bufferedMs", p.bufferedPosition)
            .put("usingCache", usingCache)
            .put("error", lastError ?: JSONObject.NULL)
            .put("canSeek", duration > 0)
        lastState = state.toString()

        // Rebuild the media notification only when what it shows actually
        // changed; the ticker still publishes position updates to the renderer.
        if (status != notifiedStatus || currentTrackId != notifiedTrackId) {
            notifiedStatus = status
            notifiedTrackId = currentTrackId
            service?.refreshNotification()
        }
    }

    fun stateJson(): String = lastState

    fun currentTrackId(): String? = currentTrackId

    fun isPlaying(): Boolean = player?.isPlaying == true

    fun positionMs(): Long = player?.currentPosition ?: 0L
}
