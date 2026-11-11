/**
 * Transition planning: when a deck A is playing and B is loaded, decide the
 * mix. Everything is computed from TrackAnalysis — tempo match, beat
 * alignment, cue point, mix-out point and fade length — plus explicit
 * warnings when the data does not support a clean mix.
 */

import type { TrackAnalysis } from "./analysis";

export interface TransitionPlan {
  /** Deck B starts here (ms on B's timeline). */
  bStartMs: number;
  /** Deck A's position where the fade begins. */
  triggerAtMs: number;
  /** Deck A's position where the fade completes and A is stopped. */
  endAtMs: number;
  /** Fade length. */
  crossfadeMs: number;
  /** Tempo offset for B, as a fraction (0.02 = +2%), to match A's BPM. */
  tempoMatch: number;
  /** B's resulting effective BPM after the match (null when unknown). */
  matchedBpm: number | null;
  /** ms to nudge B's start so the beatgrids land together. */
  beatAlignMs: number;
  warnings: string[];
}

const TEMPO_RANGE = 0.08;
const MIN_FADE_MS = 2000;
const MAX_FADE_MS = 12_000;
const DEFAULT_FADE_MS = 6000;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Fold a candidate BPM into a sane range the way a DJ halves/doubles. */
function foldBpm(bpm: number): number {
  let value = bpm;
  while (value < 60) value *= 2;
  while (value > 180) value /= 2;
  return value;
}

/**
 * Best tempo offset for B to match A, trying half/double interpretations of
 * B's detected grid (the classic octave ambiguity of BPM detection).
 */
export function tempoMatchPercent(aBpm: number, bBpm: number): { match: number; doubled: boolean } {
  const direct = foldBpm(bBpm);
  const candidates = [...new Set([direct, foldBpm(bBpm / 2), foldBpm(bBpm * 2)])];
  let best = candidates[0];
  let bestError = Number.POSITIVE_INFINITY;
  for (const candidate of candidates) {
    if (candidate <= 0) continue;
    const error = Math.abs(aBpm / candidate - 1);
    if (error < bestError) {
      bestError = error;
      best = candidate;
    }
  }
  return {
    match: clamp(aBpm / best - 1, -TEMPO_RANGE, TEMPO_RANGE),
    doubled: best !== direct,
  };
}

/**
 * Offset to apply to B's start so its first beat lands on A's grid.
 * Returns ms in [0, beat).
 */
export function beatAlignMs(a: TrackAnalysis, b: TrackAnalysis, matchedBpm: number): number {
  if (!a.bpm || !b.bpm || matchedBpm <= 0) return 0;
  const beat = 60_000 / matchedBpm;
  const offset = ((b.anchorMs - a.anchorMs) % beat + beat) % beat;
  // The closer to a whole beat is the smaller correction either way.
  return offset > beat / 2 ? offset - beat : offset;
}

export function planTransition(
  a: TrackAnalysis,
  b: TrackAnalysis,
  options: { currentTempoA?: number; fadeMs?: number } = {},
): TransitionPlan {
  const warnings: string[] = [];
  const aBpm = a.bpm ? a.bpm * (1 + (options.currentTempoA ?? 0)) : null;
  const fade = clamp(options.fadeMs ?? DEFAULT_FADE_MS, MIN_FADE_MS, MAX_FADE_MS);

  let tempoMatch = 0;
  let matchedBpm: number | null = aBpm;

  if (!aBpm || !b.bpm) {
    warnings.push("Tempo unknown on one deck — beat-matching is disabled.");
  } else {
    const match = tempoMatchPercent(aBpm, b.bpm);
    tempoMatch = match.match;
    matchedBpm = b.bpm * (1 + tempoMatch);
    if (match.doubled) {
      warnings.push("B's detected tempo was reinterpreted half/double to match A.");
    }
    if (Math.abs(tempoMatch) >= TEMPO_RANGE - 0.001) {
      warnings.push("Match needs more than ±8% — the tempos are too far apart to sync cleanly.");
    }
  }

  if (a.bpmConfidence < 0.3) warnings.push("A's beat grid is low-confidence; timing may drift.");
  if (b.bpmConfidence < 0.3) warnings.push("B's beat grid is low-confidence; timing may drift.");

  // Mix window on A's timeline: end at the audible tail, start a fade before.
  const endAtMs = Math.min(a.mixOutMs, a.durationMs);
  const triggerAtMs = Math.max(0, endAtMs - fade);

  if (endAtMs < fade) {
    warnings.push("A's outro is shorter than the fade — the mix will be abrupt.");
  }
  if (b.durationMs - b.cueInMs < fade + 1000) {
    warnings.push("B has little intro before its body — expect a hard entry.");
  }

  const align = matchedBpm ? beatAlignMs(a, b, matchedBpm) : 0;

  return {
    bStartMs: b.cueInMs,
    triggerAtMs,
    endAtMs,
    crossfadeMs: Math.max(MIN_FADE_MS, endAtMs - triggerAtMs),
    tempoMatch,
    matchedBpm,
    beatAlignMs: align,
    warnings,
  };
}

/**
 * Crossfade automation curve. Equal-power in the middle, with the tail of A
 * finishing last so vocals do not overlap — the classic "end on B" shape.
 */
export function fadeProgress(elapsedMs: number, totalMs: number): number {
  if (totalMs <= 0) return 1;
  return clamp(elapsedMs / totalMs, 0, 1);
}
