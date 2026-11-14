import { afterEach, describe, expect, it, vi } from "vitest";
import type { Track } from "@/shared/types";

const mocks = vi.hoisted(() => ({
  extractYtMusicAudio: vi.fn(),
  extractAudioStream: vi.fn(),
  canExecuteDirectInnertubePlans: vi.fn(() => true),
}));

vi.mock("@/shared/media/innertube/ytmusic", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/media/innertube/ytmusic")>();
  return { ...actual, extractYtMusicAudio: mocks.extractYtMusicAudio };
});

vi.mock("@/shared/api/innertubeClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/api/innertubeClient")>();
  return { ...actual, extractAudioStream: mocks.extractAudioStream };
});

vi.mock("./codecSupport", () => ({
  canExecuteDirectInnertubePlans: mocks.canExecuteDirectInnertubePlans,
  isCodecSupported: () => true,
  resetCodecProbeCache: vi.fn(),
}));

import { YtMusicExtractError, type YtMusicStream } from "@/shared/media/innertube/ytmusic";
import { defaultSourceProviders, innertubeClientProvider } from "./providers";
import { SourceError, type ResolveContext } from "./types";

const EXPIRE = Math.floor(Date.UTC(2030, 0, 1) / 1000);

function track(id = "dQw4w9WgXcQ"): Track {
  return { id, title: "Blinding Lights", artists: "The Weeknd", durationMs: 200_000, coverUrl: "", playCount: 0 };
}

function context(overrides: Partial<ResolveContext> = {}): ResolveContext {
  return {
    track: track(),
    purpose: "playback",
    signal: new AbortController().signal,
    forceRefresh: false,
    quality: "high",
    ...overrides,
  };
}

function ytStream(overrides: Partial<YtMusicStream> = {}): YtMusicStream {
  return {
    url: `https://rr1.googlevideo.com/videoplayback?itag=251&expire=${EXPIRE}`,
    headers: { Referer: "https://music.youtube.com/" },
    mimeType: "audio/webm",
    codec: "opus",
    bitrate: 135_000,
    itag: 251,
    expiresAtMs: EXPIRE * 1000,
    clientId: "WEB_REMIX",
    boundedRangeOnly: false,
    resolvedAt: Date.now(),
    ...overrides,
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("provider registration", () => {
  it("keeps every existing provider and leads with client extraction", () => {
    const ids = defaultSourceProviders.map((provider) => provider.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        "innertube-client",
        "neritium-auto",
        "ytdlp",
        "neritium-direct-aac",
        "neritium-direct-opus",
        "neritium-proxy-aac",
      ]),
    );
    const client = defaultSourceProviders.find((provider) => provider.id === "innertube-client");
    expect(client).toBe(innertubeClientProvider);
    expect(client?.priority).toBe(Math.max(...defaultSourceProviders.map((provider) => provider.priority)));
  });

  it("supports only YouTube ids where direct execution is possible", () => {
    expect(innertubeClientProvider.supports(track())).toBe(true);
    expect(innertubeClientProvider.supports(track("sc:12345"))).toBe(false);
    expect(innertubeClientProvider.supports({ ...track(), id: "" })).toBe(false);

    mocks.canExecuteDirectInnertubePlans.mockReturnValueOnce(false);
    expect(innertubeClientProvider.supports(track())).toBe(false);
  });
});

describe("innertube-client resolve", () => {
  it("resolves through the YouTube Music extractor with headers, format and expiry", async () => {
    mocks.extractYtMusicAudio.mockResolvedValue(ytStream());

    const stream = await innertubeClientProvider.resolve(context());

    expect(mocks.extractYtMusicAudio).toHaveBeenCalledWith("dQw4w9WgXcQ", expect.objectContaining({ quality: "high" }));
    expect(stream).toMatchObject({
      url: `https://rr1.googlevideo.com/videoplayback?itag=251&expire=${EXPIRE}`,
      headers: { Referer: "https://music.youtube.com/" },
      mimeType: "audio/webm",
      codec: "opus",
      itag: 251,
      expiresAtMs: EXPIRE * 1000,
      providerId: "innertube-client",
      providerTrackId: "dQw4w9WgXcQ",
    });
    expect(mocks.extractAudioStream).not.toHaveBeenCalled();
  });

  it("maps the lossless tier onto YouTube's best available quality", async () => {
    mocks.extractYtMusicAudio.mockResolvedValue(ytStream());

    await innertubeClientProvider.resolve(context({ quality: "lossless" }));

    expect(mocks.extractYtMusicAudio).toHaveBeenCalledWith("dQw4w9WgXcQ", expect.objectContaining({ quality: "high" }));
  });

  it("falls back to the preserved classic extraction when the new pipeline fails", async () => {
    mocks.extractYtMusicAudio.mockRejectedValue(new YtMusicExtractError("unavailable", "every client refused"));
    mocks.extractAudioStream.mockResolvedValue({
      url: `https://rr2.googlevideo.com/videoplayback?itag=140&expire=${EXPIRE}`,
      mimeType: "audio/mp4",
      codec: "aac",
      bitrate: 128_000,
      videoId: "dQw4w9WgXcQ",
    });

    const stream = await innertubeClientProvider.resolve(context());

    expect(mocks.extractAudioStream).toHaveBeenCalledTimes(1);
    expect(stream).toMatchObject({
      url: `https://rr2.googlevideo.com/videoplayback?itag=140&expire=${EXPIRE}`,
      codec: "aac",
      providerId: "innertube-client",
      expiresAtMs: EXPIRE * 1000,
    });
  });

  it("surfaces a classified SourceError when both extractions fail", async () => {
    mocks.extractYtMusicAudio.mockRejectedValue(new YtMusicExtractError("unavailable", "every client refused"));
    mocks.extractAudioStream.mockRejectedValue(new Error("boom"));

    const error = await innertubeClientProvider.resolve(context()).catch((e) => e);

    expect(error).toBeInstanceOf(SourceError);
    expect(error).toMatchObject({ code: "network", providerId: "innertube-client" });
  });

  it("treats a cancelled extraction as cancellation without burning the fallback", async () => {
    mocks.extractYtMusicAudio.mockRejectedValue(new YtMusicExtractError("cancelled", "aborted"));

    const error = await innertubeClientProvider.resolve(context()).catch((e) => e);

    expect(error).toBeInstanceOf(SourceError);
    expect(error).toMatchObject({ code: "cancelled", providerId: "innertube-client" });
    expect(mocks.extractAudioStream).not.toHaveBeenCalled();
  });
});
