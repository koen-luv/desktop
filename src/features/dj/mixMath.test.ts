import { describe, expect, it } from "vitest";
import {
  crossfadeGains,
  deckGain,
  formatDeckTime,
  needsResync,
  tempoToRate,
} from "./mixMath";

describe("crossfader", () => {
  it("gives each deck full gain at its own end", () => {
    expect(crossfadeGains(0)).toEqual({ a: 1, b: 0 });
    const full = crossfadeGains(1);
    expect(full.a).toBeCloseTo(0, 6);
    expect(full.b).toBeCloseTo(1, 6);
  });

  it("keeps combined power constant through the middle", () => {
    for (const p of [0, 0.25, 0.5, 0.75, 1]) {
      const { a, b } = crossfadeGains(p);
      expect(a * a + b * b).toBeCloseTo(1, 6);
    }
  });

  it("clamps positions outside 0..1", () => {
    expect(crossfadeGains(-3)).toEqual(crossfadeGains(0));
    const high = crossfadeGains(9);
    expect(high.b).toBeCloseTo(1, 6);
  });
});

describe("deck gain", () => {
  it("multiplies fader weight by trim", () => {
    const fade = { a: 1, b: 0 };
    expect(deckGain(fade, "a", 0.5)).toBeCloseTo(0.5);
    expect(deckGain(fade, "b", 1)).toBe(0);
  });

  it("silences a muted deck regardless of the fader", () => {
    expect(deckGain({ a: 1, b: 1 }, "a", 1, true)).toBe(0);
  });
});

describe("tempo", () => {
  it("maps the CDJ range onto playback rate", () => {
    expect(tempoToRate(0)).toBe(1);
    expect(tempoToRate(0.08)).toBeCloseTo(1.08);
    expect(tempoToRate(-0.08)).toBeCloseTo(0.92);
  });

  it("clamps beyond ±8%", () => {
    expect(tempoToRate(0.5)).toBeCloseTo(1.08);
    expect(tempoToRate(-0.5)).toBeCloseTo(0.92);
  });
});

describe("clock", () => {
  it("only asks for a resync past the click threshold", () => {
    expect(needsResync(1000, 1050)).toBe(false);
    expect(needsResync(1000, 1200)).toBe(true);
  });

  it("formats deck readouts", () => {
    expect(formatDeckTime(0)).toBe("0:00");
    expect(formatDeckTime(65_000)).toBe("1:05");
  });
});
