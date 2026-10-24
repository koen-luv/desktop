import AVFoundation
import Foundation
import MediaPlayer
import UIKit

final class PlaybackEngine {
    static let shared = PlaybackEngine()

    private var player = AVPlayer()
    private var currentItem: AVPlayerItem?

    // Overlapping crossfade: a second, silent player holds the incoming song
    // while the two volumes blend on the main run loop (see crossfadeLoad).
    private var userVolume: Double = 1
    private var transitionPlayer: AVPlayer?
    private var transitionItem: AVPlayerItem?
    private var crossfadeTrackId: String?
    private var crossfadePayload: [String: Any]?
    private var crossfadeStartedAt: Date?
    private var crossfadeDurationMs: Double = 0
    private var crossfadeTimer: Timer?
    private var crossfadeEpoch = 0
    private var trackId: String?
    private var title = ""
    private var artist = ""
    private var album = ""
    private var coverUrl: String?
    private var status = "idle"
    private var errorMessage: String?
    private var desiredRate: Double = 1
    private var payloadDurationMs: Double = 0
    private var wantsPlay = false
    private var ended = false

    private var tickTimer: Timer?
    private var tickCount = 0
    private var sleepTimer: Timer?
    private var endObserver: NSObjectProtocol?
    private var failObserver: NSObjectProtocol?

    private init() {
        player.actionAtItemEnd = .pause
        player.volume = 1
        registerRemoteCommands()
        observeInterruptions()
        startTicking()
    }


    func load(_ payloadJSON: String) {
        guard
            let data = payloadJSON.data(using: .utf8),
            let raw = try? JSONSerialization.jsonObject(with: data),
            let payload = raw as? [String: Any],
            let urlString = payload["url"] as? String,
            let url = URL(string: urlString),
            let loadedTrackId = payload["trackId"] as? String,
            !loadedTrackId.isEmpty,
            !urlString.isEmpty
        else {
            return
        }

        cancelCrossfade()
        teardownObservers()
        trackId = loadedTrackId
        title = payload["title"] as? String ?? ""
        artist = payload["artist"] as? String ?? ""
        album = payload["album"] as? String ?? "Liner"
        coverUrl = payload["coverUrl"] as? String
        payloadDurationMs = PlaybackEngine.number(payload["durationMs"])
        let startMs = PlaybackEngine.number(payload["startMs"])
        errorMessage = nil
        ended = false
        wantsPlay = true
        status = "buffering"

        let asset = AVURLAsset(
            url: url,
            options: ["AVURLAssetHTTPHeaderFieldsKey": ["User-Agent": HttpProxy.userAgent]]
        )
        let item = AVPlayerItem(asset: asset)
        item.audioTimePitchAlgorithm = .spectral
        currentItem = item

        observe(item: item)

        player.replaceCurrentItem(with: item)
        player.seek(
            to: CMTime(seconds: max(0, startMs) / 1000, preferredTimescale: 600),
            toleranceBefore: .zero,
            toleranceAfter: .zero
        ) { [weak self] _ in
            guard let self, self.wantsPlay else { return }
            self.player.playImmediately(atRate: Float(self.desiredRate))
        }

        loadArtwork()
        updateNowPlaying()
    }

    func pause() {
        cancelCrossfade()
        wantsPlay = false
        player.pause()
        status = "paused"
        updateNowPlaying()
        pushState()
    }

    func resume() {
        guard currentItem != nil else { return }
        wantsPlay = true
        ended = false
        player.playImmediately(atRate: Float(desiredRate))
        status = "playing"
        updateNowPlaying()
        pushState()
    }

    func seek(_ positionMs: Double) {
        guard currentItem != nil else { return }
        cancelCrossfade()
        let target = max(0, positionMs)
        player.seek(
            to: CMTime(seconds: target / 1000, preferredTimescale: 600),
            toleranceBefore: CMTime(seconds: 0.05, preferredTimescale: 600),
            toleranceAfter: CMTime(seconds: 0.05, preferredTimescale: 600)
        )
        ended = false
        updateNowPlaying()
        pushState()
    }

    func stop() {
        cancelCrossfade()
        wantsPlay = false
        ended = false
        player.pause()
        player.replaceCurrentItem(with: nil)
        teardownObservers()
        currentItem = nil
        trackId = nil
        title = ""
        artist = ""
        album = ""
        coverUrl = nil
        errorMessage = nil
        payloadDurationMs = 0
        status = "idle"
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
        pushState()
    }

    func setVolume(_ volume: Double) {
        userVolume = max(0, min(1, volume))
        player.volume = Float(userVolume)
    }

    func setSpeed(_ rate: Double) {
        desiredRate = min(2, max(0.5, rate))
        if player.timeControlStatus != .paused {
            player.rate = Float(desiredRate)
        }
        updateNowPlaying()
    }

    func setPitch(_ semitones: Double) {
        _ = semitones
    }

    func setReverb(_ level: Double) {
        _ = level
    }

    func sleepAt(_ deadlineMs: Double) {
        sleepTimer?.invalidate()
        sleepTimer = nil
        guard deadlineMs > 0 else { return }

        let delay = (deadlineMs - Date().timeIntervalSince1970 * 1000) / 1000
        if delay <= 0 {
            fireSleepTimer()
            return
        }
        let timer = Timer(timeInterval: delay, repeats: false) { [weak self] _ in
            self?.fireSleepTimer()
        }
        RunLoop.main.add(timer, forMode: .common)
        sleepTimer = timer
    }

    // MARK: - Overlapping crossfade

    /// Prepares the incoming song on a silent second player. Mirrors the
    /// Android transition player: the blend runs from here on the main run
    /// loop, so it keeps working while the app is backgrounded.
    func crossfadeLoad(_ payloadJSON: String) {
        guard
            let data = payloadJSON.data(using: .utf8),
            let raw = try? JSONSerialization.jsonObject(with: data),
            let payload = raw as? [String: Any],
            let urlString = payload["url"] as? String,
            let url = URL(string: urlString),
            let loadedTrackId = payload["trackId"] as? String,
            !loadedTrackId.isEmpty,
            !urlString.isEmpty
        else {
            return
        }

        cancelCrossfade()

        let asset = AVURLAsset(
            url: url,
            options: ["AVURLAssetHTTPHeaderFieldsKey": ["User-Agent": HttpProxy.userAgent]]
        )
        let item = AVPlayerItem(asset: asset)
        item.audioTimePitchAlgorithm = .spectral
        let incoming = AVPlayer(playerItem: item)
        incoming.actionAtItemEnd = .pause
        incoming.volume = 0
        incoming.playImmediately(atRate: Float(desiredRate))

        transitionItem = item
        transitionPlayer = incoming
        crossfadePayload = payload
        crossfadeTrackId = loadedTrackId
    }

    /// Starts (or restarts) the blend once the incoming player is ready.
    func crossfadeStart(_ durationMs: Double) {
        guard transitionPlayer != nil, transitionItem != nil, durationMs > 0 else {
            cancelCrossfade()
            return
        }
        crossfadeDurationMs = min(max(durationMs, 500), 30_000)
        crossfadeEpoch += 1
        waitForTransition(epoch: crossfadeEpoch, waitedMs: 0)
    }

    func crossfadeCancel() {
        cancelCrossfade()
    }

    private func waitForTransition(epoch: Int, waitedMs: Int) {
        guard epoch == crossfadeEpoch else { return }
        guard let incoming = transitionPlayer, let item = transitionItem else { return }
        let ready = incoming.timeControlStatus == .playing || item.status == .readyToPlay
        if ready {
            crossfadeStartedAt = Date()
            scheduleRampTick(epoch: epoch)
            return
        }
        if waitedMs >= 5_000 {
            // Fall back to the sequential path; the outgoing song keeps playing.
            cancelCrossfade()
            return
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [weak self] in
            self?.waitForTransition(epoch: epoch, waitedMs: waitedMs + 50)
        }
    }

    private func scheduleRampTick(epoch: Int) {
        crossfadeTimer?.invalidate()
        let timer = Timer(timeInterval: 1.0 / 60.0, repeats: true) { [weak self] _ in
            self?.runRampTick(epoch: epoch)
        }
        RunLoop.main.add(timer, forMode: .common)
        crossfadeTimer = timer
    }

    private func runRampTick(epoch: Int) {
        guard epoch == crossfadeEpoch else { return }
        guard let incoming = transitionPlayer, let startedAt = crossfadeStartedAt else { return }
        let elapsedMs = Date().timeIntervalSince(startedAt) * 1000
        let t = min(1, max(0, elapsedMs / crossfadeDurationMs))

        // Equal-power blend scaled by the user volume.
        let angle = t * Double.pi / 2
        player.volume = Float(userVolume * cos(angle))
        incoming.volume = Float(userVolume * sin(angle))

        if t >= 1 {
            promoteCrossfade(epoch: epoch)
        }
    }

    /// Hands playback over to the incoming player at full volume.
    private func promoteCrossfade(epoch: Int) {
        guard
            epoch == crossfadeEpoch,
            let incoming = transitionPlayer,
            let item = transitionItem
        else { return }

        crossfadeEpoch += 1
        crossfadeTimer?.invalidate()
        crossfadeTimer = nil

        let promotedId = crossfadeTrackId
        let payload = crossfadePayload

        trackId = promotedId
        title = payload?["title"] as? String ?? ""
        artist = payload?["artist"] as? String ?? ""
        album = payload?["album"] as? String ?? "Liner"
        coverUrl = payload?["coverUrl"] as? String
        payloadDurationMs = PlaybackEngine.number(payload?["durationMs"])
        errorMessage = nil
        ended = false
        wantsPlay = true
        status = "playing"

        teardownObservers()
        observe(item: item)

        let outgoing = player
        player = incoming
        currentItem = item
        player.volume = Float(userVolume)

        transitionPlayer = nil
        transitionItem = nil
        crossfadeTrackId = nil
        crossfadePayload = nil
        crossfadeStartedAt = nil

        outgoing.pause()
        outgoing.replaceCurrentItem(with: nil)

        loadArtwork()
        updateNowPlaying()
        pushState()
        if let promotedId {
            LinerHost.shared.emit("crossfadeCompleted", LinerHost.jsQuote(promotedId))
        }
    }

    private func cancelCrossfade() {
        crossfadeEpoch += 1
        crossfadeTimer?.invalidate()
        crossfadeTimer = nil
        crossfadeStartedAt = nil
        crossfadeTrackId = nil
        crossfadePayload = nil
        transitionPlayer?.pause()
        transitionPlayer?.replaceCurrentItem(with: nil)
        transitionPlayer = nil
        transitionItem = nil
        player.volume = Float(userVolume)
    }

    func stateJSON() -> String {
        var state: [String: Any] = [
            "ok": true,
            "status": status,
            "positionMs": Int(PlaybackEngine.rounded(currentPositionMs())),
            "durationMs": Int(PlaybackEngine.rounded(currentDurationMs())),
            "bufferedMs": Int(PlaybackEngine.rounded(bufferedMs())),
            "playbackRate": desiredRate,
            "at": Int(Date().timeIntervalSince1970 * 1000),
        ]
        if let trackId {
            state["trackId"] = trackId
        } else {
            state["trackId"] = NSNull()
        }
        if let errorMessage {
            state["error"] = errorMessage
        } else {
            state["error"] = NSNull()
        }
        return PlaybackEngine.json(state) ?? "{}"
    }


    private func startTicking() {
        let timer = Timer(timeInterval: 0.25, repeats: true) { [weak self] _ in
            self?.tick()
        }
        RunLoop.main.add(timer, forMode: .common)
        tickTimer = timer
    }

    private func tick() {
        tickCount &+= 1
        guard trackId != nil else {
            if status != "idle" {
                status = "idle"
                pushState()
            }
            return
        }

        if let item = currentItem {
            switch item.status {
            case .failed:
                fail(item.error?.localizedDescription ?? "Audio playback error")
            case .unknown:
                status = ended ? "ended" : "buffering"
            case .readyToPlay:
                if ended {
                    status = "ended"
                } else if !wantsPlay {
                    status = "paused"
                } else {
                    switch player.timeControlStatus {
                    case .playing:
                        status = "playing"
                        errorMessage = nil
                    case .waitingToPlayAtSpecifiedRate:
                        status = "buffering"
                    default:
                        status = "buffering"
                    }
                }
            @unknown default:
                status = "buffering"
            }
        }

        // The background keepalive audio element can take over the system
        // now-playing item; refresh ours periodically while playing.
        if status == "playing", tickCount % 8 == 0 {
            updateNowPlaying()
        }
        pushState()
    }

    private func handleEnded() {
        ended = true
        wantsPlay = false
        status = "ended"
        player.pause()
        updateNowPlaying()
        pushState()
    }

    private func fail(_ message: String) {
        errorMessage = message
        status = "error"
        wantsPlay = false
        pushState()
    }

    private func fireSleepTimer() {
        sleepTimer = nil
        pause()
        LinerHost.shared.emit("sleepTimerFired", "{}")
    }

    private func pushState() {
        LinerHost.shared.push("audio", stateJSON())
    }


    private func currentPositionMs() -> Double {
        let seconds = player.currentTime().seconds
        guard seconds.isFinite else { return 0 }
        return max(0, seconds * 1000)
    }

    private func currentDurationMs() -> Double {
        if let seconds = currentItem?.duration.seconds, seconds.isFinite, seconds > 0 {
            return seconds * 1000
        }
        return payloadDurationMs
    }

    private func bufferedMs() -> Double {
        guard
            let range = currentItem?.loadedTimeRanges.last?.timeRangeValue
        else { return 0 }
        let end = range.start.seconds + range.duration.seconds
        guard end.isFinite else { return 0 }
        return max(0, end * 1000)
    }


    private func updateNowPlaying() {
        guard trackId != nil else {
            MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
            return
        }

        var info: [String: Any] = [
            MPMediaItemPropertyTitle: title,
            MPMediaItemPropertyArtist: artist,
            MPMediaItemPropertyAlbumTitle: album,
            MPMediaItemPropertyPlaybackDuration: currentDurationMs() / 1000,
            MPNowPlayingInfoPropertyElapsedPlaybackTime: currentPositionMs() / 1000,
            MPNowPlayingInfoPropertyPlaybackRate: status == "playing" ? desiredRate : 0,
            MPNowPlayingInfoPropertyMediaType: MPNowPlayingInfoMediaType.audio.rawValue,
        ]
        if let artwork = artwork {
            info[MPMediaItemPropertyArtwork] = artwork
        }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
    }

    private var artwork: MPMediaItemArtwork?

    private func loadArtwork() {
        artwork = nil
        guard let coverUrl, let url = URL(string: coverUrl) else { return }
        URLSession.shared.dataTask(with: url) { [weak self] data, _, _ in
            guard
                let self,
                let data,
                let image = UIImage(data: data)
            else { return }
            let resized = PlaybackEngine.resize(image, to: CGSize(width: 512, height: 512))
            let mediaArtwork = MPMediaItemArtwork(boundsSize: resized.size) { _ in resized }
            DispatchQueue.main.async {
                guard self.coverUrl == coverUrl else { return }
                self.artwork = mediaArtwork
                self.updateNowPlaying()
            }
        }.resume()
    }

    private static func resize(_ image: UIImage, to size: CGSize) -> UIImage {
        let renderer = UIGraphicsImageRenderer(size: size)
        return renderer.image { _ in
            image.draw(in: CGRect(origin: .zero, size: size))
        }
    }


    private func registerRemoteCommands() {
        let center = MPRemoteCommandCenter.shared()

        center.playCommand.addTarget { [weak self] _ in
            self?.resume()
            return .success
        }
        center.pauseCommand.addTarget { [weak self] _ in
            self?.pause()
            return .success
        }
        center.togglePlayPauseCommand.addTarget { [weak self] _ in
            guard let self else { return .commandFailed }
            if self.status == "playing" {
                self.pause()
            } else {
                self.resume()
            }
            return .success
        }
        center.nextTrackCommand.addTarget { [weak self] _ in
            self?.emitCommand(["type": "next"])
            return .success
        }
        center.previousTrackCommand.addTarget { [weak self] _ in
            self?.emitCommand(["type": "prev"])
            return .success
        }
        center.changePlaybackPositionCommand.addTarget { [weak self] event in
            guard
                let self,
                let positionEvent = event as? MPChangePlaybackPositionCommandEvent
            else { return .commandFailed }
            self.seek(positionEvent.positionTime * 1000)
            self.emitCommand(["type": "seek", "positionMs": Int(positionEvent.positionTime * 1000)])
            return .success
        }
    }

    private func emitCommand(_ payload: [String: Any]) {
        guard let json = PlaybackEngine.json(payload) else { return }
        LinerHost.shared.emit("mediaCommand", json)
    }

    private func observeInterruptions() {
        NotificationCenter.default.addObserver(
            forName: AVAudioSession.interruptionNotification,
            object: nil,
            queue: .main
        ) { [weak self] notification in
            guard
                let self,
                let raw = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
                let type = AVAudioSession.InterruptionType(rawValue: raw)
            else { return }

            switch type {
            case .began:
                self.player.pause()
                self.status = "paused"
                self.updateNowPlaying()
                self.pushState()
            case .ended:
                let options = notification.userInfo?[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0
                if AVAudioSession.InterruptionOptions(rawValue: options).contains(.shouldResume),
                   self.wantsPlay {
                    self.player.playImmediately(atRate: Float(self.desiredRate))
                }
            @unknown default:
                break
            }
        }
    }

    private func observe(item: AVPlayerItem) {
        endObserver = NotificationCenter.default.addObserver(
            forName: .AVPlayerItemDidPlayToEndTime,
            object: item,
            queue: .main
        ) { [weak self] _ in
            self?.handleEnded()
        }
        failObserver = NotificationCenter.default.addObserver(
            forName: .AVPlayerItemFailedToPlayToEndTime,
            object: item,
            queue: .main
        ) { [weak self] notification in
            let error = notification.userInfo?[AVPlayerItemFailedToPlayToEndTimeErrorKey] as? Error
            self?.fail(error?.localizedDescription ?? "Audio playback error")
        }
    }

    private func teardownObservers() {
        if let endObserver {
            NotificationCenter.default.removeObserver(endObserver)
            self.endObserver = nil
        }
        if let failObserver {
            NotificationCenter.default.removeObserver(failObserver)
            self.failObserver = nil
        }
    }


    private static func number(_ value: Any?) -> Double {
        if let number = value as? NSNumber { return number.doubleValue }
        if let text = value as? String, let parsed = Double(text) { return parsed }
        return 0
    }

    private static func rounded(_ value: Double) -> Double {
        value.isFinite ? (value).rounded() : 0
    }

    private static func json(_ object: [String: Any]) -> String? {
        guard JSONSerialization.isValidJSONObject(object) else { return nil }
        guard let data = try? JSONSerialization.data(withJSONObject: object) else { return nil }
        return String(data: data, encoding: .utf8)
    }
}
