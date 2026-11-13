# Stem separation

Splitting a track into vocals / drums / bass / other is the one feature that
cannot live in this repository's compute: Demucs-class models need a GPU and
minutes of RAM, while the API runs in a 128 MB Cloudflare isolate and the phone
has no model runtime. So the app owns everything except the model.

## What is implemented

- **Backend front door** (`api-worker/src/stems.ts`)
  - `GET /v1/stems/status` → `{ available, reason? }`
  - `POST /v1/tracks/:id/stems` `{ audioUrl }` → `{ trackId, stems: [{ name, url }] }`
  - Proxies to your service when `STEMS_SERVICE_URL` is set (optional
    `STEMS_SERVICE_TOKEN` bearer), and answers `501 STEMS_UNAVAILABLE` when it is
    not, so the client can hide the feature instead of offering a dead button.
  - Only the four names the mixer understands survive the proxy; anything else
    becomes `other`.
- **Client** (`src/features/stems/api.ts`): availability probe (cached 5 min),
  `separateStems(trackId, audioUrl)`, typed `Stem`/`StemName`, and a dedicated
  `StemsUnavailableError` so callers branch on capability, not on strings.
- **Worker tests** (`api-worker/src/stems.test.ts`): unavailability, status,
  input validation, forwarding + filtering, too-few-stems, unreachable service.

## Desktop: local Demucs, then a hosted API

On desktop the separation does **not** go through the Worker. The Electron main
process owns the whole job (`electron/stems-store.ts`) and tries, in order:

1. **Local Demucs CLI** — if `demucs` is on `PATH` (or `NERITIUM_DEMUCS_PATH`
   points at an executable), the audio is downloaded to a temp dir and split by
   `demucs -n htdemucs`. The four WAVs are copied into the cache. Nothing is
   uploaded, and it works offline.
2. **Hosted Demucs API** — otherwise the audio is base64'd and `POST`ed to
   `{endpoint}/predict` `{ "instances": [{ "b64": "…" }] }`, whose four base64
   mp3s are written to the cache. Default endpoint
   `https://demucs-api-hwbhnojdya-uc.a.run.app`, override with
   `LINER_DEMUCS_ENDPOINT`.
3. Either way the stems land in `userData/stems/<trackId>/`, and the renderer
   receives local paths. Cached stems are reused forever; `stemsClear(trackId)`
   removes them.

Install the local engine with `pip install demucs` (a GPU is optional; CPU is
slower but works). The first run downloads the model weights (~80 MB).

The renderer then plays four media elements through one AudioContext with
per-stem `GainNode`s (mute/solo from `mix.ts`).

Entry point: song menu → **Separate stems (DJ)** (desktop only).

## What a self-hosted service must do

Any HTTP wrapper around `demucs` works. The contract is intentionally tiny:

```
POST {STEMS_SERVICE_URL}/separate
Authorization: Bearer {STEMS_SERVICE_TOKEN}   # only if the token is set
{ "trackId": "dQw4w9WgXcQ", "audioUrl": "https://…" }

200 →
{ "stems": [
  { "name": "vocals", "url": "https://…/vocals.m4a" },
  { "name": "drums",  "url": "https://…/drums.m4a" },
  { "name": "bass",   "url": "https://…/bass.m4a" },
  { "name": "other",  "url": "https://…/other.m4a" }
] }
```

Minimal reference implementation (CPU is slow, GPU recommended):

```bash
pip install demucs fastapi uvicorn
# POST /separate → download audioUrl → demucs --two-stems=vocals → upload stems
# → reply with the four URLs
```

Then, in `api-worker/wrangler.toml` or via `wrangler secret put`:

```
STEMS_SERVICE_URL = "https://stems.example.com"
STEMS_SERVICE_TOKEN = "…"   # optional
```

## Mixer

The **mixer** is implemented (`src/features/stems/engine.ts` + `StemsPanel.tsx`):
four `HTMLAudioElement`s, one `MediaElementAudioSourceNode` and one `GainNode`
each, all fed from a single `AudioContext`. Faders, mute and solo are real gain
changes (`mix.ts`), and stems are re-seeked only when drift passes 120 ms.

- **Cache first**: the panel asks the main process for cached stems before it
  asks Demucs, so opening the mixer twice never separates twice. Cached files
  are returned to the renderer as `file://` URLs (an OS path is not a URL and
  silently failed to load).
- **Availability**: the menu entry appears when the desktop bridge exists or
  when `/v1/stems/status` reports a configured service, so the feature is also
  offered on the web and Android builds that deploy one.
- **Transport**: opening the mixer pauses the normal player for that track (two
  transports must not play at once). Closing it stops the stems; the main player
  stays paused.
- **Android**: the mixer graph runs in the WebView, so it is a foreground tool;
  background playback remains the native Media3 service's job.

Separation is still expensive and happens once per track. The desktop cache is
`userData/stems/<trackId>/`; the worker path streams service URLs for the
session when no on-disk cache exists.
