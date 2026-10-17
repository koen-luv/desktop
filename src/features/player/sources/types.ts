import type { Track } from "@/shared/types";

/**
 * A fully resolved, playable audio stream produced by a source provider.
 *
 * IMPORTANT: signed URLs must never be reused past their expiry. Callers treat
 * `expiresAtMs === null` as "unknown expiry" and apply a conservative TTL.
 */
export interface ResolvedStream {
  url: string;
  mimeType: string;
  codec?: string;
  bitrate?: number;
  /** Epoch ms after which the signed URL must not be reused. `null` = unknown. */
  expiresAtMs: number | null;
  /** Provider that produced this stream. */
  providerId: string;
  /** The recording id the provider actually resolved (may differ on fallback). */
  providerTrackId: string;
  /** Wall-clock ms when this resolution completed. */
  resolvedAt: number;
}

/**
 * Failure classification. Determines whether the resolver retries the same
 * provider (transient) or falls back to another provider / surfaces an error
 * (permanent).
 */
export type SourceErrorCode =
  /** The provider cannot serve this kind of track at all. */
  | "unsupported"
  /** The track is not available from this provider (404/410). */
  | "unavailable"
  /** A signed URL expired before it could be played. */
  | "expired"
  /** Authentication or request signing failed. */
  | "unauthorized"
  /** HTTP 429 — retryable with backoff. */
  | "rate_limited"
  /** Network level failure / interruption. */
  | "network"
  /** HTTP 5xx. */
  | "server"
  /** Provider returned an unparseable/unexpected payload. */
  | "invalid_response"
  /** Resolution was cancelled (stale request superseded). */
  | "cancelled";

export class SourceError extends Error {
  readonly code: SourceErrorCode;
  readonly providerId: string;
  readonly status?: number;

  constructor(code: SourceErrorCode, message: string, providerId: string, status?: number) {
    super(message);
    this.name = "SourceError";
    this.code = code;
    this.providerId = providerId;
    this.status = status;
  }
}

export function isRetryableCode(code: SourceErrorCode): boolean {
  return (
    code === "network" ||
    code === "rate_limited" ||
    code === "server" ||
    // A stream that is already expired when we receive it is transient — the
    // next attempt gets a freshly signed URL (bounded by RETRY_MAX_ATTEMPTS).
    code === "expired"
  );
}

export type ResolvePurpose = "playback" | "preload";

export interface ResolveContext {
  track: Track;
  purpose: ResolvePurpose;
  /** Aborted when a newer request supersedes this one. */
  signal: AbortSignal;
  /** Force providers to bypass any cached stream. */
  forceRefresh: boolean;
}

export interface SourceProvider {
  /** Stable identifier, also used in telemetry. */
  readonly id: string;
  /** Higher priority providers are attempted first. */
  readonly priority: number;
  /** Human readable label used in diagnostics UI. */
  readonly label: string;
  /** Cheap, synchronous gate (no network). Returns false to skip this provider. */
  supports(track: Track): boolean;
  /**
   * Confidence (0..1) that this provider serves *the same recording*.
   * Used to prevent silently substituting covers / live versions / remixes.
   */
  matchConfidence(track: Track): number;
  resolve(ctx: ResolveContext): Promise<ResolvedStream>;
}

/** Minimum confidence required to accept a provider's stream automatically. */
export const MIN_AUTO_MATCH_CONFIDENCE = 0.8;
