# Neritium for the web

The same renderer runs in a browser tab. There is no second UI: the website is
the app, served as static files, with the native boundary implemented in
browser APIs.

```bash
pnpm dev:web      # vite --mode web  (no Electron bundle)
pnpm build:web    # static site in dist/ → any static host
```

`dist/` is a complete site: `index.html`, `assets/`, `manifest.webmanifest`,
`icon.png`, `cover-sw.js`.

## How the port works

`src/platform/web.ts` installs a `window.neritiumElectron`-compatible object when
neither Electron nor Android is present (`installWebPlatform()` in
`src/main.tsx`, right after the Android installer). Everything downstream keeps
using one contract:

| Capability | Website implementation |
| --- | --- |
| Request / cover signing, server clock | the same production WASM signer used on desktop and Android, instantiated in the page |
| Auth session | `localStorage` (`neritium_auth_session`), refreshed in-page |
| Playback | `HTMLAudioElement` + Web Audio runtime, Media Session for OS controls |
| Downloads | resolved blob → anchor download |
| Diagnostics dump | blob download |
| Cache clearing / stats | Cache Storage + `navigator.storage.estimate()` |
| App icon | favicon and manifest icon |

Left absent on purpose, because a tab cannot do them: window controls, the
overlay window, Discord RPC, LAN device control and the in-app updater. Every
call site already uses optional chaining, so those surfaces hide instead of
showing dead controls, and `pnpm build:web` never ships the Electron bundle.

## Differences you will feel

- **Background playback** depends on the browser. Android keeps playing because
  a foreground service owns the player; a tab can be suspended when it is
  hidden. The Media Session integration keeps OS controls working while the tab
  is alive.
- **Playback goes through the backend.** A browser cannot call YouTube (CORS)
  and a direct googlevideo URL is bound to the resolving IP, so the client-side
  Innertube path is disabled on the web and resolution uses
  `POST /v1/tracks/:id/playback`. That route now exists in `api-worker`: it
  resolves the audio server-side and returns a signed `/v1/stream/<token>` URL,
  which proxies the bytes with Range passthrough. Desktop and Android keep the
  direct path.
- **No equalizer on the web.** Web Audio can only read CORS-readable media, so
  the graph is skipped; speed/pitch still apply through the media element.
- **Lyrics** fall back to LRCLIB when the backend answers `404 CLIENT_ONLY`, so
  line-synced lyrics still appear on the website.
- **Parties** work, but guests need the host's browser tab open; there is no TURN
  relay.
- **Downloads** land in the browser's download folder, not in a Neritium-managed
  directory.

## Hosting notes

- Serve `dist/` over HTTPS; the media and API hosts are HTTPS-only.
- **Backend**: the website talks to `api-worker/` in this repository. Without
  `VITE_API_URL` the built site uses the deployed Worker
  (`https://liner-api.lucabatarcian.workers.dev`, from `src/shared/api/baseUrl.ts`);
  set `VITE_API_URL` to your own deploy. For local work run `pnpm dev:api` and
  build with `VITE_API_URL=http://localhost:8787`.
- The Worker's `ALLOWED_ORIGINS` is `*` in `wrangler.toml`, so the site works
  out of the box. If you pin it to an allowlist, add the site's origin.
- No service worker is registered yet, so the shell is not offline-cached: only
  downloaded tracks play without a network.
