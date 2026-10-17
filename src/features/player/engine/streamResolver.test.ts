import { afterEach, describe, expect, it, vi } from "vitest";
import type { Track } from "@/shared/types";

const mocks = vi.hoisted(() => ({
  resolveDirectAudioStream: vi.fn(),
  searchRaw: vi.fn(),
  resolveSoundCloudStream: vi.fn(),
}));

vi.mock("@/shared/media/innertube", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/media/innertube")>();
  return { ...actual, resolveDirectAudioStream: mocks.resolveDirectAudioStream, searchRaw: mocks.searchRaw };
});

vi.mock("@/shared/media/soundcloud", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/shared/media/soundcloud")>();
  return { ...actual, resolveSoundCloudStream: mocks.resolveSoundCloudStream };
});

import { api, canClientDirectFetch, markDirectFetchFailed } from "@/shared/api";
import { resolvePlaybackStream } from "./streamResolver";
import { clearYoutubeStandInCache } from "./youtubeStandIn";

const directStream = {
  url: "https://rr1.googlevideo.com/videoplayback?itag=251",
  mimeType: "audio/webm",
  codec: "opus" as const,
  bitrate: 135_000,
  itag: 251,
  expiresAt: "2030-01-01T00:00:00.000Z",
};

const proxySession = {
  transport: "proxy" as const,
  streamUrl: "https://api.tryliner.fun/v1/playback/pb_1/media",
  mimeType: "audio/mpeg",
  codec: "aac" as const,
  bitrate: 128_000,
};

function track(id: string, title = "Blinding Lights", artists = "The Weeknd", durationMs = 200_000): Track {
  return { id, title, artists, durationMs, coverUrl: "", playCount: 0 };
}

afterEach(() => {
  vi.restoreAllMocks();
  mocks.resolveDirectAudioStream.mockReset();
  mocks.searchRaw.mockReset();
  mocks.resolveSoundCloudStream.mockReset();
  clearYoutubeStandInCache();
});

describe("resolvePlaybackStream for youtube ids", () => {
  it("plays youtube tracks straight from googlevideo without a server session", async () => {
    mocks.resolveDirectAudioStream.mockResolvedValue(directStream);
    const sessionSpy = vi.spyOn(api, "createPlaybackSession");

    const stream = await resolvePlaybackStream(track("dQw4w9WgXcQ"));

    expect(stream).toMatchObject({ url: directStream.url, transport: "direct", expiresAtMs: Date.parse(directStream.expiresAt) });
    expect(sessionSpy).not.toHaveBeenCalled();
    expect(mocks.resolveSoundCloudStream).not.toHaveBeenCalled();
  });

  it("tries the client first even when the connectivity probe cached a blocked result", async () => {
    markDirectFetchFailed("RESOLVE_FAILED");
    expect(canClientDirectFetch()).toBe(false);
    mocks.resolveDirectAudioStream.mockResolvedValue(directStream);
    const sessionSpy = vi.spyOn(api, "createPlaybackSession");

    await expect(resolvePlaybackStream(track("dQw4w9WgXcQ"))).resolves.toMatchObject({ transport: "direct" });
    expect(sessionSpy).not.toHaveBeenCalled();
  });

  it("uses the server proxy for ids of unknown sources", async () => {
    const sessionSpy = vi.spyOn(api, "createPlaybackSession").mockResolvedValue(proxySession);

    const stream = await resolvePlaybackStream(track("local-file-1"));

    expect(mocks.resolveDirectAudioStream).not.toHaveBeenCalled();
    expect(sessionSpy).toHaveBeenCalledWith("local-file-1", undefined, undefined, "proxy");
    expect(stream).toMatchObject({ url: proxySession.streamUrl, transport: "proxy" });
  });

  it("falls back to the server proxy when client resolution fails", async () => {
    mocks.resolveDirectAudioStream.mockRejectedValue(new Error("LOGIN_REQUIRED"));
    vi.spyOn(api, "createPlaybackSession").mockResolvedValue(proxySession);

    await expect(resolvePlaybackStream(track("dQw4w9WgXcQ"))).resolves.toMatchObject({ transport: "proxy" });
  });

  it("surfaces the client error when the proxy fallback also fails", async () => {
    mocks.resolveDirectAudioStream.mockRejectedValue(new Error("LOGIN_REQUIRED"));
    vi.spyOn(api, "createPlaybackSession").mockRejectedValue(new Error("502"));

    await expect(resolvePlaybackStream(track("dQw4w9WgXcQ"))).rejects.toThrow("LOGIN_REQUIRED");
  });
});
