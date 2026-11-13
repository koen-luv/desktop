# Optional yt-dlp fallback

The desktop app can use a locally installed [yt-dlp](https://github.com/yt-dlp/yt-dlp)
as an extra playback source. It is **not bundled and never downloaded at
runtime** — install it yourself and the app picks it up.

## Why

Innertube extraction can be refused by YouTube (bot check, missing PO token,
stale player client). yt-dlp ships its own player clients and is updated
independently of the app, so it resolves videos that our in-renderer extractor
cannot. It is used only as a fallback: normal resolution runs first and stays
the fast path.

## Where it sits

- Desktop playback (`src/features/player/engine/streamResolver.ts`): after the
  Neritium R2 master and the direct Innertube extractor both fail.
- Provider chain (`src/features/player/sources/providers.ts`, priority 95):
  after `innertube-client` and `neritium-auto`, before the derived
  `neritium-direct-*` / `neritium-proxy-*` providers. This covers downloads,
  stems and the DJ surface.
- Android and the website cannot spawn a process, so the provider/fallback is
  skipped there automatically.

## Installing

Any of these locations work (first match wins):

1. `NERITIUM_YTDLP_PATH` or `YTDLP_PATH` environment variable pointing at the
   binary
2. `<userData>/bin/yt-dlp` (`yt-dlp.exe` on Windows) — drop-in location
3. `<resources>/bin/yt-dlp`
4. `<app root>/bin/yt-dlp`
5. `yt-dlp` on `PATH`

The binary is probed with `yt-dlp --version`; a missing binary is re-checked
after a minute, so installing it while the app is running works without a
restart.

Resolution runs `yt-dlp --no-playlist -f bestaudio/best -j <url>`, with a 20 s
timeout, and maps the returned direct audio URL, MIME type, codec, bitrate and
`expire` timestamp into the same stream shape the other sources use.

## Notes

- yt-dlp prints the direct `googlevideo` URL; the media element plays it with
  the app's own user agent. If YouTube starts rejecting those, update yt-dlp
  first — that is where the fixes land.
- Only 11-character YouTube video ids are accepted over IPC; everything else
  returns `{ ok: false }` and the caller keeps its normal fallback chain.
