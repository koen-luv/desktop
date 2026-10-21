package app.tryliner.android

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Intent
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.view.KeyEvent
import androidx.core.app.NotificationCompat
import androidx.media.app.NotificationCompat.MediaStyle
import android.support.v4.media.session.MediaSessionCompat
import androidx.media3.common.AudioAttributes
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.Player
import androidx.media3.datasource.DefaultDataSource
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.session.DefaultMediaNotificationProvider
import androidx.media3.session.LibraryResult
import androidx.media3.session.MediaLibraryService
import androidx.media3.session.MediaLibraryService.MediaLibrarySession
import androidx.media3.session.MediaSession
import com.google.common.collect.ImmutableList
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import com.google.common.util.concurrent.MoreExecutors
import org.json.JSONObject
import java.util.concurrent.Executors

/**
 * Foreground media service. ExoPlayer handles audio focus, headphone unplug,
 * buffering, stream errors and metadata; MediaSession exposes the lock screen,
 * Bluetooth and Android Auto controllers while this service renders the media
 * notification itself so track info and controls are always present.
 *
 * It is a [MediaLibraryService] so MediaBrowser clients (Android Auto, Android
 * TV, Bluetooth sources) can browse Recents/Playlists/Queue and search. The
 * browse tree is served from the WebView renderer through [AutoBrowse]; play
 * requests funnel into [MediaSession.Callback.onSetMediaItems], where URI-less
 * items are play intents that the renderer resolves with the real stream.
 */
class PlaybackService : MediaLibraryService() {
    private var player: ExoPlayer? = null
    private var session: MediaLibrarySession? = null
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
        val mediaSession = MediaLibrarySession.Builder(this, forwarding, libraryCallback)
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

    override fun onGetSession(controllerInfo: MediaSession.ControllerInfo): MediaLibrarySession? = session

    /**
     * Serves the browse tree to MediaBrowser clients. Roots and folders are
     * static; leaf content is queried from the renderer through [AutoBrowse]
     * and cached per served media id so [onGetItem] can answer synchronously.
     */
    private val libraryCallback = object : MediaLibrarySession.Callback {
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

        override fun onGetLibraryRoot(
            session: MediaLibrarySession,
            controllerInfo: MediaSession.ControllerInfo,
            params: MediaLibraryService.LibraryParams?,
        ): ListenableFuture<LibraryResult<MediaItem>> =
            Futures.immediateFuture(LibraryResult.ofItem(rootItem(), null))

        override fun onGetChildren(
            session: MediaLibrarySession,
            controllerInfo: MediaSession.ControllerInfo,
            mediaId: String,
            page: Int,
            pageSize: Int,
            params: MediaLibraryService.LibraryParams?,
        ): ListenableFuture<LibraryResult<ImmutableList<MediaItem>>> {
            when (mediaId) {
                AutoBrowse.ROOT_ID ->
                    return Futures.immediateFuture(LibraryResult.ofItemList(topLevelFolders(), null))
                AutoBrowse.RECENTS_ID ->
                    return rendererChildren(AutoBrowse.query("recents", ""))
                AutoBrowse.PLAYLISTS_ID ->
                    return rendererChildren(AutoBrowse.query("playlists", ""))
                AutoBrowse.QUEUE_ID ->
                    return rendererChildren(AutoBrowse.query("queue", ""))
            }
            if (mediaId.startsWith(AutoBrowse.PLAYLIST_PREFIX)) {
                return rendererChildren(
                    AutoBrowse.query("playlist", mediaId.removePrefix(AutoBrowse.PLAYLIST_PREFIX)),
                )
            }
            return Futures.immediateFuture(
                LibraryResult.ofItemList(ImmutableList.of(), null),
            )
        }

        override fun onGetItem(
            session: MediaLibrarySession,
            controllerInfo: MediaSession.ControllerInfo,
            mediaId: String,
        ): ListenableFuture<LibraryResult<MediaItem>> {
            val item = servedItem(mediaId)
                ?: if (mediaId == AutoBrowse.ROOT_ID) rootItem() else null
            return Futures.immediateFuture(
                if (item != null) {
                    LibraryResult.ofItem(item, null)
                } else {
                    LibraryResult.ofError(LibraryResult.RESULT_ERROR_BAD_VALUE)
                },
            )
        }

        override fun onSearch(
            session: MediaLibrarySession,
            controllerInfo: MediaSession.ControllerInfo,
            query: String,
            params: MediaLibraryService.LibraryParams?,
        ): ListenableFuture<LibraryResult<Void>> =
            Futures.transform(
                rendererSearch(query),
                { LibraryResult.ofVoid() },
                MoreExecutors.directExecutor(),
            )

        override fun onGetSearchResult(
            session: MediaLibrarySession,
            controllerInfo: MediaSession.ControllerInfo,
            query: String,
            page: Int,
            pageSize: Int,
            params: MediaLibraryService.LibraryParams?,
        ): ListenableFuture<LibraryResult<ImmutableList<MediaItem>>> {
            if (lastSearchQuery == query) {
                return Futures.immediateFuture(LibraryResult.ofItemList(lastSearchItems, null))
            }
            return rendererSearch(query)
        }

        /**
         * media3 converts Android Auto's playFromMediaId and playFromSearch
         * into a setMediaItems call: URI-less items carry the mediaId (or the
         * search query in requestMetadata) and are play intents for the
         * renderer, which owns stream resolution and the queue. Returning an
         * empty timeline acknowledges the intent without touching the real
         * player; the renderer loads the stream through the normal pipeline.
         * Controllers that pass real stream URIs keep the standard path.
         */
        override fun onSetMediaItems(
            session: MediaSession,
            controllerInfo: MediaSession.ControllerInfo,
            mediaItems: MutableList<MediaItem>,
            startIndex: Int,
            startPositionMs: Long,
        ): ListenableFuture<MediaSession.MediaItemsWithStartPosition> {
            if (mediaItems.isNotEmpty() && mediaItems.all { it.localConfiguration?.uri != null }) {
                return super.onSetMediaItems(
                    session,
                    controllerInfo,
                    mediaItems,
                    startIndex,
                    startPositionMs,
                )
            }
            val first = mediaItems.firstOrNull()
            val mediaId = first?.mediaId?.takeIf { it.isNotBlank() }
            val searchQuery = first?.requestMetadata?.searchQuery?.takeIf { it.isNotBlank() }
            val payload = JSONObject()
            when {
                mediaId != null -> payload.put("mediaId", mediaId)
                searchQuery != null -> payload.put("query", searchQuery)
                else -> return Futures.immediateFuture(emptyTimeline())
            }
            AutoBrowse.play(payload)
            return Futures.immediateFuture(emptyTimeline())
        }
    }

    private fun rootItem(): MediaItem =
        MediaItem.Builder()
            .setMediaId(AutoBrowse.ROOT_ID)
            .setMediaMetadata(
                MediaMetadata.Builder()
                    .setTitle(getString(R.string.app_name))
                    .setIsBrowsable(true)
                    .setIsPlayable(false)
                    .setFolderType(MediaMetadata.FOLDER_TYPE_MIXED)
                    .build(),
            )
            .build()

    private fun topLevelFolders(): List<MediaItem> = listOf(
        folderItem(AutoBrowse.RECENTS_ID, "Recents"),
        folderItem(AutoBrowse.PLAYLISTS_ID, "Playlists"),
        folderItem(AutoBrowse.QUEUE_ID, "Queue"),
    )

    private fun folderItem(id: String, title: String): MediaItem =
        MediaItem.Builder()
            .setMediaId(id)
            .setMediaMetadata(
                MediaMetadata.Builder()
                    .setTitle(title)
                    .setIsBrowsable(true)
                    .setIsPlayable(false)
                    .setFolderType(MediaMetadata.FOLDER_TYPE_NONE)
                    .build(),
            )
            .build()
            .also { rememberServed(it) }

    private fun rendererChildren(
        query: ListenableFuture<String?>,
    ): ListenableFuture<LibraryResult<ImmutableList<MediaItem>>> =
        Futures.transform(
            query,
            { json -> LibraryResult.ofItemList(entriesToMediaItems(AutoBrowse.parseEntries(json)), null) },
            MoreExecutors.directExecutor(),
        )

    private fun rendererSearch(
        query: String,
    ): ListenableFuture<LibraryResult<ImmutableList<MediaItem>>> =
        Futures.transform(
            AutoBrowse.query("search", query),
            { json ->
                val items = entriesToMediaItems(AutoBrowse.parseEntries(json))
                lastSearchQuery = query
                lastSearchItems = items
                LibraryResult.ofItemList(items, null)
            },
            MoreExecutors.directExecutor(),
        )

    private fun entriesToMediaItems(entries: List<AutoBrowse.BrowseEntry>): List<MediaItem> =
        entries.map { entry ->
            MediaItem.Builder()
                .setMediaId(entry.id)
                .setMediaMetadata(
                    MediaMetadata.Builder()
                        .setTitle(entry.title.ifBlank { "Unknown" })
                        .setArtist(entry.subtitle.takeIf { it.isNotBlank() })
                        .setArtworkUri(
                            entry.artwork.takeIf { it.startsWith("http") }?.let(Uri::parse),
                        )
                        .setIsBrowsable(!entry.playable)
                        .setIsPlayable(entry.playable)
                        .setFolderType(
                            if (entry.playable) {
                                MediaMetadata.FOLDER_TYPE_NONE
                            } else {
                                MediaMetadata.FOLDER_TYPE_MIXED
                            },
                        )
                        .build(),
                )
                .build()
                .also { rememberServed(it) }
        }

    private fun emptyTimeline(): MediaSession.MediaItemsWithStartPosition =
        MediaSession.MediaItemsWithStartPosition(ImmutableList.of(), 0, 0)

    @Volatile
    private var lastSearchQuery: String? = null

    @Volatile
    private var lastSearchItems: List<MediaItem> = emptyList()

    private val servedLock = Any()
    private val served = HashMap<String, MediaItem>()

    private fun rememberServed(item: MediaItem) {
        synchronized(servedLock) {
            if (served.size > 400) served.clear()
            served[item.mediaId] = item
        }
    }

    private fun servedItem(mediaId: String): MediaItem? = synchronized(servedLock) { served[mediaId] }

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
