import { describe, expect, it } from "vitest";
import { columnForPosition, computePeaks, positionForColumn, toMono } from "./waveform";

describe("waveform peaks", () => {
  it("keeps the extremes of each column", () => {
    const samples = new Float32Array([0, 0.5, -1, 0.2, -0.2, 1, 0, -0.5]);
    const peaks = computePeaks(samples, 4);
    expect(Array.from(peaks.min).map((value) => Number(value.toFixed(2)))).toEqual([0, -1, -0.2, -0.5]);
    expect(Array.from(peaks.max).map((value) => Number(value.toFixed(2)))).toEqual([0.5, 0.2, 1, 0]);
  });

  it("handles more columns than samples without throwing", () => {
    const peaks = computePeaks(new Float32Array([0.3, -0.3]), 8);
    expect(peaks.min.length).toBe(8);
    expect(peaks.max[0]).toBeCloseTo(0.3);
  });

  it("downmixes without losing transients", () => {
    const left = new Float32Array([0.9, 0, 0]);
    const right = new Float32Array([-0.9, 0, 0.4]);
    const mono = toMono([left, right]);
    expect(Math.abs(mono[0])).toBeCloseTo(0.9);
    expect(mono[2]).toBeCloseTo(0.4);
  });
});

describe("playhead mapping", () => {
  it("maps position to column and back", () => {
    expect(columnForPosition(0, 1000, 101)).toBe(0);
    expect(columnForPosition(1000, 1000, 101)).toBe(100);
    expect(positionForColumn(50, 1000, 101)).toBe(500);
  });

  it("clamps out-of-range positions", () => {
    expect(columnForPosition(5000, 1000, 11)).toBe(10);
    expect(positionForColumn(-20, 1000, 11)).toBe(0);
  });
});
