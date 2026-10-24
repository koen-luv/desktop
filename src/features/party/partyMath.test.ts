import { describe, expect, it } from "vitest";
import {
  DRIFT_TOLERANCE_MS,
  expectedPositionMs,
  planResync,
  stampPlaybackStateAtReceipt,
  type RemotePlaybackState,
} from "./partyMath";

const remote: RemotePlaybackState = {
  trackId: "t1",
  positionMs: 60_000,
  playing: true,
  sentAt: 1_000,
};

const local = { trackId: "t1", positionMs: 60_000, playing: true };

describe("expectedPositionMs", () => {
  it("extrapolates forward while the host is playing", () => {
    expect(expectedPositionMs(remote, 1_000 + 2_500)).toBe(62_500);
  });

  it("never extrapolates backwards on clock skew", () => {
    expect(expectedPositionMs(remote, 500)).toBe(60_000);
  });

  it("stays pinned while the host is paused", () => {
    expect(
      expectedPositionMs({ ...remote, playing: false }, 1_000 + 9_999),
    ).toBe(60_000);
  });
});

describe("stampPlaybackStateAtReceipt", () => {
  it("uses the local receipt clock instead of the host clock", () => {
    expect(stampPlaybackStateAtReceipt(remote, 5_000)).toEqual({
      ...remote,
      sentAt: 5_000,
    });
    expect(
      expectedPositionMs(stampPlaybackStateAtReceipt(remote, 5_000), 7_000),
    ).toBe(62_000);
  });
});

describe("planResync", () => {
  it("does nothing when in sync", () => {
    const now = 1_000 + 1_000; // expected 61_000
    expect(
      planResync({ ...local, positionMs: 61_000 }, remote, now),
    ).toEqual({ seekToMs: null, play: null });
  });

  it("tolerates drift exactly at the threshold", () => {
    const now = 1_000; // expected 60_000
    const behind = 60_000 - DRIFT_TOLERANCE_MS;
    expect(planResync({ ...local, positionMs: behind }, remote, now).seekToMs)
      .toBeNull();
  });

  it("seeks when behind beyond tolerance", () => {
    const now = 1_000;
    const behind = 60_000 - DRIFT_TOLERANCE_MS - 1;
    const action = planResync({ ...local, positionMs: behind }, remote, now);
    expect(action.seekToMs).toBe(60_000);
    expect(action.play).toBeNull();
  });

  it("seeks when ahead beyond tolerance", () => {
    const now = 1_000;
    const ahead = 60_000 + DRIFT_TOLERANCE_MS + 1;
    expect(
      planResync({ ...local, positionMs: ahead }, remote, now).seekToMs,
    ).toBe(60_000);
  });

  it("seeks to the extrapolated position, not the message's", () => {
    const now = 1_000 + 10_000; // expected 70_000
    const action = planResync({ ...local, positionMs: 0 }, remote, now);
    expect(action.seekToMs).toBe(70_000);
  });

  it("requests play when only the host is playing", () => {
    const now = 1_000;
    expect(planResync({ ...local, playing: false }, remote, now).play).toBe(
      true,
    );
  });

  it("requests pause when only the guest is playing", () => {
    const now = 1_000;
    expect(
      planResync({ ...local, playing: true }, { ...remote, playing: false }, now)
        .play,
    ).toBe(false);
  });

  it("pairs a transport change with a seek when both differ", () => {
    const now = 1_000;
    const action = planResync(
      { ...local, positionMs: 0, playing: false },
      remote,
      now,
    );
    expect(action).toEqual({ seekToMs: 60_000, play: true });
  });

  it("leaves the transport alone when both sides match", () => {
    const now = 1_000;
    const bothPlaying = planResync({ ...local, playing: true }, remote, now);
    const bothPaused = planResync(
      { ...local, playing: false },
      { ...remote, playing: false },
      now,
    );
    expect(bothPlaying.play).toBeNull();
    expect(bothPaused.play).toBeNull();
  });
});
