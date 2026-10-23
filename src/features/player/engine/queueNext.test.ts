import { describe, it, expect } from "vitest";
import { computeNextIndex, peekAutoNextTrack } from "./queueNext";
import type { Track } from "@/shared/types";

const track = (id: string): Track => ({ id, title: id, durationMs: 180_000 }) as unknown as Track;

const base = {
  queue: [track("a"), track("b"), track("c")],
  currentIndex: 0,
  repeat: "off" as const,
  playbackContext: null as string | null,
};

describe("queue next peek (crossfade handover agreement)", () => {
  it("picks the following track on auto-advance", () => {
    expect(peekAutoNextTrack(base)?.id).toBe("b");
  });

  it("never overlaps repeat-one (the advance replays the same song)", () => {
    expect(peekAutoNextTrack({ ...base, repeat: "one" })).toBeNull();
    expect(computeNextIndex({ ...base, repeat: "one" }, true)).toBe(0);
  });

  it("wraps with repeat-all and returns the wrapped track", () => {
    const atEnd = { ...base, currentIndex: 2, repeat: "all" as const };
    expect(peekAutoNextTrack(atEnd)?.id).toBe("a");
  });

  it("returns null at the end of a plain queue (playback stops)", () => {
    expect(peekAutoNextTrack({ ...base, currentIndex: 2 })).toBeNull();
  });

  it("returns null for radio at the tail (refill, not overlap)", () => {
    const radio = {
      ...base,
      currentIndex: 2,
      playbackContext: "radio:seed",
    };
    expect(peekAutoNextTrack(radio)).toBeNull();
  });

  it("stays silent on an empty queue or unset index", () => {
    expect(peekAutoNextTrack({ ...base, queue: [] })).toBeNull();
    expect(peekAutoNextTrack({ ...base, currentIndex: -1 })).toBeNull();
  });
});
