package app.tryliner.android

import androidx.media3.common.ForwardingPlayer
import androidx.media3.common.Player

class LinerForwardingPlayer(player: Player) : ForwardingPlayer(player) {
    private val extendedCommands: Player.Commands = super.getAvailableCommands().buildUpon()
        .add(Player.COMMAND_SEEK_TO_NEXT)
        .add(Player.COMMAND_SEEK_TO_NEXT_MEDIA_ITEM)
        .add(Player.COMMAND_SEEK_TO_PREVIOUS)
        .add(Player.COMMAND_SEEK_TO_PREVIOUS_MEDIA_ITEM)
        .build()

    override fun getAvailableCommands(): Player.Commands = extendedCommands

    override fun hasNextMediaItem(): Boolean = true

    override fun hasPreviousMediaItem(): Boolean = true

    override fun seekToNext() {
        NativeEvents.emit("mediaCommand", "{\"command\":\"next\"}")
    }

    override fun seekToNextMediaItem() {
        NativeEvents.emit("mediaCommand", "{\"command\":\"next\"}")
    }

    override fun seekToPrevious() {
        NativeEvents.emit("mediaCommand", "{\"command\":\"previous\"}")
    }

    override fun seekToPreviousMediaItem() {
        NativeEvents.emit("mediaCommand", "{\"command\":\"previous\"}")
    }
}
