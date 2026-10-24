/**
 * Pure drift-correction math for the listen party.
 *
 * The host is authoritative: it broadcasts its playback position with a
 * timestamp, and each guest replays that clock locally (positions advance in
 * real time while playing) instead of waiting for the next message. These
 * helpers decide when a guest is far enough behind/ahead to deserve a seek.
 *
 * Kept dependency-free so it can be unit-tested without a WebRTC runtime.
 */

export interface RemotePlaybackState {
  trackId: string | null;
  positionMs: number;
  playing: boolean;
  /** Host `Date.now()` when the message was produced. */
  sentAt: number;
}

/** Replace a remote wall-clock timestamp with this device's receipt time. */
export function stampPlaybackStateAtReceipt(
  remote: RemotePlaybackState,
  receivedAtMs: number,
): RemotePlaybackState {
  return { ...remote, sentAt: receivedAtMs };
}

export interface LocalPlaybackState {
  trackId: string | null;
  positionMs: number;
  playing: boolean;
}

/** Guests tolerate small network jitter; only larger gaps trigger a seek. */
export const DRIFT_TOLERANCE_MS = 2500;

/** Where the guest should be *now*, extrapolating from the host's message. */
export function expectedPositionMs(
  remote: RemotePlaybackState,
  nowMs: number,
): number {
  if (!remote.playing) return remote.positionMs;
  return remote.positionMs + Math.max(0, nowMs - remote.sentAt);
}

export interface ResyncAction {
  /** Seek here when non-null (host position extrapolated to `nowMs`). */
  seekToMs: number | null;
  /** true → play, false → pause, null → leave transport state alone. */
  play: boolean | null;
}

/**
 * Diff local playback against the host's last known state and decide what
 * (if anything) the guest engine should do. A track-id mismatch is handled
 * by the caller (it needs the full Track to load, not just an id).
 */
export function planResync(
  local: LocalPlaybackState,
  remote: RemotePlaybackState,
  nowMs: number,
): ResyncAction {
  const expected = expectedPositionMs(remote, nowMs);
  const seekToMs =
    Math.abs(local.positionMs - expected) > DRIFT_TOLERANCE_MS
      ? expected
      : null;
  const play = remote.playing !== local.playing ? remote.playing : null;
  return { seekToMs, play };
}
