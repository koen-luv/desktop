package app.neritium.android

import androidx.media3.common.ForwardingPlayer
import androidx.media3.common.Player

/**
 * Session-facing wrapper that turns Media3's next/previous commands into
 * renderer-side queue advances (the queue lives in JS, not in the player).
 *
 * One instance wraps whichever ExoPlayer is currently main: the crossfade
 * engine builds a fresh wrapper for the promoted transition player and hands
 * it to the session with MediaSession.setPlayer().
 *
 * The command set must be computed live. It used to be captured once in the
 * constructor, before any media item existed — the session therefore kept
 * advertising the empty-player commands (no seek), and seek/next/previous from
 * the lock screen and Bluetooth controls silently did nothing.
 */
class NeritiumForwardingPlayer(player: Player) : ForwardingPlayer(player) {
    override fun getAvailableCommands(): Player.Commands = super.getAvailableCommands().buildUpon()
        .add(Player.COMMAND_SEEK_TO_NEXT)
        .add(Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM)
        .add(Player.COMMAND_SEEK_TO_PREVIOUS)
        .add(Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM)
        .add(Player.COMMAND_SEEK_IN_CURRENT_MEDIA_ITEM)
        .build()

    override fun hasNextMediaItem(): Boolean = true

    override fun hasPreviousMediaItem(): Boolean = true

    override fun seekToNext() {
        PlaybackHolder.skipToNext()
    }

    override fun seekToNextMediaItem() {
        PlaybackHolder.skipToNext()
    }

    override fun seekToPrevious() {
        PlaybackHolder.skipToPrevious()
    }

    override fun seekToPreviousMediaItem() {
        PlaybackHolder.skipToPrevious()
    }

    override fun play() {
        PlaybackHolder.resume()
    }

    override fun pause() {
        PlaybackHolder.pause()
    }
}
