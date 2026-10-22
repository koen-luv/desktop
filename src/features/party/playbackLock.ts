/**
 * Guest control guard for listen parties.
 *
 * When this app is a *guest* in someone else's party, local transport actions
 * (play/pause/seek/skip from buttons, media keys, the Android notification)
 * must not fight the host's authoritative state. The engine consults
 * `isLocalPlaybackLocked()` before honoring user-initiated commands.
 *
 * The sync applier itself needs to drive the engine, so it wraps its calls in
 * `withPlaybackLockBypass()` — the lock stays "on" for user actions while the
 * applier runs. Deliberately dependency-free: `playerEngine` imports this and
 * must not pull the whole party feature (or its WebRTC graph) into the engine.
 */

let locked = false;
let bypassDepth = 0;

export function setPlaybackLock(next: boolean): void {
  locked = next;
}

export function isPlaybackLocked(): boolean {
  return locked && bypassDepth === 0;
}

export function withPlaybackLockBypass<T>(fn: () => T): T {
  bypassDepth += 1;
  try {
    return fn();
  } finally {
    bypassDepth -= 1;
  }
}

/** Test helper: reset module state between cases. */
export function resetPlaybackLock(): void {
  locked = false;
  bypassDepth = 0;
}
