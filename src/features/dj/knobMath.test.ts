import { describe, expect, it } from "vitest";
import {
  angleForNormalized,
  isBipolar,
  normalizedFromValue,
  snapToStep,
  valueFromDrag,
  valueFromNormalized,
} from "./knobMath";

describe("knob maths", () => {
  it("maps values to a 0..1 position and back", () => {
    expect(normalizedFromValue(-6, -24, 12)).toBeCloseTo(0.5);
    expect(valueFromNormalized(0.5, -24, 12)).toBeCloseTo(-6);
    expect(normalizedFromValue(999, 0, 1)).toBe(1);
    expect(normalizedFromValue(-999, 0, 1)).toBe(0);
  });

  it("rotates across a 270° sweep starting at −135°", () => {
    expect(angleForNormalized(0)).toBe(-135);
    expect(angleForNormalized(1)).toBe(135);
    expect(angleForNormalized(0.5)).toBe(0);
  });

  it("dragging up increases the value", () => {
    // 160 px covers the full 0..1 range.
    expect(valueFromDrag(0.5, -40, 0, 1)).toBeCloseTo(0.75);
    expect(valueFromDrag(0.5, 40, 0, 1)).toBeCloseTo(0.25);
  });

  it("shift halves sensitivity", () => {
    expect(valueFromDrag(0.5, -40, 0, 1, 160, true)).toBeCloseTo(0.625);
  });

  it("clamps at both ends of the range", () => {
    expect(valueFromDrag(1, -500, 0, 1)).toBe(1);
    expect(valueFromDrag(0, 500, 0, 1)).toBe(0);
  });

  it("snaps to the step grid", () => {
    expect(snapToStep(0.53, 0.05)).toBeCloseTo(0.55);
    expect(snapToStep(-6.4, 1)).toBe(-6);
  });

  it("detects bipolar controls from their default", () => {
    expect(isBipolar(-24, 12, 0)).toBe(true); // EQ resting at 0 dB
    expect(isBipolar(0, 1, 0.5)).toBe(true); // filter resting mid-sweep
    expect(isBipolar(0, 1, 0)).toBe(false); // echo resting at the bottom
    expect(isBipolar(0, 1, 1)).toBe(false);
  });
});
