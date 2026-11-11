import { describe, expect, it } from "vitest";
import { echoDelayMs, filterCutoffHz } from "./fx";

describe("fx mapping", () => {
  it("maps the filter knob logarithmically across the audible range", () => {
    expect(filterCutoffHz(0)).toBeCloseTo(40);
    expect(filterCutoffHz(1)).toBeCloseTo(18_000);
    expect(filterCutoffHz(0.5)).toBeGreaterThan(700);
    expect(filterCutoffHz(0.5)).toBeLessThan(1000);
  });

  it("clamps knob extremes", () => {
    expect(filterCutoffHz(-5)).toBeCloseTo(40);
    expect(filterCutoffHz(9)).toBeCloseTo(18_000);
  });

  it("derives echo length from the deck tempo", () => {
    expect(echoDelayMs(0.5, 120)).toBeCloseTo(250);
    expect(echoDelayMs(1, 100)).toBeCloseTo(600);
    expect(echoDelayMs(1, 0)).toBe(0);
  });
});
