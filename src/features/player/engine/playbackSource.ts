import type { Track } from "@/shared/types";
import {
  cancelPendingResolution,
  getCachedStream,
  invalidateCachedStream,
  preResolveNext,
  resolvePlayback,
  type PlaybackResolution,
  type ResolvePlaybackOptions,
} from "../sources/sourceResolver";
import type { ResolvePurpose, ResolvedStream } from "../sources/types";
import type { AudioQuality } from "../store/playerStore";

/**
 * Resolver-backed stream acquisition used by the platform runtimes.
 *
 * All playback/preload stream resolution funnels through the provider-based
 * source resolver (`sources/sourceResolver.ts`), which owns caching, dedupe,
 * supersession, bounded retries and provider fallback.
 */

export type ResolvedPlaybackStream = ResolvedStream;
export type { PlaybackResolution, ResolvePlaybackOptions, ResolvePurpose };

export function resolvePlaybackStream(
  track: Track,
  signal?: AbortSignal,
  purpose: ResolvePurpose = "playback",
  quality: AudioQuality = "high",
): Promise<ResolvedStream> {
  return resolvePlayback({ track, purpose, signal, quality }).then(
    (resolution) => resolution.stream,
  );
}

export function resolvePlaybackWithFallback(
  options: ResolvePlaybackOptions,
): Promise<PlaybackResolution> {
  return resolvePlayback(options);
}

export {
  resolvePlayback,
  cancelPendingResolution,
  getCachedStream,
  invalidateCachedStream,
  preResolveNext,
};
