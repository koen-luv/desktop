/**
 * Knob interaction maths. Pure, so drag sensitivity and bipolar mapping are
 * testable without a DOM.
 */

export const SWEEP_DEGREES = 270;
export const START_DEGREES = -135;

export function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** Normalised 0..1 → value in [min, max]. */
export function valueFromNormalized(normalized: number, min: number, max: number): number {
  return min + clamp01(normalized) * (max - min);
}

/** Value → normalised position, tolerating out-of-range inputs. */
export function normalizedFromValue(value: number, min: number, max: number): number {
  if (max === min) return 0;
  return clamp01((value - min) / (max - min));
}

/** Rotation for a normalised position. */
export function angleForNormalized(normalized: number): number {
  return START_DEGREES + clamp01(normalized) * SWEEP_DEGREES;
}

/**
 * New value from a vertical pointer drag: up increases. `pixels` is the full
 * travel that covers the whole range; Shift halves sensitivity for fine rides.
 */
export function valueFromDrag(
  startValue: number,
  deltaY: number,
  min: number,
  max: number,
  pixels = 160,
  fine = false,
): number {
  const span = max - min;
  if (span <= 0) return startValue;
  const step = (deltaY * (fine ? 0.5 : 1)) / pixels;
  const normalized = normalizedFromValue(startValue, min, max) - step;
  return valueFromNormalized(normalized, min, max);
}

/** Snap a value to a step grid (keyboard / wheel). */
export function snapToStep(value: number, step: number): number {
  return Math.round(value / step) * step;
}

/**
 * A control is bipolar when its resting default sits somewhere inside the
 * range (EQ centred at 0 dB, filter at mid) rather than at either end. The
 * value arc is drawn from the default angle, so this only decides whether the
 * needle rests mid-sweep.
 */
export function isBipolar(min: number, max: number, defaultValue: number): boolean {
  const span = max - min;
  if (span <= 0) return false;
  return Math.abs(defaultValue - min) > span * 0.01 && Math.abs(defaultValue - max) > span * 0.01;
}
