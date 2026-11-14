import { resolveDirectAudioStream, toVideoId } from "@/shared/media/innertube";
import { extractYtMusicAudio, type YtMusicStream } from "@/shared/media/innertube/ytmusic";
import type { YtMusicQuality } from "@/shared/media/innertube/ytmusic";
import { resolveSoundCloudStream, toSoundCloudTrackId } from "@/shared/media/soundcloud";
import { resolveNeritiumStream } from "@/shared/media/neritium/neritiumPlayback";
import { isAbortError } from "@/shared/utils/abort";
import { log } from "@/shared/utils/logger";
import { canExecuteDirectInnertubePlans } from "../sources/codecSupport";
import { canCallYoutubeDirectly } from "@/platform/capabilities";
import { mintPoToken } from "@/shared/media/innertube/poTokenClient";
import { api, mediaUrl } from "@/shared/api";
import {
  fromInnertubeStream,
  fromNeritiumStream,
  fromSoundCloudStream,
  type PlayableTrack,
  type PlaybackStream,
} from "./playbackStream";
import { findYoutubeStandIn } from "./youtubeStandIn";
import { resolveYtDlpStream } from "@/shared/media/ytdlp";
import type { AudioQuality } from "../store/playerStore";

export type { BufferedPlaybackStream, PlayableTrack, PlaybackStream, UrlPlaybackStream } from "./playbackStream";

function toYtQuality(quality: AudioQuality): YtMusicQuality {
  return quality === "low" ? "low" : quality === "standard" ? "standard" : "high";
}

function fromYtMusicStream(stream: YtMusicStream): PlaybackStream {
  return {
    url: stream.url,
    headers: stream.headers,
    mimeType: stream.mimeType,
    codec: stream.codec,
    bitrate: stream.bitrate,
    itag: stream.itag,
    expiresAtMs: stream.expiresAtMs,
    ...(stream.contentLength ? { contentLength: stream.contentLength } : {}),
  };
}

/**
 * Thrown when a browser cannot resolve audio at all: the renderer is not
 * allowed to call YouTube (CORS) and the backend has no resolver for it. This is
 * a capability failure, not a broken track, so the queue must not skip through
 * songs looking for one that works.
 */
export class WebPlaybackUnsupportedError extends Error {
  readonly code = "WEB_PLAYBACK_UNSUPPORTED";
  constructor(track: PlayableTrack) {
    super(
      `\"${track.title}\" cannot be resolved in a browser: YouTube blocks cross-origin requests and the API has no stream resolver. Use the desktop or Android app.`,
    );
    this.name = "WebPlaybackUnsupportedError";
  }
}

export function isWebPlaybackUnsupported(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: string }).code === "WEB_PLAYBACK_UNSUPPORTED"
  );
}

/**
 * Resolves a track through the API's proxy transport. The Worker resolves the
 * media URL server-side and streams it, so the browser never talks to YouTube.
 *
 * A PO token is minted here first when the client can run the BotGuard VM:
 * without it, YouTube answers anonymous datacenter traffic with LOGIN_REQUIRED.
 */
async function resolveThroughBackend(
  track: PlayableTrack,
  signal?: AbortSignal,
  quality: AudioQuality = "high",
): Promise<PlaybackStream> {
  const integrity = canCallYoutubeDirectly() ? null : await mintPoToken(track.id).catch(() => null);
  const response = await api.createPlaybackSession(
    track.id,
    undefined,
    signal,
    "proxy",
    quality,
    integrity ?? undefined,
  );
  // The endpoint answers with either a proxy session or a direct plan; only the
  // proxy session carries a stream URL, and that is what this path asks for.
  const stream = response as {
    streamUrl?: string;
    mimeType?: string;
    codec?: string;
    bitrate?: number;
    expiresAt?: string;
  };
  if (!stream.streamUrl) {
    throw new Error("The backend returned no playable stream for this track.");
  }
  return {
    url: mediaUrl(stream.streamUrl),
    mimeType: stream.mimeType ?? "audio/mp4",
    codec: stream.codec === "opus" ? "opus" : "aac",
    bitrate: stream.bitrate ?? 160_000,
    expiresAtMs: stream.expiresAt ? Date.parse(stream.expiresAt) : null,
  };
}

async function resolveYoutubeStandIn(track: PlayableTrack, signal?: AbortSignal): Promise<PlaybackStream> {
  const videoId = await findYoutubeStandIn(track, signal);
  if (!videoId) throw new Error("No matching YouTube track found");
  log("cyan", "playback", `playing youtube stand-in ${videoId} for "${track.title}"`);
  if (!canExecuteDirectInnertubePlans()) {
    return resolveThroughBackend({ ...track, id: videoId }, signal);
  }
  return fromInnertubeStream(await resolveDirectAudioStream(videoId, { signal }));
}

async function resolveSoundCloud(track: PlayableTrack, signal?: AbortSignal): Promise<PlaybackStream> {
  try {
    return fromSoundCloudStream(await resolveSoundCloudStream(track.id, { signal }));
  } catch (soundCloudError) {
    if (isAbortError(soundCloudError, signal)) throw soundCloudError;
    log("yellow", "playback", `soundcloud resolution failed, searching youtube: ${String(soundCloudError)}`);
    try {
      return await resolveYoutubeStandIn(track, signal);
    } catch (standInError) {
      if (isAbortError(standInError, signal)) throw standInError;
      throw soundCloudError;
    }
  }
}

async function resolveYoutubeTrack(
  track: PlayableTrack,
  videoId: string,
  signal?: AbortSignal,
  quality: AudioQuality = "high",
): Promise<PlaybackStream> {
  // The R2 master is the only source that can be lossless; YouTube never is,
  // so it stays the fallback when the backend has no lossless master.
  const neritium = await resolveNeritiumStream(videoId, signal, quality);
  if (neritium) {
    log("cyan", "playback", `playing neritium audio (r2) for "${track.title}" (${quality})`);
    return fromNeritiumStream(neritium, track);
  }
  // A browser cannot call Innertube (CORS). Ask the backend instead; if it has
  // no resolver, fail as a capability problem so the queue is not skipped
  // through song after song.
  if (!canExecuteDirectInnertubePlans()) {
    try {
      return await resolveThroughBackend(track, signal, quality);
    } catch (error) {
      if (isAbortError(error, signal)) throw error;
      log(
        "yellow",
        "playback",
        `backend stream resolution failed for "${track.title}": ${error instanceof Error ? error.message : String(error)}`,
      );
      throw new WebPlaybackUnsupportedError(track);
    }
  }
  try {
    return fromInnertubeStream(await resolveDirectAudioStream(track.id, { signal }));
  } catch (error) {
    if (isAbortError(error, signal)) throw error;
    // The YouTube Music extractor (Metrolist/InnerTubeX-style) knows more
    // client identities than the profile chain above — WEB_REMIX with signature
    // deciphering and PO-token attestation, plus alternative mobile clients —
    // so it is the next recovery step before spawning a process.
    try {
      const music = await extractYtMusicAudio(videoId, { signal, quality: toYtQuality(quality) });
      log("cyan", "playback", `playing YouTube Music extraction for "${track.title}" via ${music.clientId}`);
      return fromYtMusicStream(music);
    } catch (musicError) {
      if (isAbortError(musicError, signal)) throw musicError;
    }
    // Innertube can be refused (bot check / missing PO token) while a locally
    // installed yt-dlp still resolves the same video. It is the last resort
    // because spawning a process is slower than an in-renderer request.
    const ytDlp = await resolveYtDlpStream(videoId, signal);
    if (!ytDlp) throw error;
    log("cyan", "playback", `playing yt-dlp audio for "${track.title}"`);
    return {
      url: ytDlp.url,
      mimeType: ytDlp.mimeType,
      codec: ytDlp.codec ?? "aac",
      bitrate: ytDlp.bitrate ?? 0,
      expiresAtMs: ytDlp.expiresAtMs,
    };
  }
}

export async function resolvePlaybackStream(
  track: PlayableTrack,
  signal?: AbortSignal,
  quality: AudioQuality = "high",
): Promise<PlaybackStream> {
  if (toSoundCloudTrackId(track.id)) return resolveSoundCloud(track, signal);
  const videoId = toVideoId(track.id);
  if (videoId) return resolveYoutubeTrack(track, videoId, signal, quality);
  return resolveYoutubeStandIn(track, signal);
}
