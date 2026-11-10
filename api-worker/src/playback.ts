import {
  HttpError,
  corsHeaders,
  getRequestId,
  json,
  requireEnv,
  type Env,
} from "./http";

/**
 * Server-side playback resolution.
 *
 * A browser cannot call YouTube (no CORS) and a direct googlevideo URL is bound
 * to the requesting IP, so a client-side URL would 403 for everyone else. The
 * Worker therefore does both halves:
 *
 *   POST /v1/tracks/:id/playback  → resolve audio server-side, return a signed
 *                                   `/v1/stream/<token>` URL
 *   GET  /v1/stream/<token>       → proxy bytes with Range passthrough
 *   GET  /v1/tracks/:id/lyrics    → line-synced lyrics (LRCLIB) as the SSE
 *                                   event stream the app already parses
 *
 * Nothing is scraped from a private endpoint: resolution uses the public
 * Innertube `player` API, the same request the app's own client path makes.
 */

interface AudioFormat {
  url: string;
  mimeType: string;
  codec: "opus" | "aac";
  bitrate: number;
  itag: number;
  contentLength?: number;
}

interface ResolvedAudio extends AudioFormat {
  expiresAt: string | null;
}

/** Clients that return a direct, playable audio URL (no cipher to solve). */
const CLIENT_PROFILES = [
  {
    clientName: "ANDROID_VR",
    clientVersion: "1.62.27",
    extra: {
      deviceMake: "Oculus",
      deviceModel: "Quest 3",
      osName: "Android",
      osVersion: "12",
      androidSdkVersion: 32,
    },
    userAgent:
      "com.google.android.apps.youtube.vr.oculus/1.62.27 (Linux; U; Android 12; GB) gzip",
  },
  {
    clientName: "IOS",
    clientVersion: "20.10.4",
    extra: { deviceMake: "Apple", deviceModel: "iPhone16,2", osName: "iPhone", osVersion: "18.3.2.22D82" },
    userAgent:
      "com.google.ios.youtube/20.10.4 (iPhone16,2; U; CPU iOS 18_3_2 like Mac OS X;)",
  },
] as const;

const YOUTUBE_HOST = "https://www.youtube.com";
const PLAYER_PATH = "/youtubei/v1/player?prettyPrint=false";
const STREAM_TOKEN_TTL_SECONDS = 6 * 60 * 60;
const VIDEO_ID = /^[A-Za-z0-9_-]{6,20}$/;

export function isPlayableVideoId(value: string): boolean {
  return VIDEO_ID.test(value);
}

// ---------------------------------------------------------------------------
// Innertube
// ---------------------------------------------------------------------------

function pickAudioFormat(formats: unknown[], preferredCodec?: string): AudioFormat | null {
  const candidates: AudioFormat[] = [];
  for (const raw of formats) {
    if (!raw || typeof raw !== "object") continue;
    const format = raw as Record<string, unknown>;
    const url = typeof format.url === "string" ? format.url : "";
    if (!url) continue; // signatureCipher formats need a JS solver
    const mimeType = typeof format.mimeType === "string" ? format.mimeType : "";
    if (!mimeType.startsWith("audio/")) continue;
    const bitrate = Number(format.bitrate) || 0;
    const itag = Number(format.itag) || 0;
    const codec: "opus" | "aac" = /opus/i.test(mimeType) ? "opus" : "aac";
    const contentLength = Number(format.contentLength) || undefined;
    candidates.push({ url, mimeType, codec, bitrate, itag, contentLength });
  }
  if (candidates.length === 0) return null;

  const byPreference = candidates.filter((item) =>
    preferredCodec === "opus" ? item.codec === "opus" : preferredCodec === "aac" ? item.codec === "aac" : true,
  );
  const pool = byPreference.length > 0 ? byPreference : candidates;
  pool.sort((a, b) => b.bitrate - a.bitrate);
  return pool[0];
}

interface PlayerResponse {
  playabilityStatus?: { status?: string; reason?: string };
  streamingData?: {
    adaptiveFormats?: unknown[];
    formats?: unknown[];
    expiresInSeconds?: number | string;
  };
}

export async function resolveYoutubeAudio(
  videoId: string,
  options: {
    preferredCodec?: string;
    fetchImpl?: typeof fetch;
    /** Integrity data minted by the client (see docs/WEB.md). */
    poToken?: string;
    visitorData?: string;
  } = {},
): Promise<ResolvedAudio> {
  if (!isPlayableVideoId(videoId)) {
    throw new HttpError(400, "INVALID_TRACK_ID", "A valid track id is required.");
  }
  const doFetch = options.fetchImpl ?? fetch;
  const failures: string[] = [];

  for (const profile of CLIENT_PROFILES) {
    const body = {
      videoId,
      context: {
        client: {
          clientName: profile.clientName,
          clientVersion: profile.clientVersion,
          hl: "en",
          gl: "US",
          ...(options.visitorData ? { visitorData: options.visitorData } : {}),
          ...profile.extra,
        },
      },
      contentCheckOk: true,
      racyCheckOk: true,
      // A PO token proves the request came from a real client. YouTube rejects
      // anonymous datacenter traffic ("Sign in to confirm you're not a bot"),
      // which is why the desktop app mints one per track; passing it through
      // lets the same minted token satisfy the server-side player request.
      ...(options.poToken
        ? { serviceIntegrityDimensions: { poToken: options.poToken } }
        : {}),
    };

    let response: Response;
    try {
      response = await doFetch(`${YOUTUBE_HOST}${PLAYER_PATH}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": profile.userAgent,
          origin: YOUTUBE_HOST,
          ...(options.visitorData ? { "x-goog-visitor-id": options.visitorData } : {}),
        },
        body: JSON.stringify(body),
      });
    } catch (error) {
      failures.push(`${profile.clientName}: ${error instanceof Error ? error.message : String(error)}`);
      continue;
    }

    if (!response.ok) {
      failures.push(`${profile.clientName}: HTTP ${response.status}`);
      continue;
    }

    let payload: PlayerResponse;
    try {
      payload = (await response.json()) as PlayerResponse;
    } catch {
      failures.push(`${profile.clientName}: unreadable response`);
      continue;
    }

    const status = payload.playabilityStatus?.status;
    if (status && status !== "OK") {
      failures.push(`${profile.clientName}: ${status}${payload.playabilityStatus?.reason ? ` (${payload.playabilityStatus.reason})` : ""}`);
      continue;
    }

    const formats = [
      ...(payload.streamingData?.adaptiveFormats ?? []),
      ...(payload.streamingData?.formats ?? []),
    ];
    const format = pickAudioFormat(formats, options.preferredCodec);
    if (!format) {
      failures.push(`${profile.clientName}: no audio format with a direct URL`);
      continue;
    }

    const expiresIn = Number(payload.streamingData?.expiresInSeconds);
    const expiresAt =
      Number.isFinite(expiresIn) && expiresIn > 0
        ? new Date(Date.now() + expiresIn * 1000).toISOString()
        : null;

    return { ...format, expiresAt };
  }

  throw new HttpError(
    502,
    "PLAYBACK_UNAVAILABLE",
    `YouTube did not return a playable audio stream. ${failures.join("; ")}`,
  );
}

// ---------------------------------------------------------------------------
// Signed stream tokens
// ---------------------------------------------------------------------------

interface StreamTokenPayload {
  /** Upstream media URL. */
  u: string;
  /** Expiry, epoch ms. */
  e: number;
  /** Mime type the client should expect. */
  m: string;
  /** Track id, for logs and abuse tracing. */
  t: string;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function secretFor(env: Env): string {
  return requireEnv(env.STREAM_SIGNING_SECRET ?? env.JWT_SECRET, "STREAM_SIGNING_SECRET");
}

async function sign(secret: string, data: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return new Uint8Array(signature);
}

export async function createStreamToken(
  env: Env,
  audio: ResolvedAudio,
  trackId: string,
): Promise<string> {
  const upstreamExpiry = audio.expiresAt ? Date.parse(audio.expiresAt) : Number.POSITIVE_INFINITY;
  const payload: StreamTokenPayload = {
    u: audio.url,
    e: Math.min(Date.now() + STREAM_TOKEN_TTL_SECONDS * 1000, upstreamExpiry),
    m: audio.mimeType,
    t: trackId,
  };
  const encoded = toBase64Url(new TextEncoder().encode(JSON.stringify(payload)));
  const signature = await sign(secretFor(env), encoded);
  return `${encoded}.${toBase64Url(signature)}`;
}

export async function verifyStreamToken(
  env: Env,
  token: string,
): Promise<StreamTokenPayload> {
  const [encoded, signature] = token.split(".");
  if (!encoded || !signature) {
    throw new HttpError(400, "INVALID_STREAM_TOKEN", "Malformed stream token.");
  }
  const expected = await sign(secretFor(env), encoded);
  const provided = fromBase64Url(signature);
  if (provided.length !== expected.length) {
    throw new HttpError(403, "INVALID_STREAM_TOKEN", "Stream token signature mismatch.");
  }
  let mismatch = 0;
  for (let i = 0; i < expected.length; i += 1) mismatch |= expected[i] ^ provided[i];
  if (mismatch !== 0) {
    throw new HttpError(403, "INVALID_STREAM_TOKEN", "Stream token signature mismatch.");
  }

  let payload: StreamTokenPayload;
  try {
    payload = JSON.parse(new TextDecoder().decode(fromBase64Url(encoded))) as StreamTokenPayload;
  } catch {
    throw new HttpError(400, "INVALID_STREAM_TOKEN", "Unreadable stream token.");
  }
  if (!payload.u || !payload.e) {
    throw new HttpError(400, "INVALID_STREAM_TOKEN", "Incomplete stream token.");
  }
  if (Date.now() >= payload.e) {
    throw new HttpError(410, "STREAM_TOKEN_EXPIRED", "This stream has expired. Resolve the track again.");
  }
  return payload;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export async function handlePlaybackSession(
  request: Request,
  env: Env,
  videoId: string,
): Promise<Response> {
  const body = (await request
    .json()
    .catch(() => ({}))) as {
    preferredCodec?: string;
    transport?: string;
    poToken?: string;
    visitorData?: string;
  };

  const audio = await resolveYoutubeAudio(videoId, {
    preferredCodec: body.preferredCodec,
    poToken: typeof body.poToken === "string" ? body.poToken : undefined,
    visitorData: typeof body.visitorData === "string" ? body.visitorData : undefined,
  });
  const token = await createStreamToken(env, audio, videoId);

  return json(
    {
      trackId: videoId,
      transport: "proxy",
      streamUrl: `/v1/stream/${token}`,
      mimeType: audio.mimeType,
      codec: audio.codec,
      bitrate: audio.bitrate,
      expiresAt: audio.expiresAt ?? undefined,
      itag: audio.itag,
    },
    request,
    env,
  );
}

export async function handleStream(
  request: Request,
  env: Env,
  token: string,
): Promise<Response> {
  const payload = await verifyStreamToken(env, token);
  const range = request.headers.get("range");

  const upstream = await fetch(payload.u, {
    method: "GET",
    headers: {
      // googlevideo answers the byte range the player asks for; without Range
      // it sends the whole file, which a seek would then have to re-download.
      ...(range ? { range } : {}),
      accept: "*/*",
    },
  }).catch((error: unknown) => {
    throw new HttpError(
      502,
      "STREAM_UPSTREAM_FAILED",
      `Media host unreachable: ${error instanceof Error ? error.message : String(error)}`,
    );
  });

  if (!upstream.ok && upstream.status !== 206) {
    throw new HttpError(
      502,
      "STREAM_UPSTREAM_FAILED",
      `Media host returned HTTP ${upstream.status}.`,
    );
  }

  const headers = new Headers(corsHeaders(request, env));
  headers.set("content-type", upstream.headers.get("content-type") ?? payload.m);
  headers.set("accept-ranges", "bytes");
  headers.set("cache-control", "private, max-age=3600");
  headers.set("x-request-id", getRequestId(request));
  for (const name of ["content-length", "content-range", "etag", "last-modified"]) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }

  if (request.method === "HEAD") {
    return new Response(null, { status: upstream.status, headers });
  }

  // Stream straight through: audio files are far larger than a Worker may
  // buffer, and the player only needs the requested range.
  return new Response(upstream.body, { status: upstream.status, headers });
}

// ---------------------------------------------------------------------------
// Lyrics
// ---------------------------------------------------------------------------

interface LrclibTracks {
  trackName?: string;
  artistName?: string;
  duration?: number;
  plainLyrics?: string | null;
  syncedLyrics?: string | null;
}

async function lrclibLookup(
  title: string,
  artist: string,
  durationMs: number | null,
): Promise<LrclibTracks | null> {
  const readRecord = (body: unknown): LrclibTracks | null => {
    if (Array.isArray(body)) {
      const withLyrics = body.filter(
        (item): item is LrclibTracks =>
          Boolean(item) && typeof item === "object" && Boolean((item as LrclibTracks).syncedLyrics || (item as LrclibTracks).plainLyrics),
      );
      withLyrics.sort(
        (a, b) => Number(Boolean(b.syncedLyrics)) - Number(Boolean(a.syncedLyrics)),
      );
      return withLyrics[0] ?? null;
    }
    return body && typeof body === "object" ? (body as LrclibTracks) : null;
  };

  const exact = new URL("https://lrclib.net/api/get");
  exact.searchParams.set("track_name", title);
  exact.searchParams.set("artist_name", artist);
  if (durationMs && durationMs > 0) {
    exact.searchParams.set("duration", String(Math.round(durationMs / 1000)));
  }
  try {
    const res = await fetch(exact.toString(), { headers: { accept: "application/json" } });
    if (res.ok) {
      const record = readRecord(await res.json());
      if (record?.syncedLyrics || record?.plainLyrics) return record;
    }
    const search = new URL("https://lrclib.net/api/search");
    search.searchParams.set("track_name", title);
    search.searchParams.set("artist_name", artist);
    const searchRes = await fetch(search.toString(), { headers: { accept: "application/json" } });
    if (!searchRes.ok) return null;
    return readRecord(await searchRes.json());
  } catch {
    return null;
  }
}

function sse(event: unknown): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

export async function handleLyrics(
  request: Request,
  env: Env,
  trackId: string,
  url: URL,
): Promise<Response> {
  const title = (url.searchParams.get("title") ?? "").trim();
  const artist = (url.searchParams.get("artist") ?? "").trim();
  const durationParam = Number(url.searchParams.get("durationMs"));
  const durationMs = Number.isFinite(durationParam) && durationParam > 0 ? durationParam : null;

  const headers = new Headers(corsHeaders(request, env));
  headers.set("content-type", "text/event-stream; charset=utf-8");
  headers.set("cache-control", "no-store");
  headers.set("x-request-id", getRequestId(request));

  if (!title || !artist) {
    const body =
      sse({ type: "provider", provider: "lrclib", status: "not_found" }) +
      sse({ type: "done", cached: false, status: "not_found" });
    return new Response(body, { headers });
  }

  const record = await lrclibLookup(title, artist, durationMs);
  const synced = record?.syncedLyrics?.trim() ?? "";
  const plain = record?.plainLyrics?.trim() ?? "";
  const content = synced || plain;

  if (!content) {
    const body =
      sse({ type: "provider", provider: "lrclib", status: "not_found" }) +
      sse({ type: "done", cached: false, status: "not_found" });
    return new Response(body, { headers });
  }

  const lineSynced = Boolean(synced);
  const candidate = {
    provider: "lrclib",
    matchedTrack: {
      title: record?.trackName ?? title,
      artists: record?.artistName ? [record.artistName] : [artist],
      durationMs: record?.duration ? Math.round(record.duration * 1000) : durationMs ?? undefined,
    },
    lyrics: { format: lineSynced ? "lrc" : "plain", content },
    contentKind: lineSynced ? "line_synced" : "plain",
    syncLevel: lineSynced ? "line_level" : "plain",
    quality: {
      total: lineSynced ? 58 : 34,
      match: 16,
      content: lineSynced ? 26 : 18,
      sync: lineSynced ? 16 : 0,
      source: 4,
      reasons: [`lrclib:${trackId}`],
    },
  };

  const body =
    sse({
      type: "metadata",
      track: {
        id: trackId,
        title,
        artists: [{ id: "unknown", name: artist }],
        durationMs: durationMs ?? 0,
      },
    }) +
    sse({
      type: "provider",
      provider: "lrclib",
      status: "found",
      syncLevel: candidate.syncLevel,
      candidate,
      durationMs: candidate.matchedTrack.durationMs,
    }) +
    sse({ type: "done", cached: false });

  return new Response(body, { headers });
}
