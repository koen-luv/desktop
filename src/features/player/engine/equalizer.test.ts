import { describe, expect, it } from "vitest";
import {
  DEFAULT_EQUALIZER_GAINS,
  EQUALIZER_BANDS,
  equalizerPresetFor,
  normalizeEqualizerGains,
  presetGains,
} from "./equalizer";

describe("equalizer", () => {
  it("always returns one gain per band", () => {
    expect(normalizeEqualizerGains([])).toEqual(DEFAULT_EQUALIZER_GAINS);
    expect(normalizeEqualizerGains([3])).toHaveLength(EQUALIZER_BANDS.length);
    expect(normalizeEqualizerGains(new Array(9).fill(2))).toHaveLength(EQUALIZER_BANDS.length);
  });

  it("clamps to +/-12 dB and rounds to half steps", () => {
    expect(normalizeEqualizerGains([99, -99, 1.26, NaN, -7.74])).toEqual([
      12, -12, 1.5, 0, -7.5,
    ]);
  });

  it("recognises presets and falls back to custom", () => {
    expect(equalizerPresetFor(presetGains("bass"))).toBe("bass");
    expect(equalizerPresetFor([1, 2, 3, 4, 5])).toBe("custom");
  });
});
