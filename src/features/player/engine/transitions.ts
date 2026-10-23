/**
 * Song-to-song transition presets.
 *
 * Two transition families live here:
 *
 * - Sequential fades (every preset except "auto"): the player engine is
 *   single-stream during normal playback, so the outgoing track fades out over
 *   its final stretch, then the incoming track fades in.
 * - Overlapping crossfades ("auto"): the next song starts playing *while* the
 *   current one is still audible, and both are blended on an equal-power curve
 *   — the classic DJ crossfade. The window is auto-fitted to both songs (see
 *   {@link autoCrossfadeWindowMs}) and each runtime shapes the blend with its
 *   own effect sweep (a filter/EQ morph on Android, the blend curve itself on
 *   web). The fade timings of the preset remain as the sequential fallback for
 *   when overlapping is impossible (repeat-one, unknown next track, failed
 *   stream resolution).
 *
 * Both runtimes read the same spec, so a preset behaves identically everywhere.
 */

export type TransitionPreset =
  | "auto"
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
  /**
   * True = overlap both songs on an equal-power crossfade when a next track
   * exists and both songs are long enough; the timings above then describe the
   * sequential fallback used otherwise.
   */
  overlap: boolean;
}

export const TRANSITION_PRESETS: Record<TransitionPreset, TransitionSpec> = {
  auto: { fadeInMs: 1_200, fadeOutMs: 1_200, overlap: true },
  off: { fadeInMs: 0, fadeOutMs: 0, overlap: false },
  "fade-in": { fadeInMs: 900, fadeOutMs: 0, overlap: false },
  "fade-out": { fadeInMs: 0, fadeOutMs: 900, overlap: false },
  soft: { fadeInMs: 500, fadeOutMs: 500, overlap: false },
  medium: { fadeInMs: 1_200, fadeOutMs: 1_200, overlap: false },
  long: { fadeInMs: 3_000, fadeOutMs: 3_000, overlap: false },
  // Asymmetric: swells in slowly, ducks out quickly.
  swell: { fadeInMs: 2_200, fadeOutMs: 500, overlap: false },
};

/** Preset ids in the order they should be offered in the picker. */
export const TRANSITION_PRESET_IDS: TransitionPreset[] = [
  "auto",
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

/**
 * Equal-power blend gains for a crossfade at `progress` in [0, 1].
 * cos² + sin² = 1, so the combined acoustic power stays constant through the
 * blend — linear gains would dip audibly in the middle.
 */
export function equalPowerBlend(progress: number): { outgoing: number; incoming: number } {
  const t = Math.min(1, Math.max(0, progress));
  return {
    outgoing: Math.cos((t * Math.PI) / 2),
    incoming: Math.sin((t * Math.PI) / 2),
  };
}

export const CROSSFADE_TARGET_MS = 8_000;
export const CROSSFADE_MIN_MS = 2_000;
export const CROSSFADE_MAX_MS = 12_000;
/** Headroom left in the incoming song once the blend has fully faded it in. */
const CROSSFADE_NEXT_HEADROOM_MS = 2_000;

/**
 * Fits the overlap window to both songs: the blend must finish before the
 * outgoing song ends, and the incoming song keeps some room after the blend so
 * it never fades in right as it dies. Returns 0 when the songs are too short
 * to overlap meaningfully — callers then keep the sequential fallback.
 */
export function autoCrossfadeWindowMs(
  currentRemainingMs: number,
  nextDurationMs: number,
  targetMs: number = CROSSFADE_TARGET_MS,
): number {
  let window = Math.min(targetMs, CROSSFADE_MAX_MS, currentRemainingMs);
  if (nextDurationMs > 0) {
    window = Math.min(window, nextDurationMs - CROSSFADE_NEXT_HEADROOM_MS);
  }
  return window >= CROSSFADE_MIN_MS ? Math.round(window) : 0;
}
