import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/shared/api/auth-session", () => ({
  getAuthSession: () => ({ accessToken: "token" }),
  getValidAccessToken: async () => "token",
}));
vi.mock("@/shared/api/baseUrl", () => ({
  getApiBaseUrl: () => "https://api.test",
}));

import { resetLinerPlaybackPause, resolveLinerStream } from "./linerPlayback";

const fetchMock = vi.fn();

const streamBody = {
  url: "https://r2.example/track.flac",
  expiresAt: "2030-01-01T00:00:00.000Z",
  mimeType: "audio/flac",
  codec: "flac",
  size: 1234,
};

describe("resolveLinerStream quality", () => {
  beforeEach(() => {
    resetLinerPlaybackPause();
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("asks for the lossless master when the tier is lossless", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify(streamBody), { status: 200 }));

    const stream = await resolveLinerStream("dQw4w9WgXcQ", undefined, "lossless");

    expect(stream?.codec).toBe("flac");
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.test/v1/tracks/dQw4w9WgXcQ/playback");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body)).toEqual({ quality: "lossless" });
  });

  it("keeps the bodyless request for the default and high tiers", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify(streamBody), { status: 200 }));

    await resolveLinerStream("dQw4w9WgXcQ");
    await resolveLinerStream("dQw4w9WgXcQ", undefined, "high");

    expect(fetchMock.mock.calls[0][1].body).toBeUndefined();
    expect(fetchMock.mock.calls[1][1].body).toBeUndefined();
  });

  it("sends the tier for the lower qualities too", async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify(streamBody), { status: 200 }));

    await resolveLinerStream("dQw4w9WgXcQ", undefined, "standard");

    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ quality: "standard" });
  });
});
