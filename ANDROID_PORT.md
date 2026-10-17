# Liner for Android

The desktop application in this repository now also ships as a native Android app.
The Electron renderer is reused unchanged; a thin platform boundary supplies the
Android implementations of everything Electron used to provide, plus a real
Media3 playback service.

```
desktop (unchanged)                     android
Electron main/preload  ──┐              MainActivity (WebView) + LinerBridge
                         ├─ window.linerElectron ─┐
LinerBridge (Kotlin)   ──┘                       ├─ React/TS renderer (same code)
                                                 │
                       window.LinerAndroid ──────┘
                                │
                ┌───────────────┼────────────────┬──────────────┐
         PlaybackService   CorsProxy          Http (OkHttp)   AudioCache
         (Media3 ExoPlayer) (CORS-safe fetch)  native fetch    file:// playback
```

## Build

Prerequisites: Node 20+, pnpm, JDK 17+, Android SDK (compile SDK 35, build-tools 35).

```bash
# 1. web bundle (also builds the Electron main/preload, so desktop stays intact)
pnpm install
pnpm build

# 2. android (Gradle copies ../dist into app/src/main/assets automatically)
cd android
./gradlew :app:assembleRelease    # signed APK: app/build/outputs/apk/release/app-release.apk
./gradlew :app:assembleDebug      # debug APK: app/build/outputs/apk/debug/app-debug.apk
./gradlew :app:installDebug       # install on the attached device
```

Release signing is read from `android/keystore.properties` (gitignored):

```properties
storeFile=liner-release.jks
storePassword=…
keyAlias=liner
keyPassword=…
```

Without that file the release build is unsigned, which is intentional: no key
material is committed.

Install on a device:

```bash
adb install -r android/app/build/outputs/apk/release/app-release.apk
```

## Platform boundary

| Desktop (Electron) | Android implementation |
| --- | --- |
| `signRequest`, `signCoverUrl`, `syncServerTime` (native) | the same production WASM signer, bundled into the renderer (`src/platform/signerWasm.ts`) |
| `net.fetch` through the main process | `LinerBridge.httpRequest` (OkHttp, async response events) for POST/PUT/PATCH/DELETE and YouTube hosts; `shouldInterceptRequest` (`CorsProxy.kt`) rewrites duplicated `Access-Control-Allow-Origin` headers for GET/HEAD and streams SSE lyrics |
| localStorage / IndexedDB | the same WebView storage; the app cache is exposed through `getCacheStats`, `clearCoversCache`, `clearAudioCache`, `clearHttpCache` |
| `HTMLAudioElement` + Web Audio + pitch shifter | `PlaybackService` (Media3 `ExoPlayer` + `MediaSessionService`), audio focus, wake lock, headphone unplug, notification/lockscreen/Bluetooth controls |
| `shell.openExternal`, clipboard, share | `openExternal`, `copyText`, `shareText` |
| deep links via `liner://` protocol handler | `liner://` intent filter → `__linerAndroidEmit("deeplink", …)` |
| window controls, Hyprland overlay, Touch Bar sync | not applicable on Android (no dead code is shipped in their place) |

Request signing is unchanged: the Android build runs the exact WASM module the
desktop build uses, and every API request keeps its signature, timestamp and
nonce. Nothing is signed with a secret baked into the APK.

### Playback

* Stream resolution is the desktop algorithm (`streamResolver.ts`): the API
  returns a playback session; for `direct_innertube` sessions the WebView asks
  YouTube through the native bridge with a fresh visitor token, then hands the
  resulting URL to ExoPlayer.
* `PlaybackHolder` is the single owner of the ExoPlayer instance; the renderer
  polls `audioState()` so position/duration/buffering always come from the player,
  never from a timer.
* Downloaded tracks are cached as files and replayed from `file://` (the media
  source factory resolves both file and HTTP sources).
* `PlaybackService` is a foreground service with a media notification showing
  title, artist, artwork and previous/play-pause/next actions; it keeps playing
  when the activity is backgrounded, promotes itself to foreground before the
  five second deadline, and stops itself when a load never turns into playback.

## Feature parity

| Feature | State |
| --- | --- |
| Email/password login and registration, real Liner backend | verified |
| Home / discovery, popular tracks, daily mixes, radio wave | verified (real data) |
| Search | verified through the app API layer (35 real results for a live query) |
| Artist / album / playlist / library pages | reused unchanged; library and playlist pages verified rendering real account data |
| Player: play, pause, seek, next, previous, repeat, shuffle, queue edits | verified (native ExoPlayer is the source of truth) |
| Synchronized lyrics (line + word level) | verified: active line follows position (42.6 s → "Ай, а-а-а", 48.1 s → "Услышь, как шумит моя кожа") with line/word highlight classes |
| Background playback, notification, lock screen, Bluetooth buttons | verified |
| Audio focus, headphone unplug, interruptions | handled by ExoPlayer (`setAudioAttributes`, `setHandleAudioBecomingNoisy`) |
| Speed / pitch / reverb | ExoPlayer `PlaybackParameters` + `PresetReverb` |
| Offline audio cache and `file://` replay | verified (`usingCache: true`) |
| WebGL visualizer (Kawarp shader) | runs in the WebView with a live WebGL context |
| Settings (playback, audio, appearance, customization) and persistence | verified across a full reload |
| System back, dialogs, rotation, safe areas, font scale | verified |
| Deep links `liner://` | wired through the same handler as desktop |

## Verification performed

Build/static: `pnpm build`, `pnpm exec tsc -b`, `pnpm test` (49 files, 290 tests),
`./gradlew :app:assembleDebug`, `./gradlew :app:assembleRelease`,
`apksigner verify`.

Runtime (Android 15 emulator, API 35, x86_64): login with a real account, real
home/discovery data, real stream playback (position 17.3 s → 21.1 s over 4 s,
seek to 60 s, pause/resume), notification metadata (`дырки в штанах — madk1d`)
with artwork, foreground service, playback continuing after HOME, media button
`next` changing the track, lyrics synchronization, settings persistence over
reload, rotation without reloading the activity, back closing dialogs, cached
track playback (`usingCache: true`), and the signed release APK performing login,
playback and notification rendering.

## Known limitations

1. **Physical device network.** On the Xiaomi 23129RN51X (MIUI 14) used for
   testing, DNS resolution fails for the app UID (`Unable to resolve host
   "api.tryliner.fun"`) while the same host resolves from the shell and other
   apps. This is a per-app network restriction of that device's OS, not an app
   error; the app reports the failure through its normal error states. Runtime
   verification was completed on the emulator instead. Allow network access for
   `app.tryliner.android` in MIUI's data-usage settings on such devices.
2. **Expired stream URLs.** A CDN can reject a resolved URL with an HTTP status
   after it expires. The player surfaces the error and the queue advances to the
   next track; a transparent re-resolve/retry is not implemented yet.
3. **Reverb and pitch** use Android's `PresetReverb`/`PlaybackParameters`, which
   approximate the desktop Web Audio graph rather than matching it exactly.
4. **Electron-only surfaces** (custom window chrome, Hyprland overlay, Touch Bar,
   tray, auto-updater) have no Android equivalent and are not exposed there.
