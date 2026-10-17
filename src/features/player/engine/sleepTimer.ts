/** Presets offered for the sleep timer, in minutes. */
export const SLEEP_TIMER_PRESETS_MINUTES = [15, 30, 45, 60, 90] as const;

/** Absolute epoch-ms deadline for a "play for N more minutes" timer. */
export function sleepDeadlineFromMinutes(minutes: number, nowMs = Date.now()): number {
  return nowMs + Math.max(1, Math.round(minutes)) * 60_000;
}

/** Milliseconds left before a deadline (0 when off or already passed). */
export function sleepRemainingMs(endsAtMs: number | null, nowMs = Date.now()): number {
  if (!endsAtMs) return 0;
  return Math.max(0, endsAtMs - nowMs);
}

/** "m:ss" countdown label for the remaining time. */
export function formatSleepRemaining(ms: number): string {
  const totalSec = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSec / 60);
  const seconds = totalSec % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}
