package app.tryliner.android

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.view.KeyEvent
import androidx.core.app.NotificationCompat
import androidx.media.app.NotificationCompat.MediaStyle
import android.support.v4.media.session.MediaSessionCompat
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.Player
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.session.DefaultMediaNotificationProvider
import androidx.media3.session.MediaSession
import androidx.media3.session.MediaSessionService
import java.util.concurrent.Executors

/**
 * Foreground media service. ExoPlayer handles audio focus, headphone unplug,
 * buffering, stream errors and metadata; MediaSession exposes the lock screen,
 * Bluetooth and Android Auto controllers while this service renders the media
 * notification itself so track info and controls are always present.
 */
class PlaybackService : MediaSessionService() {
    private var player: ExoPlayer? = null
    private var session: MediaSession? = null
    private val handler = Handler(Looper.getMainLooper())
    private var idleCheck: Runnable? = null
    private val artworkExecutor = Executors.newSingleThreadExecutor()
    private val artworkCache = HashMap<String, Bitmap>()
    @Volatile private var currentArtwork: Bitmap? = null
    @Volatile private var currentArtworkUrl: String? = null

    override fun onCreate() {
        super.onCreate()
        PlaybackHolder.service = this

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val manager = getSystemService(NotificationManager::class.java)
            if (manager.getNotificationChannel(NOTIFICATION_CHANNEL_ID) == null) {
                manager.createNotificationChannel(
                    NotificationChannel(
                        NOTIFICATION_CHANNEL_ID,
                        getString(R.string.playback_channel_name),
                        NotificationManager.IMPORTANCE_LOW,
                    ).apply {
                        description = getString(R.string.playback_channel_description)
                        setShowBadge(false)
                    },
                )
            }
        }

        val audioAttributes = AudioAttributes.Builder()
            .setUsage(C.USAGE_MEDIA)
            .setContentType(C.AUDIO_CONTENT_TYPE_MUSIC)
            .build()

        // Streaming CDNs hand out cross-protocol redirects and expect a normal
        // player user agent, so the data source is configured explicitly.
        // googlevideo answers HTTP 403 to a request without a Range header, and
        // ExoPlayer omits Range on its first (position 0) request, so a default
        // is provided here; real range requests still override it while seeking.
        val httpDataSourceFactory = DefaultHttpDataSource.Factory()
            .setUserAgent(Http.userAgent)
            .setConnectTimeoutMs(20_000)
            .setReadTimeoutMs(45_000)
            .setAllowCrossProtocolRedirects(true)
            .setDefaultRequestProperties(
                mapOf(
                    "Accept-Language" to "en-US,en;q=0.9",
                    "Range" to "bytes=0-",
                ),
            )

        // Cached downloads are played back as file:// URIs, so the resolving data
        // source is required instead of the HTTP-only one.
        val dataSourceFactory = DefaultDataSource.Factory(this, httpDataSourceFactory)

        val exoPlayer = ExoPlayer.Builder(this)
            .setMediaSourceFactory(DefaultMediaSourceFactory(dataSourceFactory))
            .setAudioAttributes(audioAttributes, /* handleAudioFocus = */ true)
            .setHandleAudioBecomingNoisy(true)
            .setWakeMode(C.WAKE_MODE_NETWORK)
            .setSeekBackIncrementMs(5_000)
            .setSeekForwardIncrementMs(5_000)
            .build()
        player = exoPlayer

        val forwarding = LinerForwardingPlayer(exoPlayer)
        val mediaSession = MediaSession.Builder(this, forwarding)
            .setCallback(object : MediaSession.Callback {
                override fun onMediaButtonEvent(
                    session: MediaSession,
                    controllerInfo: MediaSession.ControllerInfo,
                    intent: Intent,
                ): Boolean {
                    if (intent.action == Intent.ACTION_MEDIA_BUTTON) {
                        @Suppress("DEPRECATION")
                        val event = intent.getParcelableExtra<KeyEvent>(Intent.EXTRA_KEY_EVENT)
                        when (event?.keyCode) {
                            KeyEvent.KEYCODE_MEDIA_NEXT -> {
                                emitMediaCommand("next")
                                return true
                            }
                            KeyEvent.KEYCODE_MEDIA_PREVIOUS -> {
                                emitMediaCommand("previous")
                                return true
                            }
                        }
                    }
                    return super.onMediaButtonEvent(session, controllerInfo, intent)
                }
            })
            .build()
        session = mediaSession

        val launchIntent = packageManager.getLaunchIntentForPackage(packageName)
        val pendingIntent = if (launchIntent != null) {
            PendingIntent.getActivity(
                this,
                0,
                launchIntent,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
        } else {
            null
        }
        if (pendingIntent != null) {
            mediaSession.setSessionActivity(pendingIntent)
        }

        // Media3 keeps its provider for the cases where it posts the notification
        // itself (for example after a MediaController reconnect); it uses the same
        // id and channel as the notification built here.
        val notificationProvider = DefaultMediaNotificationProvider.Builder(this)
            .setChannelId(NOTIFICATION_CHANNEL_ID)
            .setChannelName(R.string.playback_channel_name)
            .setNotificationId(NOTIFICATION_ID)
            .build()
        notificationProvider.setSmallIcon(R.drawable.ic_notification)
        setMediaNotificationProvider(notificationProvider)

        PlaybackHolder.attach(this, exoPlayer, mediaSession)
    }

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaSession? = session

    /**
     * A track load starts this service before the stream is ready, so the service
     * must satisfy the five second foreground contract itself. The notification
     * built here is the real media notification (track, artist, controls) and is
     * refreshed whenever playback state or metadata changes.
     */
    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_PREVIOUS -> emitMediaCommand("previous")
            ACTION_NEXT -> emitMediaCommand("next")
            ACTION_TOGGLE -> togglePlayback()
        }
        if (intent?.getBooleanExtra(EXTRA_PROMOTE_TO_FOREGROUND, false) == true) {
            promoteToForeground()
        }
        val result = super.onStartCommand(intent, flags, startId)
        scheduleIdleStop()
        return result
    }

    private fun togglePlayback() {
        val current = player ?: return
        if (current.isPlaying) current.pause() else current.play()
        refreshNotification()
    }

    private fun promoteToForeground() {
        try {
            startForeground(NOTIFICATION_ID, buildNotification())
        } catch (_: Exception) {
            // startForeground can only fail if the process is already dying.
        }
    }

    /** Re-renders the notification from the current player state. */
    fun refreshNotification() {
        val current = player ?: return
        if (current.mediaItemCount == 0) return
        try {
            val manager = getSystemService(NotificationManager::class.java)
            manager.notify(NOTIFICATION_ID, buildNotification())
        } catch (_: Exception) {
            // Notification updates are best effort.
        }
        loadArtwork(current.mediaMetadata.artworkUri?.toString())
    }

    private fun buildNotification(): android.app.Notification {
        val current = player
        val metadata = current?.mediaMetadata
        val title = metadata?.title?.toString()?.takeIf { it.isNotBlank() }
            ?: getString(R.string.app_name)
        val artist = metadata?.artist?.toString()?.takeIf { it.isNotBlank() }
            ?: getString(R.string.playback_preparing)
        val playing = current?.isPlaying == true

        val launchIntent = packageManager.getLaunchIntentForPackage(packageName)
        val contentIntent = launchIntent?.let {
            PendingIntent.getActivity(
                this,
                0,
                it,
                PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
            )
        }

        val builder = NotificationCompat.Builder(this, NOTIFICATION_CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_notification)
            .setContentTitle(title)
            .setContentText(artist)
            .setOnlyAlertOnce(true)
            .setShowWhen(false)
            .setSilent(true)
            .setOngoing(playing)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .addAction(
                R.drawable.ic_skip_prev,
                getString(R.string.notification_previous),
                serviceIntent(ACTION_PREVIOUS, 1),
            )
            .addAction(
                if (playing) R.drawable.ic_pause else R.drawable.ic_play,
                getString(if (playing) R.string.notification_pause else R.string.notification_play),
                serviceIntent(ACTION_TOGGLE, 2),
            )
            .addAction(
                R.drawable.ic_skip_next,
                getString(R.string.notification_next),
                serviceIntent(ACTION_NEXT, 3),
            )

        if (contentIntent != null) builder.setContentIntent(contentIntent)
        currentArtwork?.let { builder.setLargeIcon(it) }

        val mediaSession = session
        if (mediaSession != null) {
            builder.setStyle(
                MediaStyle()
                    .setMediaSession(MediaSessionCompat.Token.fromToken(mediaSession.platformToken))
                    .setShowActionsInCompactView(0, 1, 2),
            )
        }
        return builder.build()
    }

    private fun serviceIntent(action: String, requestCode: Int): PendingIntent =
        PendingIntent.getService(
            this,
            requestCode,
            Intent(this, PlaybackService::class.java).setAction(action),
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE,
        )

    /**
     * Artwork is decoded off the main thread and cached per URL; a refresh is
     * posted once so the notification picks the cover up when it is ready.
     */
    private fun loadArtwork(url: String?) {
        if (url == null || url == currentArtworkUrl) return
        currentArtworkUrl = url
        val cached = artworkCache[url]
        if (cached != null) {
            currentArtwork = cached
            postArtworkRefresh()
            return
        }
        artworkExecutor.execute {
            val bitmap = try {
                val request = okhttp3.Request.Builder().url(url).build()
                Http.client.newCall(request).execute().use { response ->
                    if (!response.isSuccessful) return@use null
                    response.body?.byteStream()?.use { stream ->
                        BitmapFactory.decodeStream(stream)
                    }
                }
            } catch (_: Exception) {
                null
            }
            if (bitmap == null) return@execute
            if (artworkCache.size > 12) artworkCache.clear()
            artworkCache[url] = bitmap
            if (currentArtworkUrl == url) {
                currentArtwork = bitmap
                postArtworkRefresh()
            }
        }
    }

    private fun postArtworkRefresh() {
        handler.post { refreshNotification() }
    }

    private fun emitMediaCommand(command: String) {
        NativeEvents.emit("mediaCommand", "{\"command\":\"$command\"}")
    }

    /** Releases the service again when a load never turned into real playback. */
    private fun scheduleIdleStop() {
        idleCheck?.let { handler.removeCallbacks(it) }
        val check = Runnable {
            val current = player
            if (current == null || (!current.isPlaying && current.playbackState != Player.STATE_BUFFERING)) {
                stopSelf()
            }
        }
        idleCheck = check
        handler.postDelayed(check, IDLE_STOP_DELAY_MS)
    }

    override fun onTaskRemoved(rootIntent: Intent?) {
        // Keep playing when the task is swiped away only while audio is active.
        if (player?.playWhenReady != true) {
            stopSelf()
        }
        super.onTaskRemoved(rootIntent)
    }

    override fun onDestroy() {
        idleCheck?.let { handler.removeCallbacks(it) }
        idleCheck = null
        val currentPlayer = player
        if (currentPlayer != null) {
            PlaybackHolder.detach(currentPlayer)
        }
        session?.release()
        session = null
        currentPlayer?.release()
        player = null
        artworkExecutor.shutdownNow()
        artworkCache.clear()
        super.onDestroy()
    }

    companion object {
        const val NOTIFICATION_CHANNEL_ID = "liner_playback"
        const val NOTIFICATION_ID = 1102
        const val EXTRA_PROMOTE_TO_FOREGROUND = "app.tryliner.android.extra.PROMOTE_FOREGROUND"
        private const val ACTION_TOGGLE = "app.tryliner.android.action.TOGGLE"
        private const val ACTION_NEXT = "app.tryliner.android.action.NEXT"
        private const val ACTION_PREVIOUS = "app.tryliner.android.action.PREVIOUS"
        private const val IDLE_STOP_DELAY_MS = 25_000L
    }
}
