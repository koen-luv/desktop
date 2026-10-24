/**
 * Five-band graphic equalizer shared by the web/Electron Web Audio graph and
 * the Android native effect. Gains are in dB; 0 dB is bit-transparent.
 */

export interface EqualizerBand {
  /** Centre frequency in Hz. */
  frequency: number;
  /** Short label shown under the slider. */
  label: string;
}

export const EQUALIZER_BANDS: EqualizerBand[] = [
  { frequency: 60, label: "60" },
  { frequency: 230, label: "230" },
  { frequency: 910, label: "910" },
  { frequency: 3600, label: "3.6k" },
  { frequency: 14000, label: "14k" },
];

export const EQUALIZER_MIN_DB = -12;
export const EQUALIZER_MAX_DB = 12;
export const DEFAULT_EQUALIZER_GAINS = [0, 0, 0, 0, 0];

export type EqualizerPresetId = "flat" | "bass" | "vocal" | "treble" | "loudness" | "custom";

export interface EqualizerPreset {
  id: EqualizerPresetId;
  gains: number[];
}

export const EQUALIZER_PRESETS: EqualizerPreset[] = [
  { id: "flat", gains: [0, 0, 0, 0, 0] },
  { id: "bass", gains: [7, 4, 0, -1, -2] },
  { id: "vocal", gains: [-2, -1, 4, 3, 0] },
  { id: "treble", gains: [-2, -1, 0, 4, 7] },
  { id: "loudness", gains: [6, 2, -1, 3, 5] },
];

export function clampEqualizerGain(value: unknown): number {
  if (typeof value !== "number" || Number.isNaN(value)) return 0;
  return Math.max(EQUALIZER_MIN_DB, Math.min(EQUALIZER_MAX_DB, Math.round(value * 2) / 2));
}

/** Returns exactly one clamped gain per band, padding/truncating as needed. */
export function normalizeEqualizerGains(gains: unknown): number[] {
  const input = Array.isArray(gains) ? gains : [];
  return EQUALIZER_BANDS.map((_, index) => clampEqualizerGain(input[index] ?? 0));
}

export function presetGains(id: EqualizerPresetId): number[] {
  const preset = EQUALIZER_PRESETS.find((entry) => entry.id === id);
  return normalizeEqualizerGains(preset?.gains ?? DEFAULT_EQUALIZER_GAINS);
}

/** Name of the preset matching these exact gains, or "custom". */
export function equalizerPresetFor(gains: number[]): EqualizerPresetId {
  const normalized = normalizeEqualizerGains(gains);
  const match = EQUALIZER_PRESETS.find((preset) =>
    preset.gains.every((gain, index) => Math.abs(gain - normalized[index]) < 0.01),
  );
  return match?.id ?? "custom";
}

/** Flat (bypass) response when the equalizer is disabled. */
export function effectiveEqualizerGains(enabled: boolean, gains: number[]): number[] {
  return enabled ? normalizeEqualizerGains(gains) : DEFAULT_EQUALIZER_GAINS;
}
