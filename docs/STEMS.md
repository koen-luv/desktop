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

## Desktop: hosted Demucs API (default)

On desktop the separation does **not** go through the Worker. The Electron main
process does the whole job (`electron/stems-store.ts`):

1. fetch the track audio, base64 it, `POST {endpoint}/predict`
   `{ "instances": [{ "b64": "…" }] }`
2. decode the four base64 mp3s from the response (`vocals/drums/bass/other`)
3. write them to `userData/stems/<trackId>/` and hand the renderer local paths

Default endpoint: `https://demucs-api-hwbhnojdya-uc.a.run.app` (override with
`LINER_DEMUCS_ENDPOINT`). Cached stems are reused forever; `stemsClear(trackId)`
removes them. The renderer then plays four media elements through one
AudioContext with per-stem `GainNode`s (mute/solo from `mix.ts`).

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

## Not implemented yet

The **mixer** — four faders with mute/solo that play in sync with the transport.
That is deliberately left out of this change because it needs a decision:

- **Desktop**: Web Audio (`MediaElementSource` per stem into `GainNode`s) — works
  today, the runtime already owns an AudioContext.
- **Android**: ExoPlayer holds one player per stem (four players, one clock) or a
  native mixing stage; heavier, and the foreground service has to own it.

Say which target to build first and the mixer follows on top of this contract.
Caching (separated stems are expensive — one separation per track should persist
in IndexedDB / the audio cache) belongs in the same change.
