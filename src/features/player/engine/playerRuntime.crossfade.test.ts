import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mocks = vi.hoisted(() => ({ resolvePlaybackStream: vi.fn() }));

vi.mock("./streamResolver", () => ({ resolvePlaybackStream: mocks.resolvePlaybackStream }));

import { playerRuntime } from "./playerRuntime";
import { usePlayerStore } from "../store/playerStore";
import type { Track } from "@/shared/types";

const urlStream = {
  url: "https://rr1.googlevideo.com/videoplayback?itag=251",
  mimeType: "audio/webm",
  codec: "opus",
  bitrate: 128000,
  expiresAtMs: null,
};

function makeTrack(id: string, title: string): Track {
  return {
    id,
    title,
    artists: "Artist",
    durationMs: 100_000,
    coverUrl: "",
    playCount: 0,
  };
}

const t1 = makeTrack("t1", "Track 1");
const t2 = makeTrack("t2", "Track 2");
const t3 = makeTrack("t3", "Track 3");

describe("PlayerRuntime crossfade handover", () => {
  const runtime = playerRuntime as any;
  const initialAudio = runtime.audio;

  function setMediaTiming(element: HTMLAudioElement, duration = 100, currentTime = 95) {
    Object.defineProperty(element, "duration", { value: duration, configurable: true });
    Object.defineProperty(element, "currentTime", {
      value: currentTime,
      configurable: true,
      writable: true,
    });
  }

  beforeEach(() => {
    usePlayerStore.setState({
      status: "playing",
      currentTrack: t1,
      queue: [t1, t2, t3],
      currentIndex: 0,
      positionMs: 0,
      durationMs: t1.durationMs,
      volume: 1,
      error: null,
      transitionPreset: "auto",
    });
    runtime.audio = initialAudio;
    runtime.audio.id = "liner-audio";
    runtime.audio.volume = 1;
    runtime.currentTrackId = t1.id;
    runtime.attachedTrackId = t1.id;
    runtime.adoptTrackId = null;
    runtime.crossfade = null;
    runtime.xAudio = null;
    runtime.endFadeTrackId = null;
    runtime.activeBlobUrl = null;
    runtime.currentSessionExpiresAt = null;
    runtime.recoveryAttempts = 0;
    runtime.recoveryHoldUntilMs = null;
    (window as any).__liner_audio = initialAudio;
  });

  afterEach(() => {
    runtime.cancelCrossfade();
    runtime.cancelFade();
    runtime.audio = initialAudio;
    runtime.currentTrackId = null;
    runtime.attachedTrackId = null;
    runtime.adoptTrackId = null;
    runtime.endFadeTrackId = null;
    runtime.activeBlobUrl = null;
    runtime.xAudio = null;
    (window as any).__liner_audio = initialAudio;
    usePlayerStore.setState({
      status: "idle",
      currentTrack: null,
      queue: [],
      currentIndex: -1,
      positionMs: 0,
      durationMs: 0,
      volume: 1,
      error: null,
      transitionPreset: "auto",
    });
    vi.restoreAllMocks();
    mocks.resolvePlaybackStream.mockReset();
  });

  it("promotes the incoming element and parks the old primary for reuse", () => {
    const oldPrimary = runtime.audio;
    const incoming = new Audio();
    runtime.xAudio = incoming;
    runtime.crossfade = {
      trackId: t2.id,
      element: incoming,
      windowMs: 1_000,
      startedAt: 0,
      timer: null,
      blobUrl: null,
    };

    runtime.completeCrossfade(incoming, t2);

    expect(runtime.audio).toBe(incoming);
    expect(runtime.xAudio).toBe(oldPrimary);
    expect(runtime.getCurrentTrackId()).toBe(t2.id);
    expect(runtime.attachedTrackId).toBe(t2.id);
    expect(runtime.adoptTrackId).toBe(t2.id);
    expect(runtime.endFadeTrackId).toBeNull();
  });

  it("never reuses the live primary as the next incoming element", async () => {
    const primary = runtime.audio;
    setMediaTiming(primary);
    vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue();
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    mocks.resolvePlaybackStream.mockResolvedValue(urlStream);

    await runtime.startCrossfade(t2, 1_000);
    const incoming = runtime.crossfade.element;
    expect(incoming).not.toBe(primary);

    runtime.completeCrossfade(incoming, t2);
    expect(runtime.audio).toBe(incoming);

    // The old primary is now the spare and must be the next incoming side,
    // never the element that is currently audible.
    usePlayerStore.setState({ currentTrack: t2, currentIndex: 1, status: "playing" });
    setMediaTiming(incoming);
    await runtime.startCrossfade(t3, 1_000);

    expect(runtime.crossfade.element).toBe(primary);
    expect(runtime.crossfade.element).not.toBe(runtime.audio);
  });

  it("attaches media listeners to a reused element only once", () => {
    const element = new Audio();
    const addListener = vi.spyOn(element, "addEventListener");

    runtime.setupAudioListeners(element);
    const firstPassCalls = addListener.mock.calls.length;
    runtime.setupAudioListeners(element);

    expect(firstPassCalls).toBeGreaterThan(0);
    expect(addListener).toHaveBeenCalledTimes(firstPassCalls);
  });

  it("cancels the blend and restores the outgoing volume when the incoming stream errors", () => {
    const outgoing = runtime.audio;
    const incoming = new Audio();
    vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
    runtime.xAudio = incoming;
    runtime.setupAudioListeners(incoming);
    runtime.crossfade = {
      trackId: t2.id,
      element: incoming,
      windowMs: 1_000,
      startedAt: 0,
      timer: null,
      blobUrl: null,
    };
    runtime.crossfadeInFlight = false;
    outgoing.volume = 0.25;

    incoming.dispatchEvent(new Event("error"));

    expect(runtime.crossfade).toBeNull();
    expect(outgoing.volume).toBe(1);
    expect(incoming.pause).toHaveBeenCalled();
  });
});
