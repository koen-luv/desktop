package app.tryliner.android

import android.content.Context
import okhttp3.Cache
import okhttp3.OkHttpClient
import java.io.File
import java.util.concurrent.TimeUnit

/**
 * One HTTP stack for native cover loading, the CORS-compatible fetch bridge and
 * audio cache downloads. It uses a real disk cache so repeated artwork and
 * YouTube visitor/bootstrap requests do not hit the network again.
 */
object Http {
    @Volatile
    lateinit var client: OkHttpClient
        private set

    @Volatile
    var userAgent: String =
        "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 " +
            "(KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36"

    fun init(context: Context) {
        if (::client.isInitialized) return
        val cacheDir = File(context.cacheDir, "http_cache").apply { mkdirs() }
        client = OkHttpClient.Builder()
            .cache(Cache(cacheDir, 96L * 1024 * 1024))
            .connectTimeout(20, TimeUnit.SECONDS)
            .readTimeout(45, TimeUnit.SECONDS)
            .writeTimeout(30, TimeUnit.SECONDS)
            .followRedirects(true)
            .followSslRedirects(true)
            .retryOnConnectionFailure(true)
            .build()
    }
}
