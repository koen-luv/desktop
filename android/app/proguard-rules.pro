# JavaScript bridge surface
-keepclassmembers class fun.tryliner.android.LinerBridge {
    public *;
}
-keepattributes JavascriptInterface
-keep class androidx.media3.** { *; }
-dontwarn androidx.media3.**
