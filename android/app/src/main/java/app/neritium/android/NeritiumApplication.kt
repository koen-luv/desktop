package app.neritium.android

import android.app.Application

class NeritiumApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        Http.init(this)
        AudioCache.init(this)
    }
}
