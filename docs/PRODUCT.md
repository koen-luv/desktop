# Neritium — product facts for interface work

Keep this file true. Interface claims must trace to a line here.

## What it is

A music player for a library you own. Streams resolve from the app's own API /
self-hosted server, play through a native pipeline on each platform, and can be
downloaded for offline use. There is no subscription catalogue.

## Users and jobs

1. **Listener with a library** — open app, resume what was playing, play a
   playlist, keep it going in the background with the screen off.
2. **Curator** — import from Spotify / Apple Music / SoundCloud / YouTube,
   merge duplicates, reorder, share a playlist with a link.
3. **Offline listener** — download tracks, play them with no network.
4. **Party host** — start a listen party; guests follow the host's playback.

## Real facts

- Playback: HTMLAudioElement + Web Audio on desktop; Media3/ExoPlayer on Android.
- Background playback on Android is native; queue advancement, error-skipping,
  crossfade and repeat are handled by the service, not the WebView.
- Crossfade presets: auto (overlap), off, fade-in, fade-out, soft, medium, long,
  swell.
- Lyrics come from several providers with a sync-quality score; line and
  word-level highlighting, with a per-track offset control.
- Library storage is local (IndexedDB) plus the account API.
- Accent/branding variants are user-selectable (13 variants) and the launcher
  icon follows the choice on Android and desktop.

## Non-goals

- No social feed, no recommendation carousel marketing surface.
- No fabricated listening statistics: numbers shown come from the account API.

## Content gaps

Copy is localized (en/es/ru/uk) through `@/languages`; new interface strings
must ship a key, not inline English.
