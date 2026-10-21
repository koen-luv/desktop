import { useEffect, useRef } from "react";
import { usePlayerState } from "@/features/player/hooks/usePlayerState";
import type { Track } from "@/shared/types";
import {
  lastfmScrobble,
  lastfmUpdateNowPlaying,
} from "../lib/lastfmClient";
import { lastfmCredentials, useLastfmSettingsStore } from "../store/lastfmSettingsStore";

/**
 * How often listening time is credited while status === "playing".
 * The tick is deliberately coarse: scrobbling only needs second-level
 * accuracy, and a cheap timer costs nothing next to the audio pipeline.
 */
const TICK_MS = 1_000;

/** Last.fm's rule: tracks shorter than 30s are never scrobbled. */
const MIN_SCROBBLE_MS = 30_000;

/** Scrobble after half the track or 4 minutes of listening, whichever is first. */
const MAX_SCROBBLE_MS = 4 * 60 * 1_000;

function artistNamesOf(track: Track): string {
  if (track.artists && typeof track.artists === "string" && track.artists.trim()) {
    return track.artists.trim();
  }
  if (Array.isArray(track.artistList) && track.artistList.length > 0) {
    const names = track.artistList
      .map((entry: { name?: string } | string) => (typeof entry === "string" ? entry : entry?.name))
      .filter(Boolean)
      .join(", ");
    if (names) return names;
  }
  const legacyArtist = (track as { artist?: unknown }).artist;
  if (typeof legacyArtist === "string" && legacyArtist.trim()) return legacyArtist.trim();
  return "Unknown Artist";
}

function albumOf(track: Track): string | undefined {
  if (typeof track.album === "string") return track.album || undefined;
  return track.album?.title || undefined;
}

interface ListenSession {
  trackId: string | null;
  /** Real playing time accumulated for the current track (pauses excluded). */
  listenedMs: number;
  nowPlayingSent: boolean;
  scrobbled: boolean;
}

/**
 * Client-side Last.fm scrobbler.
 *
 * While a track is playing the hook credits one second of listening per tick,
 * sends a now-playing update on the first playing tick of each track, and
 * scrobbles once the official threshold is crossed:
 *   duration ≥ 30s AND listened ≥ min(duration / 2, 4 minutes).
 * The scrobble timestamp is the moment playback of that track started,
 * derived as (now − listenedMs) so pauses never shift it.
 *
 * Everything no-ops until the user connects an account in settings.
 */
export function useLastfmScrobbler() {
  const player = usePlayerState();

  // Latest snapshot for the interval closure — the tick must not restart
  // every time positionMs updates.
  const playerRef = useRef(player);
  playerRef.current = player;

  const sessionRef = useRef<ListenSession>({
    trackId: null,
    listenedMs: 0,
    nowPlayingSent: false,
    scrobbled: false,
  });

  // The scrobbler only runs when a completed account is on file.
  const enabled = useLastfmSettingsStore((s) => s.enabled);
  const apiKey = useLastfmSettingsStore((s) => s.apiKey);
  const apiSecret = useLastfmSettingsStore((s) => s.apiSecret);
  const sessionKey = useLastfmSettingsStore((s) => s.sessionKey);

  useEffect(() => {
    const credentials = lastfmCredentials({
      enabled,
      apiKey,
      apiSecret,
      sessionKey,
      username: null,
    });
    if (!enabled || !sessionKey) return;

    const tick = () => {
      const snapshot = playerRef.current;
      const session = sessionRef.current;
      const track = snapshot.currentTrack;
      const trackId = track?.id ?? null;

      // New track (or nothing playing): start a fresh listen session.
      if (session.trackId !== trackId) {
        session.trackId = trackId;
        session.listenedMs = 0;
        session.nowPlayingSent = false;
        session.scrobbled = false;
      }

      if (!track || snapshot.status !== "playing") return;

      session.listenedMs += TICK_MS;

      if (!session.nowPlayingSent) {
        session.nowPlayingSent = true;
        void lastfmUpdateNowPlaying(credentials, sessionKey, {
          artist: artistNamesOf(track),
          track: track.title,
          album: albumOf(track),
          durationMs: track.durationMs || snapshot.durationMs,
        }).catch((error) => {
          console.warn("[lastfm] now-playing update failed:", error);
        });
      }

      if (session.scrobbled) return;

      const durationMs = track.durationMs || snapshot.durationMs || 0;
      const thresholdMs = Math.min(durationMs / 2, MAX_SCROBBLE_MS);
      if (durationMs >= MIN_SCROBBLE_MS && session.listenedMs >= thresholdMs) {
        session.scrobbled = true;
        const startedAtSeconds = Math.floor((Date.now() - session.listenedMs) / 1000);
        void lastfmScrobble(
          credentials,
          sessionKey,
          {
            artist: artistNamesOf(track),
            track: track.title,
            album: albumOf(track),
            durationMs,
          },
          startedAtSeconds,
        ).catch((error) => {
          console.warn("[lastfm] scrobble failed:", error);
        });
      }
    };

    const timer = window.setInterval(tick, TICK_MS);
    return () => window.clearInterval(timer);
  }, [enabled, apiKey, apiSecret, sessionKey]);
}
