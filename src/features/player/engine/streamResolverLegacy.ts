import { api, mediaUrl } from "@/shared/api";
import type { Track } from "@/shared/types";
import type { PlaybackSession, PlaybackSessionResponse } from "@/shared/contracts/playback";
import { getClientVisitorData } from "@/shared/api/visitorSession";
import { SourceError, type ResolvedStream, type SourceErrorCode } from "../sources/types";
import type { AudioQuality } from "../store/playerStore";

export interface StreamResolveOptions {
  signal?: AbortSignal;
  /** Codec preference forwarded to the resolver endpoint. */
  preferredCodec?: "aac" | "opus";
  providerId?: string;
  /** Streaming tier forwarded to the resolver endpoint (lossless asks for the master). */
  quality?: AudioQuality;
}

/**
 * The resolver endpoint returns `PlaybackSessionResponse` (which carries the
 * optional direct-plan fields) or, rarely, a bare `DirectInnertubePlan`. Both
 * are fully described by `PlaybackSessionResponse`, so we normalize to it.
 */
function asSessionResponse(session: PlaybackSession): PlaybackSessionResponse {
  return session as PlaybackSessionResponse;
}

/**
 * Signed streams must not be attached when they expire almost immediately ΓÇö
 * that surfaces as a media error after the track already "started".
 */
const EXPIRY_SAFETY_MARGIN_MS = 5_000;

/** Maps an unknown thrown value onto a SourceError with a classified code. */
export function classifySourceError(err: unknown, providerId: string): SourceError {
  if (err instanceof SourceError) return err;
  if (err instanceof DOMException && err.name === "AbortError") {
    return new SourceError("cancelled", "Resolution cancelled", providerId);
  }

  const anyErr = err as { status?: number; message?: string; name?: string } | null;
  const status = typeof anyErr?.status === "number" ? anyErr.status : undefined;
  const message = anyErr?.message ?? String(err);

  let code: SourceErrorCode = "network";
  if (status === 401 || status === 403) code = "unauthorized";
  else if (status === 404 || status === 410) code = "unavailable";
  else if (status === 429) code = "rate_limited";
  else if (typeof status === "number" && status >= 500) code = "server";
  else if (anyErr?.name === "TypeError") code = "network";
  else if (/json|parse|unexpected/i.test(message)) code = "invalid_response";

  return new SourceError(code, message, providerId, status);
}

/**
 * Best-effort expiry extraction. Signed media URLs (googlevideo / Liner proxy)
 * embed `expire=<epoch seconds>`; fall back to the session's `expiresAt`.
 */
export function streamExpiryMs(url: string, sessionExpiresAt?: string): number | null {
  try {
    const expire = new URL(url, "https://placeholder.invalid").searchParams.get("expire");
    if (expire && /^\d+$/.test(expire)) {
      const ms = Number(expire) * 1000;
      if (Number.isFinite(ms) && ms > 0) return ms;
    }
  } catch {
    /* unparseable url ΓÇö fall through */
  }
  if (sessionExpiresAt) {
    const ms = new Date(sessionExpiresAt).getTime();
    if (Number.isFinite(ms)) return ms;
  }
  return null;
}

function assertFreshExpiry(expiresAtMs: number | null, providerId: string): number | null {
  if (expiresAtMs !== null && expiresAtMs - Date.now() < EXPIRY_SAFETY_MARGIN_MS) {
    throw new SourceError("expired", "Signed stream URL already expired", providerId);
  }
  return expiresAtMs;
}

/**
 * Executes an already-issued direct_innertube plan (flat fields on the
 * session response) using the client's own visitorData. No second session
 * round-trip is made ΓÇö the plan in hand is used verbatim.
 */
export async function executeDirectPlanStream(
  track: Track,
  rawSession: PlaybackSession,
  options: StreamResolveOptions = {},
): Promise<ResolvedStream> {
  const providerId = options.providerId ?? "liner-direct";
  const session = asSessionResponse(rawSession);
  if (!session.endpoint || !session.body) {
    throw new SourceError(
      "invalid_response",
      "direct_innertube response missing (no endpoint/body plan)",
      providerId,
    );
  }

  // Warm / fetch the client's own visitorData concurrently with validation so
  // the extra round-trip is hidden behind the expiry check.
  const visitorPromise = getClientVisitorData();

  try {
    // Pre-emptively handle expiring signed URLs.
    assertFreshExpiry(streamExpiryMs("", session.expiresAt), providerId);

    const visitorData = await visitorPromise;
    const result = await api.executePlaybackEndpoint(
      {
        endpoint: session.endpoint,
        method: session.method,
        headers: session.headers,
        body: session.body,
        visitorData,
      },
      options.signal,
    );

    const expiresAtMs = streamExpiryMs(result.url, session.expiresAt);
    return {
      url: result.url,
      mimeType: result.mimeType,
      codec: result.codec,
      bitrate: result.bitrate,
      expiresAtMs,
      providerId,
      providerTrackId: result.videoId ?? session.videoId ?? track.id,
      quality: options.quality,
      resolvedAt: Date.now(),
    };
  } finally {
    // Ensure a rejected visitor fetch never becomes an unhandled rejection.
    visitorPromise.catch(() => {});
  }
}

/**
 * Resolves a direct media URL by asking Liner's resolver endpoint for the
 * signed Innertube player request, then executing it from the client using the
 * project's request signing (WASM / Electron RSA / WebCrypto).
 *
 * The stream URL itself is never proxied through Liner ΓÇö it is fetched from
 * the media host (googlevideo.com) directly, exactly as the browser does when
 * streaming.
 */
export async function resolveDirectInnertubeStream(
  track: Track,
  options: StreamResolveOptions = {},
): Promise<ResolvedStream> {
  const providerId = options.providerId ?? "liner-innertube";
  const session = await api.createPlaybackSession(
    track.id,
    options.preferredCodec,
    options.signal,
    "direct_innertube",
    options.quality,
  );
  if (session.transport !== "direct_innertube" || !session.endpoint) {
    throw new SourceError(
      "invalid_response",
      "direct_innertube response missing (no `endpoint` plan)",
      providerId,
    );
  }
  return executeDirectPlanStream(track, session, { ...options, providerId });
}

/**
 * Builds a ResolvedStream from a proxy-transport session. Rejects sessions
 * whose signed URL is already (nearly) expired instead of handing them to the
 * audio element.
 */
export function resolveProxySessionStream(
  track: Track,
  rawSession: PlaybackSession,
  options: StreamResolveOptions = {},
): ResolvedStream {
  const providerId = options.providerId ?? "liner-proxy";
  const session = asSessionResponse(rawSession);
  if (!session.streamUrl) {
    throw new SourceError(
      "unavailable",
      "Proxy transport returned no playable stream for this track",
      providerId,
    );
  }
  const url = mediaUrl(session.streamUrl);
  const expiresAtMs = assertFreshExpiry(streamExpiryMs(url, session.expiresAt), providerId);
  return {
    url,
    mimeType: session.mimeType || "audio/mpeg",
    codec: session.codec || "aac",
    bitrate: session.bitrate || 160000,
    expiresAtMs,
    providerId,
    providerTrackId: session.trackId ?? track.id,
    quality: options.quality,
    resolvedAt: Date.now(),
  };
}

/**
 * Resolves a stream served by Liner's own proxy transport. This transport is
 * only used when the provider explicitly supports it (the resolver endpoint
 * returns 404 otherwise).
 */
export async function resolveProxyInnertubeStream(
  track: Track,
  options: StreamResolveOptions = {},
): Promise<ResolvedStream> {
  const providerId = options.providerId ?? "liner-proxy";
  const session = await api.createPlaybackSession(
    track.id,
    options.preferredCodec,
    options.signal,
    "proxy",
    options.quality,
  );
  return resolveProxySessionStream(track, session, { ...options, providerId });
}

/**
 * Resolves a stream from an already-created session of either transport. The
 * server picks the transport when it created the session (this is the app's
 * historical single-round-trip behaviour, preserved as the primary provider).
 */
export async function resolveSessionStream(
  track: Track,
  session: PlaybackSession,
  options: StreamResolveOptions = {},
): Promise<ResolvedStream> {
  if (session.transport === "direct_innertube") {
    return executeDirectPlanStream(track, session, options);
  }
  return resolveProxySessionStream(track, session, options);
}
