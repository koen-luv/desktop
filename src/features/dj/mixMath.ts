/**
 * DJ mixing maths.
 *
 * Pure, so the parts that decide what you hear can be tested without audio
 * hardware: the crossfader curve, per-deck trim, tempo → playbackRate, and the
 * equal-power law that keeps perceived loudness steady across the fader.
 */

/** Equal-power crossfader: cos/sin keeps combined power constant. */
export function crossfadeGains(position: number): { a: number; b: number } {
  const t = Math.min(1, Math.max(0, position));
  const angle = (t * Math.PI) / 2;
  return { a: Math.cos(angle), b: Math.sin(angle) };
}

/** Deck output = fader weight × channel trim × (1 if playing, 0 if muted). */
export function deckGain(
  crossfade: { a: number; b: number },
  side: "a" | "b",
  trim: number,
  muted = false,
): number {
  if (muted) return 0;
  const clampedTrim = Math.min(1, Math.max(0, trim));
  return (side === "a" ? crossfade.a : crossfade.b) * clampedTrim;
}

/**
 * Tempo slider (−8% … +8% like a CDJ) mapped onto a playback rate. Pitch is
 * preserved by the media element, so this is a tempo change, not a chipmunk
 * effect.
 */
export const TEMPO_RANGE = 0.08;

export function tempoToRate(percent: number): number {
  const clamped = Math.min(TEMPO_RANGE, Math.max(-TEMPO_RANGE, percent));
  return Number((1 + clamped).toFixed(4));
}

/**
 * How far a deck's clock may drift from the master before it is nudged, in ms.
 * Below this, the correction is audible as a click, above it the decks phase.
 */
export const MAX_DECK_DRIFT_MS = 80;

/** True when `b` should be re-seeked to `a`. */
export function needsResync(masterMs: number, deckMs: number): boolean {
  return Math.abs(masterMs - deckMs) > MAX_DECK_DRIFT_MS;
}

/** mm:ss for deck readouts. */
export function formatDeckTime(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}
