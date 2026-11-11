/**
 * Track structure analysis for auto-mix decisions.
 *
 * From the decoded PCM we derive what a DJ actually reads off a waveform:
 * where the track really starts (first sustained energy), where it ends
 * (last sustained energy), the tempo and beat anchor, and a coarse energy
 * profile. Heuristic by design — every number is computed from the audio,
 * nothing is guessed from metadata.
 */

import { computePeaks, toMono } from "./waveform";
import { detectBpm } from "./bpm";
import type { WaveformPeaks } from "./waveform";

export interface TrackAnalysis {
  durationMs: number;
  bpm: number | null;
  /** 0..1; below ~0.2 the grid should not be trusted. */
  bpmConfidence: number;
  /** First onset of the beat grid, folded into one beat period. */
  anchorMs: number;
  /** Where a DJ should cue in: start of the first sustained energy. */
  cueInMs: number;
  /** Where the audible body ends: last sustained energy + one window. */
  mixOutMs: number;
  /** ~1 s RMS windows, normalised to the loudest window. */
  energy: number[];
  peaks: WaveformPeaks;
}

const ENERGY_WINDOW_MS = 1000;

/** RMS per ~1 s window, normalised so the loudest window is 1. */
export function energyProfile(samples: Float32Array, sampleRate: number): number[] {
  const window = Math.max(1, Math.floor((sampleRate * ENERGY_WINDOW_MS) / 1000));
  const frames = Math.max(1, Math.floor(samples.length / window));
  const out: number[] = [];
  let max = 0;
  for (let frame = 0; frame < frames; frame += 1) {
    let sum = 0;
    const from = frame * window;
    const to = Math.min(samples.length, from + window);
    for (let i = from; i < to; i += 1) {
      const v = samples[i];
      sum += v * v;
    }
    const rms = Math.sqrt(sum / Math.max(1, to - from));
    out.push(rms);
    if (rms > max) max = rms;
  }
  return max > 0 ? out.map((value) => value / max) : out;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * First window at or above the threshold that stays above it for `sustain`
 * windows — silence intros and one-off hits do not count as "the track
 * started".
 */
export function firstSustained(
  energy: readonly number[],
  threshold: number,
  sustain = 3,
): number {
  for (let i = 0; i + sustain <= energy.length; i += 1) {
    let ok = true;
    for (let j = i; j < i + sustain; j += 1) {
      if (energy[j] < threshold) {
        ok = false;
        break;
      }
    }
    if (ok) return i;
  }
  return 0;
}

/** Last window at or above the threshold (scanning backwards). */
export function lastSustained(
  energy: readonly number[],
  threshold: number,
  sustain = 2,
): number {
  for (let i = energy.length - 1; i >= sustain; i -= 1) {
    let ok = true;
    for (let j = i - sustain; j < i; j += 1) {
      if (energy[j] < threshold) {
        ok = false;
        break;
      }
    }
    if (ok) return i;
  }
  return energy.length;
}

export function analyzeTrack(mono: Float32Array, sampleRate: number): TrackAnalysis {
  const durationMs = (mono.length / sampleRate) * 1000;
  const peaks = computePeaks(mono, 900);
  const energy = energyProfile(mono, sampleRate);
  const threshold = median(energy) * 0.35;

  const estimate = detectBpm(mono, sampleRate);
  const bpm = estimate && estimate.confidence >= 0.2 ? estimate.bpm : null;
  const anchorMs = estimate && bpm ? estimate.anchorMs % (60_000 / bpm) : 0;

  const cueInMs = firstSustained(energy, threshold) * ENERGY_WINDOW_MS;
  const mixOutMs = Math.min(
    durationMs,
    (lastSustained(energy, threshold) + 1) * ENERGY_WINDOW_MS,
  );

  return {
    durationMs,
    bpm,
    bpmConfidence: estimate?.confidence ?? 0,
    anchorMs,
    cueInMs,
    mixOutMs,
    energy,
    peaks,
  };
}

export { computePeaks, toMono };
