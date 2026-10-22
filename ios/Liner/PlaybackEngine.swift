import AVFoundation
import Foundation
import MediaPlayer
import UIKit

/// Native playback engine for iOS — the counterpart of the Media3 service in
/// `android/app/src/main/java/app/tryliner/android/PlaybackService.kt`.
///
/// The renderer keeps owning queue, repeat/shuffle, lyrics and persistence; it
/// polls `audioState()` every 150 ms and mirrors the returned JSON into the same
/// player store the desktop runtime feeds (`androidPlayerRuntime.ts`). Audio
/// decoding, background playback and lock-screen controls live here.
final class PlaybackEngine {
    static let shared = PlaybackEngine()

    private let player = AVPlayer()
    private var currentItem: AVPlayerItem?
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

    // MARK: - Bridge surface

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
        // Spectral keeps the key when the user changes speed, matching Media3's
        // pitch-preserving default.
        item.audioTimePitchAlgorithm = .spectral
        currentItem = item

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
        player.volume = Float(max(0, min(1, volume)))
    }

    func setSpeed(_ rate: Double) {
        desiredRate = min(2, max(0.5, rate))
        if player.timeControlStatus != .paused {
            player.rate = Float(desiredRate)
        }
        updateNowPlaying()
    }

    /// Standalone pitch shifting (without a tempo change) needs an
    /// `AVAudioEngine` + `AVAudioUnitTimePitch` graph over a downloaded file;
    /// the streaming `AVPlayer` cannot do it. Linked pitch is covered by
    /// `setSpeed`, which preserves the key via `audioTimePitchAlgorithm`.
    func setPitch(_ semitones: Double) {
        _ = semitones
    }

    /// No reverb stage on AVPlayer (same limitation as `setPitch`).
    func setReverb(_ level: Double) {
        _ = level
    }

    /// Schedules a pause at an absolute epoch-ms deadline (0 cancels). Enforced
    /// here, not in JS, so it still fires with the screen off and the app in the
    /// background — then reported as a `sleepTimerFired` event.
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

    // MARK: - Ticking

    private func startTicking() {
        let timer = Timer(timeInterval: 0.25, repeats: true) { [weak self] _ in
            self?.tick()
        }
        RunLoop.main.add(timer, forMode: .common)
        tickTimer = timer
    }

    private func tick() {
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

    // MARK: - Clock

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

    // MARK: - Now Playing

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

    // MARK: - Remote commands / interruptions

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

    // MARK: - Small helpers

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
