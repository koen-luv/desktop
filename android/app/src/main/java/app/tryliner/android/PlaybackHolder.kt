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
import android.media.audiofx.Equalizer
import android.media.audiofx.PresetReverb
import android.net.Uri
import org.json.JSONObject
import java.io.File

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

    private var sleepRunnable: Runnable? = null
    @Volatile private var sleepDeadlineMs: Long = 0L

    // ---- Overlapping crossfade (two players audible at once) ----
    /** Session wrapper around whichever ExoPlayer is currently main. */
    @Volatile private var sessionPlayer: LinerForwardingPlayer? = null
    @Volatile private var transitionPlayer: ExoPlayer? = null
    /** Track prepared on the transition player; null when no blend is armed/running. */
    @Volatile private var crossfadeTrackId: String? = null
    /** Bumped on every start/cancel/promote so stale ramp ticks exit early. */
    private var crossfadeEpoch = 0
    private var crossfadeRunnable: Runnable? = null
    private var crossfadeDurationMs = 0L
    private var crossfadeStartedAt = 0L
    private var lastEqSweepAt = 0L
    private var mainEqualizer: Equalizer? = null
    private var transitionEqualizer: Equalizer? = null

    private val playerListener = object : Player.Listener {
        override fun onPlaybackStateChanged(playbackState: Int) {
            if (playbackState == Player.STATE_ENDED) {
                // During a crossfade the blend's completion — not the outgoing
                // player's end — drives the queue advance.
                if (crossfadeTrackId == null) {
                    val id = currentTrackId
                    if (id != null) {
                        NativeEvents.emit("playbackEnded", JSONObject.quote(id))
                    }
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
    }

    fun ensureService(context: Context) {
        if (service != null) return
        val app = context.applicationContext
        val intent = Intent(app, PlaybackService::class.java)
        try {
            app.startForegroundService(
                intent.putExtra(PlaybackService.EXTRA_PROMOTE_TO_FOREGROUND, true),
            )
        } catch (_: Exception) {
            try {
                app.startService(intent)
            } catch (_: Exception) {
            }
        }
    }

    internal fun attach(
        service: PlaybackService,
        player: ExoPlayer,
        session: MediaSession,
        forwarding: LinerForwardingPlayer,
    ) {
        this.service = service
        this.player = player
        this.session = session
        this.sessionPlayer = forwarding
        player.volume = volume
        applyPlaybackParams(player)
        player.addListener(playerListener)

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
            cancelCrossfadeLocked()
            this.player = null
            this.session = null
            this.service = null
            this.sessionPlayer = null
            ticker?.let { main.removeCallbacks(it) }
            ticker = null
            cancelSleep()
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
        cancelCrossfadeLocked()
        runOnPlayer {
            it.volume = volume
            it.pause()
        }
    }

    fun resume() {
        playWhenReadyIntent = true
        runOnPlayer { it.play() }
    }

    fun seek(positionMs: Long) {
        cancelCrossfadeLocked()
        runOnPlayer {
            it.volume = volume
            it.seekTo(positionMs.coerceAtLeast(0L))
        }
    }

    fun setVolume(next: Float) {
        volume = next.coerceIn(0f, 1f)
        runOnPlayer { p ->
            // Mid-crossfade the ramp loop owns both players' volumes and will
            // rescale them with the new user volume on its next tick.
            if (crossfadeTrackId == null) p.volume = volume
        }
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
        }
    }

    private fun releaseReverb() {
        try { reverb?.release() } catch (_: Exception) {}
        reverb = null
    }

    fun stop() = runOnPlayer {
        cancelCrossfadeLocked()
        playWhenReadyIntent = false
        it.volume = volume
        it.stop()
        it.clearMediaItems()
        currentTrackId = null
        loadedDurationMs = 0L
        lastError = null
        usingCache = false
        updateState()
    }

    fun setSleepAt(deadlineEpochMs: Long) {
        cancelSleep()
        if (deadlineEpochMs <= 0L) return
        sleepDeadlineMs = deadlineEpochMs
        val delay = (deadlineEpochMs - System.currentTimeMillis()).coerceAtLeast(0L)
        val runnable = Runnable {
            sleepRunnable = null
            sleepDeadlineMs = 0L
            playWhenReadyIntent = false
            player?.pause()
            updateState()
            NativeEvents.emit("sleepTimerFired", "{}")
        }
        sleepRunnable = runnable
        main.postDelayed(runnable, delay)
    }

    private fun cancelSleep() {
        sleepRunnable?.let { main.removeCallbacks(it) }
        sleepRunnable = null
        sleepDeadlineMs = 0L
    }

    fun sleepDeadlineMs(): Long = sleepDeadlineMs

    // ---------------------------------------------------------------------
    // Overlapping crossfade
    //
    // JS resolves the incoming song's stream and hands it over with
    // crossfadeLoad (prepared on a hidden second ExoPlayer at volume 0), then
    // crossfadeStart(durationMs) runs the blend natively: equal-power volume
    // ramps on both players plus a band-scoop EQ sweep that morphs the
    // outgoing song out and opens the incoming one up — the DJ effect. The
    // ramp runs on the main Handler so it survives the screen turning off and
    // the app being backgrounded. At the end the transition player is
    // promoted to main (MediaSession follows via LinerForwardingPlayer) and a
    // crossfadeCompleted event tells JS to advance its queue without
    // reloading the now-playing track.
    // ---------------------------------------------------------------------

    /**
     * Prepares the incoming song on the transition player, silently. The
     * player takes the service's data-source factory (same redirects/headers
     * as main) and deliberately does NOT request audio focus — main holds it.
     */
    fun crossfadeLoad(context: Context, payloadJson: String) {
        ensureService(context)
        main.post {
            cancelCrossfadeLocked()
            val svc = service ?: return@post
            try {
                val payload = JSONObject(payloadJson)
                val url = payload.optString("url")
                val trackId = payload.optString("trackId")
                if (url.isBlank() || trackId.isBlank()) return@post

                val cached: File? = AudioCache.find(trackId)
                val uri = if (cached != null) Uri.fromFile(cached) else Uri.parse(url)
                val resolvedMime = if (cached != null) AudioCache.mimeOf(cached)
                    else payload.optString("mimeType").ifBlank { null }
                val metadata = MediaMetadata.Builder()
                    .setTitle(payload.optString("title").ifBlank { null })
                    .setArtist(payload.optString("artist").ifBlank { null })
                    .setAlbumTitle(payload.optString("album").ifBlank { null })
                    .setArtworkUri(
                        payload.optString("coverUrl").takeIf { it.startsWith("http") }?.let(Uri::parse),
                    )
                    .build()
                val item = MediaItem.Builder()
                    .setUri(uri)
                    .setMediaMetadata(metadata)
                    .apply { if (resolvedMime != null) setMimeType(resolvedMime) }
                    .build()

                val transition = svc.buildCrossfadePlayer()
                transition.volume = 0f
                transition.setMediaItem(item, payload.optLong("startMs", 0L).coerceAtLeast(0L))
                transition.playWhenReady = true // audible only through volume
                transition.prepare()
                transitionPlayer = transition
                crossfadeTrackId = trackId
            } catch (error: Exception) {
                lastError = "crossfade load failed: " + (error.message ?: "invalid payload")
                cancelCrossfadeLocked()
            }
        }
    }

    /** Starts (or restarts) the blend once the transition player is ready. */
    fun crossfadeStart(durationMs: Long) {
        main.post {
            if (transitionPlayer == null || player == null || durationMs <= 0L) {
                cancelCrossfadeLocked()
                return@post
            }
            crossfadeEpoch += 1
            val epoch = crossfadeEpoch
            crossfadeDurationMs = durationMs
            crossfadeStartedAt = 0L
            lastEqSweepAt = 0L

            val waitReady = object : Runnable {
                var waitedMs = 0L
                override fun run() {
                    if (epoch != crossfadeEpoch) return
                    val transition = transitionPlayer ?: return
                    val ready = transition.isPlaying ||
                        transition.playbackState == Player.STATE_READY
                    if (!ready) {
                        if (waitedMs < 5_000L) {
                            waitedMs += 50L
                            main.postDelayed(this, 50L)
                        } else {
                            cancelCrossfadeLocked() // fall back to the sequential path
                        }
                        return
                    }
                    crossfadeStartedAt = System.currentTimeMillis()
                    scheduleRampTick(epoch)
                }
            }
            main.post(waitReady)
        }
    }

    fun crossfadeCancel() = main.post { cancelCrossfadeLocked() }

    private fun scheduleRampTick(epoch: Int) {
        crossfadeRunnable?.let { main.removeCallbacks(it) }
        val tick = Runnable { runRampTick(epoch) }
        crossfadeRunnable = tick
        main.postDelayed(tick, 16L)
    }

    private fun runRampTick(epoch: Int) {
        if (epoch != crossfadeEpoch) return
        val mainPlayer = player ?: return
        val transition = transitionPlayer ?: return
        val elapsed = System.currentTimeMillis() - crossfadeStartedAt
        val t = (elapsed.toFloat() / crossfadeDurationMs.toFloat()).coerceIn(0f, 1f)

        // Equal-power blend scaled by the user volume.
        val angle = t * Math.PI.toFloat() / 2f
        mainPlayer.volume = volume * kotlin.math.cos(angle)
        transition.volume = volume * kotlin.math.sin(angle)
        sweepEqualizers(t, elapsed)

        if (t >= 1f) {
            promoteCrossfade(epoch)
            return
        }
        scheduleRampTick(epoch)
    }

    /**
     * The effect half of the transition: the outgoing song loses its highs
     * first and its bass last (a filter-morph feel), while the incoming song
     * starts scooped and opens up just before the blend completes.
     */
    private fun sweepEqualizers(t: Float, elapsed: Long) {
        if (elapsed - lastEqSweepAt < 80L) return
        lastEqSweepAt = elapsed

        equalizerFor(player, isMain = true)?.let { eq ->
            val high = eq.numberOfBands - 1
            setBand(eq, high, -1400f * (t * 1.6f).coerceAtMost(1f))
            if (high > 0) setBand(eq, high - 1, -1200f * (t * 1.6f).coerceAtMost(1f))
            setBand(eq, 0, -1600f * ((t - 0.55f) / 0.45f).coerceIn(0f, 1f))
        }
        equalizerFor(transitionPlayer, isMain = false)?.let { eq ->
            val open = (t / 0.85f).coerceAtMost(1f)
            val high = eq.numberOfBands - 1
            setBand(eq, 0, -1000f * (1f - open))
            setBand(eq, high, -1200f * (1f - open))
            if (high > 1) setBand(eq, high / 2, -300f * (1f - open))
        }
    }

    private fun equalizerFor(target: ExoPlayer?, isMain: Boolean): Equalizer? {
        if (target == null) return null
        val existing = if (isMain) mainEqualizer else transitionEqualizer
        if (existing != null) return existing
        val sessionId = target.audioSessionId
        if (sessionId == C.AUDIO_SESSION_ID_UNSET || sessionId == 0) return null
        return try {
            val eq = Equalizer(1000, sessionId).apply { enabled = true }
            if (isMain) mainEqualizer = eq else transitionEqualizer = eq
            eq
        } catch (_: Exception) {
            null
        }
    }

    private fun setBand(eq: Equalizer, band: Int, millibel: Float) {
        try {
            val range = eq.bandLevelRange
            val clamped = millibel.toInt().coerceIn(range[0].toInt(), range[1].toInt())
            eq.setBandLevel(band.coerceIn(0, eq.numberOfBands - 1).toShort(), clamped.toShort())
        } catch (_: Exception) {
        }
    }

    /** Hands the session and all state over to the transition player, gapless. */
    private fun promoteCrossfade(epoch: Int) {
        if (epoch != crossfadeEpoch) return
        val mainPlayer = player ?: return
        val transition = transitionPlayer ?: return
        val promotedId = crossfadeTrackId

        crossfadeEpoch += 1
        crossfadeRunnable?.let { main.removeCallbacks(it) }
        crossfadeRunnable = null

        try { mainPlayer.removeListener(playerListener) } catch (_: Exception) {}
        try {
            mainEqualizer?.enabled = false
            mainEqualizer?.release()
        } catch (_: Exception) {}
        mainEqualizer = transitionEqualizer
        transitionEqualizer = null

        transition.volume = volume
        transition.addListener(playerListener)
        player = transition
        currentTrackId = promotedId ?: currentTrackId
        val duration = transition.duration
        if (duration > 0 && duration != C.TIME_UNSET) loadedDurationMs = duration
        lastError = null

        // Hand the session (notification, lock screen, other controllers) to
        // the promoted player through a fresh command-wiring wrapper.
        val promotedSessionPlayer = LinerForwardingPlayer(transition)
        sessionPlayer = promotedSessionPlayer
        try { session?.setPlayer(promotedSessionPlayer) } catch (_: Exception) {}
        transitionPlayer = null
        crossfadeTrackId = null

        try { mainPlayer.stop(); mainPlayer.clearMediaItems() } catch (_: Exception) {}
        try { mainPlayer.release() } catch (_: Exception) {}

        updateState()
        promotedId?.let { NativeEvents.emit("crossfadeCompleted", JSONObject.quote(it)) }
    }

    private fun cancelCrossfadeLocked() {
        crossfadeEpoch += 1
        crossfadeRunnable?.let { main.removeCallbacks(it) }
        crossfadeRunnable = null
        crossfadeTrackId = null
        transitionPlayer?.let { transition ->
            try { transition.stop() } catch (_: Exception) {}
            try { transition.release() } catch (_: Exception) {}
        }
        transitionPlayer = null
        try { transitionEqualizer?.release() } catch (_: Exception) {}
        transitionEqualizer = null
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

    private fun describePlaybackError(error: PlaybackException): String {
        val cause = error.cause
        val builder = StringBuilder(error.errorCodeName)
        if (cause != null) {
            builder.append(": ").append(cause.javaClass.simpleName)
            cause.message?.takeIf { it.isNotBlank() }?.let { builder.append(" ").append(it) }
            if (cause is androidx.media3.datasource.HttpDataSource.InvalidResponseCodeException) {
                builder.append(" (HTTP ").append(cause.responseCode).append(", ")
                builder.append(cause.dataSpec?.uri?.host ?: "unknown host").append(")")
                val body = cause.responseBody
                if (body.isNotEmpty()) {
                    val text = String(body, 0, minOf(body.size, 220), Charsets.UTF_8)
                        .replace(Regex("\\s+"), " ")
                        .trim()
                    if (text.isNotEmpty()) builder.append(" | ").append(text)
                }
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
