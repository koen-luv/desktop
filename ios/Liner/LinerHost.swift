import Foundation
import UIKit
import UserNotifications
import WebKit

/// Central native coordinator. Owns the WebView reference, the values the
/// renderer reads synchronously (`getInsets`, `audioState`, `getCacheStats`),
/// and the app-level bridge calls that need UIKit.
final class LinerHost {
    static let shared = LinerHost()

    weak var webView: WKWebView?
    weak var controller: UIViewController?
    private(set) var lightBars = false

    private var pendingURL: URL?
    private var insetsJSON = "{\"top\":0,\"bottom\":0,\"left\":0,\"right\":0,\"scale\":1}"
    private var statsJSON = "{}"
    private var localStorageBytes: Double = 0
    private var indexedDbBytes: Double = 0
    private var ready = false

    private init() {}

    // MARK: - Wiring

    func attach(webView: WKWebView, controller: UIViewController) {
        self.webView = webView
        self.controller = controller
        self.ready = true
        refreshStats()
        if let url = pendingURL {
            pendingURL = nil
            // The page installs `__linerAndroidEmit` during module evaluation;
            // mirror Android's "pending deeplink on page finished" timing.
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.8) { [weak self] in
                self?.handleIncoming(url: url)
            }
        }
    }

    func didFinishNavigation() {
        refreshStats()
        if let controller {
            updateInsets(for: controller.view)
        }
    }

    // MARK: - JS plumbing

    /// Native → JS event channel. Matches the Kotlin `emitToJs` contract:
    /// `window.__linerAndroidEmit(type, payloadJson)`.
    func emit(_ type: String, _ payload: String) {
        DispatchQueue.main.async { [weak self] in
            guard let webView = self?.webView else { return }
            let script = "window.__linerAndroidEmit?.(\(LinerHost.jsQuote(type)),\(LinerHost.jsQuote(payload)));"
            webView.evaluateJavaScript(script, completionHandler: nil)
        }
    }

    /// Updates a value the renderer reads synchronously from the bridge.
    func push(_ key: String, _ json: String) {
        DispatchQueue.main.async { [weak self] in
            guard let webView = self?.webView else { return }
            let script = "window.__linerNativeSet?.(\(LinerHost.jsQuote(key)),\(LinerHost.jsQuote(json)));"
            webView.evaluateJavaScript(script, completionHandler: nil)
        }
    }

    static func jsQuote(_ value: String) -> String {
        var escaped = value
        escaped = escaped.replacingOccurrences(of: "\\", with: "\\\\")
        escaped = escaped.replacingOccurrences(of: "\"", with: "\\\"")
        escaped = escaped.replacingOccurrences(of: "\n", with: "\\n")
        escaped = escaped.replacingOccurrences(of: "\r", with: "\\r")
        escaped = escaped.replacingOccurrences(of: "\u{2028}", with: "\\u2028")
        escaped = escaped.replacingOccurrences(of: "\u{2029}", with: "\\u2029")
        return "\"\(escaped)\""
    }

    // MARK: - Insets

    func updateInsets(for view: UIView) {
        guard ready else { return }
        // The hosting view fills the window (`.ignoresSafeArea()`), so the window
        // carries the real notch/home-indicator insets.
        let windowInsets = view.window?.safeAreaInsets ?? .zero
        let insets = windowInsets == .zero ? view.safeAreaInsets : windowInsets
        let top = Int(insets.top.rounded())
        let bottom = Int(insets.bottom.rounded())
        let left = Int(insets.left.rounded())
        let right = Int(insets.right.rounded())
        let json = "{\"top\":\(top),\"bottom\":\(bottom),\"left\":\(left),\"right\":\(right),\"scale\":1}"
        guard json != insetsJSON else { return }
        insetsJSON = json
        push("insets", json)
        emit("insets", json)
    }

    func setLightBars(_ light: Bool) {
        lightBars = light
        controller?.setNeedsStatusBarAppearanceUpdate()
    }

    // MARK: - Cache stats

    func reportStorage(localStorage: Double, indexedDb: Double) {
        localStorageBytes = max(0, localStorage)
        indexedDbBytes = max(0, indexedDb)
    }

    func refreshStats() {
        let audioCache = FileManager.default
            .urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("audio_cache", isDirectory: true)
        let http = HttpProxy.diskUsage
        let audio = HttpProxy.directorySize(audioCache)
        let local = Int64(max(0, localStorageBytes))
        let indexed = Int64(max(0, indexedDbBytes))
        let total = http + audio + local + indexed

        let stats: [String: Any] = [
            "cacheSize": total,
            "httpCacheSize": http,
            "codeCacheSize": 0,
            "serviceWorkerSize": 0,
            "indexedDbSize": indexed,
            "localStorageSize": local,
            "blobStorageSize": 0,
            "audioCacheSize": audio,
            "cachePath": audioCache.path,
        ]
        guard
            JSONSerialization.isValidJSONObject(stats),
            let data = try? JSONSerialization.data(withJSONObject: stats),
            let json = String(data: data, encoding: .utf8)
        else { return }

        statsJSON = json
        push("stats", json)
    }

    func cacheStatsJSON() -> String {
        refreshStats()
        return statsJSON
    }

    // MARK: - UIKit bridge calls

    func openExternal(_ raw: String) {
        guard let url = URL(string: raw), let scheme = url.scheme?.lowercased(),
              scheme == "https" || scheme == "http" else { return }
        DispatchQueue.main.async {
            UIApplication.shared.open(url, options: [:], completionHandler: nil)
        }
    }

    func share(text: String) {
        DispatchQueue.main.async { [weak self] in
            guard let controller = self?.topViewController() else { return }
            let activity = UIActivityViewController(activityItems: [text], applicationActivities: nil)
            activity.popoverPresentationController?.sourceView = controller.view
            controller.present(activity, animated: true)
        }
    }

    func copy(text: String) {
        UIPasteboard.general.string = text
    }

    func openSettings() {
        DispatchQueue.main.async {
            guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
            UIApplication.shared.open(url, options: [:], completionHandler: nil)
        }
    }

    /// There is no public "open the app's Documents folder" URL. `shareddocuments`
    /// is the Files-app bridge used by on-device installs; fall back to Settings.
    func openDownloads() {
        DispatchQueue.main.async {
            guard let url = URL(string: "shareddocuments://") else {
                self.openSettings()
                return
            }
            UIApplication.shared.open(url, options: [:]) { opened in
                if !opened { self.openSettings() }
            }
        }
    }

    func setKeepScreenOn(_ on: Bool) {
        DispatchQueue.main.async {
            UIApplication.shared.isIdleTimerDisabled = on
        }
    }

    func requestNotifications() {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { _, _ in }
    }

    func clearHttpCaches() {
        HttpProxy.clearCache()
        let types: Set<String> = [
            WKWebsiteDataTypeDiskCache,
            WKWebsiteDataTypeMemoryCache,
            WKWebsiteDataTypeFetchCache,
            WKWebsiteDataTypeOfflineWebApplicationCache,
        ]
        WKWebsiteDataStore.default().removeData(ofTypes: types, modifiedSince: .distantPast) { [weak self] in
            self?.refreshStats()
        }
    }

    // MARK: - Deeplinks

    func handleIncoming(url: URL) {
        guard url.scheme?.lowercased() == "liner" else { return }
        guard ready else {
            pendingURL = url
            return
        }

        let components = url.pathComponents.filter { $0 != "/" && !$0.isEmpty }
        var type = url.host?.lowercased() ?? ""
        var identifier = components.first ?? ""

        if type.isEmpty, components.count >= 2 {
            type = components[0].lowercased()
            identifier = components[1]
        } else if !components.isEmpty, identifier.isEmpty {
            identifier = components[0]
        }

        let allowed = ["track", "album", "playlist", "artist"]
        guard allowed.contains(type), !identifier.isEmpty else { return }

        let payload: [String: Any] = ["type": type, "id": identifier]
        guard
            JSONSerialization.isValidJSONObject(payload),
            let data = try? JSONSerialization.data(withJSONObject: payload),
            let json = String(data: data, encoding: .utf8)
        else { return }
        emit("deeplink", json)
    }

    // MARK: - Helpers

    private func topViewController() -> UIViewController? {
        var current = controller
        while let presented = current?.presentedViewController {
            current = presented
        }
        return current
    }

    func flushState() {
        _ = PlaybackEngine.shared.stateJSON()
    }
}
