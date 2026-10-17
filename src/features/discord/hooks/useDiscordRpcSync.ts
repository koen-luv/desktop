import { useEffect } from "react";
import { usePlayerStore } from "@/features/player";
import { useDiscordSettingsStore } from "../store/discordSettingsStore";
import { buildDiscordPresence } from "../lib/buildPresence";

/** Minimum gap between presence pushes (Discord rate-limits SET_ACTIVITY). */
const MIN_SEND_INTERVAL_MS = 5_000;
/** Position drift below this is normal playback advance, not a seek. */
const POSITION_SKEW_MS = 2_000;
/** Periodic refresh so the elapsed timer stays accurate and presence stays alive. */
const REFRESH_INTERVAL_MS = 20_000;

/**
 * Mirrors the player store into Discord Rich Presence on the desktop app.
 *
 * Runs only where `window.linerElectron` exists (Electron). Discord has no
 * rich-presence API for Android apps and the web build would need a separate
 * OAuth flow, so those platforms simply no-op here.
 *
 * Sending is throttled: a track/status change or a real seek pushes
 * immediately, but the steady advance of playback does not — the rendered
 * elapsed timer is anchored to a `start` timestamp Discord ticks on its own.
 */
export function useDiscordRpcSync() {
  const enabled = useDiscordSettingsStore((s) => s.enabled);
  const clientId = useDiscordSettingsStore((s) => s.clientId);
  const api = window.linerElectron;

  // Connect/disconnect the main-process IPC client whenever the setting changes.
  useEffect(() => {
    if (!api?.discordRpcConfigure) return;
    api.discordRpcConfigure(clientId, enabled);
  }, [api, clientId, enabled]);

  useEffect(() => {
    if (!api?.discordRpcSetPresence) return;

    if (!enabled || !clientId) {
      api.discordRpcClear();
      return;
    }

    let lastSentAt = 0;
    let lastSentKey = "";

    const send = (force = false) => {
      const s = usePlayerStore.getState();
      const track = s.currentTrack;

      if (!track || (s.status !== "playing" && s.status !== "paused")) {
        if (lastSentKey !== "clear") {
          lastSentKey = "clear";
          api.discordRpcClear();
        }
        return;
      }

      const key = `${track.id}:${s.status}:${Math.round(s.positionMs / POSITION_SKEW_MS)}`;
      if (!force) {
        if (key === lastSentKey) return;
        if (Date.now() - lastSentAt < MIN_SEND_INTERVAL_MS) return;
      }

      const activity = buildDiscordPresence({
        status: s.status,
        title: track.title,
        artist: track.artists || "",
        album: track.album?.title || "",
        coverUrl: track.coverUrl,
        positionMs: s.positionMs,
        nowMs: Date.now(),
      });

      lastSentAt = Date.now();
      lastSentKey = key;
      api.discordRpcSetPresence(activity);
    };

    const unsubscribe = usePlayerStore.subscribe((state, prev) => {
      if (
        state.status !== prev.status ||
        state.currentTrack?.id !== prev.currentTrack?.id ||
        Math.abs(state.positionMs - prev.positionMs) > POSITION_SKEW_MS
      ) {
        send();
      }
    });

    send(true);
    const timer = setInterval(() => send(true), REFRESH_INTERVAL_MS);

    return () => {
      unsubscribe();
      clearInterval(timer);
      api.discordRpcClear();
    };
  }, [api, enabled, clientId]);
}
