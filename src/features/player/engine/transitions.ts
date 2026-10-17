/**
 * Song-to-song transition presets.
 *
 * The player engine is single-stream on every platform (one `<audio>` element on
 * web/Electron, one native ExoPlayer on Android), so a transition cannot overlap
 * two songs the way a DJ crossfade does. These presets therefore shape a
 * *sequential* transition: the outgoing track fades out over its final stretch,
 * then the incoming track fades in. "off" keeps playback gapless/instant.
 *
 * Both runtimes read the same spec, so a preset behaves identically everywhere.
 */

export type TransitionPreset =
  | "off"
  | "fade-in"
  | "fade-out"
  | "soft"
  | "medium"
  | "long"
  | "swell";

export interface TransitionSpec {
  /** Fade-in applied to the incoming track (ms). 0 = start instantly. */
  fadeInMs: number;
  /** Fade-out applied to the outgoing track (ms). 0 = cut instantly. */
  fadeOutMs: number;
}

export const TRANSITION_PRESETS: Record<TransitionPreset, TransitionSpec> = {
  off: { fadeInMs: 0, fadeOutMs: 0 },
  "fade-in": { fadeInMs: 900, fadeOutMs: 0 },
  "fade-out": { fadeInMs: 0, fadeOutMs: 900 },
  soft: { fadeInMs: 500, fadeOutMs: 500 },
  medium: { fadeInMs: 1_200, fadeOutMs: 1_200 },
  long: { fadeInMs: 3_000, fadeOutMs: 3_000 },
  // Asymmetric: swells in slowly, ducks out quickly.
  swell: { fadeInMs: 2_200, fadeOutMs: 500 },
};

/** Preset ids in the order they should be offered in the picker. */
export const TRANSITION_PRESET_IDS: TransitionPreset[] = [
  "off",
  "fade-in",
  "fade-out",
  "soft",
  "medium",
  "long",
  "swell",
];

export function isTransitionPreset(value: unknown): value is TransitionPreset {
  return typeof value === "string" && value in TRANSITION_PRESETS;
}

/** Resolves a preset to its timings, tolerating any unknown/persisted value. */
export function transitionSpec(preset: unknown): TransitionSpec {
  return isTransitionPreset(preset) ? TRANSITION_PRESETS[preset] : TRANSITION_PRESETS.off;
}
