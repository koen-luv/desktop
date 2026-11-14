import { afterEach, describe, expect, it, vi } from "vitest";
import type { SearchResult } from "@/shared/contracts";
import type { Track } from "@/shared/types";

const mocks = vi.hoisted(() => ({
  resolveDirectAudioStream: vi.fn(),
  extractYtMusicAudio: vi.fn(),
  searchRaw: vi.fn(),
  resolveSoundCloudStream: vi.fn(),
  createPlaybackSession: vi.fn(),
}));

vi.mock("@/shared/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/api")>();
  return {
    ...actual,
    api: { ...actual.api, createPlaybackSession: mocks.createPlaybackSession },
  };
});

// The browser path mints a PO token before asking the backend; keep the suite
// off the network and let it proceed anonymously.
vi.mock("@/shared/media/innertube/poTokenClient", () => ({
  mintPoToken: vi.fn(async () => null),
}));

vi.mock("@/shared/media/innertube", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/media/innertube")>();
  return { ...actual, resolveDirectAudioStream: mocks.resolveDirectAudioStream, searchRaw: mocks.searchRaw };
});

// The recovery stage after the profile chain is the YouTube Music extractor;
// keep it off the network (it is covered by its own suite).
vi.mock("@/shared/media/innertube/ytmusic", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/media/innertube/ytmusic")>();
  return { ...actual, extractYtMusicAudio: mocks.extractYtMusicAudio };
});

vi.mock("@/shared/media/soundcloud", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/media/soundcloud")>();
  return { ...actual, resolveSoundCloudStream: mocks.resolveSoundCloudStream };
});

import { isWebPlaybackUnsupported, resolvePlaybackStream } from "./streamResolver";
import { clearYoutubeStandInCache } from "./youtubeStandIn";
import { resetCodecProbeCache } from "../sources/codecSupport";

/**
 * The resolver is platform-dependent: a native shell (Electron / Android) may
 * call Innertube directly, a browser may not. These suites describe the native
 * behaviour, so they declare a desktop shell.
 */
function installDesktopShell() {
  (window as unknown as { neritiumElectron?: unknown }).neritiumElectron = { platform: "linux" };
  resetCodecProbeCache();
}

const directStream = {
  url: "https://rr1.googlevideo.com/videoplayback?itag=251",
  mimeType: "audio/webm",
  codec: "opus" as const,
  bitrate: 135_000,
  itag: 251,
  expiresAt: "2030-01-01T00:00:00.000Z",
};

function track(id: string, title = "Blinding Lights", artists = "The Weeknd", durationMs = 200_000): Track {
  return { id, title, artists, durationMs, coverUrl: "", playCount: 0 };
}

function searchTrack(id: string, title: string, artist: string, durationMs: number): SearchResult {
  return { type: "track", id, title, artists: [{ id: `UC_${artist}`, name: artist }], durationMs };
}

afterEach(() => {
  vi.restoreAllMocks();
  delete (window as unknown as { neritiumElectron?: unknown }).neritiumElectron;
  resetCodecProbeCache();
  mocks.resolveDirectAudioStream.mockReset();
  mocks.extractYtMusicAudio.mockReset();
  mocks.extractYtMusicAudio.mockRejectedValue(new Error("no YouTube Music client could serve the video"));
  mocks.searchRaw.mockReset();
  mocks.resolveSoundCloudStream.mockReset();
  mocks.createPlaybackSession.mockReset();
  clearYoutubeStandInCache();
});

describe("resolvePlaybackStream for youtube ids", () => {
  it("plays youtube tracks straight from googlevideo", async () => {
    installDesktopShell();
    mocks.resolveDirectAudioStream.mockResolvedValue(directStream);

    const stream = await resolvePlaybackStream(track("dQw4w9WgXcQ"));

    expect(stream).toMatchObject({ url: directStream.url, expiresAtMs: Date.parse(directStream.expiresAt) });
    expect(mocks.resolveSoundCloudStream).not.toHaveBeenCalled();
  });

  it("surfaces the innertube error when youtube cannot play the track", async () => {
    installDesktopShell();
    mocks.resolveDirectAudioStream.mockRejectedValue(new Error("LOGIN_REQUIRED"));

    await expect(resolvePlaybackStream(track("dQw4w9WgXcQ"))).rejects.toThrow("LOGIN_REQUIRED");
  });

  it("falls back to YouTube Music extraction when the profile chain fails", async () => {
    installDesktopShell();
    mocks.resolveDirectAudioStream.mockRejectedValue(new Error("LOGIN_REQUIRED"));
    mocks.extractYtMusicAudio.mockResolvedValue({
      url: "https://rr1.googlevideo.com/videoplayback?itag=251&expire=1999999999",
      headers: { Referer: "https://music.youtube.com/" },
      mimeType: "audio/webm",
      codec: "opus",
      bitrate: 135_000,
      itag: 251,
      expiresAtMs: Date.parse("2033-05-18T00:00:00.000Z"),
      clientId: "WEB_REMIX",
      boundedRangeOnly: false,
      resolvedAt: Date.now(),
    });

    const stream = await resolvePlaybackStream(track("dQw4w9WgXcQ"));

    expect(mocks.extractYtMusicAudio).toHaveBeenCalledWith("dQw4w9WgXcQ", expect.objectContaining({ signal: undefined }));
    expect(stream).toMatchObject({
      url: "https://rr1.googlevideo.com/videoplayback?itag=251&expire=1999999999",
      headers: { Referer: "https://music.youtube.com/" },
      itag: 251,
      codec: "opus",
    });
  });

  it("keeps the original error when YouTube Music extraction also fails", async () => {
    installDesktopShell();
    mocks.resolveDirectAudioStream.mockRejectedValue(new Error("LOGIN_REQUIRED"));

    await expect(resolvePlaybackStream(track("dQw4w9WgXcQ"))).rejects.toThrow("LOGIN_REQUIRED");
    expect(mocks.extractYtMusicAudio).toHaveBeenCalledTimes(1);
  });
});

describe("resolvePlaybackStream for ids of unknown sources", () => {
  it("plays the matching youtube track", async () => {
    installDesktopShell();
    mocks.searchRaw.mockResolvedValue([searchTrack("4NRXx6U8ABQ", "Blinding Lights", "The Weeknd", 200_040)]);
    mocks.resolveDirectAudioStream.mockResolvedValue(directStream);

    const stream = await resolvePlaybackStream(track("local-file-1"));

    expect(mocks.resolveDirectAudioStream).toHaveBeenCalledWith("4NRXx6U8ABQ", { signal: undefined });
    expect(stream).toMatchObject({ url: directStream.url });
  });

  it("fails when youtube has no matching track", async () => {
    mocks.searchRaw.mockResolvedValue([]);

    await expect(resolvePlaybackStream(track("local-file-2"))).rejects.toThrow("No matching YouTube track found");
  });
});

describe("resolvePlaybackStream in a browser (no native shell)", () => {
  it("resolves through the backend instead of calling YouTube", async () => {
    mocks.createPlaybackSession.mockResolvedValue({
      streamUrl: "https://liner-api.example.com/v1/stream/abc",
      mimeType: "audio/mp4",
      codec: "aac",
      bitrate: 128_000,
      expiresAt: null,
    });

    const stream = await resolvePlaybackStream(track("dQw4w9WgXcQ"));

    expect(stream.url).toBe("https://liner-api.example.com/v1/stream/abc");
    expect(mocks.createPlaybackSession).toHaveBeenCalledTimes(1);
    // The browser must never attempt the CORS-blocked direct path.
    expect(mocks.resolveDirectAudioStream).not.toHaveBeenCalled();
  });

  it("reports a capability failure instead of an unplayable track", async () => {
    mocks.createPlaybackSession.mockRejectedValue(new Error("CLIENT_ONLY"));

    await expect(resolvePlaybackStream(track("dQw4w9WgXcQ"))).rejects.toSatisfy(
      (error: unknown) => isWebPlaybackUnsupported(error),
    );
    expect(mocks.resolveDirectAudioStream).not.toHaveBeenCalled();
    expect(mocks.searchRaw).not.toHaveBeenCalled();
  });
});
