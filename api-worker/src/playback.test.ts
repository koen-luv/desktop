import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createStreamToken,
  handleLyrics,
  handlePlaybackSession,
  handleStream,
  isPlayableVideoId,
  resolveYoutubeAudio,
  verifyStreamToken,
} from "./playback";
import type { Env } from "./http";

const env: Env = { STREAM_SIGNING_SECRET: "test-secret" };

function playerResponse(formats: unknown[], status = "OK") {
  return {
    playabilityStatus: { status, reason: status === "OK" ? undefined : "Video unavailable" },
    streamingData: { adaptiveFormats: formats, expiresInSeconds: 21_600 },
  };
}

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });
}

function format(overrides: Record<string, unknown> = {}) {
  return {
    url: "https://rr1.googlevideo.com/videoplayback?itag=251",
    mimeType: 'audio/webm; codecs="opus"',
    bitrate: 135_000,
    itag: 251,
    contentLength: "4_000_000",
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("resolveYoutubeAudio", () => {
  it("picks the highest-bitrate audio format with a direct URL", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(
        playerResponse([
          format({ itag: 140, mimeType: 'audio/mp4; codecs="mp4a.40.2"', bitrate: 128_000, url: "https://rr1.googlevideo.com/aac" }),
          format({ itag: 251, bitrate: 160_000, url: "https://rr1.googlevideo.com/opus" }),
        ]),
      ),
    );

    const audio = await resolveYoutubeAudio("dQw4w9WgXcQ", { fetchImpl });

    expect(audio.url).toBe("https://rr1.googlevideo.com/opus");
    expect(audio.codec).toBe("opus");
    expect(audio.bitrate).toBe(160_000);
    expect(audio.expiresAt).toBeTruthy();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("honours the preferred codec", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(
        playerResponse([
          format({ itag: 251, bitrate: 160_000, url: "https://rr1.googlevideo.com/opus" }),
          format({ itag: 140, mimeType: 'audio/mp4; codecs="mp4a.40.2"', bitrate: 128_000, url: "https://rr1.googlevideo.com/aac" }),
        ]),
      ),
    );

    const audio = await resolveYoutubeAudio("dQw4w9WgXcQ", { fetchImpl, preferredCodec: "aac" });

    expect(audio.url).toBe("https://rr1.googlevideo.com/aac");
  });

  it("falls through to the next client when a response is unplayable", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(playerResponse([], "LOGIN_REQUIRED")))
      .mockResolvedValueOnce(jsonResponse(playerResponse([format()])));

    const audio = await resolveYoutubeAudio("dQw4w9WgXcQ", { fetchImpl });

    expect(audio.codec).toBe("opus");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("reports a clear failure when only ciphered formats exist", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      jsonResponse(
        playerResponse([
          {
            mimeType: 'audio/webm; codecs="opus"',
            bitrate: 130_000,
            itag: 251,
            signatureCipher: "s=abc&url=https%3A%2F%2Frr1.googlevideo.com%2Fcipher",
          },
        ]),
      ),
    );

    await expect(resolveYoutubeAudio("dQw4w9WgXcQ", { fetchImpl })).rejects.toThrow(
      /no audio format with a direct URL/,
    );
  });

  it("rejects ids that are not video ids", async () => {
    await expect(resolveYoutubeAudio("not a video id", { fetchImpl: vi.fn() })).rejects.toThrow(
      /valid track id/i,
    );
  });
});

describe("stream tokens", () => {
  const audio = {
    url: "https://rr1.googlevideo.com/videoplayback?itag=251",
    mimeType: 'audio/webm; codecs="opus"',
    codec: "opus" as const,
    bitrate: 135_000,
    itag: 251,
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  };

  it("round-trips a signed payload", async () => {
    const token = await createStreamToken(env, audio, "dQw4w9WgXcQ");
    const payload = await verifyStreamToken(env, token);

    expect(payload.u).toBe(audio.url);
    expect(payload.t).toBe("dQw4w9WgXcQ");
    expect(payload.m).toBe(audio.mimeType);
  });

  it("rejects a tampered payload", async () => {
    const token = await createStreamToken(env, audio, "dQw4w9WgXcQ");
    const [encoded, signature] = token.split(".");
    const forged = btoa(JSON.stringify({ u: "https://evil.example/audio", e: Date.now() + 10_000, m: "audio/mp4", t: "x" }))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    await expect(verifyStreamToken(env, `${forged}.${signature}`)).rejects.toThrow(
      /signature mismatch/i,
    );
    expect(encoded).toBeTruthy();
  });

  it("rejects an expired token", async () => {
    const expired = { ...audio, expiresAt: new Date(Date.now() - 1_000).toISOString() };
    const token = await createStreamToken(env, expired, "dQw4w9WgXcQ");

    await expect(verifyStreamToken(env, token)).rejects.toThrow(/expired/i);
  });
});

describe("handleStream", () => {
  it("forwards the Range header and returns the partial response", async () => {
    const token = await createStreamToken(
      env,
      {
        url: "https://rr1.googlevideo.com/videoplayback?itag=251",
        mimeType: "audio/webm",
        codec: "opus",
        bitrate: 128_000,
        itag: 251,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      },
      "dQw4w9WgXcQ",
    );

    const upstream = new Response(new Uint8Array([1, 2, 3]), {
      status: 206,
      headers: {
        "content-type": "audio/webm",
        "content-length": "3",
        "content-range": "bytes 0-2/100",
      },
    });
    const fetchImpl = vi.fn().mockResolvedValue(upstream);
    vi.stubGlobal("fetch", fetchImpl);

    const request = new Request(`https://api.example.com/v1/stream/${token}`, {
      headers: { range: "bytes=0-2" },
    });
    const response = await handleStream(request, env, token);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect((init.headers as Record<string, string>).range).toBe("bytes=0-2");
    expect(response.status).toBe(206);
    expect(response.headers.get("content-range")).toBe("bytes 0-2/100");
    expect(response.headers.get("accept-ranges")).toBe("bytes");
    expect(response.headers.get("content-type")).toBe("audio/webm");
  });

  it("refuses an unsigned token without calling the media host", async () => {
    const fetchImpl = vi.fn();
    vi.stubGlobal("fetch", fetchImpl);

    const request = new Request("https://api.example.com/v1/stream/nope.nope");
    await expect(handleStream(request, env, "nope.nope")).rejects.toThrow(/signature mismatch/i);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("handleLyrics", () => {
  it("streams provider + done events for a synced match", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse({
          trackName: "Cooler Than Me",
          artistName: "Mike Posner",
          duration: 214,
          syncedLyrics: "[00:12.00] first line\n[00:16.00] second line",
          plainLyrics: "first line\nsecond line",
        }),
      ),
    );

    const url = new URL(
      "https://api.example.com/v1/tracks/abc/lyrics?title=Cooler+Than+Me&artist=Mike+Posner&durationMs=214000",
    );
    const response = await handleLyrics(new Request(url), env, "abc", url);
    const body = await response.text();

    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const events = body
      .split("\n\n")
      .filter(Boolean)
      .map((chunk) => JSON.parse(chunk.replace(/^data: /, "")));

    expect(events[0].type).toBe("metadata");
    const provider = events.find((event) => event.type === "provider");
    expect(provider.status).toBe("found");
    expect(provider.syncLevel).toBe("line_level");
    expect(provider.candidate.lyrics.format).toBe("lrc");
    expect(events.at(-1)).toMatchObject({ type: "done", cached: false });
  });

  it("reports not_found when the provider has nothing", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("", { status: 404 })));

    const url = new URL("https://api.example.com/v1/tracks/abc/lyrics?title=X&artist=Y");
    const response = await handleLyrics(new Request(url), env, "abc", url);
    const body = await response.text();

    expect(body).toContain('"not_found"');
    expect(body).toContain('"done"');
  });
});

describe("handlePlaybackSession", () => {
  it("returns a signed stream URL for the resolved track", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(
          playerResponse([
            format({ url: "https://rr1.googlevideo.com/videoplayback?itag=251", bitrate: 160_000 }),
          ]),
        ),
      ),
    );

    const request = new Request("https://api.example.com/v1/tracks/dQw4w9WgXcQ/playback", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ transport: "proxy" }),
    });
    const response = await handlePlaybackSession(request, env, "dQw4w9WgXcQ");
    const body = (await response.json()) as Record<string, unknown>;

    expect(body.transport).toBe("proxy");
    expect(String(body.streamUrl)).toMatch(/^\/v1\/stream\//);
    expect(body.codec).toBe("opus");
    expect(body.trackId).toBe("dQw4w9WgXcQ");

    const token = String(body.streamUrl).replace("/v1/stream/", "");
    await expect(verifyStreamToken(env, token)).resolves.toMatchObject({ t: "dQw4w9WgXcQ" });
  });
});

describe("isPlayableVideoId", () => {
  it("accepts real ids and rejects junk", () => {
    expect(isPlayableVideoId("dQw4w9WgXcQ")).toBe(true);
    expect(isPlayableVideoId("0cmbxttS-RY")).toBe(true);
    expect(isPlayableVideoId("")).toBe(false);
    expect(isPlayableVideoId("../../etc/passwd")).toBe(false);
  });
});

describe("poToken passthrough", () => {
  it("forwards a client-minted PO token and visitor data", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(playerResponse([format()])));

    await resolveYoutubeAudio("dQw4w9WgXcQ", {
      fetchImpl,
      poToken: "POTOKEN123",
      visitorData: "VISITOR456",
    });

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, any>;
    const headers = init.headers as Record<string, string>;

    expect(body.serviceIntegrityDimensions.poToken).toBe("POTOKEN123");
    expect(body.context.client.visitorData).toBe("VISITOR456");
    expect(headers["x-goog-visitor-id"]).toBe("VISITOR456");
  });

  it("omits integrity fields when the client has none", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse(playerResponse([format()])));

    await resolveYoutubeAudio("dQw4w9WgXcQ", { fetchImpl });

    const [, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body)) as Record<string, any>;
    expect(body.serviceIntegrityDimensions).toBeUndefined();
    expect(body.context.client.visitorData).toBeUndefined();
  });
});
