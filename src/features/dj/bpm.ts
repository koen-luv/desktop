/**
 * Tempo detection from decoded PCM.
 *
 * Classic onset-envelope + autocorrelation: energy is windowed, the positive
 * derivative of that envelope is the onset signal, and the lag that repeats it
 * best is the beat period. Pure so it can be tested against synthetic click
 * tracks.
 */

const MIN_BPM = 60;
const MAX_BPM = 180;

export interface BpmEstimate {
  bpm: number;
  /** First strong onset, for beatgrid anchoring. */
  anchorMs: number;
  /** Normalised autocorrelation peak, 0..1 — treat <0.2 as unreliable. */
  confidence: number;
}

/** RMS energy per window, then the positive derivative = onset envelope. */
export function onsetEnvelope(samples: Float32Array, sampleRate: number, windowMs = 23): Float32Array {
  const window = Math.max(1, Math.floor((sampleRate * windowMs) / 1000));
  const frames = Math.max(1, Math.floor(samples.length / window));
  const energy = new Float32Array(frames);
  for (let frame = 0; frame < frames; frame += 1) {
    let sum = 0;
    const from = frame * window;
    const to = Math.min(samples.length, from + window);
    for (let i = from; i < to; i += 1) {
      const v = samples[i];
      sum += v * v;
    }
    energy[frame] = Math.sqrt(sum / Math.max(1, to - from));
  }
  const onsets = new Float32Array(frames);
  for (let frame = 1; frame < frames; frame += 1) {
    onsets[frame] = Math.max(0, energy[frame] - energy[frame - 1]);
  }
  return onsets;
}

export function detectBpm(samples: Float32Array, sampleRate: number): BpmEstimate | null {
  if (samples.length < sampleRate * 2) return null;
  const onsets = onsetEnvelope(samples, sampleRate);
  const frameMs = 23;
  const minLag = Math.floor((60_000 / MAX_BPM) / frameMs);
  const maxLag = Math.floor((60_000 / MIN_BPM) / frameMs);
  if (maxLag >= onsets.length) return null;

  // Remove the mean so autocorrelation measures periodicity, not loudness.
  let mean = 0;
  for (const value of onsets) mean += value;
  mean /= onsets.length;

  let bestLag = 0;
  let bestScore = -1;
  let norm = 0;
  for (const value of onsets) norm += value * value;
  if (norm === 0) return null;

  for (let lag = minLag; lag <= maxLag; lag += 1) {
    let score = 0;
    for (let i = lag; i < onsets.length; i += 1) {
      score += (onsets[i] - mean) * (onsets[i - lag] - mean);
    }
    score /= norm;
    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }
  if (bestLag === 0) return null;

  const beatMs = bestLag * frameMs;
  let bpm = (60_000 / beatMs) * 100;
  bpm = Math.round(bpm) / 100;
  // Fold into the sane range (half/double tempo ambiguity).
  while (bpm < MIN_BPM) bpm *= 2;
  while (bpm > MAX_BPM) bpm /= 2;

  // Anchor: first onset frame above half the average onset strength.
  let threshold = 0;
  for (const value of onsets) threshold += value;
  threshold = (threshold / onsets.length) * 1.5;
  let anchorMs = 0;
  for (let i = 0; i < onsets.length; i += 1) {
    if (onsets[i] > threshold) {
      anchorMs = i * frameMs;
      break;
    }
  }
  return { bpm, anchorMs, confidence: Math.max(0, Math.min(1, bestScore)) };
}

/**
 * Snap a position onto the beatgrid (anchor + n beats). strength 0 = off,
 * 1 = full quantise; intermediate values interpolate for "nudge to grid".
 */
export function quantizePosition(
  positionMs: number,
  bpm: number,
  anchorMs: number,
  strength = 1,
): number {
  if (bpm <= 0) return positionMs;
  const beat = 60_000 / bpm;
  const relative = positionMs - anchorMs;
  const snapped = anchorMs + Math.round(relative / beat) * beat;
  return positionMs + (snapped - positionMs) * Math.min(1, Math.max(0, strength));
}
