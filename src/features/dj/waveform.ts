/**
 * Waveform peaks.
 *
 * Mixxx-style overview: the channel data is reduced to one min/max pair per
 * pixel column once, then drawn every frame. Pure so the reduction can be
 * tested without a canvas.
 */

export interface WaveformPeaks {
  /** Closest value to −1 for each column. */
  min: Float32Array;
  /** Closest value to +1 for each column. */
  max: Float32Array;
  /** Samples per column, useful for beat marker placement later. */
  samplesPerColumn: number;
}

/** Reduce mono samples to one min/max per column. */
export function computePeaks(samples: Float32Array, columns: number): WaveformPeaks {
  const width = Math.max(1, Math.floor(columns));
  const min = new Float32Array(width);
  const max = new Float32Array(width);
  const step = samples.length / width || 1;

  for (let column = 0; column < width; column += 1) {
    // When there are more columns than samples a column can cover none of
    // them; every column still maps to at least one sample so narrow waveforms
    // stay populated instead of collapsing to a flat line.
    const from = Math.min(samples.length - 1, Math.floor(column * step));
    const to =
      column === width - 1
        ? samples.length
        : Math.max(from + 1, Math.floor((column + 1) * step));
    let lo = 0;
    let hi = 0;
    for (let index = from; index < to; index += 1) {
      const value = samples[index] ?? 0;
      if (value < lo) lo = value;
      if (value > hi) hi = value;
    }
    min[column] = lo;
    max[column] = hi;
  }
  return { min, max, samplesPerColumn: step };
}

/** Downmix all channels to a mono array (peak-preserving per sample). */
export function toMono(channels: Float32Array[]): Float32Array {
  if (channels.length === 0) return new Float32Array(0);
  if (channels.length === 1) return channels[0];
  const length = channels[0].length;
  const mono = new Float32Array(length);
  for (let index = 0; index < length; index += 1) {
    let sum = 0;
    let peak = 0;
    for (const channel of channels) {
      const value = channel[index] ?? 0;
      sum += value;
      if (Math.abs(value) > Math.abs(peak)) peak = value;
    }
    // Average keeps quiet detail; peaks stay visible on transients.
    mono[index] = Math.abs(sum / channels.length) > Math.abs(peak) ? sum / channels.length : peak;
  }
  return mono;
}

/** Column index the playhead sits on for a given position. */
export function columnForPosition(positionMs: number, durationMs: number, columns: number): number {
  if (durationMs <= 0) return 0;
  const ratio = Math.min(1, Math.max(0, positionMs / durationMs));
  return Math.round(ratio * (columns - 1));
}

/** Inverse, for click-to-seek. */
export function positionForColumn(column: number, durationMs: number, columns: number): number {
  if (columns <= 1) return 0;
  const ratio = Math.min(1, Math.max(0, column / (columns - 1)));
  return Math.round(ratio * durationMs);
}
