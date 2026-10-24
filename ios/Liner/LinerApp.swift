import AVFoundation
import SwiftUI
import UIKit
import UniformTypeIdentifiers
import WebKit

@main
struct LinerApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        WindowGroup {
            RootView()
                .ignoresSafeArea()
                .background(Color.black)
        }
    }
}

final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(.playback, mode: .default, options: [])
        try? session.setActive(true, options: [])
        return true
    }

    func application(
        _ app: UIApplication,
        open url: URL,
        options: [UIApplication.OpenURLOptionsKey: Any] = [:]
    ) -> Bool {
        LinerHost.shared.handleIncoming(url: url)
        return true
    }
}

struct RootView: UIViewControllerRepresentable {
    func makeUIViewController(context: Context) -> LinerWebViewController {
        LinerWebViewController()
    }

    func updateUIViewController(_ uiViewController: LinerWebViewController, context: Context) {}
}

final class LinerWebViewController: UIViewController, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler, UIDocumentPickerDelegate {
    private var webView: WKWebView?
    private var hasLoaded = false
    /// Pending `<input type="file">` completion, resolved by the document picker.
    private var filePickerCompletion: (([URL]?) -> Void)?

    override var preferredStatusBarStyle: UIStatusBarStyle {
        LinerHost.shared.lightBars ? .darkContent : .lightContent
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        start()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        LinerHost.shared.updateInsets(for: view)
    }


    private func start() {
        do {
            let port = try LocalServer.shared.start()
            guard let url = URL(string: "http://127.0.0.1:\(port)/index.html") else {
                showFatal("Invalid bundle URL")
                return
            }

            let configuration = WKWebViewConfiguration()
            configuration.websiteDataStore = .default()
            configuration.allowsInlineMediaPlayback = true
            configuration.mediaTypesRequiringUserActionForPlayback = []
            configuration.defaultWebpagePreferences.allowsContentJavaScript = true
            configuration.userContentController.addUserScript(
                WKUserScript(
                    source: LinerBridge.script,
                    injectionTime: .atDocumentStart,
                    forMainFrameOnly: true
                )
            )
            configuration.userContentController.add(self, name: "liner")

            let web = WKWebView(frame: .zero, configuration: configuration)
            web.navigationDelegate = self
            web.uiDelegate = self
            web.isOpaque = false
            web.backgroundColor = .black
            web.scrollView.backgroundColor = .black
            web.scrollView.contentInsetAdjustmentBehavior = .never
            web.scrollView.keyboardDismissMode = .interactive
            web.allowsBackForwardNavigationGestures = true
            web.translatesAutoresizingMaskIntoConstraints = false
            if #available(iOS 16.4, *) {
                web.isInspectable = true
            }

            view.addSubview(web)
            NSLayoutConstraint.activate([
                web.leadingAnchor.constraint(equalTo: view.leadingAnchor),
                web.trailingAnchor.constraint(equalTo: view.trailingAnchor),
                web.topAnchor.constraint(equalTo: view.topAnchor),
                web.bottomAnchor.constraint(equalTo: view.bottomAnchor),
            ])

            webView = web
            LinerHost.shared.attach(webView: web, controller: self)
            web.load(URLRequest(url: url))
        } catch {
            showFatal("Liner could not start\n\n\(error.localizedDescription)")
        }
    }

    private func showFatal(_ message: String) {
        let label = UILabel()
        label.text = message
        label.textColor = .white
        label.numberOfLines = 0
        label.textAlignment = .center
        label.font = .systemFont(ofSize: 15, weight: .medium)
        label.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(label)
        NSLayoutConstraint.activate([
            label.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            label.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            label.widthAnchor.constraint(lessThanOrEqualTo: view.widthAnchor, multiplier: 0.8),
        ])
    }


    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage
    ) {
        guard message.name == "liner", let body = message.body as? [String: Any] else { return }
        LinerBridge.handle(body: body)
    }


    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        hasLoaded = true
        LinerHost.shared.didFinishNavigation()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { [weak self] in
            guard let self else { return }
            LinerHost.shared.updateInsets(for: self.view)
        }
    }

    func webView(
        _ webView: WKWebView,
        didFailProvisionalNavigation navigation: WKNavigation!,
        withError error: Error
    ) {
        let code = (error as NSError).code
        if code == NSURLErrorCancelled { return }
        if hasLoaded { return }
        showFatal("Liner could not start\n\n\(error.localizedDescription)")
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.allow)
            return
        }

        let scheme = url.scheme?.lowercased() ?? ""
        let host = url.host?.lowercased() ?? ""

        if host == "127.0.0.1" || host == "localhost" {
            decisionHandler(.allow)
            return
        }

        switch scheme {
        case "liner":
            LinerHost.shared.handleIncoming(url: url)
            decisionHandler(.cancel)
        case "http", "https":
            LinerHost.shared.openExternal(url.absoluteString)
            decisionHandler(.cancel)
        case "mailto", "tel":
            UIApplication.shared.open(url, options: [:], completionHandler: nil)
            decisionHandler(.cancel)
        default:
            decisionHandler(.cancel)
        }
    }

    func webView(
        _ webView: WKWebView,
        createWebViewWith configuration: WKWebViewConfiguration,
        for navigationAction: WKNavigationAction,
        windowFeatures: WKWindowFeatures
    ) -> WKWebView? {
        if let url = navigationAction.request.url {
            LinerHost.shared.openExternal(url.absoluteString)
        }
        return nil
    }

    /// WKWebView asks the host to present a picker for `<input type="file">`
    /// (custom playlist covers, wallpaper, playlist imports). This delegate is
    /// iOS 18.4+; older releases keep WebKit's built-in upload panel.
    @available(iOS 18.4, *)
    func webView(
        _ webView: WKWebView,
        runOpenPanelWith parameters: WKOpenPanelParameters,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping ([URL]?) -> Void
    ) {
        filePickerCompletion = completionHandler
        let picker = UIDocumentPickerViewController(forOpeningContentTypes: [.image], asCopy: true)
        picker.allowsMultipleSelection = parameters.allowsMultipleSelection
        picker.delegate = self
        present(picker, animated: true)
    }

    func documentPicker(
        _ controller: UIDocumentPickerViewController,
        didPickDocumentsAt urls: [URL]
    ) {
        let completion = filePickerCompletion
        filePickerCompletion = nil
        completion?(urls)
    }

    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        let completion = filePickerCompletion
        filePickerCompletion = nil
        completion?(nil)
    }
}
