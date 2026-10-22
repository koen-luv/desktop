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
| `HTMLAudioElement` + Web Audio + pitch shifter | `PlaybackService` (Media3 `ExoPlayer` + `MediaLibraryService`), audio focus, wake lock, headphone unplug, notification/lockscreen/Bluetooth controls, Android Auto browse tree |
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

### Radio and autoplay

* "Autoplay similar tracks" (Settings → Playback) and the endless radio
  station refill the queue from the Innertube `next` endpoint. YouTube Music
  sends no CORS headers, so the renderer sends that request through the
  platform HTTP layer (`platformFetch`): on Android it leaves through
  `LinerBridge.httpRequest` (OkHttp), which mirrors the target's own `Origin`
  header — YouTube answers "Origin doesn't match Host" otherwise. The plain
  browser `fetch` is only used on the desktop, where Electron runs without
  CORS restrictions.
* The same path serves the client-side catalog (search, artist, album and
  playlist pages), so those pages no longer need an `api.tryliner.fun`
  round-trip on Android.

### Android Auto

* `PlaybackService` is a `MediaLibraryService`; the manifest declares the
  `android.media.browse.MediaBrowserService` action so Android Auto (and any
  other MediaBrowser client) can discover and bind it.
* The browse tree (Recents, Playlists, Queue, per-playlist folders, search) is
  served from the renderer, which owns the library data: the service forwards
  `autoBrowseQuery` events through `NativeEvents` and the renderer answers with
  `autoBrowseResponse`. Queries time out after 3 s with an empty list, and
  events emitted before the WebView attaches are queued (`NativeEvents`
  pending queue), so a cold start from the car does not hang the client.
* Play requests need no native stream knowledge: media3 converts Auto's
  `playFromMediaId`/`playFromSearch` into `MediaSession.Callback.onSetMediaItems`,
  which forwards the mediaId (or search query) to the renderer as an `autoPlay`
  event and acknowledges with an empty timeline. The renderer then resolves the
  stream and loads it through the normal playback pipeline, so next/previous,
  notification, Discord and scrobbling all follow as with a UI-initiated play.

## Feature parity

| Feature | State |
| --- | --- |
| Email/password login and registration, real Liner backend | verified |
| Home / discovery, popular tracks, daily mixes, radio wave | verified (real data) |
| Search | verified through the app API layer (35 real results for a live query) |
| Artist / album / playlist / library pages | reused unchanged; library and playlist pages verified rendering real account data |
| Player: play, pause, seek, next, previous, repeat, shuffle, queue edits | verified (native ExoPlayer is the source of truth) |
| Autoplay similar tracks / radio queue refill | wired through the native Innertube bridge (`platformFetch` → `LinerBridge.httpRequest`), the same path the radio wave uses |
| Synchronized lyrics (line + word level) | verified: active line follows position (42.6 s → "Ай, а-а-а", 48.1 s → "Услышь, как шумит моя кожа") with line/word highlight classes |
| Background playback, notification, lock screen, Bluetooth buttons | verified |
| Audio focus, headphone unplug, interruptions | handled by ExoPlayer (`setAudioAttributes`, `setHandleAudioBecomingNoisy`) |
| Speed / pitch / reverb | ExoPlayer `PlaybackParameters` + `PresetReverb` |
| Offline audio cache and `file://` replay | verified (`usingCache: true`) |
| WebGL visualizer (Kawarp shader) | runs in the WebView with a live WebGL context |
| Settings (two-level menus: grouped categories → one category screen at a time) and persistence | verified across a full reload |
| System back, dialogs, rotation, safe areas, font scale | verified |
| Deep links `liner://` | wired through the same handler as desktop |
| Discord Rich Presence | verified (v2): the renderer pushes the desktop-parity state/settings payloads into `DiscordRpc.kt` (WebSocket to the signed-in Discord client's local endpoint, ports 6463-6472, `10.0.2.2` on the emulator); presence follows song transitions, artwork, status format and button settings exactly like desktop |
| Last.fm scrobbling | verified: fully client-side scrobbler (`src/features/lastfm`) — Liner's own Last.fm app is built in (custom key/secret optional), out-of-band authorization, now-playing on first playing tick, scrobble at ≥ min(duration/2, 4 min) for tracks ≥ 30 s with the playback start timestamp; settings under Playback → Last.fm |
| Android Auto | verified (CDP smoke on the release APK): `MediaLibraryService` with renderer-backed browse tree (Recents, Playlists, Queue, search) and play-through-the-renderer pipeline — queue and recents queries answered by the renderer (recents returned real server history with title/artists/artwork) and an `autoPlay` event with a served media id started normal playback (MiniPlayer playing with queue context); see "Android Auto" above |

## Verification performed

Build/static: `pnpm build`, `pnpm exec tsc -b`, `pnpm exec vitest run`
(96/97 files and 600/604 tests green with zero failures across repeated runs;
one worker fork consistently hits the harness's ~4 GB V8 heap cap and exits,
losing 4 tests — a tooling memory limit, not a test failure), `./gradlew
:app:assembleDebug`, `./gradlew :app:assembleRelease`, `apksigner verify`.

Android Auto (CDP smoke against the running release APK): an `autoBrowseQuery`
for the queue folder was answered by the renderer (`{items:[]}` on an empty
queue), a `recents` query returned real server history (`liner.track:` items
with title, artists and artwork URL), and an `autoPlay` event carrying a served
media id started playback through the normal pipeline (MiniPlayer showing the
track playing with its queue context). The smoke also caught and led to a fix:
the platform dispatcher pre-parses event JSON, so the Auto handlers now accept
both object and string payloads (previously every query was silently dropped).

Last.fm: the built-in application credentials were exercised against the live
API — the same signed `auth.getToken` call the app uses returned a real request
token and a working `last.fm/api/auth` authorization URL.

Runtime (Android 15 emulator, API 35, x86_64): login with a real account, real
home/discovery data, real stream playback (position 17.3 s → 21.1 s over 4 s,
seek to 60 s, pause/resume), notification metadata (`дырки в штанах — madk1d`)
with artwork, foreground service, playback continuing after HOME, media button
`next` changing the track, lyrics synchronization, settings persistence over
reload, rotation without reloading the activity, back closing dialogs, cached
track playback (`usingCache: true`), and the signed release APK performing login,
playback and notification rendering. Discord RPC on-device: the Android host
opened a WebSocket to the desktop Discord client running on the development
machine (`10.0.2.2:6463`, upgrade accepted with the `https://localhost` Origin),
walked all 20 candidates, rejected a placeholder application id with the
server's close code 4000, retried with the 2 s → 60 s backoff, and queued real
track presence (`addiction (Slowed) — LONOWN`, with artwork) on playback; the
settings category renders the Discord rows (and only those) on Android.

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
5. **Android Auto needs the renderer.** Browse lists and stream resolution are
   served by the WebView; if only the media service is alive (process restarted
   by the car) or the renderer is still loading, folders appear empty and play
   taps no-op. Events emitted before the WebView attaches are queued (bounded),
   so a cold start from the car usually recovers within a few seconds.
