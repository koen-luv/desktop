package app.tryliner.android

import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import okhttp3.Request
import java.io.FilterInputStream
import java.io.InputStream
import java.util.Locale

object CorsProxy {
    private val apiHosts = setOf("api.tryliner.fun", "covers.tryliner.fun", "link.tryliner.fun")
    private val imageExtensions = setOf("jpg", "jpeg", "png", "webp", "gif", "avif")
    private val forwardedHeaders = setOf(
        "authorization",
        "accept",
        "accept-language",
        "content-type",
        "if-none-match",
        "if-modified-since",
        "range",
        "x-liner-signature",
        "x-liner-timestamp",
        "x-liner-nonce",
        "x-request-id",
        "x-client-version",
        "x-platform",
        "x-user-id",
        "x-user-name",
        "x-session-id",
        "x-goog-visitor-id",
    )

    fun shouldProxy(request: WebResourceRequest): Boolean {
        val uri = request.url
        if (uri.scheme != "https" && uri.scheme != "http") return false
        val host = uri.host?.lowercase(Locale.ROOT) ?: return false
        if (host == "appassets.androidplatform.net") return false
        if (apiHosts.contains(host)) return true
        if (request.method == "OPTIONS") return false
        if (request.method != "GET" && request.method != "HEAD") return false
        return isImageRequest(request, uri.lastPathSegment)
    }

    private fun isImageRequest(request: WebResourceRequest, lastSegment: String?): Boolean {
        if (request.requestHeaders["Sec-Fetch-Dest"]?.lowercase(Locale.ROOT) == "image") return true
        val ext = lastSegment?.substringAfterLast('.', "")?.lowercase(Locale.ROOT) ?: return false
        return ext in imageExtensions
    }

    fun handle(request: WebResourceRequest): WebResourceResponse? {
        return if (request.method == "OPTIONS") preflight(request) else proxy(request)
    }

    private fun originOf(request: WebResourceRequest): String =
        request.requestHeaders["Origin"]?.takeIf { it.isNotBlank() } ?: "*"

    private fun preflight(request: WebResourceRequest): WebResourceResponse {
        val origin = originOf(request)
        val requestedHeaders = request.requestHeaders["Access-Control-Request-Headers"]
            ?: "authorization,content-type,x-liner-signature,x-liner-timestamp,x-liner-nonce"
        val headers = HashMap<String, String>()
        headers["Access-Control-Allow-Origin"] = origin
        headers["Access-Control-Allow-Methods"] = "GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS"
        headers["Access-Control-Allow-Headers"] = requestedHeaders
        headers["Access-Control-Max-Age"] = "86400"
        headers["Access-Control-Expose-Headers"] = EXPOSE_HEADERS
        headers["Vary"] = "Origin, Access-Control-Request-Headers"
        headers["Content-Length"] = "0"
        return WebResourceResponse(
            "text/plain",
            "utf-8",
            204,
            "No Content",
            headers,
            ByteArray(0).inputStream(),
        )
    }

    private fun proxy(request: WebResourceRequest): WebResourceResponse? {
        return try {
            val origin = originOf(request)
            val builder = Request.Builder()
                .url(request.url.toString())
                .header("Accept-Language", "en-US,en;q=0.9")

            var hasUserAgent = false
            for ((key, value) in request.requestHeaders) {
                val lower = key.lowercase(Locale.ROOT)
                if (lower == "user-agent") hasUserAgent = true
                if (lower in forwardedHeaders || lower == "user-agent" || lower == "origin") {
                    builder.header(key, value)
                }
            }
            if (!hasUserAgent) builder.header("User-Agent", Http.userAgent)
            if (request.method == "HEAD") builder.head()

            val response = Http.client.newCall(builder.build()).execute()
            try {
                val body = response.body
                val headers = HashMap<String, String>()
                headers["Access-Control-Allow-Origin"] = origin
                headers["Access-Control-Expose-Headers"] = EXPOSE_HEADERS
                headers["Cross-Origin-Resource-Policy"] = "cross-origin"
                headers["Vary"] = "Origin"
                body?.contentType()?.let { headers["Content-Type"] = it.toString() }
                response.header("Cache-Control")?.let { headers["Cache-Control"] = it }
                response.header("Expires")?.let { headers["Expires"] = it }
                response.header("Last-Modified")?.let { headers["Last-Modified"] = it }
                response.header("ETag")?.let { headers["ETag"] = it }
                response.header("Content-Range")?.let { headers["Content-Range"] = it }
                response.header("Accept-Ranges")?.let { headers["Accept-Ranges"] = it }
                response.header("x-request-id")?.let { headers["x-request-id"] = it }
                response.header("x-liner-server-time")?.let {
                    headers["x-liner-server-time"] = it
                }
                response.header("Date")?.let { headers["Date"] = it }

                val emptyBody = request.method == "HEAD" ||
                    response.code == 204 ||
                    response.code == 304 ||
                    body == null
                if (emptyBody) {
                    response.close()
                    return WebResourceResponse(
                        headers["Content-Type"] ?: "application/json",
                        "utf-8",
                        response.code,
                        response.message.ifBlank { "OK" },
                        headers,
                        ByteArray(0).inputStream(),
                    )
                }

                return WebResourceResponse(
                    headers["Content-Type"] ?: "application/octet-stream",
                    null,
                    response.code,
                    response.message.ifBlank { "OK" },
                    headers,
                    ClosingStream(body.byteStream(), response),
                )
            } catch (error: Exception) {
                response.close()
                throw error
            }
        } catch (_: Exception) {
            null
        }
    }

    private class ClosingStream(
        input: InputStream,
        private val response: okhttp3.Response,
    ) : FilterInputStream(input) {
        override fun available(): Int = try {
            super.available()
        } catch (_: Exception) {
            0
        }

        override fun close() {
            try {
                super.close()
            } catch (_: Exception) {
            } finally {
                response.close()
            }
        }
    }

    private const val EXPOSE_HEADERS =
        "Date, date, x-liner-server-time, x-request-id, content-range, accept-ranges, etag, " +
            "x-instance, x-liner-instance, content-length"
}
