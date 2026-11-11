import { describe, expect, it } from "vitest";
import { energyProfile, firstSustained, lastSustained } from "./analysis";

function ramp(length: number, from: number, to: number): number[] {
  return Array.from({ length }, (_, i) => from + ((to - from) * i) / Math.max(1, length - 1));
}

describe("structure detection", () => {
  it("finds where sustained energy starts", () => {
    const energy = [0, 0, 0.1, 0.9, 0.9, 0.9, 0.8];
    expect(firstSustained(energy, 0.5, 3)).toBe(3);
  });

  it("ignores a single loud hit before the real start", () => {
    const energy = [0, 0.9, 0, 0, 0.8, 0.9, 0.8];
    expect(firstSustained(energy, 0.5, 3)).toBe(4);
  });

  it("falls back to zero when nothing sustains", () => {
    expect(firstSustained([0.9, 0, 0.9, 0], 0.5, 3)).toBe(0);
  });

  it("finds the last sustained window from the end", () => {
    const energy = [0.9, 0.9, 0.9, 0.1, 0];
    expect(lastSustained(energy, 0.5, 2)).toBe(3);
  });
});

describe("energy profile", () => {
  it("normalises the loudest window to 1", () => {
    const sampleRate = 8000;
    const loud = ramp(8000, 0, 0.8);
    const quiet = ramp(8000, 0, 0.1);
    const samples = new Float32Array([...quiet, ...loud]);
    const profile = energyProfile(samples, sampleRate);
    expect(profile.length).toBe(2);
    expect(Math.max(...profile)).toBeCloseTo(1, 3);
    expect(profile[0]).toBeLessThan(profile[1]);
  });
});
