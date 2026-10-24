import React, { act } from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRoot, Root } from "react-dom/client";
import { useLastfmScrobbler } from "./useLastfmScrobbler";
import { useLastfmSettingsStore } from "../store/lastfmSettingsStore";
import { lastfmScrobble, lastfmUpdateNowPlaying } from "../lib/lastfmClient";
import { usePlayerStore } from "@/features/player/engine/playerEngine";
import type { Track } from "@/shared/types";

vi.mock("../lib/lastfmClient", () => ({
  lastfmGetToken: vi.fn(),
  lastfmGetSession: vi.fn(),
  lastfmAuthorizeUrl: vi.fn(() => "https://www.last.fm/api/auth"),
  lastfmUpdateNowPlaying: vi.fn(() => Promise.resolve()),
  lastfmScrobble: vi.fn(() => Promise.resolve()),
}));

// 40s track: passes Last.fm's 30s minimum, scrobble threshold is 20s.
const track: Track = {
  id: "t1",
  title: "Test Song",
  artists: "Test Artist",
  durationMs: 40_000,
  coverUrl: "https://example.com/c.jpg",
  playCount: 0,
};

function Harness() {
  useLastfmScrobbler();
  return null;
}

let container: HTMLDivElement;
let root: Root;

const mount = () => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root.render(<Harness />);
  });
};

describe("useLastfmScrobbler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-24T10:00:00Z"));
    useLastfmSettingsStore.setState({
      enabled: true,
      sessionKey: "SK-test",
      username: "tester",
      pendingToken: null,
      pendingTokenAt: null,
    });
    usePlayerStore.setState({
      status: "playing",
      currentTrack: track,
      durationMs: track.durationMs,
      positionMs: 0,
      error: null,
    });
    mount();
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  it("sends now-playing once and scrobbles at half the track", async () => {
    expect(lastfmUpdateNowPlaying).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(20_500);
    });

    expect(lastfmUpdateNowPlaying).toHaveBeenCalledTimes(1);
    expect(lastfmScrobble).toHaveBeenCalledTimes(1);

    const [, sessionKey, info, startedAt] = vi.mocked(lastfmScrobble).mock.calls[0];
    expect(sessionKey).toBe("SK-test");
    expect(info.artist).toBe("Test Artist");
    expect(info.track).toBe("Test Song");
    expect(info.durationMs).toBe(40_000);
    // Timestamp is the moment playback started, ~20s before the scrobble.
    const expected = Math.floor((Date.now() - 20_000) / 1000);
    expect(Math.abs(startedAt - expected)).toBeLessThanOrEqual(3);
  });

  it("does not credit listening time while paused", async () => {
    await act(async () => {
      vi.advanceTimersByTime(10_000);
    });
    expect(lastfmScrobble).not.toHaveBeenCalled();

    act(() => {
      usePlayerStore.setState({ status: "paused" });
    });
    await act(async () => {
      vi.advanceTimersByTime(60_000);
    });
    expect(lastfmScrobble).not.toHaveBeenCalled();

    act(() => {
      usePlayerStore.setState({ status: "playing" });
    });
    await act(async () => {
      vi.advanceTimersByTime(11_000);
    });

    expect(lastfmScrobble).toHaveBeenCalledTimes(1);
  });

  it("credits a long timer gap (background/throttled WebView)", async () => {
    await act(async () => {
      vi.advanceTimersByTime(5_000);
    });
    expect(lastfmScrobble).not.toHaveBeenCalled();

    // Simulate a suspended renderer: the wall clock moves a minute while the
    // interval never fires, then a single late tick arrives.
    vi.setSystemTime(Date.now() + 60_000);
    await act(async () => {
      vi.advanceTimersByTime(1_000);
    });

    expect(lastfmScrobble).toHaveBeenCalledTimes(1);
  });

  it("falls back to the four-minute ceiling when the duration is unknown", async () => {
    const unknown: Track = { ...track, id: "t2", durationMs: 0 };
    act(() => {
      usePlayerStore.setState({ currentTrack: unknown, durationMs: 0 });
    });

    await act(async () => {
      vi.advanceTimersByTime(200_000);
    });
    expect(lastfmScrobble).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(41_000);
    });
    expect(lastfmScrobble).toHaveBeenCalledTimes(1);
  });

  it("never scrobbles tracks shorter than 30 seconds", async () => {
    const short: Track = { ...track, id: "t3", durationMs: 20_000 };
    act(() => {
      usePlayerStore.setState({ currentTrack: short, durationMs: 20_000 });
    });

    await act(async () => {
      vi.advanceTimersByTime(120_000);
    });
    expect(lastfmScrobble).not.toHaveBeenCalled();
  });

  it("does nothing when the account is not connected", async () => {
    act(() => {
      useLastfmSettingsStore.setState({ sessionKey: null, enabled: false });
    });

    await act(async () => {
      vi.advanceTimersByTime(120_000);
    });
    expect(lastfmUpdateNowPlaying).not.toHaveBeenCalled();
    expect(lastfmScrobble).not.toHaveBeenCalled();
  });
});
