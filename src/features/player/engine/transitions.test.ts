import { describe, it, expect } from "vitest";
import {
  TRANSITION_PRESETS,
  TRANSITION_PRESET_IDS,
  isTransitionPreset,
  transitionSpec,
} from "./transitions";

describe("transition presets", () => {
  it("offers every declared preset in the picker order", () => {
    expect(TRANSITION_PRESET_IDS).toEqual(Object.keys(TRANSITION_PRESETS));
  });

  it("keeps 'off' truly gapless", () => {
    expect(TRANSITION_PRESETS.off).toEqual({ fadeInMs: 0, fadeOutMs: 0 });
  });

  it("declares only non-negative fade durations", () => {
    for (const id of TRANSITION_PRESET_IDS) {
      const spec = TRANSITION_PRESETS[id];
      expect(spec.fadeInMs).toBeGreaterThanOrEqual(0);
      expect(spec.fadeOutMs).toBeGreaterThanOrEqual(0);
    }
  });

  it("type-guards known presets and rejects anything else", () => {
    expect(isTransitionPreset("soft")).toBe(true);
    expect(isTransitionPreset("swell")).toBe(true);
    expect(isTransitionPreset("warp-speed")).toBe(false);
    expect(isTransitionPreset(undefined)).toBe(false);
    expect(isTransitionPreset(42)).toBe(false);
  });

  it("falls back to 'off' for unknown persisted values", () => {
    expect(transitionSpec("soft").fadeInMs).toBe(TRANSITION_PRESETS.soft.fadeInMs);
    expect(transitionSpec("garbage-from-old-version")).toEqual(TRANSITION_PRESETS.off);
    expect(transitionSpec(null)).toEqual(TRANSITION_PRESETS.off);
  });
});
