import { describe, expect, it } from "vitest";
import { detectBpm, onsetEnvelope, quantizePosition } from "./bpm";

/** Synthetic track: a click every `beatMs`, plus quiet noise between. */
function clickTrack(sampleRate: number, beatMs: number, seconds: number): Float32Array {
  const length = sampleRate * seconds;
  const samples = new Float32Array(length);
  for (let beat = 0; beat * beatMs < seconds * 1000; beat += 1) {
    const start = Math.floor((beat * beatMs * sampleRate) / 1000);
    for (let i = 0; i < sampleRate * 0.02 && start + i < length; i += 1) {
      samples[start + i] = 0.9 * Math.sin((2 * Math.PI * 1000 * i) / sampleRate);
    }
  }
  return samples;
}

describe("bpm detection", () => {
  it("finds a 120 BPM click track", () => {
    const estimate = detectBpm(clickTrack(44_100, 500, 8), 44_100);
    expect(estimate).not.toBeNull();
    expect(estimate!.bpm).toBeGreaterThan(110);
    expect(estimate!.bpm).toBeLessThan(130);
  });

  it("finds a 90 BPM click track", () => {
    const estimate = detectBpm(clickTrack(44_100, 6000 / 9, 10), 44_100);
    expect(estimate!.bpm).toBeGreaterThan(80);
    expect(estimate!.bpm).toBeLessThan(100);
  });

  it("gives up on audio too short to analyse", () => {
    expect(detectBpm(new Float32Array(44_100), 44_100)).toBeNull();
  });

  it("produces an onset envelope with one frame per window", () => {
    const onsets = onsetEnvelope(new Float32Array(44_100), 44_100, 23);
    expect(onsets.length).toBe(Math.floor(44_100 / Math.floor((44_100 * 23) / 1000)));
  });
});

describe("quantise", () => {
  it("snaps to the nearest beat", () => {
    // 120 BPM, anchor 1000: beats at 1000, 1500, 2000…
    expect(quantizePosition(1740, 120, 1000)).toBe(1500);
    expect(quantizePosition(1760, 120, 1000)).toBe(2000);
  });

  it("interpolates with partial strength", () => {
    expect(quantizePosition(1740, 120, 1000, 0.5)).toBe(1620);
  });

  it("is inert without a tempo", () => {
    expect(quantizePosition(1234, 0, 0)).toBe(1234);
  });
});
