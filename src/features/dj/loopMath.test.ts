import { describe, expect, it } from "vitest";
import {
  beatMs,
  insideLoop,
  loopExitPosition,
  loopedPosition,
  makeLoop,
  tapTempo,
} from "./loopMath";

// 120 BPM → one beat is 500 ms.
const bpm = 120;

describe("beat grid", () => {
  it("converts BPM to beat length", () => {
    expect(beatMs(bpm)).toBeCloseTo(500);
    expect(beatMs(0)).toBe(0);
    expect(makeLoop(1000, 4, 0)).toBeNull();
  });

  it("sizes loops in beats", () => {
    expect(makeLoop(1000, 4, bpm)).toEqual({ startMs: 1000, lengthMs: 2000 });
  });
});

describe("loop window", () => {
  const loop = { startMs: 1000, lengthMs: 2000 };

  it("wraps the playhead back to the start when the end passes", () => {
    expect(loopedPosition(1500, loop)).toBe(1500);
    expect(loopedPosition(3000, loop)).toBe(1000);
    expect(loopedPosition(3500, loop)).toBe(1500);
  });

  it("leaves positions before the loop alone", () => {
    expect(loopedPosition(500, loop)).toBe(500);
  });

  it("treats the end as exclusive", () => {
    expect(insideLoop(1000, loop)).toBe(true);
    expect(insideLoop(2999, loop)).toBe(true);
    expect(insideLoop(3000, loop)).toBe(false);
  });

  it("exits at the next loop boundary, not backwards", () => {
    expect(loopExitPosition(1500, loop)).toBe(3000);
    expect(loopExitPosition(500, loop)).toBe(500);
  });
});

describe("tap tempo", () => {
  it("derives BPM from steady taps", () => {
    expect(tapTempo([0, 500, 1000, 1500])).toBeCloseTo(120);
  });

  it("needs at least three taps", () => {
    expect(tapTempo([0, 500])).toBeNull();
    expect(tapTempo([])).toBeNull();
  });

  it("rejects implausible rates", () => {
    expect(tapTempo([0, 100, 200])).toBeNull(); // 600 BPM
    expect(tapTempo([0, 20_000, 40_000])).toBeNull(); // 3 BPM
  });

  it("ignores tap order", () => {
    expect(tapTempo([1000, 0, 500])).toBeCloseTo(120);
  });
});
