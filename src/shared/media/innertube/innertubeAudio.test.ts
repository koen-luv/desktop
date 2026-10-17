import { afterEach, describe, expect, it, vi } from "vitest";

const { resetClientVisitorData } = vi.hoisted(() => ({ resetClientVisitorData: vi.fn() }));

vi.mock("@/shared/api/visitorSession", () => ({
  getClientVisitorData: async () => "CgtVISITOR123",
  resetClientVisitorData,
}));

import { resolveDirectAudioStream, toVideoId } from "./innertubeAudio";
import { selectBestAudioFormat, type AudioFormat } from "./innertubeAudioFormats";

const expire = Math.floor(Date.UTC(2030, 0, 1) / 1000);
const opus: AudioFormat = { itag: 251, url: `https://rr1.googlevideo.com/videoplayback?itag=251&expire=${expire}`, mimeType: 'audio/webm; codecs="opus"', bitrate: 135_000 };
const aac: AudioFormat = { itag: 140, url: "https://rr1.googlevideo.com/videoplayback?itag=140", mimeType: 'audio/mp4; codecs="mp4a.40.2"', bitrate: 130_000 };
const low: AudioFormat = { itag: 249, url: "https://rr1.googlevideo.com/videoplayback?itag=249", mimeType: 'audio/webm; codecs="opus"', bitrate: 50_000 };

function playerResponse(formats: unknown[], status = "OK") {
  return new Response(
    JSON.stringify({ playabilityStatus: { status, reason: status === "OK" ? undefined : "Sign in to confirm" }, streamingData: { adaptiveFormats: formats } }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  resetClientVisitorData.mockClear();
});

describe("audio format selection", () => {
  it("prefers opus 251, then aac 140", () => {
    expect(selectBestAudioFormat([low, aac, opus])?.itag).toBe(251);
    expect(selectBestAudioFormat([low, aac])?.itag).toBe(140);
    expect(selectBestAudioFormat([aac, opus], "aac")?.itag).toBe(140);
  });

  it("returns null when there are no direct audio formats", () => {
    expect(selectBestAudioFormat([])).toBeNull();
  });
});

describe("resolveDirectAudioStream", () => {
  it("resolves opus through the VISIONOS profile on music.youtube.com", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      playerResponse([{ ...aac }, { ...opus }, { itag: 18, url: "https://x", mimeType: "video/mp4" }]),
    );
    const stream = await resolveDirectAudioStream("dQw4w9WgXcQ");

    expect(stream).toMatchObject({ itag: 251, codec: "opus", mimeType: "audio/webm", url: opus.url });
    expect(stream.expiresAt).toBe(new Date(expire * 1000).toISOString());

    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://music.youtube.com/youtubei/v1/player?prettyPrint=false");
    const headers = (init?.headers ?? {}) as Record<string, string>;
    expect(headers["x-youtube-client-name"]).toBe("101");
    expect(headers["x-goog-visitor-id"]).toBe("CgtVISITOR123");
    expect(headers["x-liner-user-agent"]).toContain("visionos");
    const body = JSON.parse(String(init?.body));
    expect(body.videoId).toBe("dQw4w9WgXcQ");
    expect(body.context.client).toMatchObject({ clientName: "VISIONOS", clientVersion: "1.04", visitorData: "CgtVISITOR123" });
  });

  it("refreshes visitorData and retries once when youtube asks for a bot check", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(playerResponse([], "LOGIN_REQUIRED"))
      .mockResolvedValueOnce(playerResponse([opus]));
    const stream = await resolveDirectAudioStream("dQw4w9WgXcQ");

    expect(resetClientVisitorData).toHaveBeenCalledTimes(1);
    expect(stream.itag).toBe(251);
    expect(fetchSpy.mock.calls.map(([url]) => String(url))).toEqual([
      "https://music.youtube.com/youtubei/v1/player?prettyPrint=false",
      "https://music.youtube.com/youtubei/v1/player?prettyPrint=false",
    ]);
  });

  it("falls back to ANDROID_VR when VISIONOS is not playable", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(playerResponse([], "UNPLAYABLE"))
      .mockResolvedValueOnce(playerResponse([aac]));
    const stream = await resolveDirectAudioStream("yt:dQw4w9WgXcQ");

    expect(stream).toMatchObject({ itag: 140, codec: "aac", mimeType: "audio/mp4" });
    expect(fetchSpy.mock.calls[1][0]).toBe("https://www.youtube.com/youtubei/v1/player?prettyPrint=false");
    expect(JSON.parse(String(fetchSpy.mock.calls[1][1]?.body)).context.client.clientName).toBe("ANDROID_VR");
  });

  it("reports every profile failure when nothing is playable", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => playerResponse([], "UNPLAYABLE"));
    await expect(resolveDirectAudioStream("dQw4w9WgXcQ")).rejects.toThrow(/VISIONOS.*ANDROID_VR/);
  });

  it("rejects non-youtube ids without any network call", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    expect(toVideoId("sc:12345")).toBeNull();
    await expect(resolveDirectAudioStream("sc:12345")).rejects.toThrow(/not a YouTube video/);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
