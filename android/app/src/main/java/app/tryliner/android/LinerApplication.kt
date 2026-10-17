package app.tryliner.android

import android.app.Application

class LinerApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        Http.init(this)
        AudioCache.init(this)
    }
}
