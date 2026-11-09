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
import org.json.JSONArray
import java.io.File

object PlaybackHolder {
    private val main = Handler(Looper.getMainLooper())
    @Volatile private var player: ExoPlayer? = null
    @Volatile private var session: MediaSession? = null
    @Volatile var service: PlaybackService? = null
        internal set

    private var pendingLoad: String? = null
    // Pre-resolved upcoming queue, pushed by JS while the app is in the
    // foreground. Native owns advancement from here so queue walking,
    // error-skipping and crossfade keep working when the WebView is frozen.
    private val queueLock = Any()
    private val nextQueue = ArrayDeque<String>()
    @Volatile private var queueAutoAdvance = false
    @Volatile private var previousTrackPayload: String? = null
    private val history = ArrayDeque<String>()
    @Volatile private var currentPayload: String? = null
    @Volatile private var crossfadeEnabled = false
    @Volatile private var crossfadeWindowMs = 8_000L
    // "off" | "all" | "one" — mirrors the JS repeat mode so looping keeps
    // working with the WebView frozen.
    @Volatile private var repeatMode = "off"
    @Volatile private var loopFirstPayload: String? = null
    private var consecutiveErrors = 0
    private var pendingActions = mutableListOf<() -> Unit>()

    @Volatile private var volume = 1f
    @Volatile private var speed = 1f
    @Volatile private var pitch = 1f
    @Volatile private var reverbLevel = 0f
    private var reverb: PresetReverb? = null
    private var reverbSessionId = C.AUDIO_SESSION_ID_UNSET

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
    @Volatile private var equalizerEnabled = false
    @Volatile private var equalizerGains = FloatArray(5)
    private val equalizerFrequencies = floatArrayOf(60f, 230f, 910f, 3600f, 14000f)

    private val playerListener = object : Player.Listener {
        override fun onPlaybackStateChanged(playbackState: Int) {
            if (playbackState == Player.STATE_ENDED) {
                // During a crossfade the blend's completion — not the outgoing
                // player's end — drives the queue advance.
                if (crossfadeTrackId == null) {
                    val id = currentTrackId
                    if (id != null) {
                        val next = consumeNextLocked() ?: peekNextLocked()
                        if (next != null && playWhenReadyIntent && queueAutoAdvance) {
                            consumeNextLocked()
                            previousTrackPayload = null
                            main.post {
                                if (currentTrackId != id || player?.playbackState != Player.STATE_ENDED) {
                                    return@post
                                }
                                val nextId = try {
                                    JSONObject(next).optString("trackId").takeIf { it.isNotBlank() }
                                } catch (_: Exception) {
                                    null
                                }
                                applyLoad(next)
                                if (nextId != null && currentTrackId == nextId) {
                                    NativeEvents.emit(
                                        "playbackAutoAdvanced",
                                        JSONObject().put("trackId", nextId).toString(),
                                    )
                                }
                            }
                        } else if (repeatMode == "one" && playWhenReadyIntent) {
                            main.post {
                                if (currentTrackId != id) return@post
                                player?.seekTo(0L)
                                player?.play()
                                NativeEvents.emit(
                                    "playbackAutoAdvanced",
                                    JSONObject().put("trackId", id).toString(),
                                )
                            }
                        } else if (repeatMode == "all" && playWhenReadyIntent && loopFirstPayload != null) {
                            val first = loopFirstPayload!!
                            main.post {
                                if (currentTrackId != id) return@post
                                applyLoad(first)
                                val firstId = try { JSONObject(first).optString("trackId").takeIf { it.isNotBlank() } } catch (_: Exception) { null }
                                if (firstId != null && currentTrackId == firstId) {
                                    NativeEvents.emit("playbackAutoAdvanced", JSONObject().put("trackId", firstId).toString())
                                }
                            }
                        } else {
                            NativeEvents.emit("playbackEnded", JSONObject.quote(id))
                        }
                    }
                }
            }
            updateState()
        }

        override fun onIsPlayingChanged(isPlaying: Boolean) {
            if (isPlaying) consecutiveErrors = 0
            updateState()
        }

        override fun onPlayerError(error: PlaybackException) {
            val failedTrackId = currentTrackId
            lastError = describePlaybackError(error)
            consecutiveErrors += 1
            // Skip unavailable / undecodable tracks without JS. Consecutive
            // errors only stop at the cap, so a bad track never wedges the
            // queue while the WebView is frozen.
            val canSkip = playWhenReadyIntent && failedTrackId != null && queueAutoAdvance && consecutiveErrors <= 10
            val next = if (canSkip) consumeNextLocked() else null
            if (next != null && failedTrackId != null) {
                main.post {
                    if (currentTrackId != failedTrackId || !playWhenReadyIntent) return@post
                    cancelCrossfadeLocked()
                    applyLoad(next)
                    emitTrackChange("playbackAutoAdvanced", next)
                }
                return
            }
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

    fun togglePlayback() {
        if (player?.isPlaying == true) pause() else resume()
    }

    fun setNextTrack(payload: String?, autoAdvance: Boolean) {
        val validated = validateTrackPayload(payload)
        main.post {
            synchronized(queueLock) {
                nextQueue.clear()
                if (validated != null) nextQueue.addLast(validated)
            }
            queueAutoAdvance = autoAdvance
        }
    }

    fun setNextQueue(payloadsJson: String?, autoAdvance: Boolean) {
        val payloads = mutableListOf<String>()
        if (!payloadsJson.isNullOrBlank()) {
            try {
                val arr = org.json.JSONArray(payloadsJson)
                for (i in 0 until arr.length()) {
                    val raw = arr.optString(i)
                    validateTrackPayload(raw)?.let { payloads.add(it) }
                }
            } catch (_: Exception) {
            }
        }
        main.post {
            synchronized(queueLock) {
                nextQueue.clear()
                nextQueue.addAll(payloads)
            }
            queueAutoAdvance = autoAdvance
        }
    }

    fun setCrossfade(enabled: Boolean, windowMs: Long) {
        crossfadeEnabled = enabled
        crossfadeWindowMs = windowMs.coerceIn(2_000L, 12_000L)
    }

    fun setLoopState(mode: String, firstPayload: String?) {
        repeatMode = when (mode.trim().lowercase()) { "one" -> "one"; "all" -> "all"; else -> "off" }
        loopFirstPayload = validateTrackPayload(firstPayload)
    }

    private fun peekNextLocked(): String? = synchronized(queueLock) { nextQueue.firstOrNull() }

    private fun consumeNextLocked(): String? = synchronized(queueLock) {
        if (nextQueue.isEmpty()) null else nextQueue.removeFirst()
    }

    private fun removeFromNextQueue(trackId: String?) {
        if (trackId == null) return
        synchronized(queueLock) {
            val it = nextQueue.iterator()
            while (it.hasNext()) {
                val raw = it.next()
                val id = try { JSONObject(raw).optString("trackId") } catch (_: Exception) { null }
                if (id == trackId) it.remove()
            }
        }
    }

    fun setPreviousTrack(payload: String?) {
        previousTrackPayload = validateTrackPayload(payload)
    }

    private fun validateTrackPayload(payload: String?): String? =
        payload?.takeIf { raw ->
            try {
                val json = JSONObject(raw)
                json.optString("trackId").isNotBlank() && json.optString("url").startsWith("http")
            } catch (_: Exception) {
                false
            }
        }

    fun skipToNext() {
        val next = consumeNextLocked()
        if (next != null) {
            previousTrackPayload = null
            runOnPlayer {
                cancelCrossfadeLocked()
                applyLoad(next)
                emitTrackChange("playbackNextAdvanced", next)
            }
        } else {
            NativeEvents.emit("mediaCommand", "{\"command\":\"next\"}")
        }
    }

    fun skipToPrevious() {
        runOnPlayer { current ->
            if (current.currentPosition > 3_000L) {
                current.seekTo(0L)
            } else {
                val previous = synchronized(queueLock) {
                    if (history.isNotEmpty()) history.removeLast() else null
                } ?: previousTrackPayload
                if (previous != null) {
                    previousTrackPayload = null
                    synchronized(queueLock) { nextQueue.clear() }
                    applyLoad(previous)
                    emitTrackChange("playbackPreviousAdvanced", previous)
                } else {
                    current.seekTo(0L)
                }
            }
        }
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

    fun setEqualizer(enabled: Boolean, gainsJson: String) {
        val parsed = try {
            val values = JSONArray(gainsJson)
            FloatArray(equalizerFrequencies.size) { index ->
                if (index < values.length()) values.optDouble(index, 0.0).toFloat().coerceIn(-12f, 12f)
                else 0f
            }
        } catch (_: Exception) {
            return
        }
        equalizerEnabled = enabled
        equalizerGains = parsed
        runOnPlayer {
            if (enabled) equalizerFor(it, isMain = true)
            applyEqualizerSettings()
        }
    }

    private fun applyEqualizerSettings() {
        listOf(mainEqualizer, transitionEqualizer).forEach { eq ->
            if (eq == null) return@forEach
            try {
                eq.enabled = equalizerEnabled || crossfadeTrackId != null
                for (band in 0 until eq.numberOfBands.toInt()) setBand(eq, band, 0f)
            } catch (_: Exception) {
            }
        }
    }

    private fun ensureReverb(p: ExoPlayer) {
        if (reverbLevel <= 0.01f) {
            try { reverb?.enabled = false } catch (_: Exception) {}
            return
        }
        val sessionId = p.audioSessionId
        if (sessionId == C.AUDIO_SESSION_ID_UNSET || sessionId == 0) return
        // The player may be recreated (or recover with a new session), which
        // leaves an old PresetReverb attached to a dead audio session.
        if (reverb != null && reverbSessionId != sessionId) releaseReverb()
        if (reverb == null) {
            try {
                reverb = PresetReverb(0, sessionId).apply { enabled = true }
                reverbSessionId = sessionId
            } catch (_: Exception) {
                reverb = null
                reverbSessionId = C.AUDIO_SESSION_ID_UNSET
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
        reverbSessionId = C.AUDIO_SESSION_ID_UNSET
    }

    fun stop() = runOnPlayer {
        cancelCrossfadeLocked()
        playWhenReadyIntent = false
        synchronized(queueLock) { nextQueue.clear(); history.clear() }
        queueAutoAdvance = false
        previousTrackPayload = null
        currentPayload = null
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
            val payload = try { JSONObject(payloadJson) } catch (_: Exception) { null }
            val requestedTrackId = payload
                ?.optString("trackId")
                ?.takeIf { it.isNotBlank() }
            if (requestedTrackId != null) crossfadeTrackId = requestedTrackId
            val svc = service ?: run {
                // Emit via cancel so JS can fall back to the sequential path.
                cancelCrossfadeLocked()
                return@post
            }
            try {
                if (payload == null) {
                    cancelCrossfadeLocked()
                    return@post
                }
                val url = payload.optString("url")
                val trackId = requestedTrackId
                if (url.isBlank() || trackId == null) {
                    cancelCrossfadeLocked()
                    return@post
                }

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

    /**
     * Native crossfade watchdog, driven from the service ticker (not the
     * WebView). When JS is frozen in background, the JS poll that used to
     * arm blends never runs — this watches the real remaining time and
     * blends into the queued next track entirely natively.
     */
    private fun maybeStartNativeCrossfade() {
        if (!crossfadeEnabled || crossfadeTrackId != null || transitionPlayer != null) return
        if (!playWhenReadyIntent || !queueAutoAdvance) return
        val p = player ?: return
        if (!p.isPlaying) return
        val next = peekNextLocked() ?: return
        val duration = p.duration.takeIf { it > 0 && it != C.TIME_UNSET } ?: loadedDurationMs
        if (duration <= 0L) return
        val remaining = duration - p.currentPosition
        if (remaining <= 0L || remaining > 12_000L) return
        val nextDuration = try { JSONObject(next).optLong("durationMs", 0L) } catch (_: Exception) { 0L }
        var window = minOf(crossfadeWindowMs, remaining)
        if (nextDuration > 2_000L) window = minOf(window, nextDuration - 2_000L)
        if (window < 2_000L) return
        // Reuse the JS entry points so a foreground blend and a background
        // blend share the exact load/ready/promote path.
        crossfadeLoad(service ?: return, next)
        main.postDelayed({ crossfadeStart(window) }, 50L)
        logReady(window, remaining)
    }

    private fun logReady(window: Long, remaining: Long) {
        // keep stdlib-only; failures here must never break playback
    }

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
            applyEqualizerSettings()
            eq
        } catch (_: Exception) {
            null
        }
    }

    private fun setBand(eq: Equalizer, band: Int, millibel: Float) {
        try {
            val range = eq.bandLevelRange
            val centerHz = eq.getCenterFreq(band.coerceIn(0, eq.numberOfBands - 1).toShort()) / 1000f
            val profileIndex = equalizerFrequencies.indices.minByOrNull { index ->
                kotlin.math.abs(kotlin.math.ln(centerHz.coerceAtLeast(1f) / equalizerFrequencies[index]))
            } ?: 0
            val profileGain = if (equalizerEnabled) equalizerGains[profileIndex] * 1000f else 0f
            val clamped = (millibel + profileGain).toInt().coerceIn(range[0].toInt(), range[1].toInt())
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
        removeFromNextQueue(promotedId)
        if (previousTrackPayload?.let {
                try { JSONObject(it).optString("trackId") == promotedId } catch (_: Exception) { false }
            } == true
        ) {
            previousTrackPayload = null
        }
        applyEqualizerSettings()

        try { mainPlayer.stop(); mainPlayer.clearMediaItems() } catch (_: Exception) {}
        try { mainPlayer.release() } catch (_: Exception) {}

        updateState()
        promotedId?.let { NativeEvents.emit("crossfadeCompleted", JSONObject.quote(it)) }
    }

    private fun cancelCrossfadeLocked() {
        crossfadeEpoch += 1
        crossfadeRunnable?.let { main.removeCallbacks(it) }
        crossfadeRunnable = null
        val cancelledId = crossfadeTrackId
        crossfadeTrackId = null
        // A cancelled blend may have left the outgoing player mid-ramp.
        player?.volume = volume
        applyEqualizerSettings()
        transitionPlayer?.let { transition ->
            try { transition.stop() } catch (_: Exception) {}
            try { transition.release() } catch (_: Exception) {}
        }
        transitionPlayer = null
        try { transitionEqualizer?.release() } catch (_: Exception) {}
        transitionEqualizer = null
        // If a blend was armed but could not start (or was cancelled natively),
        // tell JS so it does not keep suppressing future crossfades.
        cancelledId?.let { NativeEvents.emit("crossfadeCancelled", JSONObject.quote(it)) }
    }

    private fun applyLoad(json: String) {
        val p = player ?: run { pendingLoad = json; return }
        try {
            val payload = JSONObject(json)
            val url = payload.optString("url")
            val trackId = payload.optString("trackId")
            if (url.isBlank() || trackId.isBlank()) return
            removeFromNextQueue(trackId)
            // Remember the outgoing track so Previous works in background
            // even when JS never pushed a previous payload.
            val outgoing = currentPayload
            val outgoingId = try { outgoing?.let { JSONObject(it).optString("trackId") } } catch (_: Exception) { null }
            if (outgoing != null && outgoingId != null && outgoingId != trackId) {
                synchronized(queueLock) {
                    history.addLast(outgoing)
                    while (history.size > 50) history.removeFirst()
                }
            }

            if (previousTrackPayload?.let {
                    try { JSONObject(it).optString("trackId") == trackId } catch (_: Exception) { false }
                } == true
            ) {
                previousTrackPayload = null
            }
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

            currentPayload = json
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

    private fun emitTrackChange(event: String, payload: String) {
        val trackId = try {
            JSONObject(payload).optString("trackId").takeIf { it.isNotBlank() }
        } catch (_: Exception) {
            null
        } ?: return
        NativeEvents.emit(event, JSONObject().put("trackId", trackId).toString())
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
                maybeStartNativeCrossfade()
                updateState()
                val p = player
                if (equalizerEnabled && p != null && mainEqualizer == null) {
                    equalizerFor(p, isMain = true)
                }
                if (p != null && reverbLevel > 0.01f && (reverb == null || reverbSessionId != p.audioSessionId)) ensureReverb(p)
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
