import { describe, it, expect } from "vitest";
import {
  TRANSITION_PRESETS,
  TRANSITION_PRESET_IDS,
  autoCrossfadeWindowMs,
  equalPowerBlend,
  isTransitionPreset,
  transitionSpec,
  CROSSFADE_MAX_MS,
  CROSSFADE_MIN_MS,
} from "./transitions";

describe("transition presets", () => {
  it("offers every declared preset in the picker order", () => {
    expect(TRANSITION_PRESET_IDS).toEqual(Object.keys(TRANSITION_PRESETS));
  });

  it("keeps 'off' truly gapless", () => {
    expect(TRANSITION_PRESETS.off).toEqual({ fadeInMs: 0, fadeOutMs: 0, overlap: false });
  });

  it("marks exactly 'auto' as an overlapping crossfade", () => {
    expect(TRANSITION_PRESETS.auto.overlap).toBe(true);
    for (const id of TRANSITION_PRESET_IDS) {
      if (id === "auto") continue;
      expect(TRANSITION_PRESETS[id].overlap).toBe(false);
    }
  });

  it("declares only non-negative fade durations", () => {
    for (const id of TRANSITION_PRESET_IDS) {
      const spec = TRANSITION_PRESETS[id];
      expect(spec.fadeInMs).toBeGreaterThanOrEqual(0);
      expect(spec.fadeOutMs).toBeGreaterThanOrEqual(0);
    }
  });

  it("type-guards known presets and rejects anything else", () => {
    expect(isTransitionPreset("auto")).toBe(true);
    expect(isTransitionPreset("soft")).toBe(true);
    expect(isTransitionPreset("swell")).toBe(true);
    expect(isTransitionPreset("warp-speed")).toBe(false);
    expect(isTransitionPreset(undefined)).toBe(false);
    expect(isTransitionPreset(42)).toBe(false);
  });

  it("falls back to 'off' for unknown persisted values", () => {
    expect(transitionSpec("soft").fadeInMs).toEqual(TRANSITION_PRESETS.soft.fadeInMs);
    expect(transitionSpec("garbage-from-old-version")).toEqual(TRANSITION_PRESETS.off);
    expect(transitionSpec(null)).toEqual(TRANSITION_PRESETS.off);
  });
});

describe("equal-power crossfade blend", () => {
  it("starts fully on the outgoing song and ends fully on the incoming one", () => {
    expect(equalPowerBlend(0)).toEqual({ outgoing: 1, incoming: 0 });
    const end = equalPowerBlend(1);
    expect(end.outgoing).toBeCloseTo(0, 5);
    expect(end.incoming).toBeCloseTo(1, 5);
  });

  it("keeps constant acoustic power through the middle of the blend", () => {
    for (const t of [0.1, 0.25, 0.5, 0.75, 0.9]) {
      const { outgoing, incoming } = equalPowerBlend(t);
      expect(outgoing ** 2 + incoming ** 2).toBeCloseTo(1, 5);
    }
  });

  it("clamps progress outside [0, 1]", () => {
    expect(equalPowerBlend(-3).outgoing).toBe(1);
    expect(equalPowerBlend(2).incoming).toBeCloseTo(1, 5);
  });
});

describe("auto crossfade window fitting", () => {
  it("targets the default window when both songs have room", () => {
    expect(autoCrossfadeWindowMs(60_000, 240_000)).toBe(8_000);
  });

  it("shrinks to the outgoing song's remaining time", () => {
    expect(autoCrossfadeWindowMs(5_000, 240_000)).toBe(5_000);
  });

  it("shrinks to leave headroom in the incoming song", () => {
    // next song is 7s long -> blend may only cover 5s of it
    expect(autoCrossfadeWindowMs(60_000, 7_000)).toBe(5_000);
  });

  it("never exceeds the maximum window", () => {
    // even with an oversized caller target, the hard cap holds
    expect(autoCrossfadeWindowMs(300_000, 600_000, 20_000)).toBe(CROSSFADE_MAX_MS);
    expect(autoCrossfadeWindowMs(300_000, 600_000)).toBeLessThanOrEqual(CROSSFADE_MAX_MS);
  });

  it("refuses to overlap songs that are too short to blend", () => {
    expect(autoCrossfadeWindowMs(1_500, 240_000)).toBe(0);
    expect(autoCrossfadeWindowMs(60_000, CROSSFADE_MIN_MS + 1_999)).toBe(0);
    expect(autoCrossfadeWindowMs(0, 240_000)).toBe(0);
  });

  it("tolerates an unknown next duration (streams without metadata)", () => {
    expect(autoCrossfadeWindowMs(30_000, 0)).toBe(8_000);
  });
});
