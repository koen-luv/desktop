import type { Track } from "@/shared/types";
import { log } from "@/shared/utils/logger";
import { scoreRecordingMatch } from "./matchConfidence";
import { defaultSourceProviders } from "./providers";
import {
  MIN_AUTO_MATCH_CONFIDENCE,
  SourceError,
  isRetryableCode,
  type ResolvePurpose,
  type ResolvedStream,
  type SourceProvider,
} from "./types";

/**
 * Provider-based playback source resolver.
 *
 * Responsibilities:
 *  - Rank sources by availability, compatibility and reliability.
 *  - Retry transient failures with bounded exponential backoff + jitter.
 *  - Fall back to the next supported provider when a source fails.
 *  - Cancel superseded resolutions so stale results cannot hijack playback.
 *  - Deduplicate concurrent resolutions for the same track.
 *  - Cache resolved streams without ever reusing an expired signed URL.
 *  - Pre-resolve queued tracks ahead of playback.
 */

const RETRY_BASE_DELAY_MS = 350;
const RETRY_MAX_DELAY_MS = 4_000;
const RETRY_MAX_ATTEMPTS = 3;
/** Signed URLs within this window are considered unsafe to reuse. */
const URL_SAFETY_MARGIN_MS = 30_000;
/** TTL for entries whose provider did not report an expiry. */
const UNKNOWN_EXPIRY_TTL_MS = 30 * 60_000;
/** Whole-resolution cache entries older than this are dropped. */
const RESOLUTION_MAX_AGE_MS = 60 * 60_000;

export interface ResolvePlaybackOptions {
  track: Track;
  purpose?: ResolvePurpose;
  /** Skip cache and force a fresh resolution (also invalidates cached URL). */
  forceRefresh?: boolean;
  /** Caller-supplied signal; combined with internal supersede cancellation. */
  signal?: AbortSignal;
}

export interface PlaybackResolution {
  stream: ResolvedStream;
  providerId: string;
  /** Total attempts across all providers. */
  attempts: number;
  fromCache: boolean;
}

export interface SourceResolutionStats {
  resolutions: number;
  cacheHits: number;
  retries: number;
  fallbacks: number;
  deduped: number;
  cancellations: number;
}

const stats: SourceResolutionStats = {
  resolutions: 0,
  cacheHits: 0,
  retries: 0,
  fallbacks: 0,
  deduped: 0,
  cancellations: 0,
};

export function getSourceResolutionStats(): SourceResolutionStats {
  return { ...stats };
}

export function resetSourceResolutionStats(): void {
  stats.resolutions = 0;
  stats.cacheHits = 0;
  stats.retries = 0;
  stats.fallbacks = 0;
  stats.deduped = 0;
  stats.cancellations = 0;
}

interface CacheEntry {
  stream: ResolvedStream;
  cachedAt: number;
}

const urlCache = new Map<string, CacheEntry>();
const inFlight = new Map<string, Promise<PlaybackResolution>>();
const trackControllers = new Map<string, AbortController>();

/** True when a resolved stream can still be handed to the audio engine. */
export function isStreamUsable(stream: ResolvedStream, now = Date.now()): boolean {
  if (stream.expiresAtMs === null) {
    return now - stream.resolvedAt < UNKNOWN_EXPIRY_TTL_MS;
  }
  return stream.expiresAtMs - URL_SAFETY_MARGIN_MS > now;
}

function cacheKey(trackId: string, purpose: ResolvePurpose): string {
  return `${purpose}:${trackId}`;
}

export function invalidateCachedStream(trackId: string): void {
  for (const key of [...urlCache.keys()]) {
    if (key.endsWith(`:${trackId}`) || key === trackId) urlCache.delete(key);
  }
}

export function getCachedStream(trackId: string): ResolvedStream | null {
  const entry =
    urlCache.get(cacheKey(trackId, "playback")) ?? urlCache.get(cacheKey(trackId, "preload"));
  if (!entry) return null;
  if (!isStreamUsable(entry.stream)) {
    invalidateCachedStream(trackId);
    return null;
  }
  return entry.stream;
}

function purgeStaleCacheEntries(now: number): void {
  for (const [key, entry] of urlCache) {
    if (!isStreamUsable(entry.stream, now) || now - entry.cachedAt > RESOLUTION_MAX_AGE_MS) {
      urlCache.delete(key);
    }
  }
}

function controllerFor(trackId: string): AbortController {
  const existing = trackControllers.get(trackId);
  if (existing && !existing.signal.aborted) {
    // A newer request for the same track supersedes the older one.
    stats.cancellations += 1;
    existing.abort();
  }
  const controller = new AbortController();
  trackControllers.set(trackId, controller);
  return controller;
}

function isCancelled(err: unknown, ...signals: Array<AbortSignal | undefined>): boolean {
  if (err instanceof SourceError && err.code === "cancelled") return true;
  if (err instanceof DOMException && err.name === "AbortError") return true;
  return signals.some((s) => s?.aborted);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new SourceError("cancelled", "cancelled", "resolver"));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new SourceError("cancelled", "cancelled", "resolver"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Bounded exponential backoff with full jitter. */
export function computeBackoffDelay(attempt: number, random = Math.random): number {
  const capped = Math.min(RETRY_MAX_DELAY_MS, RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
  const jitter = 0.5 + random() * 0.5; // 50–100% of the capped delay
  return Math.round(capped * jitter);
}

function orderedProviders(track: Track, overrides?: SourceProvider[]): SourceProvider[] {
  const pool = overrides ?? customProviders ?? defaultSourceProviders;
  return [...pool].sort((a, b) => b.priority - a.priority);
}

let customProviders: SourceProvider[] | null = null;

/** Test hook: replace the provider set without touching the network. */
export function __setCustomProviders(providers: SourceProvider[] | null): void {
  customProviders = providers;
}

/**
 * Verifies a provider actually resolved *this* recording before we play it.
 * A mismatching recording id is only acceptable when its metadata scores above
 * MIN_AUTO_MATCH_CONFIDENCE — otherwise playback falls through to the next
 * source instead of silently substituting a cover/live/remix.
 */
async function verifyRecordingIdentity(
  track: Track,
  stream: ResolvedStream,
  provider: SourceProvider,
): Promise<void> {
  if (stream.providerTrackId === track.id) return;

  const confidence = provider.matchConfidence(track);
  if (confidence >= MIN_AUTO_MATCH_CONFIDENCE) return;

  // Provider flagged uncertainty — score the actual recording we got back.
  try {
    const { api } = await import("@/shared/api");
    const candidate = await api.getTrack(stream.providerTrackId);
    const score = scoreRecordingMatch(track, candidate);
    if (score.confidence >= MIN_AUTO_MATCH_CONFIDENCE) return;
    throw new SourceError(
      "unavailable",
      `Source returned a different recording (${score.reasons.join("; ") || "low match"})`,
      provider.id,
    );
  } catch (err) {
    if (err instanceof SourceError) throw err;
    throw new SourceError(
      "unavailable",
      "Source returned a different recording that could not be verified",
      provider.id,
    );
  }
}

async function resolveWithProviders(
  track: Track,
  purpose: ResolvePurpose,
  forceRefresh: boolean,
  signal: AbortSignal,
  overrides?: SourceProvider[],
): Promise<PlaybackResolution> {
  const providers = orderedProviders(track, overrides);
  let attempts = 0;
  let lastError: SourceError | null = null;
  let usedFallback = false;

  for (let index = 0; index < providers.length; index++) {
    const provider = providers[index];
    if (!provider.supports(track)) {
      log("yellow", "sources", `skip ${provider.id}: unsupported on this platform`);
      continue;
    }

    for (let attempt = 1; attempt <= RETRY_MAX_ATTEMPTS; attempt++) {
      if (signal.aborted) throw new SourceError("cancelled", "cancelled", provider.id);
      attempts += 1;
      try {
        const stream = await provider.resolve({ track, purpose, signal, forceRefresh });
        if (signal.aborted) throw new SourceError("cancelled", "cancelled", provider.id);
        if (!stream.url) {
          throw new SourceError("invalid_response", "empty stream url", provider.id);
        }
        await verifyRecordingIdentity(track, stream, provider);

        if (usedFallback) stats.fallbacks += 1;
        if (index > 0 || attempt > 1) {
          log(
            "cyan",
            "sources",
            `resolved via ${provider.id} (attempt ${attempt}, provider #${index + 1})`,
          );
        }
        return { stream, providerId: provider.id, attempts, fromCache: false };
      } catch (err) {
        if (isCancelled(err, signal)) {
          throw new SourceError("cancelled", "cancelled", provider.id);
        }
        const sourceErr =
          err instanceof SourceError
            ? err
            : new SourceError("network", (err as Error)?.message ?? String(err), provider.id);
        lastError = sourceErr;

        // Permanent for this provider → stop retrying it, move to next source.
        if (!isRetryableCode(sourceErr.code)) {
          log(
            "yellow",
            "sources",
            `${provider.id} → ${sourceErr.code}: ${sourceErr.message}`,
          );
          break;
        }

        if (attempt < RETRY_MAX_ATTEMPTS) {
          stats.retries += 1;
          const delay = computeBackoffDelay(attempt);
          log(
            "yellow",
            "sources",
            `${provider.id} transient ${sourceErr.code}, retry ${attempt}/${RETRY_MAX_ATTEMPTS - 1} in ${delay}ms`,
          );
          await sleep(delay, signal);
        }
      }
    }
    usedFallback = true;
  }

  if (lastError) throw lastError;
  throw new SourceError(
    "unsupported",
    "No supported playback source can play this track",
    "resolver",
  );
}

/**
 * Resolves a playable, unexpired stream for `track`.
 *
 * Concurrent calls for the same track share one in-flight request. A newer
 * request for the same track aborts the older one, so a rapid switching race
 * can never apply a stale stream.
 */
export function resolvePlayback(options: ResolvePlaybackOptions): Promise<PlaybackResolution> {
  const { track, purpose = "playback", forceRefresh = false, signal } = options;
  if (!track?.id) {
    return Promise.reject(new SourceError("invalid_response", "track id missing", "resolver"));
  }

  purgeStaleCacheEntries(Date.now());

  if (!forceRefresh) {
    const cached = getCachedStream(track.id);
    if (cached && (purpose === "playback" || isStreamUsable(cached))) {
      stats.cacheHits += 1;
      return Promise.resolve({
        stream: cached,
        providerId: cached.providerId,
        attempts: 0,
        fromCache: true,
      });
    }
  } else {
    invalidateCachedStream(track.id);
    // An explicit refresh supersedes any in-flight request for this track.
    cancelPendingResolution(track.id);
  }

  const key = cacheKey(track.id, purpose);
  const existing = inFlight.get(key);
  if (existing) {
    stats.deduped += 1;
    return existing;
  }

  const controller = controllerFor(track.id);
  const controllerSignal = controller.signal;

  let promise!: Promise<PlaybackResolution>;
  promise = (async (): Promise<PlaybackResolution> => {
    const abort = () => controller.abort();
    if (signal) {
      if (signal.aborted) throw new SourceError("cancelled", "cancelled", "resolver");
      signal.addEventListener("abort", abort, { once: true });
    }
    try {
      stats.resolutions += 1;
      const resolution = await resolveWithProviders(
        track,
        purpose,
        forceRefresh,
        controllerSignal,
      );
      urlCache.set(key, { stream: resolution.stream, cachedAt: Date.now() });
      return resolution;
    } finally {
      if (signal) signal.removeEventListener("abort", abort);
      if (inFlight.get(key) === promise) inFlight.delete(key);
      if (trackControllers.get(track.id) === controller) {
        trackControllers.delete(track.id);
      }
    }
  })();

  inFlight.set(key, promise);
  return promise;
}

/**
 * Pre-resolves the next queued track. Failures are swallowed on purpose — a
 * failed preload must never affect current playback.
 */
export function preResolveNext(track: Track): void {
  if (!track?.id || urlCache.has(cacheKey(track.id, "preload"))) return;
  void resolvePlayback({ track, purpose: "preload" }).catch((err) => {
    if (!(err instanceof SourceError) || err.code !== "cancelled") {
      log("yellow", "sources", `preload resolve failed for "${track.title}": ${err?.message ?? err}`);
    }
  });
}

/** Cancels any pending resolution for a track (e.g. it was removed). */
export function cancelPendingResolution(trackId: string): void {
  const controller = trackControllers.get(trackId);
  if (controller && !controller.signal.aborted) {
    stats.cancellations += 1;
    controller.abort();
  }
  for (const key of [...inFlight.keys()]) {
    if (key.endsWith(`:${trackId}`)) inFlight.delete(key);
  }
}

/** Test-only: clears caches and pending requests. */
export function __resetSourceResolverForTests(): void {
  for (const controller of trackControllers.values()) {
    try {
      controller.abort();
    } catch {
      /* noop */
    }
  }
  trackControllers.clear();
  inFlight.clear();
  urlCache.clear();
  customProviders = null;
  resetSourceResolutionStats();
}
