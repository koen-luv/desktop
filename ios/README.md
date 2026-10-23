# iOS shell

Native port of the Android WebView host (`android/app/src/main/java/app/tryliner/android/`)
so the existing Liner renderer can ship as an `.ipa`.

The project is described by [`project.yml`](./project.yml) and generated with
[XcodeGen](https://github.com/yonaskolb/XcodeGen); there is no checked-in
`.xcodeproj` to drift out of date.

## Build an IPA

CI (`.github/workflows/release.yml`, `build-ios` job, macOS runner) is the
supported path:

```bash
pnpm build
bash ios/sync-web.sh      # dist/ -> ios/Web/
brew install xcodegen
cd ios && xcodegen generate
```

The workflow archives with `CODE_SIGNING_ALLOWED=NO` and packages
`Payload/Liner.app` into `Liner-unsigned.ipa`, uploaded as a build artifact (and
attached to the release on a `v*` tag).

### Installing the unsigned IPA

An unsigned IPA installs only through a sideloading tool that re-signs it with
your Apple ID:

1. Download `Liner-unsigned.ipa` from the workflow artifacts (or the release).
2. Open it with [Sideloadly](https://sideloadly.io) (Windows/macOS) or AltStore.
3. Sign in with a free Apple ID. The app then runs for 7 days, or one year with a
   paid Apple Developer account (bundle id `app.tryliner.ios`).

### Re-signing the IPA by hand

The bundle id is `app.tryliner.ios`. With a paid Apple Developer account and the
app registered in the portal, a signing certificate (`Apple Development` or
`Apple Distribution`) exported as `.p12` and its `.mobileprovision` re-sign the
unsigned IPA on any Mac:

```bash
unzip -q Liner-unsigned.ipa -d out                 # out/Payload/Liner.app
codesign -f -s "Apple Distribution: Your Name (TEAMID)" \
  --entitlements Liner.entitlements out/Payload/Liner.app/Frameworks/*.framework
codesign -f -s "Apple Distribution: Your Name (TEAMID)" \
  --entitlements Liner.entitlements out/Payload/Liner.app
cp Liner.mobileprovision out/Payload/Liner.app/embedded.mobileprovision
cd out && zip -qry ../Liner-signed.ipa Payload
```

The entitlements file must at least carry
`application-identifier` = `TEAMID.app.tryliner.ios` and the
`com.apple.developer.team-identifier` matching the profile, or install fails on
device. Ad-hoc signing (`codesign -s -`) only works for the simulator.

Signing in CI instead: add `IOS_CERT_P12_BASE64`, `IOS_CERT_PASSWORD`,
`IOS_PROVISION_PROFILE_BASE64` and `IOS_TEAM_ID` secrets, import the identity and
profile into a temporary keychain, and archive without the
`CODE_SIGNING_ALLOWED=NO` overrides. Not wired up by default because it needs
credentials that cannot be committed.

## How it maps to the Android shell

| Android | iOS |
| --- | --- |
| `WebViewAssetLoader` on `https://appassets.androidplatform.net` | [`LocalServer.swift`](./Liner/LocalServer.swift) serving `Web/` on `127.0.0.1` (real origin, so localStorage/IndexedDB/service workers keep working; `file://` would not) |
| `addJavascriptInterface(LinerBridge, "LinerAndroid")` | [`LinerBridge.swift`](./Liner/LinerBridge.swift) injecting `window.LinerAndroid` at document start over `WKScriptMessageHandler`; sync getters read a native-pushed mirror |
| `Media3/ExoPlayer` foreground service | [`PlaybackEngine.swift`](./Liner/PlaybackEngine.swift) `AVPlayer` + background audio + `MPNowPlayingInfoCenter` + remote commands |
| `CorsProxy`/`httpRequest` (OkHttp) | [`HttpProxy.swift`](./Liner/HttpProxy.swift) `URLSession`, same host allowlist and `httpResponse` payload |
| Downloads via MediaStore | `URLSession` download into `Documents/Downloads` (Files-app visible) |
| Insets from `WindowInsets` | `safeAreaInsets` pushed as `--inset-*` CSS variables |
| `DiscordRpc.kt` local-socket RPC | Not possible in the iOS sandbox: `discordGetStatus()` reports disconnected |

The renderer is untouched: `src/platform/index.ts` already installs the Android
contract whenever `window.LinerAndroid` exists, and
`src/features/player/engine/runtime.ts` selects the native playback runtime from
that same flag.

### Radio and autoplay

"Autoplay similar tracks" (Settings → Playback) and the radio station refill
the queue from the Innertube `next` endpoint. YouTube Music sends no CORS
headers, so the renderer routes that request through `platformFetch`: on iOS it
leaves through `HttpProxy` (`URLSession`), which mirrors the target's own
`Origin` header the way the Kotlin bridge does on Android. The plain browser
`fetch` is used only on the desktop, where Electron runs without CORS
restrictions.

## Known gaps

- **Pitch / reverb** (`audioSetPitch`, `audioSetReverb`) are no-ops. `AVPlayer`
  cannot shift pitch independently of tempo, and there is no reverb stage;
  speed changes do preserve pitch.
- **Audio disk cache** (`audioCache*`) is a no-op — playback is streaming only on
  both platforms (`AUTO_CACHE_AUDIO = false`).
- **App icon / launch screen**: no 1024 px icon ships in the repo yet, so the
  build uses the default icon. Add `Liner/Assets.xcassets/AppIcon.appiconset`
  and set `ASSETCATALOG_COMPILER_APPICON_NAME` in `project.yml` to brand it.
- **Discord Rich Presence** stays disconnected.
- Requires iOS 15+.
