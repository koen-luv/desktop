import { describe, expect, it } from "vitest";
import { beatAlignMs, planTransition, tempoMatchPercent, fadeProgress } from "./transition";
import type { TrackAnalysis } from "./analysis";

function analysis(patch: Partial<TrackAnalysis>): TrackAnalysis {
  return {
    durationMs: 200_000,
    bpm: 120,
    bpmConfidence: 0.8,
    anchorMs: 0,
    cueInMs: 2000,
    mixOutMs: 195_000,
    energy: [],
    peaks: { min: new Float32Array(2), max: new Float32Array(2), samplesPerColumn: 1 },
    ...patch,
  };
}

describe("tempo matching", () => {
  it("matches identical tempos with zero offset", () => {
    expect(tempoMatchPercent(124, 124)).toEqual({ match: 0, doubled: false });
  });

  it("matches 120 → 123 with +2.5%", () => {
    expect(tempoMatchPercent(120, 123).match).toBeCloseTo(-3 / 123, 4);
  });

  it("reinterprets half/double instead of demanding an impossible shift", () => {
    const result = tempoMatchPercent(120, 62);
    expect(result.doubled).toBe(true);
    expect(Math.abs(result.match)).toBeLessThan(0.08);
  });

  it("clamps beyond the ±8% range", () => {
    expect(Math.abs(tempoMatchPercent(120, 150).match)).toBeLessThanOrEqual(0.08);
  });
});

describe("beat alignment", () => {
  it("returns the smallest nudge onto A's grid", () => {
    const a = analysis({ anchorMs: 0 });
    const b = analysis({ anchorMs: 400 }); // 120 BPM: beat = 500 ms
    expect(beatAlignMs(a, b, 120)).toBe(-100); // -100 ms beats +400 ms
  });

  it("is inert without tempo", () => {
    expect(beatAlignMs(analysis({ bpm: null }), analysis({}), 0)).toBe(0);
  });
});

describe("transition plan", () => {
  it("schedules the fade to end at A's mix-out", () => {
    const a = analysis({ mixOutMs: 100_000 });
    const b = analysis({ cueInMs: 4000 });
    const plan = planTransition(a, b, { fadeMs: 8000 });
    expect(plan.triggerAtMs).toBe(92_000);
    expect(plan.endAtMs).toBe(100_000);
    expect(plan.bStartMs).toBe(4000);
    expect(plan.warnings).toEqual([]);
  });

  it("warns when tempos are out of reach", () => {
    const plan = planTransition(analysis({ bpm: 120 }), analysis({ bpm: 150 }));
    expect(plan.warnings.join(" ")).toMatch(/±8%/);
  });

  it("warns on low-confidence grids", () => {
    const plan = planTransition(
      analysis({ bpmConfidence: 0.1 }),
      analysis({ bpmConfidence: 0.1 }),
    );
    expect(plan.warnings.filter((w) => /low-confidence/.test(w)).length).toBe(2);
  });

  it("warns when A's outro is shorter than the fade", () => {
    const plan = planTransition(analysis({ mixOutMs: 3000 }), analysis({}), { fadeMs: 12_000 });
    expect(plan.warnings.join(" ")).toMatch(/abrupt/);
  });

  it("applies the current tempo of A to the target", () => {
    const plan = planTransition(analysis({ bpm: 120 }), analysis({ bpm: 120 }), {
      currentTempoA: 0.04,
    });
    expect(plan.matchedBpm).toBeCloseTo(124.8, 1);
    expect(plan.tempoMatch).toBeCloseTo(0.04, 2);
  });
});

describe("fade curve", () => {
  it("progresses 0..1 and clamps", () => {
    expect(fadeProgress(0, 1000)).toBe(0);
    expect(fadeProgress(500, 1000)).toBe(0.5);
    expect(fadeProgress(9999, 1000)).toBe(1);
    expect(fadeProgress(0, 0)).toBe(1);
  });
});
