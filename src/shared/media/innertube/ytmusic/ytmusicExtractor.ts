/**
 * YouTube Music audio extraction — Metrolist/InnerTubeX-inspired.
 *
 * Resolves a YouTube video id into a playable audio stream by executing Innertube
 * `player` requests directly from the client (the yt-dlp technique, as refined by
 * Metrolist's InnerTubeX extraction pipeline):
 *
 *  - Alternative client configurations (WEB_REMIX first, then the direct-URL
 *    mobile identities) with per-client request shapes and headers.
 *  - Signature deciphering + n-transform (throttling parameter) for ciphered
 *    `signatureCipher` formats and `n`-parameterized direct URLs.
 *  - PO token generation where required: video-bound tokens ride the media URL
 *    (`pot=`), visitor-bound tokens attest the player request itself. The two
 *    bindings are never mixed (Metrolist docs/innertube.md).
 *  - Best-format selection across quality tiers (original audio track only).
 *  - Stream URLs with the required HTTP headers, format details and the signed
 *    URL's expiration.
 *  - Intelligent retries: bot checks re-mint attestation and refresh the visitor
 *    session once per client, stale identities are cooled down by the client
 *    health tracker, transient network failures retry with backoff, and the
 *    extraction always falls through to the next client configuration on
 *    permanent errors.
 *
 * No Neritium backend is involved, so extraction keeps working when the API is
 * down. Errors are classified like the app's source errors so the provider
 * layer can decide between retry, fallback and surfacing.
 */

import { platformFetch } from "@/platform/http";
import { getClientVisitorData, resetClientVisitorData } from "@/shared/api/visitorSession";
import { log } from "@/shared/utils/logger";
import { asArray, asRecord, numberValue, stringValue } from "@/shared/utils/json";
import {
  YT_MUSIC_CLIENTS,
  findYtMusicClient,
  ytMusicClientHealth,
  type ClientFailureKind,
  type YtMusicClientConfig,
} from "./clients";
import { decipherFormatUrl, getSignatureTimestamp } from "./cipher";
import { selectBestYtAudioFormat, type YtAudioFormat, type YtMusicQuality } from "./formatSelection";
import { getYtPoToken, resetYtPoTokenCache } from "./poTokens";

const PLAYER_ENDPOINT = "https://youtubei.googleapis.com/youtubei/v1/player";
const REQUEST_TIMEOUT_MS = 12_000;
const NETWORK_RETRY_LIMIT = 1;
const NETWORK_RETRY_DELAY_MS = 250;
/** Signed URLs within this window are treated as already expired. */
const EXPIRY_SAFETY_MARGIN_MS = 5_000;
const CPN_ALPHABET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_";
/** Direct URLs still carrying an `n=` parameter must run the n-transform. */
const N_PARAMETER_REGEX = /[?&]n=[^&]+/i;

export type YtMusicErrorCode =
  | "unsupported"
  | "unavailable"
  | "unauthorized"
  | "rate_limited"
  | "network"
  | "server"
  | "invalid_response"
  | "expired"
  | "cancelled";

export class YtMusicExtractError extends Error {
  readonly code: YtMusicErrorCode;
  readonly status?: number;
  readonly clientId?: string;

  constructor(code: YtMusicErrorCode, message: string, status?: number, clientId?: string) {
    super(message);
    this.name = "YtMusicExtractError";
    this.code = code;
    this.status = status;
    this.clientId = clientId;
  }
}

export function isYtMusicExtractError(error: unknown): error is YtMusicExtractError {
  return error instanceof YtMusicExtractError;
}

export interface YtMusicExtractOptions {
  signal?: AbortSignal;
  preferredCodec?: "opus" | "aac";
  /** Streaming tier; `low`/`standard`/`high` (YouTube has no lossless). */
  quality?: YtMusicQuality;
  /** Ranged reachability probe on the resolved URL (catches dead URLs early). */
  probeStream?: boolean;
  /** Restrict the client set (diagnostics / tests). */
  clientIds?: readonly string[];
}

export interface YtMusicStream {
  /** Ready-to-play media URL (deciphered, `pot`/`cpn` applied). */
  url: string;
  /** HTTP headers the media request requires (User-Agent/Referer/Origin). */
  headers: Record<string, string>;
  mimeType: string;
  codec: "opus" | "aac";
  bitrate: number;
  itag: number;
  contentLength?: number;
  /** Epoch ms after which the signed URL must not be reused. `null` = unknown. */
  expiresAtMs: number | null;
  /** Client identity that produced the stream. */
  clientId: string;
  /** Video-bound PO token attached to the URL, when one was minted. */
  poToken?: string;
  /**
   * googlevideo refuses open-ended requests on this client's URLs (bounded
   * Range only, ~1 MiB served cap). Playback must read it in bounded chunks.
   */
  boundedRangeOnly: boolean;
  /** Wall-clock ms when this resolution completed. */
  resolvedAt: number;
}

interface PlayerResponse {
  playabilityStatus?: { status?: string; reason?: string };
  streamingData?: {
    adaptiveFormats?: unknown[];
    expiresInSeconds?: number;
  };
  videoDetails?: { videoId?: string };
}

let lastWorkingClient: string | null = null;

/** Test hook: forget client preference and health state. */
export function resetYtMusicExtractorState(): void {
  lastWorkingClient = null;
  ytMusicClientHealth.reset();
  resetYtPoTokenCache();
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
}

function cancelledError(clientId?: string): YtMusicExtractError {
  return new YtMusicExtractError("cancelled", "Extraction cancelled", undefined, clientId);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function generateCpn(): string {
  let cpn = "";
  for (let i = 0; i < 16; i += 1) cpn += CPN_ALPHABET[Math.floor(Math.random() * CPN_ALPHABET.length)];
  return cpn;
}

/** Only googlevideo `/videoplayback` URLs take cpn/pot parameters. */
function isGoogleVideoMediaUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "https:" &&
      (parsed.hostname === "googlevideo.com" || parsed.hostname.endsWith(".googlevideo.com")) &&
      parsed.pathname === "/videoplayback"
    );
  } catch {
    return false;
  }
}

function appendQueryParam(url: string, key: string, value: string): string {
  const fragmentStart = url.indexOf("#");
  const beforeFragment = fragmentStart < 0 ? url : url.slice(0, fragmentStart);
  const fragment = fragmentStart < 0 ? "" : url.slice(fragmentStart);
  const separator = beforeFragment.includes("?") ? "&" : "?";
  return `${beforeFragment}${separator}${key}=${encodeURIComponent(value)}${fragment}`;
}

function applyStreamParams(url: string, cpn: string, poToken: string | null): string {
  let result = url;
  if (isGoogleVideoMediaUrl(result)) {
    if (!/[?&]cpn=/.test(result)) result = appendQueryParam(result, "cpn", cpn);
    if (poToken && !/[?&]pot=/.test(result)) result = appendQueryParam(result, "pot", poToken);
  }
  return result;
}

/**
 * Media-request headers per client identity — the InnerTubeX `buildHeaders`
 * rules. VR/visionOS clients fetch with no extra headers (their URLs accept
 * plain requests); the web client needs its web identity and origin.
 */
export function buildMediaHeaders(client: YtMusicClientConfig): Record<string, string> {
  if (client.id === "VISIONOS" || client.id === "ANDROID_VR" || client.clientName === "TVHTML5_SIMPLY") {
    return {};
  }
  const headers: Record<string, string> = {
    "User-Agent": client.userAgent,
    Accept: "*/*",
    "Accept-Language": "en-US,en;q=0.9",
  };
  if (client.referer) headers["Referer"] = client.referer;
  if (client.origin) headers["Origin"] = client.origin;
  return headers;
}

/**
 * Signed URL expiry: the `expire=<epoch seconds>` query parameter (or the
 * `/expire/<seconds>/` path segment on newer URLs) is authoritative; the
 * response's `expiresInSeconds` is the fallback. The earliest wins.
 */
export function streamExpiryFromUrl(url: string, expiresInSeconds?: number): number | null {
  const deadlines: number[] = [];
  try {
    const parsed = new URL(url);
    for (const value of parsed.searchParams.getAll("expire")) {
      const seconds = Number(value);
      if (Number.isFinite(seconds) && seconds > 0) deadlines.push(seconds * 1000);
    }
    const segments = parsed.pathname.split("/");
    for (let i = 0; i < segments.length - 1; i += 1) {
      if (segments[i] === "expire") {
        const seconds = Number(segments[i + 1]);
        if (Number.isFinite(seconds) && seconds > 0) deadlines.push(seconds * 1000);
      }
    }
  } catch {
    /* unparseable url — fall through to expiresInSeconds */
  }
  if (typeof expiresInSeconds === "number" && expiresInSeconds > 0) {
    deadlines.push(Date.now() + expiresInSeconds * 1000);
  }
  return deadlines.length > 0 ? Math.min(...deadlines) : null;
}

function parseAudioFormats(response: PlayerResponse): YtAudioFormat[] {
  return asArray(response.streamingData?.adaptiveFormats)
    .map((raw): YtAudioFormat | null => {
      const format = asRecord(raw);
      if (!format) return null;
      const mimeType = stringValue(format.mimeType);
      const itag = numberValue(format.itag);
      if (!mimeType || !mimeType.startsWith("audio/") || typeof itag !== "number") return null;
      const parsed: YtAudioFormat = { itag, mimeType, bitrate: numberValue(format.bitrate) ?? 0 };
      const url = stringValue(format.url);
      const signatureCipher = stringValue(format.signatureCipher);
      const cipher = stringValue(format.cipher);
      const averageBitrate = numberValue(format.averageBitrate);
      const contentLength = numberValue(format.contentLength);
      const audioQuality = stringValue(format.audioQuality);
      const audioChannels = numberValue(format.audioChannels);
      const audioSampleRate = numberValue(format.audioSampleRate);
      const xtags = stringValue(format.xtags);
      if (url) parsed.url = url;
      if (signatureCipher) parsed.signatureCipher = signatureCipher;
      if (cipher) parsed.cipher = cipher;
      if (averageBitrate) parsed.averageBitrate = averageBitrate;
      if (contentLength) parsed.contentLength = contentLength;
      if (audioQuality) parsed.audioQuality = audioQuality;
      if (audioChannels) parsed.audioChannels = audioChannels;
      if (audioSampleRate) parsed.audioSampleRate = audioSampleRate;
      if (xtags) parsed.xtags = xtags;
      return parsed;
    })
    .filter((format): format is YtAudioFormat => format !== null);
}

function classifyHttpFailure(status: number): { code: YtMusicErrorCode; kind: ClientFailureKind } {
  if (status === 400) return { code: "invalid_response", kind: "stale_client" };
  if (status === 401 || status === 403) return { code: "unauthorized", kind: "bot_check" };
  if (status === 429) return { code: "rate_limited", kind: "network" };
  if (status >= 500) return { code: "server", kind: "network" };
  return { code: "network", kind: "network" };
}

interface PlayerRequestContext {
  visitorData: string;
  signatureTimestamp: number | null;
  playerPoToken: string | null;
}

function buildPlayerBody(
  client: YtMusicClientConfig,
  videoId: string,
  ctx: PlayerRequestContext,
): Record<string, unknown> {
  const clientContext: Record<string, unknown> = {
    clientName: client.clientName,
    clientVersion: client.clientVersion,
    hl: "en",
    gl: "US",
    ...(ctx.visitorData ? { visitorData: ctx.visitorData } : {}),
    ...(client.extraContext ?? {}),
  };
  const body: Record<string, unknown> = {
    videoId,
    context: { client: clientContext },
    contentCheckOk: true,
    racyCheckOk: true,
  };
  if (client.wantsPlaybackContext || client.wantsSignatureTimestamp) {
    body.playbackContext = {
      contentPlaybackContext: {
        ...(client.wantsPlaybackContext ? { html5Preference: "HTML5_PREF_WANTS" } : {}),
        ...(client.wantsSignatureTimestamp && ctx.signatureTimestamp
          ? { signatureTimestamp: ctx.signatureTimestamp }
          : {}),
      },
    };
  }
  // Attestation tokens are always visitor-bound here — a video-bound GVS token
  // must never be reused for the player request (Metrolist docs/innertube.md).
  if (ctx.playerPoToken) {
    body.serviceIntegrityDimensions = { poToken: ctx.playerPoToken };
  }
  return body;
}

function buildPlayerHeaders(client: YtMusicClientConfig, ctx: PlayerRequestContext): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "User-Agent": client.userAgent,
    "X-Youtube-Client-Name": client.clientIdHeader,
    "X-Youtube-Client-Version": client.clientVersion,
    ...(client.origin ? { Origin: client.origin } : {}),
    ...(ctx.visitorData ? { "X-Goog-Visitor-Id": ctx.visitorData } : {}),
  };
}

async function requestPlayer(
  client: YtMusicClientConfig,
  videoId: string,
  ctx: PlayerRequestContext,
  signal?: AbortSignal,
): Promise<PlayerResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort(new DOMException(`player request timed out after ${REQUEST_TIMEOUT_MS}ms`, "TimeoutError"));
  }, REQUEST_TIMEOUT_MS);
  const onAbort = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  try {
    const response = await platformFetch(PLAYER_ENDPOINT, {
      method: "POST",
      headers: buildPlayerHeaders(client, ctx),
      body: JSON.stringify(buildPlayerBody(client, videoId, ctx)),
      signal: controller.signal,
    });
    if (!response.ok) {
      const failure = classifyHttpFailure(response.status);
      throw new YtMusicExtractError(
        failure.code,
        `${client.id} player responded ${response.status}`,
        response.status,
        client.id,
      );
    }
    return (await response.json()) as PlayerResponse;
  } catch (error) {
    if (error instanceof YtMusicExtractError) throw error;
    if (signal?.aborted) throw cancelledError(client.id);
    const name = (error as { name?: string })?.name;
    if (name === "AbortError" || name === "TimeoutError") {
      throw new YtMusicExtractError("network", `${client.id} player request timed out`, undefined, client.id);
    }
    throw new YtMusicExtractError(
      "network",
      `${client.id} player request failed: ${error instanceof Error ? error.message : String(error)}`,
      undefined,
      client.id,
    );
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

/** Ranged reachability probe — catches dead/expired URLs before playback. */
async function probeStream(
  url: string,
  headers: Record<string, string>,
  contentLength: number | undefined,
  signal?: AbortSignal,
): Promise<void> {
  const probe = new URL(url);
  const offset = contentLength && contentLength > 1_048_576 + 4_096 ? 1_048_576 + 4_096 : 0;
  probe.searchParams.set("range", `${offset}-${offset}`);
  const response = await platformFetch(probe.toString(), { headers, signal });
  await response.body?.cancel().catch(() => undefined);
  if (!response.ok) {
    // 4xx means this client's URL style is refused outright — a retry would
    // get the same answer, so fall through to the next client. 5xx is
    // transient and retried in place.
    const code: YtMusicErrorCode = response.status >= 500 ? "network" : "unauthorized";
    throw new YtMusicExtractError(code, `stream url rejected with ${response.status}`, response.status);
  }
}

function playabilityFailure(response: PlayerResponse): { status: string; reason?: string } | null {
  const status = stringValue(response.playabilityStatus?.status);
  if (!status || status === "OK") return null;
  return { status, reason: stringValue(response.playabilityStatus?.reason) };
}

/** LOGIN_REQUIRED is the bot check: re-attest and retry once. */
function isBotCheck(status: string): boolean {
  return status === "LOGIN_REQUIRED";
}

/** Statuses that mean the video itself cannot be served by anyone. */
function isUnavailableStatus(status: string): boolean {
  return (
    status === "ERROR" || status === "UNPLAYABLE" || status === "VIDEO_UNAVAILABLE" || status === "LIVE_STREAM_OFFLINE"
  );
}

interface AttemptDiagnostics {
  sawUnavailable: boolean;
  sawRateLimit: boolean;
}

/**
 * One client extraction attempt, with the InnerTubeX retry shape: a bot check
 * (HTTP 401/403 or a `LOGIN_REQUIRED` playability status) gets exactly one
 * tokenized retry with a refreshed visitor session before the client gives up.
 */
async function attemptClient(
  client: YtMusicClientConfig,
  videoId: string,
  options: YtMusicExtractOptions,
  diagnostics: AttemptDiagnostics,
): Promise<YtMusicStream> {
  const { signal } = options;
  throwIfAborted(signal);

  // Every client benefits from the visitor session (web identities require
  // it); the fetch is cached and warmed at boot.
  const visitorData = await getClientVisitorData();
  throwIfAborted(signal);

  const [gvsPoToken, signatureTimestamp] = await Promise.all([
    client.gvsPoToken !== "none"
      ? getYtPoToken({ binding: "video", bindingKey: videoId })
      : Promise.resolve(null),
    client.wantsSignatureTimestamp ? getSignatureTimestamp() : Promise.resolve(null),
  ]);
  throwIfAborted(signal);

  const makeContext = (visitor: string, playerPoToken: string | null): PlayerRequestContext => ({
    visitorData: visitor,
    signatureTimestamp,
    playerPoToken,
  });

  let response: PlayerResponse | null = null;
  let lastError: unknown = null;

  for (let pass = 0; pass < 2; pass += 1) {
    const freshVisitor = pass === 0 ? visitorData : await getClientVisitorData();
    // The retry pass always attests: a bot check is answered with fresh
    // visitor-bound attestation (InnerTubeX `webSessionPlayerRequired`).
    const playerPoToken =
      freshVisitor && (pass > 0 || client.playerPoToken === "visitor")
        ? await getYtPoToken({ binding: "visitor", bindingKey: freshVisitor })
        : null;
    throwIfAborted(signal);
    try {
      response = await requestPlayer(client, videoId, makeContext(freshVisitor, playerPoToken), signal);
    } catch (error) {
      lastError = error;
      const status = error instanceof YtMusicExtractError ? error.status : undefined;
      const botHttpError = status === 401 || status === 403;
      if (pass === 0 && botHttpError) {
        // Hard refusal before any response: refresh attestation and retry once.
        resetClientVisitorData();
        continue;
      }
      throw error;
    }

    const unplayable = playabilityFailure(response);
    if (!unplayable) break;
    if (pass === 0 && isBotCheck(unplayable.status)) {
      // "Sign in to confirm you're not a bot": refresh the visitor session,
      // mint visitor-bound attestation and retry once.
      resetClientVisitorData();
      continue;
    }
    if (isUnavailableStatus(unplayable.status)) diagnostics.sawUnavailable = true;
    throw new YtMusicExtractError(
      isUnavailableStatus(unplayable.status) ? "unavailable" : "unauthorized",
      `${client.id}: ${unplayable.reason || `playability ${unplayable.status}`}`,
      isUnavailableStatus(unplayable.status) ? 410 : 403,
      client.id,
    );
  }

  if (!response) {
    throw lastError instanceof YtMusicExtractError
      ? lastError
      : new YtMusicExtractError("network", `${client.id} produced no player response`, undefined, client.id);
  }

  const formats = parseAudioFormats(response);
  const best = selectBestYtAudioFormat(formats, {
    quality: options.quality,
    preferredCodec: options.preferredCodec,
  });
  if (!best) {
    throw new YtMusicExtractError("unavailable", `${client.id} returned no usable audio formats`, 410, client.id);
  }
  throwIfAborted(signal);

  // Ciphered formats and direct URLs with a throttling `n` parameter both need
  // the player-script transforms (signature decipher + n-transform).
  const needsDecipher = !best.url || N_PARAMETER_REGEX.test(best.url);
  const mediaUrl = needsDecipher
    ? await decipherFormatUrl({ url: best.url, signatureCipher: best.signatureCipher, cipher: best.cipher }, signal)
    : best.url;
  if (!mediaUrl) {
    throw new YtMusicExtractError(
      "invalid_response",
      `${client.id} format ${best.itag} has no resolvable url`,
      undefined,
      client.id,
    );
  }
  throwIfAborted(signal);

  const expiresAtMs = streamExpiryFromUrl(mediaUrl, numberValue(response.streamingData?.expiresInSeconds));
  if (expiresAtMs !== null && expiresAtMs - Date.now() < EXPIRY_SAFETY_MARGIN_MS) {
    throw new YtMusicExtractError("expired", `${client.id} returned an already-expired stream url`, undefined, client.id);
  }

  const url = applyStreamParams(mediaUrl, generateCpn(), gvsPoToken);
  const headers = buildMediaHeaders(client);

  if (options.probeStream !== false) {
    await probeStream(url, headers, best.contentLength, signal);
  }

  const codec: "opus" | "aac" = /opus|webm/i.test(best.mimeType) ? "opus" : "aac";
  return {
    url,
    headers,
    mimeType: best.mimeType.split(";")[0]?.trim() || (codec === "opus" ? "audio/webm" : "audio/mp4"),
    codec,
    bitrate: best.bitrate || best.averageBitrate || 160_000,
    itag: best.itag,
    ...(best.contentLength ? { contentLength: best.contentLength } : {}),
    expiresAtMs,
    clientId: client.id,
    ...(gvsPoToken ? { poToken: gvsPoToken } : {}),
    boundedRangeOnly: client.boundedRangeOnly,
    resolvedAt: Date.now(),
  };
}

function orderedClients(options: YtMusicExtractOptions): YtMusicClientConfig[] {
  const pool = options.clientIds
    ? options.clientIds
        .map((id) => findYtMusicClient(id))
        .filter((client): client is YtMusicClientConfig => Boolean(client))
    : [...YT_MUSIC_CLIENTS];
  const available = pool.filter((client) => ytMusicClientHealth.isAvailable(client.id));
  const ranked = [...available].sort((a, b) => b.priority - a.priority);
  if (!lastWorkingClient) return ranked;
  return [
    ...ranked.filter((client) => client.id === lastWorkingClient),
    ...ranked.filter((client) => client.id !== lastWorkingClient),
  ];
}

function toFailureKind(code: YtMusicErrorCode): ClientFailureKind {
  if (code === "invalid_response") return "stale_client";
  if (code === "unauthorized") return "bot_check";
  if (code === "network" || code === "server" || code === "rate_limited") return "network";
  return "playability";
}

/**
 * Resolves a playable audio stream for a YouTube video id.
 *
 * Throws `YtMusicExtractError` with a classified code when no client can serve
 * the video; aborts promptly with `cancelled` when the signal fires. Transient
 * failures retry in place (bounded), permanent failures fall through to the
 * next client configuration.
 */
export async function extractYtMusicAudio(
  videoId: string,
  options: YtMusicExtractOptions = {},
): Promise<YtMusicStream> {
  if (!/^[a-zA-Z0-9_-]{11}$/.test(videoId)) {
    throw new YtMusicExtractError("unsupported", `"${videoId}" is not a YouTube video id`);
  }

  const failures: string[] = [];
  const diagnostics: AttemptDiagnostics = { sawUnavailable: false, sawRateLimit: false };

  for (const client of orderedClients(options)) {
    let networkRetries = NETWORK_RETRY_LIMIT;
    for (;;) {
      try {
        const stream = await attemptClient(client, videoId, options, diagnostics);
        ytMusicClientHealth.recordSuccess(client.id);
        lastWorkingClient = client.id;
        return stream;
      } catch (error) {
        if (options.signal?.aborted || (error instanceof YtMusicExtractError && error.code === "cancelled")) {
          throw error instanceof YtMusicExtractError ? error : cancelledError();
        }
        const message = error instanceof Error ? error.message : String(error);
        failures.push(`${client.id}: ${message}`);

        const code: YtMusicErrorCode = error instanceof YtMusicExtractError ? error.code : "network";
        if (code === "network" && networkRetries > 0) {
          // Transient network hiccup: bounded in-place retry with backoff.
          networkRetries -= 1;
          await sleep(NETWORK_RETRY_DELAY_MS, options.signal).catch(() => undefined);
          continue;
        }
        if (code === "rate_limited") diagnostics.sawRateLimit = true;
        ytMusicClientHealth.recordFailure(client.id, toFailureKind(code));
        break;
      }
    }
  }

  const summary = failures.length > 0 ? failures.join("; ") : "no client configurations available";
  const code: YtMusicErrorCode = diagnostics.sawRateLimit
    ? "rate_limited"
    : failures.some((failure) => /LOGIN_REQUIRED|401|403|unauthorized/i.test(failure))
      ? "unauthorized"
      : "unavailable";
  log("yellow", "playback", `YouTube Music extraction failed (${summary})`);
  throw new YtMusicExtractError(code, `YouTube Music extraction failed (${summary})`);
}
