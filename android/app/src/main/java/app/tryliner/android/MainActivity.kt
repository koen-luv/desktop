package app.tryliner.android

import android.annotation.SuppressLint
import android.content.Intent
import android.content.res.Configuration
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.CookieManager
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import androidx.activity.ComponentActivity
import androidx.activity.OnBackPressedCallback
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewAssetLoader.AssetsPathHandler
import org.json.JSONObject

class MainActivity : ComponentActivity() {
    lateinit var webView: WebView
        private set
    private lateinit var root: FrameLayout
    private lateinit var assetLoader: WebViewAssetLoader

    @Volatile var notificationPermissionAsked = false
    private var pageReady = false
    private var pendingDeeplink: String? = null
    private var lightSystemBars = false
    private var rendererRecovered = false

    private var insetTopDp = 0f
    private var insetBottomDp = 0f
    private var insetLeftDp = 0f
    private var insetRightDp = 0f

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        Http.init(applicationContext)
        AudioCache.init(applicationContext)

        WindowCompat.setDecorFitsSystemWindows(window, false)
        window.statusBarColor = Color.TRANSPARENT
        window.navigationBarColor = Color.TRANSPARENT
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            window.attributes = window.attributes.apply {
                layoutInDisplayCutoutMode =
                    WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
            }
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            window.isNavigationBarContrastEnforced = false
        }
        WindowCompat.setDecorFitsSystemWindows(window, false)

        assetLoader = WebViewAssetLoader.Builder()
            .addPathHandler("/", AssetsPathHandler(this))
            .build()

        root = FrameLayout(this).apply { setBackgroundColor(Color.BLACK) }
        setContentView(root)

        webView = buildWebView()
        root.addView(
            webView,
            FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT,
            ),
        )

        ViewCompat.setOnApplyWindowInsetsListener(root) { view, insets ->
            val imeBottom = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom
            view.setPadding(0, 0, 0, imeBottom)
            val bars = insets.getInsets(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout(),
            )
            val density = resources.displayMetrics.density.coerceAtLeast(1f)
            insetTopDp = bars.top / density
            insetBottomDp = bars.bottom / density
            insetLeftDp = bars.left / density
            insetRightDp = bars.right / density
            postInsets()
            insets
        }
        ViewCompat.requestApplyInsets(root)

        NativeEvents.emitter = { type, payload ->
            emitToJs(type, payload)
        }

        onBackPressedDispatcher.addCallback(this, object : OnBackPressedCallback(true) {
            override fun handleOnBackPressed() {
                handleBack()
            }
        })

        handleIntent(intent)
        webView.loadUrl("https://appassets.androidplatform.net/index.html")
    }

    @SuppressLint("SetJavaScriptEnabled")
    private fun buildWebView(): WebView {
        val view = WebView(this)
        view.setBackgroundColor(Color.BLACK)
        view.overScrollMode = View.OVER_SCROLL_NEVER
        view.isVerticalScrollBarEnabled = false
        view.isHorizontalScrollBarEnabled = false
        view.setLayerType(View.LAYER_TYPE_HARDWARE, null)
        if (BuildConfig.DEBUG) {
            WebView.setWebContentsDebuggingEnabled(true)
        }

        val settings = view.settings
        settings.javaScriptEnabled = true
        settings.domStorageEnabled = true
        settings.databaseEnabled = true
        settings.mediaPlaybackRequiresUserGesture = false
        settings.javaScriptCanOpenWindowsAutomatically = false
        settings.setSupportMultipleWindows(false)
        settings.setSupportZoom(false)
        settings.builtInZoomControls = false
        settings.displayZoomControls = false
        settings.allowFileAccess = false
        settings.allowContentAccess = false
        settings.allowFileAccessFromFileURLs = false
        settings.allowUniversalAccessFromFileURLs = false
        settings.mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        // The WebView serves the app shell from the APK assets, so there is
        // nothing worth caching: without this, Chromium keeps serving a stale
        // index.html (and its old JS bundle) after the app is updated.
        settings.cacheMode = WebSettings.LOAD_NO_CACHE
        settings.loadsImagesAutomatically = true
        settings.blockNetworkImage = false
        settings.safeBrowsingEnabled = true
        settings.textZoom = (resources.configuration.fontScale * 100).toInt().coerceIn(75, 200)
        Http.userAgent = settings.userAgentString

        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(view, false)

        view.addJavascriptInterface(LinerBridge(this), "LinerAndroid")

        view.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(
                view: WebView,
                request: WebResourceRequest,
            ): Boolean {
                val uri = request.url
                if (uri.host == "appassets.androidplatform.net") return false
                when (uri.scheme?.lowercase()) {
                    "liner" -> {
                        handleDeeplink(uri)
                        return true
                    }
                    "http", "https" -> {
                        openExternal(uri)
                        return true
                    }
                    "mailto", "tel" -> {
                        try {
                            startActivity(Intent(Intent.ACTION_VIEW, uri))
                        } catch (_: Exception) {
                        }
                        return true
                    }
                }
                return true
            }

            override fun shouldInterceptRequest(
                view: WebView,
                request: WebResourceRequest,
            ): WebResourceResponse? {
                val loader = try {
                    assetLoader.shouldInterceptRequest(request.url)
                } catch (_: Exception) {
                    null
                }
                if (loader != null) return loader
                if (CorsProxy.shouldProxy(request)) {
                    return try {
                        CorsProxy.handle(request)
                    } catch (_: Exception) {
                        null
                    }
                }
                return null
            }

            override fun onPageFinished(view: WebView, url: String?) {
                pageReady = true
                view.evaluateJavascript(LINK_GUARD_JS, null)
                pendingDeeplink?.let { payload ->
                    pendingDeeplink = null
                    emitToJs("deeplink", payload)
                }
                applySystemBarAppearance(lightSystemBars)
                postInsets()
            }

            override fun onReceivedError(
                view: WebView,
                request: WebResourceRequest,
                error: WebResourceError,
            ) {
                if (!request.isForMainFrame) return
                showLoadError(
                    view,
                    "Liner could not start",
                    "The application bundle failed to load (${error.errorCode}: ${error.description}).",
                )
            }

            override fun onReceivedHttpError(
                view: WebView,
                request: WebResourceRequest,
                errorResponse: WebResourceResponse,
            ) {
                if (!request.isForMainFrame) return
                showLoadError(
                    view,
                    "Liner could not start",
                    "The application bundle returned HTTP ${errorResponse.statusCode}.",
                )
            }

            override fun onRenderProcessGone(
                view: WebView,
                detail: RenderProcessGoneDetail,
            ): Boolean {
                if (rendererRecovered) {
                    showRendererError()
                    return true
                }
                rendererRecovered = true
                root.removeView(view)
                view.destroy()
                root.postDelayed({ recreate() }, 250)
                return true
            }
        }

        view.webChromeClient = object : WebChromeClient() {
            override fun onCreateWindow(
                view: WebView,
                isDialog: Boolean,
                isUserGesture: Boolean,
                resultMsg: android.os.Message,
            ): Boolean {
                // External links are opened in the system browser, never in an
                // uncontrolled popup WebView.
                return false
            }
        }

        return view
    }

    private fun showLoadError(view: WebView, title: String, message: String) {
        val html = """
            <!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
            <style>
              html,body{height:100%;margin:0;background:#0a0a0a;color:#fff;font-family:system-ui,-apple-system,sans-serif}
              body{display:flex;align-items:center;justify-content:center;padding:24px;box-sizing:border-box}
              .card{max-width:420px;width:100%;text-align:center}
              h1{font-size:20px;font-weight:600;margin:0 0 10px}
              p{color:rgba(255,255,255,.65);font-size:14px;line-height:1.5;margin:0 0 22px}
              button{appearance:none;border:0;border-radius:10px;background:#fff;color:#000;font-size:14px;font-weight:600;padding:12px 20px}
            </style></head><body><div class="card">
              <h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>
              <button onclick="location.replace('https://appassets.androidplatform.net/index.html')">Retry</button>
            </div></body></html>
        """.trimIndent()
        view.loadDataWithBaseURL(
            "https://appassets.androidplatform.net/",
            html,
            "text/html",
            "utf-8",
            null,
        )
    }

    private fun showRendererError() {
        val layout = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = android.view.Gravity.CENTER
            setBackgroundColor(Color.BLACK)
            setPadding(48, 48, 48, 48)
        }
        layout.addView(TextView(this).apply {
            text = "Liner could not restore its interface."
            setTextColor(Color.WHITE)
            textSize = 18f
        })
        layout.addView(Button(this).apply {
            text = "Restart"
            setOnClickListener { recreate() }
        })
        root.removeAllViews()
        root.addView(layout)
    }

    private fun escapeHtml(value: String): String = value
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace("\"", "&quot;")

    private fun openExternal(uri: Uri) {
        try {
            startActivity(
                Intent(Intent.ACTION_VIEW, uri)
                    .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK),
            )
        } catch (_: Exception) {
        }
    }

    fun applySystemBarAppearance(light: Boolean) {
        lightSystemBars = light
        val controller = WindowInsetsControllerCompat(window, window.decorView)
        controller.isAppearanceLightStatusBars = light
        controller.isAppearanceLightNavigationBars = light
        window.statusBarColor = Color.TRANSPARENT
        window.navigationBarColor = Color.TRANSPARENT
    }

    fun insetsJson(): String {
        return JSONObject()
            .put("top", insetTopDp.toDouble())
            .put("bottom", insetBottomDp.toDouble())
            .put("left", insetLeftDp.toDouble())
            .put("right", insetRightDp.toDouble())
            .put("scale", resources.configuration.fontScale.toDouble())
            .toString()
    }

    private fun postInsets() {
        if (!::webView.isInitialized) return
        val payload = insetsJson()
        runOnUiThread {
            if (::webView.isInitialized) {
                emitToJsInternal("insets", payload)
            }
        }
    }

    fun emitToJs(type: String, payload: String) {
        runOnUiThread { emitToJsInternal(type, payload) }
    }

    private fun emitToJsInternal(type: String, payload: String) {
        if (!::webView.isInitialized || isFinishing || isDestroyed) return
        val js = "window.__linerAndroidEmit?.(" +
            JSONObject.quote(type) + "," + JSONObject.quote(payload) + ");"
        try {
            webView.evaluateJavascript(js, null)
        } catch (_: Exception) {
        }
    }

    private fun handleBack() {
        if (!pageReady) {
            finishAfterBack()
            return
        }
        webView.evaluateJavascript(
            "(function(){try{return String(!!(window.__linerHandleBack&&window.__linerHandleBack()))}catch(e){return 'false'}})()",
        ) { raw ->
            val handled = raw?.trim('"') == "true"
            if (!handled) finishAfterBack()
        }
    }

    private fun finishAfterBack() {
        if (isFinishing) return
        // Keep the WebView and its queue alive while audio is active, exactly
        // like a music app going to the background. Without playback, exit.
        if (PlaybackHolder.isPlaying()) {
            moveTaskToBack(true)
        } else {
            finish()
        }
    }

    private fun handleIntent(intent: Intent?) {
        if (intent?.action != Intent.ACTION_VIEW) return
        val data = intent.data ?: return
        if (data.scheme?.lowercase() != "liner") return
        handleDeeplink(data)
    }

    private fun handleDeeplink(uri: Uri) {
        val type = uri.host?.takeIf { it.isNotBlank() }
            ?: uri.pathSegments.firstOrNull().orEmpty()
        if (type !in setOf("artist", "album", "playlist", "track")) return
        val id = uri.getQueryParameter("id")?.takeIf { it.isNotBlank() }
            ?: uri.pathSegments.getOrNull(1)?.takeIf { it.isNotBlank() }
            ?: return
        val payload = JSONObject().put("type", type).put("id", id).toString()
        if (pageReady) {
            emitToJs("deeplink", payload)
        } else {
            pendingDeeplink = payload
        }
    }

    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        setIntent(intent)
        handleIntent(intent)
    }

    override fun onResume() {
        super.onResume()
        if (::webView.isInitialized) {
            applySystemBarAppearance(lightSystemBars)
            postInsets()
            emitToJs("appResumed", "{}")
        }
    }

    override fun onPause() {
        // Intentionally do not call webView.onPause(): the renderer owns the
        // queue and must keep advancing tracks while ExoPlayer plays in the
        // background.
        super.onPause()
    }

    override fun onConfigurationChanged(newConfig: Configuration) {
        super.onConfigurationChanged(newConfig)
        if (::webView.isInitialized) {
            webView.settings.textZoom =
                (newConfig.fontScale * 100).toInt().coerceIn(75, 200)
            applySystemBarAppearance(lightSystemBars)
            ViewCompat.requestApplyInsets(root)
            postInsets()
        }
    }

    override fun onDestroy() {
        NativeEvents.emitter = null
        if (::webView.isInitialized) {
            root.removeView(webView)
            webView.stopLoading()
            webView.destroy()
        }
        super.onDestroy()
    }

    companion object {
        const val NOTIFICATION_PERMISSION_REQUEST = 3001

        private const val LINK_GUARD_JS = """
            (function(){
              window.__linerAndroidReady = true;
              if (window.__linerAndroidLinksInstalled) return;
              window.__linerAndroidLinksInstalled = true;
              document.addEventListener('click', function(event){
                var anchor = event.target && event.target.closest ? event.target.closest('a[href]') : null;
                if (!anchor) return;
                var href = anchor.getAttribute('href') || '';
                if (/^https?:\/\//i.test(href) && href.indexOf('appassets.androidplatform.net') === -1) {
                  event.preventDefault();
                  window.LinerAndroid && window.LinerAndroid.openExternal(href);
                }
              }, true);
            })();
        """
    }
}
