import { platformFetch } from "@/platform/http";

/**
 * Client-side execution of a signed Innertube playback plan.
 *
 * Liner's resolver endpoint (`POST /v1/tracks/:id/playback`) can return either
 * a proxied stream URL or a *plan*: the exact Innertube `player` request the
 * server would have made. The client executes that request itself (with its own
 * residential-IP visitorData) and plays the resulting googlevideo URL directly.
 * Audio is never proxied through Liner and no request is signed here — the plan
 * returned by Liner's API is already complete and authorized.
 */

const PLAN_TIMEOUT_MS = 12_000;

/** Hosts a signed plan is allowed to target. Defense-in-depth against abuse. */
const ALLOWED_PLAN_HOSTS = /(^|\.)youtube\.com$|(^|\.)youtube-nocookie\.com$|(^|\.)googlevideo\.com$/;

export interface InnertubePlan {
  endpoint: string;
  method?: string;
  headers?: Record<string, string>;
  body?: Record<string, unknown>;
  /** Optional visitorData override; the client normally uses its own. */
  visitorData?: string;
}

export interface ExecutedInnertubeStream {
  url: string;
  mimeType: string;
  codec?: string;
  bitrate?: number;
  videoId?: string;
}

export interface InnertubeFormat {
  mimeType?: string;
  url?: string;
  bitrate?: number;
  audioQuality?: string;
  /** Enciphered formats cannot be played without a decipherer — skipped. */
  signatureCipher?: string;
}

interface InnertubePlayerResponse {
  playabilityStatus?: { status?: string; reason?: string };
  streamingData?: { adaptiveFormats?: InnertubeFormat[] };
  videoDetails?: { videoId?: string };
}

/** Error carrying an HTTP-like status so classifySourceError can map it. */
export class InnertubePlanError extends Error {
  readonly status: number;
  readonly reason?: string;

  constructor(message: string, status: number, reason?: string) {
    super(message);
    this.name = "InnertubePlanError";
    this.status = status;
    this.reason = reason;
  }
}

/** Splits `audio/webm; codecs="opus"` into its parts. */
export function parseFormatMimeType(mimeType: string): { mime: string; codec?: string } {
  const [mime, ...params] = String(mimeType || "").split(";");
  const codecMatch = /codecs="([^"]+)"/i.exec(params.join(";"));
  return { mime: mime.trim(), codec: codecMatch?.[1]?.trim() };
}

function containerOf(mimeType: string): "mp4" | "webm" | "other" {
  const { mime } = parseFormatMimeType(mimeType);
  if (mime.includes("mp4")) return "mp4";
  if (mime.includes("webm")) return "webm";
  return "other";
}

/**
 * Picks the best directly playable audio format.
 *
 * - Only formats with a direct `url` are usable (enciphered ones are skipped).
 * - When a codec preference is given, matching containers win; if the response
 *   contains none, any playable audio format is accepted.
 * - Within a group the highest bitrate wins.
 */
export function pickBestAudioFormat(
  formats: InnertubeFormat[],
  preferredCodec?: "aac" | "opus",
): InnertubeFormat | null {
  const playable = (formats ?? []).filter(
    (f) => typeof f.url === "string" && f.url.length > 0 && /^audio\//i.test(f.mimeType || ""),
  );
  if (playable.length === 0) return null;

  const byBitrate = (a: InnertubeFormat, b: InnertubeFormat) => (b.bitrate ?? 0) - (a.bitrate ?? 0);

  if (preferredCodec) {
    const wanted = preferredCodec === "aac" ? "mp4" : "webm";
    const matching = playable.filter((f) => containerOf(f.mimeType || "") === wanted).sort(byBitrate);
    if (matching.length > 0) return matching[0];
  }

  return [...playable].sort(byBitrate)[0] ?? null;
}

function playabilityToHttpStatus(status: string | undefined): number {
  switch (status) {
    case "LOGIN_REQUIRED":
    case "UNPLAYABLE":
    case "AGE_CHECK_REQUIRED":
      return 403;
    default:
      // UNAVAILABLE, CONTENT_CHECK_REQUIRED, ERROR, missing entirely, …
      return 410;
  }
}

function combineSignal(signal: AbortSignal | undefined): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new DOMException(`Innertube request timed out after ${PLAN_TIMEOUT_MS}ms`, "TimeoutError"));
  }, PLAN_TIMEOUT_MS);
  const onAbort = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    },
  };
}

/**
 * Executes a signed Innertube player plan and returns the best audio stream.
 * Throws `InnertubePlanError` (with an HTTP-like `status`) on any failure.
 */
export async function executePlaybackEndpoint(
  plan: InnertubePlan,
  signal?: AbortSignal,
): Promise<ExecutedInnertubeStream> {
  let endpoint: URL;
  try {
    endpoint = new URL(plan.endpoint);
  } catch {
    throw new InnertubePlanError("Invalid Innertube endpoint", 400);
  }
  if (endpoint.protocol !== "https:" || !ALLOWED_PLAN_HOSTS.test(endpoint.hostname)) {
    throw new InnertubePlanError(`Refusing to execute plan against host ${endpoint.hostname}`, 400);
  }

  const headers: Record<string, string> = { ...(plan.headers ?? {}) };
  const hasLowerHeader = (name: string) =>
    Object.keys(headers).some((h) => h.toLowerCase() === name.toLowerCase());
  if (plan.body && !hasLowerHeader("content-type")) headers["Content-Type"] = "application/json";
  if (plan.visitorData && !hasLowerHeader("x-goog-visitor-id")) {
    headers["X-Goog-Visitor-Id"] = plan.visitorData;
  }

  const { signal: combinedSignal, cleanup } = combineSignal(signal);
  let response: Response;
  try {
    response = await platformFetch(endpoint.toString(), {
      method: plan.method === "GET" ? "GET" : "POST",
      headers,
      ...(plan.method === "GET" ? {} : { body: JSON.stringify(plan.body ?? {}) }),
      signal: combinedSignal,
    });
  } catch (err) {
    if (
      (err instanceof DOMException && err.name === "AbortError") ||
      (err as { name?: string })?.name === "AbortError"
    ) {
      throw err;
    }
    throw new InnertubePlanError(
      `Innertube request failed: ${err instanceof Error ? err.message : String(err)}`,
      0,
    );
  } finally {
    cleanup();
  }

  if (!response.ok) {
    throw new InnertubePlanError(`Innertube responded ${response.status}`, response.status);
  }

  let data: InnertubePlayerResponse;
  try {
    data = await response.json();
  } catch {
    throw new InnertubePlanError("Innertube response was not valid JSON", 502);
  }

  const playability = data.playabilityStatus?.status;
  if (playability && playability !== "OK") {
    throw new InnertubePlanError(
      `Video not playable (${playability}${data.playabilityStatus?.reason ? `: ${data.playabilityStatus.reason}` : ""})`,
      playabilityToHttpStatus(playability),
      playability,
    );
  }

  const formats = data.streamingData?.adaptiveFormats ?? [];
  const best = pickBestAudioFormat(formats);
  if (!best?.url) {
    throw new InnertubePlanError("No playable audio formats in response", 410);
  }

  const { mime, codec } = parseFormatMimeType(best.mimeType || "audio/webm");
  return {
    url: best.url,
    mimeType: mime || "audio/webm",
    codec,
    bitrate: best.bitrate,
    videoId: data.videoDetails?.videoId,
  };
}
