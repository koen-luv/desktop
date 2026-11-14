import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  decipherFormatUrl: vi.fn(),
  getSignatureTimestamp: vi.fn(async (): Promise<number | null> => 20_017),
  getYtPoToken: vi.fn(async (_request: { binding: string }): Promise<string | null> => null),
  resetYtPoTokenCache: vi.fn(),
  getClientVisitorData: vi.fn(async () => "CgtVISITOR123"),
  resetClientVisitorData: vi.fn(),
}));

vi.mock("./cipher", () => ({
  decipherFormatUrl: mocks.decipherFormatUrl,
  getSignatureTimestamp: mocks.getSignatureTimestamp,
  resetCipherCache: vi.fn(),
}));

vi.mock("./poTokens", () => ({
  getYtPoToken: mocks.getYtPoToken,
  resetYtPoTokenCache: mocks.resetYtPoTokenCache,
  canMintYtPoToken: () => true,
}));

vi.mock("@/shared/api/visitorSession", () => ({
  getClientVisitorData: mocks.getClientVisitorData,
  resetClientVisitorData: mocks.resetClientVisitorData,
}));

import {
  YtMusicExtractError,
  buildMediaHeaders,
  extractYtMusicAudio,
  isYtMusicExtractError,
  resetYtMusicExtractorState,
  streamExpiryFromUrl,
} from "./ytmusicExtractor";
import { YT_MUSIC_CLIENTS, findYtMusicClient, ytMusicClientHealth } from "./clients";

const EXPIRE = Math.floor(Date.UTC(2030, 0, 1) / 1000);
const VIDEO_ID = "dQw4w9WgXcQ";

function directFormat(overrides: Record<string, unknown> = {}) {
  return {
    itag: 251,
    url: `https://rr1.googlevideo.com/videoplayback?itag=251&expire=${EXPIRE}&n=RAWNSIG`,
    mimeType: 'audio/webm; codecs="opus"',
    bitrate: 135_000,
    contentLength: 3_000_000,
    ...overrides,
  };
}

function playerResponse(formats: unknown[], status = "OK", expiresInSeconds?: number) {
  return new Response(
    JSON.stringify({
      playabilityStatus: { status, reason: status === "OK" ? undefined : "Sign in to confirm you're not a bot" },
      streamingData: {
        adaptiveFormats: formats,
        ...(expiresInSeconds !== undefined ? { expiresInSeconds } : {}),
      },
      videoDetails: { videoId: VIDEO_ID },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

type FetchInput = Parameters<typeof fetch>[0];

interface RecordedPlayerCall {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function isPlayerRequest(input: FetchInput): boolean {
  return String(input).includes("youtubei.googleapis.com/youtubei/v1/player");
}

function isStreamProbe(input: FetchInput): boolean {
  return String(input).includes("googlevideo.com/");
}

interface MockOptions {
  /** Player responses keyed by `context.client.clientName`; last entry repeats. */
  byClient?: Record<string, Array<Response | "network-error" | number>>;
  probeStatus?: (url: string) => number;
}

function mockFetch(options: MockOptions) {
  const cursors = new Map<string, number>();
  const playerCalls: RecordedPlayerCall[] = [];
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input: FetchInput, init?: RequestInit) => {
    const url = String(input);
    if (isStreamProbe(input)) {
      return new Response(null, { status: options.probeStatus?.(url) ?? 206 });
    }
    if (!isPlayerRequest(input)) throw new Error(`unexpected request to ${url}`);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    const clientName = String((body.context as { client?: { clientName?: string } })?.client?.clientName ?? "");
    playerCalls.push({ url, headers: { ...(init?.headers as Record<string, string>) }, body });
    const queue = options.byClient?.[clientName] ?? [];
    if (queue.length === 0) throw new Error(`no player response queued for ${clientName}`);
    const index = cursors.get(clientName) ?? 0;
    const next = queue[Math.min(index, queue.length - 1)];
    cursors.set(clientName, index + 1);
    if (next === "network-error") throw new TypeError("Failed to fetch");
    if (typeof next === "number") return new Response(JSON.stringify({ error: "nope" }), { status: next });
    return next.clone();
  });
  return { spy, playerCalls };
}

function clientNames(playerCalls: RecordedPlayerCall[]): string[] {
  return playerCalls.map((call) => String((call.body.context as { client?: { clientName?: string } })?.client?.clientName));
}

beforeEach(() => {
  resetYtMusicExtractorState();
  mocks.decipherFormatUrl.mockImplementation(async (format: { url?: string }) => {
    if (format.url) return format.url.replace("n=RAWNSIG", "n=TRANSFORMED");
    return `https://rr1.googlevideo.com/videoplayback?itag=251&expire=${EXPIRE}&n=TRANSFORMED`;
  });
  mocks.getSignatureTimestamp.mockResolvedValue(20_017);
  mocks.getYtPoToken.mockImplementation(async (request: { binding: string }) =>
    request.binding === "video" ? "POT_VIDEO" : "POT_VISITOR",
  );
  mocks.getClientVisitorData.mockResolvedValue("CgtVISITOR123");
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("extractYtMusicAudio — WEB_REMIX (ciphered YouTube Music client)", () => {
  it("builds the YouTube Music player request and returns a deciphered stream with headers and expiry", async () => {
    const ciphered = directFormat({ url: undefined, signatureCipher: "s=ABC&sp=sig&url=https%3A%2F%2Frr1.googlevideo.com%2Fvideoplayback%3Fitag%3D251%26expire%3D" + EXPIRE });
    const { playerCalls } = mockFetch({ byClient: { WEB_REMIX: [playerResponse([ciphered])] } });

    const stream = await extractYtMusicAudio(VIDEO_ID, { clientIds: ["WEB_REMIX"] });

    // Player request carries the YouTube Music identity and signature timestamp.
    expect(playerCalls).toHaveLength(1);
    expect(playerCalls[0].url).toBe("https://youtubei.googleapis.com/youtubei/v1/player");
    expect(playerCalls[0].headers).toMatchObject({
      "X-Youtube-Client-Name": "67",
      Origin: "https://music.youtube.com",
      "X-Goog-Visitor-Id": "CgtVISITOR123",
    });
    expect(playerCalls[0].body).toMatchObject({
      videoId: VIDEO_ID,
      contentCheckOk: true,
      racyCheckOk: true,
    });
    const context = playerCalls[0].body.context as { client: Record<string, unknown> };
    expect(context.client).toMatchObject({ clientName: "WEB_REMIX", hl: "en", gl: "US" });
    const playbackContext = playerCalls[0].body.playbackContext as {
      contentPlaybackContext: Record<string, unknown>;
    };
    expect(playbackContext.contentPlaybackContext).toMatchObject({
      html5Preference: "HTML5_PREF_WANTS",
      signatureTimestamp: 20_017,
    });
    // The player request must not carry the video-bound GVS token.
    expect(playerCalls[0].body.serviceIntegrityDimensions).toBeUndefined();
    expect(mocks.decipherFormatUrl).toHaveBeenCalledTimes(1);

    // The stream URL is deciphered and carries the video-bound token + cpn.
    const mediaUrl = new URL(stream.url);
    expect(stream.url).toContain("n=TRANSFORMED");
    expect(mediaUrl.searchParams.get("pot")).toBe("POT_VIDEO");
    expect(mediaUrl.searchParams.get("cpn")).toHaveLength(16);
    expect(stream).toMatchObject({
      clientId: "WEB_REMIX",
      mimeType: "audio/webm",
      codec: "opus",
      itag: 251,
      contentLength: 3_000_000,
      boundedRangeOnly: false,
      expiresAtMs: EXPIRE * 1000,
    });

    // Required HTTP headers for the media request.
    expect(stream.headers).toMatchObject({
      Referer: "https://music.youtube.com/",
      Origin: "https://music.youtube.com",
    });
    expect(stream.headers["User-Agent"]).toContain("Chrome");
  });

  it("returns a direct URL untouched when it needs no deciphering", async () => {
    const { playerCalls } = mockFetch({
      byClient: { VISIONOS: [playerResponse([directFormat({ url: `https://rr1.googlevideo.com/videoplayback?itag=251&expire=${EXPIRE}` })])] },
    });

    const stream = await extractYtMusicAudio(VIDEO_ID, { clientIds: ["VISIONOS"] });

    expect(mocks.decipherFormatUrl).not.toHaveBeenCalled();
    expect(stream.url).toContain("expire=" + EXPIRE);
    // visionOS/VR clients fetch without extra headers (InnerTubeX buildHeaders).
    expect(stream.headers).toEqual({});
    expect(stream.expiresAtMs).toBe(EXPIRE * 1000);
    expect(playerCalls[0].headers["X-Youtube-Client-Name"]).toBe("101");
  });

  it("deciphers direct URLs that still carry a throttling n parameter", async () => {
    mockFetch({
      byClient: { VISIONOS: [playerResponse([directFormat({ url: `https://rr1.googlevideo.com/videoplayback?itag=251&expire=${EXPIRE}&n=RAWNSIG` })])] },
    });

    const stream = await extractYtMusicAudio(VIDEO_ID, { clientIds: ["VISIONOS"] });

    expect(mocks.decipherFormatUrl).toHaveBeenCalledTimes(1);
    expect(stream.url).toContain("n=TRANSFORMED");
    expect(stream.url).not.toContain("n=RAWNSIG");
  });
});

describe("extractYtMusicAudio — format selection", () => {
  it("honours the quality tier and codec preference", async () => {
    const opus = directFormat({ itag: 251, bitrate: 135_000 });
    const aac = directFormat({ itag: 140, mimeType: 'audio/mp4; codecs="mp4a.40.2"', bitrate: 130_000 });
    mockFetch({ byClient: { VISIONOS: [playerResponse([opus, aac])] } });

    const stream = await extractYtMusicAudio(VIDEO_ID, { clientIds: ["VISIONOS"], preferredCodec: "aac" });

    expect(stream.itag).toBe(140);
    expect(stream.codec).toBe("aac");
    expect(stream.mimeType).toBe("audio/mp4");
  });

  it("fails with unavailable when the client returns no audio formats", async () => {
    mockFetch({ byClient: { VISIONOS: [playerResponse([])] } });

    await expect(extractYtMusicAudio(VIDEO_ID, { clientIds: ["VISIONOS"] })).rejects.toMatchObject({
      code: "unavailable",
    });
  });
});

describe("extractYtMusicAudio — intelligent retries and client fallback", () => {
  it("falls through to the next client configuration when one is refused", async () => {
    const { playerCalls } = mockFetch({
      byClient: {
        VISIONOS: [playerResponse([], "UNPLAYABLE")],
        ANDROID_VR: [playerResponse([directFormat({ itag: 140, mimeType: 'audio/mp4; codecs="mp4a.40.2"' })])],
      },
    });

    const stream = await extractYtMusicAudio(VIDEO_ID, { clientIds: ["VISIONOS", "ANDROID_VR"] });

    expect(stream).toMatchObject({ clientId: "ANDROID_VR", itag: 140 });
    expect(clientNames(playerCalls)).toEqual(["VISIONOS", "ANDROID_VR"]);
  });

  it("prefers the last working client on the next extraction", async () => {
    const ok = playerResponse([directFormat()]);
    const { playerCalls } = mockFetch({
      byClient: {
        VISIONOS: [playerResponse([], "UNPLAYABLE"), ok],
        ANDROID_VR: [playerResponse([directFormat({ itag: 140, mimeType: 'audio/mp4; codecs="mp4a.40.2"' })]), ok],
      },
    });

    await extractYtMusicAudio(VIDEO_ID, { clientIds: ["VISIONOS", "ANDROID_VR"] });
    playerCalls.length = 0;
    await extractYtMusicAudio(VIDEO_ID, { clientIds: ["VISIONOS", "ANDROID_VR"] });

    // ANDROID_VR worked last time, so it goes first now.
    expect(clientNames(playerCalls)).toEqual(["ANDROID_VR"]);
  });

  it("answers a bot check with fresh attestation before moving on", async () => {
    const { playerCalls } = mockFetch({
      byClient: {
        VISIONOS: [playerResponse([], "LOGIN_REQUIRED"), playerResponse([directFormat()])],
      },
    });

    const stream = await extractYtMusicAudio(VIDEO_ID, { clientIds: ["VISIONOS"] });

    expect(stream.clientId).toBe("VISIONOS");
    expect(mocks.resetClientVisitorData).toHaveBeenCalled();
    expect(mocks.getYtPoToken).toHaveBeenCalledWith({ binding: "visitor", bindingKey: "CgtVISITOR123" });
    expect(playerCalls).toHaveLength(2);
    // The retry pass is the attested one.
    expect(playerCalls[1].body.serviceIntegrityDimensions).toEqual({ poToken: "POT_VISITOR" });
    expect(playerCalls[1].headers["X-Goog-Visitor-Id"]).toBe("CgtVISITOR123");
  });

  it("retries transient network failures in place before falling back", async () => {
    const { playerCalls } = mockFetch({
      byClient: {
        VISIONOS: ["network-error", playerResponse([directFormat()])],
      },
    });

    const stream = await extractYtMusicAudio(VIDEO_ID, { clientIds: ["VISIONOS"] });

    expect(stream.clientId).toBe("VISIONOS");
    expect(playerCalls).toHaveLength(2);
  });

  it("cools a stale client down after HTTP 400 and stops burning requests on it", async () => {
    const { playerCalls } = mockFetch({
      byClient: {
        ANDROID_MUSIC: [400],
        IOS_MUSIC: [playerResponse([directFormat({ itag: 140, mimeType: 'audio/mp4; codecs="mp4a.40.2"' })])],
      },
    });

    const first = await extractYtMusicAudio(VIDEO_ID, { clientIds: ["ANDROID_MUSIC", "IOS_MUSIC"] });
    expect(first.clientId).toBe("IOS_MUSIC");
    expect(clientNames(playerCalls)).toEqual(["ANDROID_MUSIC", "IOS_MUSIC"]);

    playerCalls.length = 0;
    const second = await extractYtMusicAudio(VIDEO_ID, { clientIds: ["ANDROID_MUSIC", "IOS_MUSIC"] });
    expect(second.clientId).toBe("IOS_MUSIC");
    // The stale identity is on cooldown — one failed attempt was enough.
    expect(clientNames(playerCalls)).toEqual(["IOS_MUSIC"]);
  });

  it("falls through when googlevideo rejects the resolved URL", async () => {
    const { playerCalls } = mockFetch({
      byClient: {
        VISIONOS: [playerResponse([directFormat({ url: `https://rr1.googlevideo.com/videoplayback?itag=251&expire=${EXPIRE}&dead=yes` })])],
        ANDROID_VR: [playerResponse([directFormat({ itag: 140, mimeType: 'audio/mp4; codecs="mp4a.40.2"' })])],
      },
      probeStatus: (url) => (url.includes("dead=yes") ? 403 : 206),
    });

    const stream = await extractYtMusicAudio(VIDEO_ID, { clientIds: ["VISIONOS", "ANDROID_VR"] });

    expect(stream.itag).toBe(140);
    expect(clientNames(playerCalls)).toEqual(["VISIONOS", "ANDROID_VR"]);
  });

  it("rejects an already-expired signed URL and recovers through the next client", async () => {
    const expired = Math.floor(Date.now() / 1000) - 60;
    const { playerCalls } = mockFetch({
      byClient: {
        VISIONOS: [playerResponse([directFormat({ url: `https://rr1.googlevideo.com/videoplayback?itag=251&expire=${expired}` })])],
        ANDROID_VR: [playerResponse([directFormat({ itag: 140, mimeType: 'audio/mp4; codecs="mp4a.40.2"' })])],
      },
    });

    const stream = await extractYtMusicAudio(VIDEO_ID, { clientIds: ["VISIONOS", "ANDROID_VR"] });

    expect(stream.clientId).toBe("ANDROID_VR");
    expect(clientNames(playerCalls)).toEqual(["VISIONOS", "ANDROID_VR"]);
    expect(stream.expiresAtMs).toBe(EXPIRE * 1000);
  });

  it("reports every client failure when nothing is playable", async () => {
    mockFetch({
      byClient: {
        VISIONOS: [playerResponse([], "UNPLAYABLE")],
        ANDROID_VR: [400],
      },
    });

    const error = await extractYtMusicAudio(VIDEO_ID, { clientIds: ["VISIONOS", "ANDROID_VR"] }).catch((e) => e);

    expect(isYtMusicExtractError(error)).toBe(true);
    expect((error as YtMusicExtractError).message).toMatch(/VISIONOS/);
    expect((error as YtMusicExtractError).message).toMatch(/ANDROID_VR/);
    expect((error as YtMusicExtractError).code).toBe("unavailable");
  });

  it("aborts with a cancelled error when the signal fires", async () => {
    const controller = new AbortController();
    controller.abort();
    mockFetch({ byClient: {} });

    const error = await extractYtMusicAudio(VIDEO_ID, { signal: controller.signal }).catch((e) => e);

    expect(isYtMusicExtractError(error)).toBe(true);
    expect((error as YtMusicExtractError).code).toBe("cancelled");
  });

  it("rejects non-YouTube ids without any network call", async () => {
    const spy = vi.spyOn(globalThis, "fetch");

    await expect(extractYtMusicAudio("sc:12345")).rejects.toMatchObject({ code: "unsupported" });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe("extractYtMusicAudio — expiration reporting", () => {
  it("takes the earliest of the signed URL deadline and expiresInSeconds", async () => {
    mockFetch({
      byClient: { VISIONOS: [playerResponse([directFormat()], "OK", 60)] },
    });

    const stream = await extractYtMusicAudio(VIDEO_ID, { clientIds: ["VISIONOS"] });

    // expiresInSeconds (60s) beats the 2030 URL deadline.
    expect(stream.expiresAtMs).toBeLessThanOrEqual(Date.now() + 60_000);
    expect(stream.expiresAtMs).toBeGreaterThan(Date.now() + 30_000);
  });
});

describe("helpers", () => {
  it("streamExpiryFromUrl reads query and path expire parameters", () => {
    expect(streamExpiryFromUrl(`https://r1.googlevideo.com/videoplayback?expire=${EXPIRE}`)).toBe(EXPIRE * 1000);
    expect(streamExpiryFromUrl(`https://r1.googlevideo.com/videoplayback/expire/${EXPIRE}/x`)).toBe(EXPIRE * 1000);
    expect(streamExpiryFromUrl("https://r1.googlevideo.com/videoplayback")).toBeNull();
    const soon = streamExpiryFromUrl("https://r1.googlevideo.com/videoplayback", 30);
    expect(soon).toBeLessThanOrEqual(Date.now() + 30_000);
    expect(soon).toBeGreaterThan(Date.now() + 20_000);
  });

  it("buildMediaHeaders follows the InnerTubeX header rules", () => {
    const webRemix = findYtMusicClient("WEB_REMIX");
    expect(buildMediaHeaders(webRemix!)).toMatchObject({
      Referer: "https://music.youtube.com/",
      Origin: "https://music.youtube.com",
    });
    expect(buildMediaHeaders(findYtMusicClient("VISIONOS")!)).toEqual({});
    expect(buildMediaHeaders(findYtMusicClient("ANDROID")!)).toHaveProperty("User-Agent");
    expect(buildMediaHeaders(findYtMusicClient("ANDROID")!)).not.toHaveProperty("Referer");
    expect(YT_MUSIC_CLIENTS.length).toBeGreaterThanOrEqual(5);
  });
});

describe("client health tracking", () => {
  it("pauses a failing client and clears the record on success", () => {
    const health = ytMusicClientHealth;
    health.recordFailure("WEB_REMIX", "network");
    expect(health.isAvailable("WEB_REMIX")).toBe(true);
    health.recordFailure("WEB_REMIX", "network");
    expect(health.isAvailable("WEB_REMIX")).toBe(false);
    health.recordSuccess("WEB_REMIX");
    expect(health.isAvailable("WEB_REMIX")).toBe(true);
  });

  it("pauses a stale identity immediately", () => {
    ytMusicClientHealth.recordFailure("ANDROID_MUSIC", "stale_client");
    expect(ytMusicClientHealth.isAvailable("ANDROID_MUSIC")).toBe(false);
  });
});
