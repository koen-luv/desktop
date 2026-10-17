import { api, mediaUrl } from "@/shared/api";
import { resolveDirectAudioStream, toVideoId } from "@/shared/media/innertube";
import { resolveSoundCloudStream, toSoundCloudTrackId } from "@/shared/media/soundcloud";
import { log } from "@/shared/utils/logger";
import {
  fromInnertubeStream,
  fromSoundCloudStream,
  isAbort,
  toTimestamp,
  type PlayableTrack,
  type PlaybackStream,
} from "./playbackStream";
import { findYoutubeStandIn } from "./youtubeStandIn";

export type { BufferedPlaybackStream, PlayableTrack, PlaybackStream, UrlPlaybackStream } from "./playbackStream";

async function resolveViaServerProxy(trackId: string, signal?: AbortSignal): Promise<PlaybackStream> {
  const session = await api.createPlaybackSession(trackId, undefined, signal, "proxy");
  if (!session.streamUrl) throw new Error("No playable stream URL returned by server");
  return {
    url: mediaUrl(session.streamUrl),
    mimeType: session.mimeType || "audio/webm",
    codec: session.codec || "opus",
    bitrate: session.bitrate || 160_000,
    expiresAtMs: toTimestamp(session.expiresAt),
    transport: "proxy",
  };
}

async function withProxyFallback(
  trackId: string,
  clientError: unknown,
  signal?: AbortSignal,
): Promise<PlaybackStream> {
  try {
    return await resolveViaServerProxy(trackId, signal);
  } catch (proxyError) {
    if (isAbort(proxyError, signal)) throw proxyError;
    throw clientError;
  }
}

async function resolveYoutube(trackId: string, signal?: AbortSignal): Promise<PlaybackStream> {
  try {
    return fromInnertubeStream(await resolveDirectAudioStream(trackId, { signal }));
  } catch (error) {
    if (isAbort(error, signal)) throw error;
    log("yellow", "playback", `client innertube resolution failed, trying server proxy: ${String(error)}`);
    return withProxyFallback(trackId, error, signal);
  }
}

async function resolveYoutubeStandIn(track: PlayableTrack, signal?: AbortSignal): Promise<PlaybackStream> {
  const videoId = await findYoutubeStandIn(track, signal);
  if (!videoId) throw new Error("No matching YouTube track found");
  log("cyan", "playback", `playing youtube stand-in ${videoId} for "${track.title}"`);
  return fromInnertubeStream(await resolveDirectAudioStream(videoId, { signal }));
}

async function resolveSoundCloud(track: PlayableTrack, signal?: AbortSignal): Promise<PlaybackStream> {
  try {
    return fromSoundCloudStream(await resolveSoundCloudStream(track.id, { signal }));
  } catch (soundCloudError) {
    if (isAbort(soundCloudError, signal)) throw soundCloudError;
    log("yellow", "playback", `soundcloud resolution failed, searching youtube: ${String(soundCloudError)}`);
    try {
      return await resolveYoutubeStandIn(track, signal);
    } catch (standInError) {
      if (isAbort(standInError, signal)) throw standInError;
      log("yellow", "playback", `youtube stand-in failed, trying server proxy: ${String(standInError)}`);
      return withProxyFallback(track.id, soundCloudError, signal);
    }
  }
}

export async function resolvePlaybackStream(track: PlayableTrack, signal?: AbortSignal): Promise<PlaybackStream> {
  if (toSoundCloudTrackId(track.id)) return resolveSoundCloud(track, signal);
  if (toVideoId(track.id)) return resolveYoutube(track.id, signal);
  return resolveViaServerProxy(track.id, signal);
}
