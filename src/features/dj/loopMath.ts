/**
 * Loop maths for DJ decks.
 *
 * A loop is a [start, length] pair; everything else (staying inside it,
 * deciding when to jump back) derives from it. Kept pure so the half-open
 * interval rules — the ones that cause audible "loop skips" when wrong — are
 * tested without audio.
 */

/** Loop lengths in beats, offered as one-tap buttons like hardware. */
export const LOOP_BEATS = [0.25, 0.5, 1, 2, 4, 8] as const;

/** Milliseconds of one beat at a given BPM. */
export function beatMs(bpm: number): number {
  if (!Number.isFinite(bpm) || bpm <= 0) return 0;
  return 60_000 / bpm;
}

/** Loop window for `beats` beats starting at `startMs`. */
export function makeLoop(startMs: number, beats: number, bpm: number): { startMs: number; lengthMs: number } | null {
  const length = beatMs(bpm) * beats;
  if (length <= 0) return null;
  return { startMs: Math.max(0, startMs), lengthMs: length };
}

/**
 * Where the playhead should be given a clock position inside an active loop.
 * Returns the corrected position (jumping back when the end is passed).
 */
export function loopedPosition(positionMs: number, loop: { startMs: number; lengthMs: number }): number {
  if (loop.lengthMs <= 0 || positionMs < loop.startMs) return positionMs;
  const offset = (positionMs - loop.startMs) % loop.lengthMs;
  return loop.startMs + offset;
}

/** True when the position is inside the loop window (start inclusive, end exclusive). */
export function insideLoop(positionMs: number, loop: { startMs: number; lengthMs: number }): boolean {
  return positionMs >= loop.startMs && positionMs < loop.startMs + loop.lengthMs;
}

/**
 * Exit point when releasing a loop: resume at the equivalent phase after the
 * loop, so the mix keeps the beat grid instead of rewinding.
 */
export function loopExitPosition(positionMs: number, loop: { startMs: number; lengthMs: number }): number {
  if (!insideLoop(positionMs, loop)) return positionMs;
  const cycles = Math.floor((positionMs - loop.startMs) / loop.lengthMs);
  return loop.startMs + (cycles + 1) * loop.lengthMs;
}

/**
 * BPM from tap timestamps (ms). Uses the last few intervals; returns null when
 * there is not enough data or the taps are implausible (<40 or >220 BPM).
 */
export function tapTempo(tapsMs: readonly number[]): number | null {
  if (tapsMs.length < 3) return null;
  const sorted = [...tapsMs].sort((a, b) => a - b);
  const recent = sorted.slice(-5);
  const intervals: number[] = [];
  for (let i = 1; i < recent.length; i += 1) {
    intervals.push(recent[i] - recent[i - 1]);
  }
  const mean = intervals.reduce((sum, value) => sum + value, 0) / intervals.length;
  if (mean <= 0) return null;
  const bpm = 60_000 / mean;
  if (bpm < 40 || bpm > 220) return null;
  return Math.round(bpm * 100) / 100;
}
