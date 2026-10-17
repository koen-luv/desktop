import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { playerRuntime, PlayerRuntime } from "./playerRuntime";
import { usePlayerStore } from "../store/playerStore";
import { api } from "@/shared/api";
import { linerDb } from "@/shared/storage";
import { __resetSourceResolverForTests } from "../sources/sourceResolver";
import type { Track } from "@/shared/types";

const track: Track = {
  id: "t1",
  title: "Track",
  artists: "Artist",
  durationMs: 100_000,
  coverUrl: "",
  playCount: 0,
};

function setAudioPaused(value: boolean) {
  Object.defineProperty((playerRuntime as any).audio, "paused", {
    value,
    configurable: true,
  });
}

describe("PlayerRuntime — status must always match the real audio state", () => {
  beforeEach(() => {
    usePlayerStore.setState({
      status: "idle",
      currentTrack: track,
      queue: [track],
      currentIndex: 0,
      positionMs: 0,
      durationMs: track.durationMs,
      volume: 1,
      error: null,
    });
    (playerRuntime as any).audio.src = "blob:mock-stream";
    setAudioPaused(true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("a stale resume() play-promise settling after a newer pause() must not restart the fade/playback sequence", async () => {
    const originalFadeVolume = (PlayerRuntime.prototype as any).fadeVolume;
    const fadeSpy = vi
      .spyOn(PlayerRuntime.prototype as any, "fadeVolume")
      .mockImplementation(function (this: unknown, ...args: unknown[]) {
        return originalFadeVolume.apply(this, args);
      });

    let resolvePlay: () => void;
    const pendingPlay = new Promise<void>((resolve) => {
      resolvePlay = resolve;
    });
    vi.spyOn(HTMLMediaElement.prototype, "play").mockReturnValue(pendingPlay as unknown as Promise<void>);
    const pauseSpy = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});

    playerRuntime!.resume();
    expect(usePlayerStore.getState().status).toBe("playing");
    expect(fadeSpy).not.toHaveBeenCalled();

    playerRuntime!.pause();
    expect(usePlayerStore.getState().status).toBe("paused");
    expect(pauseSpy).toHaveBeenCalledTimes(1);
    expect(fadeSpy).toHaveBeenCalledTimes(1);

    resolvePlay!();
    await pendingPlay;
    await Promise.resolve();
    await Promise.resolve();

    expect(fadeSpy).toHaveBeenCalledTimes(1);
    expect(usePlayerStore.getState().status).toBe("paused");
  });

  it("a stale resume() play-promise rejecting after a newer pause() must not touch status either", async () => {
    let rejectPlay: (err: unknown) => void;
    const pendingPlay = new Promise<void>((_resolve, reject) => {
      rejectPlay = reject;
    });
    vi.spyOn(HTMLMediaElement.prototype, "play").mockReturnValue(pendingPlay as unknown as Promise<void>);
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});

    playerRuntime!.resume();
    playerRuntime!.pause();
    expect(usePlayerStore.getState().status).toBe("paused");

    rejectPlay!(new DOMException("aborted", "AbortError"));
    await pendingPlay.catch(() => {});
    await Promise.resolve();
    await Promise.resolve();

    expect(usePlayerStore.getState().status).toBe("paused");
  });
});

describe("PlayerRuntime audio caching", () => {
  beforeEach(() => {
    __resetSourceResolverForTests();
    if (!globalThis.URL.createObjectURL) {
      globalThis.URL.createObjectURL = vi.fn((_blob: Blob) => "blob:mock-object-url");
    } else {
      vi.spyOn(globalThis.URL, "createObjectURL").mockReturnValue("blob:mock-object-url");
    }
    if (!globalThis.URL.revokeObjectURL) {
      globalThis.URL.revokeObjectURL = vi.fn();
    } else {
      vi.spyOn(globalThis.URL, "revokeObjectURL").mockImplementation(() => {});
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("plays directly from linerDb cache when audio blob exists without calling backend session API", async () => {
    const playSpy = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    const sessionSpy = vi.spyOn(api, "createPlaybackSession");
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    const mockBlob = new Blob(["fake-opus-data"], { type: "audio/webm" });
    await linerDb.putAudio("cached-track-1", mockBlob, "audio/webm");

    const cachedTrack: Track = {
      ...track,
      id: "cached-track-1",
      title: "Cached Track",
    };

    await playerRuntime!.loadAndPlay(cachedTrack);

    expect(sessionSpy).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(playSpy).toHaveBeenCalled();
    expect(usePlayerStore.getState().status).toBe("playing");
  });

  it("fetches and plays without writing to linerDb (files are saved only via Download)", async () => {
    const playSpy = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    const sessionSpy = vi.spyOn(api, "createPlaybackSession").mockResolvedValue({
      sessionId: "pb_123",
      trackId: "fresh-track-2",
      transport: "proxy",
      playbackId: "pb_123",
      streamUrl: "/v1/playback/pb_123/media",
      mimeType: "audio/webm",
      codec: "opus",
      bitrate: 128000,
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4, 0, 0, 0, 0, 0, 0, 0, 0]), {
        status: 206,
        headers: { "content-type": "audio/webm" },
      }),
    );

    const freshTrack: Track = {
      ...track,
      id: "fresh-track-2",
      title: "Fresh Track",
    };

    await playerRuntime!.loadAndPlay(freshTrack);

    expect(sessionSpy).toHaveBeenCalledTimes(1);
    expect(playSpy).toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await linerDb.getAudio("fresh-track-2")).toBeNull();

    (playerRuntime as any).audio.dispatchEvent(new Event("playing"));

    // Give the (now disabled) background cache a chance to run, then assert
    // nothing was downloaded or stored to disk.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await linerDb.getAudio("fresh-track-2")).toBeNull();
  });

  it("drops a cached file that fails to decode and retries once from the network instead of looping", async () => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    const sessionSpy = vi.spyOn(api, "createPlaybackSession").mockResolvedValue({
      sessionId: "pb_bad",
      trackId: "bad-cache-track",
      transport: "proxy",
      playbackId: "pb_bad",
      streamUrl: "/v1/playback/pb_bad/media",
      mimeType: "audio/mpeg",
      codec: "aac",
      bitrate: 128000,
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    });
    const badTrack: Track = { ...track, id: "bad-cache-track", title: "Bad Cache" };
    await linerDb.putAudio(badTrack.id, new Blob([new Uint8Array([9, 9, 9])], { type: "audio/webm" }), "audio/webm");
    usePlayerStore.setState({ currentTrack: badTrack });

    await playerRuntime!.loadAndPlay(badTrack);
    expect(sessionSpy).not.toHaveBeenCalled();

    (playerRuntime as any).audio.dispatchEvent(new Event("error"));

    await vi.waitFor(() => expect(sessionSpy).toHaveBeenCalledTimes(1));
    expect(await linerDb.getAudio(badTrack.id)).toBeNull();

    const errors: unknown[] = [];
    (playerRuntime as any).onError = (e: unknown) => errors.push(e);
    (playerRuntime as any).audio.dispatchEvent(new Event("error"));
    expect(errors).toHaveLength(1);
    expect(sessionSpy).toHaveBeenCalledTimes(1);
  });

  it("preloads the stream URL without downloading, and plays without storing", async () => {
    const sessionSpy = vi.spyOn(api, "createPlaybackSession").mockResolvedValue({
      sessionId: "pb_preload_1",
      trackId: "next-track-3",
      transport: "proxy",
      playbackId: "pb_preload_1",
      streamUrl: "/v1/playback/pb_preload_1/media",
      mimeType: "audio/webm",
      codec: "opus",
      bitrate: 128000,
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 5, 6, 7, 8, 0, 0, 0, 0, 0, 0, 0, 0]), {
        status: 206,
        headers: { "content-type": "audio/webm" },
      }),
    );

    const nextTrack: Track = {
      ...track,
      id: "next-track-3",
      title: "Next Track",
    };

    await playerRuntime!.preloadTrack(nextTrack);

    // The stream URL is resolved (warmed), but nothing is downloaded or stored.
    expect(sessionSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await linerDb.getAudio("next-track-3")).toBeNull();

    sessionSpy.mockClear();

    const playSpy = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    await playerRuntime!.loadAndPlay(nextTrack);

    // Playback resolves its own session and still never writes to disk.
    expect(playSpy).toHaveBeenCalled();
    expect(usePlayerStore.getState().status).toBe("playing");
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(await linerDb.getAudio("next-track-3")).toBeNull();
  });

  it("drops an unreadable cached file and recovers from the network once instead of looping", async () => {
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    const sessionSpy = vi.spyOn(api, "createPlaybackSession").mockResolvedValue({
      sessionId: "pb_c",
      trackId: "corrupt-track",
      transport: "proxy",
      playbackId: "pb_c",
      streamUrl: "/v1/playback/pb_c/media",
      mimeType: "audio/webm",
      codec: "opus",
      bitrate: 128000,
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    });
    // background re-cache gets a dash segment again, which must not be stored
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      new Response(new Uint8Array([0, 0, 0, 0x18, 0x73, 0x74, 0x79, 0x70, 0, 0, 0, 0, 0, 0, 0, 0]), { status: 206 }),
    );

    const corruptTrack: Track = { ...track, id: "corrupt-track", title: "Corrupt" };
    await linerDb.putAudio("corrupt-track", new Blob(["styp-segment"]), "audio/webm");
    usePlayerStore.setState({ currentTrack: corruptTrack, positionMs: 0 });
    await playerRuntime!.loadAndPlay(corruptTrack);

    const audio = (playerRuntime as any).audio as HTMLAudioElement;
    Object.defineProperty(audio, "error", { value: { code: 4, message: "DEMUXER_ERROR_COULD_NOT_OPEN" }, configurable: true });
    try {
      audio.dispatchEvent(new Event("error"));
      await vi.waitFor(() => expect(sessionSpy).toHaveBeenCalledTimes(1));
      expect(await linerDb.getAudio("corrupt-track")).toBeNull();

      // a second failure on the same track gives up instead of retrying forever
      audio.dispatchEvent(new Event("error"));
      await vi.waitFor(() => expect(usePlayerStore.getState().status).toBe("error"));
      expect(sessionSpy).toHaveBeenCalledTimes(1);
    } finally {
      delete (audio as any).error;
    }
  });
});

describe("PlayerRuntime — track transition fades", () => {
  beforeEach(() => {
    usePlayerStore.setState({
      status: "playing",
      currentTrack: track,
      queue: [track],
      currentIndex: 0,
      positionMs: 0,
      durationMs: track.durationMs,
      volume: 1,
      error: null,
      transitionPreset: "off",
    });
    (playerRuntime as any).audio.src = "blob:mock-stream";
    (playerRuntime as any).currentTrackId = track.id;
    (playerRuntime as any).endFadeTrackId = null;
    setAudioPaused(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function setAudioTimeline(positionS: number, durationS: number) {
    Object.defineProperty((playerRuntime as any).audio, "duration", {
      value: durationS,
      configurable: true,
    });
    Object.defineProperty((playerRuntime as any).audio, "currentTime", {
      value: positionS,
      writable: true,
      configurable: true,
    });
  }

  it("with 'off' the transition never touches volume on track start", () => {
    usePlayerStore.setState({ transitionPreset: "off", volume: 0.8 });
    const fadeSpy = vi
      .spyOn(PlayerRuntime.prototype as any, "fadeVolume")
      .mockImplementation(() => {});
    (playerRuntime as any).audio.volume = 0;

    (playerRuntime as any).applyTransitionFadeIn();

    expect(fadeSpy).not.toHaveBeenCalled();
    expect((playerRuntime as any).audio.volume).toBeCloseTo(0.8);
  });

  it("fades the outgoing song out over its final stretch, exactly once per track", () => {
    usePlayerStore.setState({ transitionPreset: "soft" });
    const fadeSpy = vi
      .spyOn(PlayerRuntime.prototype as any, "fadeVolume")
      .mockImplementation(() => {});

    // 100s track, 300ms left — inside the 500ms "soft" fade-out window.
    setAudioTimeline(99.7, 100);
    (playerRuntime as any).audio.dispatchEvent(new Event("timeupdate"));
    expect(fadeSpy).toHaveBeenCalledTimes(1);
    expect(fadeSpy).toHaveBeenCalledWith(0, 500);

    // Later ticks in the same tail must not restart (and re-cut) the fade.
    setAudioTimeline(99.9, 100);
    (playerRuntime as any).audio.dispatchEvent(new Event("timeupdate"));
    expect(fadeSpy).toHaveBeenCalledTimes(1);
  });

  it("does not fade out when still far from the end of the track", () => {
    usePlayerStore.setState({ transitionPreset: "soft" });
    const fadeSpy = vi
      .spyOn(PlayerRuntime.prototype as any, "fadeVolume")
      .mockImplementation(() => {});

    setAudioTimeline(50, 100);
    (playerRuntime as any).audio.dispatchEvent(new Event("timeupdate"));
    expect(fadeSpy).not.toHaveBeenCalled();
  });

  it("a manual skip fades the outgoing track out before switching", async () => {
    usePlayerStore.setState({ transitionPreset: "soft" });
    const fadeSpy = vi
      .spyOn(PlayerRuntime.prototype as any, "fadeVolume")
      .mockImplementation((...args: unknown[]) => {
        (args[2] as (() => void) | undefined)?.();
      });
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    vi.spyOn(api, "createPlaybackSession").mockResolvedValue({
      sessionId: "pb_skip",
      trackId: "t2",
      transport: "proxy",
      playbackId: "pb_skip",
      streamUrl: "/v1/playback/pb_skip/media",
      mimeType: "audio/webm",
      codec: "opus",
      bitrate: 128000,
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4]), {
        status: 206,
        headers: { "content-type": "audio/webm" },
      }),
    );
    const nextTrack: Track = { ...track, id: "t2", title: "Next" };

    await playerRuntime!.loadAndPlay(nextTrack);

    expect(fadeSpy).toHaveBeenCalledWith(0, 500, expect.any(Function));
  });

  it("seeking away from the tail restores volume and cancels the end fade", () => {
    (playerRuntime as any).endFadeTrackId = track.id;
    (playerRuntime as any).audio.volume = 0;
    setAudioPaused(false);
    setAudioTimeline(99.9, 100);

    playerRuntime!.seek(10_000);

    expect((playerRuntime as any).endFadeTrackId).toBeNull();
    expect((playerRuntime as any).audio.volume).toBeCloseTo(1);
  });
});

describe("PlayerRuntime — sleep timer", () => {
  afterEach(() => vi.restoreAllMocks());

  it("cancels a pending sleep timer when the deadline is cleared", () => {
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");
    (playerRuntime as any).sleepTimerId = setTimeout(() => {}, 60_000);
    (playerRuntime as any).syncSleepTimer(null);
    expect((playerRuntime as any).sleepTimerId).toBeNull();
    expect(clearSpy).toHaveBeenCalled();
  });

  it("clears the timer without fading when playback is not active", () => {
    usePlayerStore.setState({
      status: "paused",
      sleepTimerEndsAtMs: Date.now() + 10_000,
    });
    const fadeSpy = vi.spyOn(PlayerRuntime.prototype as any, "fadeVolume");
    (playerRuntime as any).fireSleepTimer();
    expect(fadeSpy).not.toHaveBeenCalled();
    expect(usePlayerStore.getState().sleepTimerEndsAtMs).toBeNull();
  });

  it("fades out and pauses when the timer fires during playback", () => {
    usePlayerStore.setState({
      status: "playing",
      volume: 1,
      sleepTimerEndsAtMs: Date.now() + 10_000,
    });
    (playerRuntime as any).audio.src = "blob:mock";
    setAudioPaused(false);
    const fadeSpy = vi
      .spyOn(PlayerRuntime.prototype as any, "fadeVolume")
      .mockImplementation((...args: unknown[]) => {
        (args[2] as (() => void) | undefined)?.();
      });

    (playerRuntime as any).fireSleepTimer();

    expect(fadeSpy).toHaveBeenCalled();
    expect(usePlayerStore.getState().sleepTimerEndsAtMs).toBeNull();
    expect(usePlayerStore.getState().status).toBe("paused");
    expect((playerRuntime as any).audio.volume).toBeCloseTo(1);
  });
});
