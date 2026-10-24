import Foundation
import UIKit

enum LinerBridge {
    static var version: String {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "0.0.0"
    }

    static let script: String = {
        let source = """
        (function () {
          if (window.LinerAndroid) { return; }
          var state = {
            version: "__LINER_VERSION__",
            insets: "{\\"top\\":0,\\"bottom\\":0,\\"left\\":0,\\"right\\":0,\\"scale\\":1}",
            audio: "",
            stats: "{}"
          };

          function send(method, args) {
            try {
              window.webkit.messageHandlers.liner.postMessage({ method: method, args: args || [] });
            } catch (error) {
              /* host not attached yet */
            }
          }

          window.__linerNativeSet = function (key, value) {
            state[key] = value;
          };

          function audioState() {
            if (!state.audio) { return "{}"; }
            try {
              var parsed = JSON.parse(state.audio);
              if (parsed && typeof parsed.positionMs === "number"
                  && typeof parsed.at === "number"
                  && parsed.status === "playing") {
                var elapsed = Date.now() - parsed.at;
                if (elapsed > 0 && elapsed < 3000) {
                  var next = parsed.positionMs + elapsed * (parsed.playbackRate || 1);
                  var limit = typeof parsed.durationMs === "number" && parsed.durationMs > 0
                    ? parsed.durationMs
                    : next;
                  parsed.positionMs = Math.min(next, limit);
                }
              }
              return JSON.stringify(parsed);
            } catch (error) {
              return state.audio;
            }
          }

          window.LinerAndroid = {
            getVersion: function () { return state.version; },
            getPlatform: function () { return "ios"; },
            getInsets: function () { return state.insets; },
            setLightSystemBars: function (light) { send("setLightSystemBars", [!!light]); },
            openExternal: function (url) { send("openExternal", [String(url)]); },
            shareText: function (text) { send("shareText", [String(text)]); },
            copyText: function (text) { send("copyText", [String(text)]); },
            saveDump: function (filename, content) {
              send("saveDump", [String(filename), String(content)]);
              return "{\\"success\\":true}";
            },
            getCacheStats: function () { return state.stats; },
            reportStorageUsage: function (localStorageBytes, indexedDbBytes) {
              send("reportStorageUsage", [Number(localStorageBytes) || 0, Number(indexedDbBytes) || 0]);
            },
            httpRequest: function (id, method, url, headersJson, body) {
              send("httpRequest", [String(id), String(method), String(url), String(headersJson || "{}"), body == null ? null : String(body)]);
            },
            downloadAudio: function (id, url, filename, mimeType) {
              send("downloadAudio", [String(id), String(url), String(filename), String(mimeType || "")]);
            },
            openAppStorageSettings: function () { send("openSettings", []); },
            openDownloads: function () { send("openDownloads", []); },
            /* No Android Auto browse tree on iOS; the renderer only replies to
               `autoBrowseQuery` events we never emit, so answering is a no-op. */
            autoBrowseResponse: function () {},
            clearCoversCache: function () { send("clearCoversCache", []); return true; },
            clearAudioCache: function () { send("clearAudioCache", []); return true; },
            clearHttpCache: function () { send("clearHttpCache", []); return true; },
            audioLoad: function (payload) { send("audioLoad", [String(payload)]); },
            audioCrossfadeLoad: function (payload) { send("audioCrossfadeLoad", [String(payload)]); },
            audioCrossfadeStart: function (durationMs) { send("audioCrossfadeStart", [Number(durationMs) || 0]); },
            audioCrossfadeCancel: function () { send("audioCrossfadeCancel", []); },
            audioPause: function () { send("audioPause", []); },
            audioResume: function () { send("audioResume", []); },
            audioSeek: function (positionMs) { send("audioSeek", [Number(positionMs) || 0]); },
            audioStop: function () { send("audioStop", []); },
            audioSetVolume: function (volume) { send("audioSetVolume", [Number(volume) || 0]); },
            audioSetSpeed: function (rate) { send("audioSetSpeed", [Number(rate) || 1]); },
            audioSetPitch: function (semitones) { send("audioSetPitch", [Number(semitones) || 0]); },
            audioSetReverb: function (level) { send("audioSetReverb", [Number(level) || 0]); },
            audioSleepAt: function (deadlineMs) { send("audioSleepAt", [Number(deadlineMs) || 0]); },
            audioState: audioState,
            audioCache: function () { /* streaming only on iOS */ },
            audioSetCacheLimit: function () { /* no on-disk audio cache */ },
            audioClearCache: function () { send("clearAudioCache", []); return true; },
            requestNotificationPermission: function () { send("requestNotifications", []); },
            setKeepScreenOn: function (on) { send("setKeepScreenOn", [!!on]); },
            /* Discord RPC needs a local socket to the desktop client, which iOS
               sandboxing forbids; the Settings tab reports "not connected". */
            discordUpdateState: function () {},
            discordUpdateSettings: function () {},
            discordGetStatus: function () { return "{\\"connected\\":false}"; }
          };
        })();
        """
        return source.replacingOccurrences(of: "__LINER_VERSION__", with: version)
    }()

    static func handle(body: [String: Any]) {
        guard let method = body["method"] as? String else { return }
        let args = body["args"] as? [Any] ?? []

        switch method {
        case "setLightSystemBars":
            LinerHost.shared.setLightBars(flag(args, 0))

        case "openExternal":
            LinerHost.shared.openExternal(text(args, 0))

        case "shareText":
            LinerHost.shared.share(text: text(args, 0))

        case "copyText":
            LinerHost.shared.copy(text: text(args, 0))

        case "saveDump":
            _ = HttpProxy.saveDump(filename: text(args, 0), content: text(args, 1))
            LinerHost.shared.refreshStats()

        case "reportStorageUsage":
            LinerHost.shared.reportStorage(localStorage: number(args, 0), indexedDb: number(args, 1))

        case "httpRequest":
            HttpProxy.request(
                id: text(args, 0),
                method: text(args, 1),
                url: text(args, 2),
                headersJSON: text(args, 3),
                body: args.count > 4 ? (args[4] as? String) : nil
            )

        case "downloadAudio":
            HttpProxy.downloadAudio(
                id: text(args, 0),
                url: text(args, 1),
                filename: text(args, 2),
                mimeType: text(args, 3)
            )

        case "openSettings":
            LinerHost.shared.openSettings()

        case "openDownloads":
            LinerHost.shared.openDownloads()

        case "clearCoversCache":
            LinerHost.shared.clearHttpCaches()

        case "clearHttpCache":
            LinerHost.shared.clearHttpCaches()

        case "clearAudioCache":
            LinerHost.shared.refreshStats()

        case "audioLoad":
            PlaybackEngine.shared.load(text(args, 0))

        case "audioCrossfadeLoad":
            PlaybackEngine.shared.crossfadeLoad(text(args, 0))

        case "audioCrossfadeStart":
            PlaybackEngine.shared.crossfadeStart(number(args, 0))

        case "audioCrossfadeCancel":
            PlaybackEngine.shared.crossfadeCancel()

        case "audioPause":
            PlaybackEngine.shared.pause()

        case "audioResume":
            PlaybackEngine.shared.resume()

        case "audioSeek":
            PlaybackEngine.shared.seek(number(args, 0))

        case "audioStop":
            PlaybackEngine.shared.stop()

        case "audioSetVolume":
            PlaybackEngine.shared.setVolume(number(args, 0))

        case "audioSetSpeed":
            PlaybackEngine.shared.setSpeed(number(args, 0))

        case "audioSetPitch":
            PlaybackEngine.shared.setPitch(number(args, 0))

        case "audioSetReverb":
            PlaybackEngine.shared.setReverb(number(args, 0))

        case "audioSleepAt":
            PlaybackEngine.shared.sleepAt(number(args, 0))

        case "requestNotifications":
            LinerHost.shared.requestNotifications()

        case "setKeepScreenOn":
            LinerHost.shared.setKeepScreenOn(flag(args, 0))

        default:
            break
        }
    }


    static func text(_ args: [Any], _ index: Int) -> String {
        guard index < args.count else { return "" }
        if let value = args[index] as? String { return value }
        if let value = args[index] as? NSNumber { return value.stringValue }
        return ""
    }

    static func number(_ args: [Any], _ index: Int) -> Double {
        guard index < args.count else { return 0 }
        if let value = args[index] as? NSNumber { return value.doubleValue }
        if let value = args[index] as? String, let parsed = Double(value) { return parsed }
        return 0
    }

    static func flag(_ args: [Any], _ index: Int) -> Bool {
        guard index < args.count else { return false }
        if let value = args[index] as? NSNumber { return value.boolValue }
        if let value = args[index] as? Bool { return value }
        return false
    }
}
