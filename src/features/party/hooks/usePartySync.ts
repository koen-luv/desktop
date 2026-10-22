import { useEffect } from "react";
import { usePlayerStore } from "@/features/player/store/playerStore";
import { playerEngine } from "@/features/player/engine/playerEngine";
import type { Track } from "@/shared/types";
import { type PartyMessage } from "../partySession";
import { usePartyStore } from "../store/partyStore";
import { planResync, type RemotePlaybackState } from "../partyMath";
import {
  resetPlaybackLock,
  setPlaybackLock,
  withPlaybackLockBypass,
} from "../playbackLock";

/** Keep guests' extrapolation clocks fresh while playing. */
const HEARTBEAT_MS = 5000;
/** Between heartbeat and the guest's local drift timer, gaps get corrected. */
const GUEST_DRIFT_TICK_MS = 2000;

/**
 * Every state message carries the current track (so a guest that just joined
 * — or missed an event — can always load it) and the queue whenever the track
 * changed, which is when the queue meaningfully moves.
 */
function buildStateMessage(): PartyMessage {
  const s = usePlayerStore.getState();
  const base = {
    t: "state" as const,
    trackId: s.currentTrack?.id ?? null,
    positionMs: s.positionMs,
    playing: s.status === "playing",
    playbackRate: s.playbackRate,
    sentAt: Date.now(),
  };
  if (!s.currentTrack) return { ...base, track: undefined, queue: [] };
  return {
    ...base,
    track: s.currentTrack,
    queue: s.queue,
    context: s.playbackContext,
    contextCover: s.playbackContextCover,
  };
}

/**
 * Wires the party transport to the player engine.
 *
 * Host: mirrors player-store changes (track, transport, seeks, rate) onto all
 * open connections plus a 5s heartbeat so guests can extrapolate drift between
 * events.
 *
 * Guest: locks local transport controls and applies the host's authoritative
 * state — loading tracks, seeking, matching play/pause — via the lock bypass,
 * with a 2s local drift tick between messages.
 */
export function usePartySync(): void {
  const phase = usePartyStore((s) => s.phase);
  const role = usePartyStore((s) => s.role);
  const guestCount = usePartyStore((s) => s.guests.length);

  // --- Host broadcast -----------------------------------------------------
  useEffect(() => {
    if (role !== "host") return;
    let disposed = false;

    const broadcast = () => {
      if (disposed) return;
      const message = buildStateMessage();
      const store = usePartyStore.getState();
      for (const conn of store.hostConnections.values()) {
        conn.send(message);
      }
    };

    const unsubscribe = usePlayerStore.subscribe((state, prev) => {
      if (disposed) return;
      const trackChanged = state.currentTrack?.id !== prev.currentTrack?.id;
      const queueChanged = state.queue !== prev.queue;
      const transportChanged = state.status !== prev.status;
      const rateChanged = state.playbackRate !== prev.playbackRate;
      // Position ticks stream at poll cadence; only big jumps are seeks.
      const seeked =
        !trackChanged &&
        state.status === prev.status &&
        Math.abs(state.positionMs - prev.positionMs) > 1500;
      if (
        trackChanged ||
        queueChanged ||
        transportChanged ||
        rateChanged ||
        seeked
      ) {
        broadcast();
      }
    });

    // Immediate full state (covers a guest that just connected).
    broadcast();
    const heartbeat = window.setInterval(broadcast, HEARTBEAT_MS);

    return () => {
      disposed = true;
      unsubscribe();
      window.clearInterval(heartbeat);
    };
  }, [role, guestCount, phase]);

  // --- Guest apply + lock -------------------------------------------------
  useEffect(() => {
    if (role !== "guest") return;
    let disposed = false;
    let lastRemote: RemotePlaybackState | null = null;
    setPlaybackLock(true);

    const apply = (message: PartyMessage) => {
      if (disposed || message.t !== "state") return;
      const remote: RemotePlaybackState = {
        trackId: message.trackId,
        positionMs: message.positionMs,
        playing: message.playing,
        sentAt: message.sentAt,
      };
      lastRemote = remote;

      const local = usePlayerStore.getState();
      const localId = local.currentTrack?.id ?? null;

      // Host stopped everything: stand down.
      if (!message.trackId) {
        if (localId) {
          void withPlaybackLockBypass(() => playerEngine.stopAndClear());
        }
        return;
      }

      const track = message.track as Track | undefined;
      if (track && localId !== message.trackId) {
        const queue = (message.queue as Track[] | undefined) ?? [track];
        const load = withPlaybackLockBypass(() =>
          playerEngine.playTrack(
            track,
            queue,
            message.context ?? null,
            message.contextCover ?? null,
          ),
        );
        void load.then(() => {
          if (disposed) return;
          withPlaybackLockBypass(() =>
            playerEngine.seek(message.positionMs, message.playing),
          );
        });
        return;
      }

      const action = planResync(
        {
          trackId: localId,
          positionMs: local.positionMs,
          playing: local.status === "playing",
        },
        remote,
        Date.now(),
      );
      if (action.seekToMs === null && action.play === null) return;
      withPlaybackLockBypass(() => {
        if (action.seekToMs !== null) {
          playerEngine.seek(action.seekToMs, action.play ?? false);
        }
        if (action.play === true) playerEngine.resume();
        else if (action.play === false) playerEngine.pause();
      });
    };

    const unsubscribeMessages =
      usePartyStore.getState().subscribeMessages(apply);

    // Between messages, correct drift that accumulates locally (buffering
    // hiccup, a control that slipped through before the lock engaged, etc.).
    const driftTimer = window.setInterval(() => {
      if (disposed || !lastRemote) return;
      const local = usePlayerStore.getState();
      const action = planResync(
        {
          trackId: local.currentTrack?.id ?? null,
          positionMs: local.positionMs,
          playing: local.status === "playing",
        },
        lastRemote,
        Date.now(),
      );
      if (action.seekToMs === null && action.play === null) return;
      withPlaybackLockBypass(() => {
        if (action.seekToMs !== null) {
          playerEngine.seek(action.seekToMs, action.play ?? false);
        }
        if (action.play === true) playerEngine.resume();
        else if (action.play === false) playerEngine.pause();
      });
    }, GUEST_DRIFT_TICK_MS);

    return () => {
      disposed = true;
      setPlaybackLock(false);
      unsubscribeMessages();
      window.clearInterval(driftTimer);
    };
  }, [role, phase]);

  // Belt-and-braces: never let the lock outlive this hook (app teardown).
  useEffect(() => () => resetPlaybackLock(), []);
}

/** Host: push current state right after a guest connects. */
export function broadcastHostState(): void {
  const store = usePartyStore.getState();
  if (store.role !== "host") return;
  const message = buildStateMessage();
  for (const conn of store.hostConnections.values()) conn.send(message);
}
