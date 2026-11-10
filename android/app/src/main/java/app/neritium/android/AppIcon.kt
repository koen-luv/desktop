package app.neritium.android

import android.content.ComponentName
import android.content.Context
import android.content.pm.PackageManager

/**
 * Swaps the launcher icon to the branding accent the renderer is using
 * (the Android counterpart of the Electron `setAppIcon` IPC). Implemented
 * with manifest activity-alises: exactly one Icon_<variant> component is
 * enabled at a time and the rest stay disabled.
 */
object AppIcon {
    private val VARIANTS = listOf(
        "default", "spotify", "discord", "telegram", "aurora", "sunset",
        "ocean", "forest", "berry", "carbon", "pixel", "scanlines", "vhs",
    )

    fun setVariant(context: Context, variant: String) {
        val target = if (variant in VARIANTS) variant else "default"
        val pkg = context.packageName
        for (v in VARIANTS) {
            val component = ComponentName(pkg, "$pkg.Icon_$v")
            val state =
                if (v == target) PackageManager.COMPONENT_ENABLED_STATE_ENABLED
                else PackageManager.COMPONENT_ENABLED_STATE_DISABLED
            try {
                context.packageManager.setComponentEnabledSetting(
                    component,
                    state,
                    PackageManager.DONT_KILL_APP,
                )
            } catch (_: Exception) {
            }
        }
        persist(context, target)
    }

    private fun persist(context: Context, variant: String) {
        try {
            context.getSharedPreferences("neritium_app_icon", Context.MODE_PRIVATE)
                .edit().putString("variant", variant).apply()
        } catch (_: Exception) {
        }
    }
}
