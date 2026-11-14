import type { ResolvedAudioStream } from "@/shared/media/innertube";
import type { ResolvedSoundCloudStream } from "@/shared/media/soundcloud";
import type { NeritiumAudioStream } from "@/shared/media/neritium/neritiumPlayback";
import type { Track } from "@/shared/types";

interface PlaybackStreamFormat {
  mimeType: string;
  codec: string;
  bitrate: number;
  contentLength?: number;
  /** HTTP headers the media request requires (User-Agent/Referer/Origin). */
  headers?: Record<string, string>;
  /** YouTube itag (or equivalent format id) the provider selected. */
  itag?: number;
}

export interface UrlPlaybackStream extends PlaybackStreamFormat {
  url: string;
  expiresAtMs: number | null;
  blob?: undefined;
}

export interface BufferedPlaybackStream extends PlaybackStreamFormat {
  blob: Blob;
  expiresAtMs: null;
  url?: undefined;
}

export type PlaybackStream = UrlPlaybackStream | BufferedPlaybackStream;

export type PlayableTrack = Pick<Track, "id" | "title" | "artists" | "durationMs">;

function toTimestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

export function fromInnertubeStream(direct: ResolvedAudioStream): PlaybackStream {
  return {
    url: direct.url,
    mimeType: direct.mimeType,
    codec: direct.codec,
    bitrate: direct.bitrate,
    expiresAtMs: toTimestamp(direct.expiresAt),
    ...(direct.contentLength ? { contentLength: direct.contentLength } : {}),
  };
}

export function fromSoundCloudStream(stream: ResolvedSoundCloudStream): PlaybackStream {
  const format = { mimeType: stream.mimeType, codec: stream.codec, bitrate: stream.bitrate };
  if (stream.blob) {
    return { ...format, blob: stream.blob, expiresAtMs: null, contentLength: stream.contentLength };
  }
  return {
    ...format,
    url: stream.url,
    expiresAtMs: toTimestamp(stream.expiresAt),
    ...(stream.contentLength ? { contentLength: stream.contentLength } : {}),
  };
}

export function fromNeritiumStream(stream: NeritiumAudioStream, track: PlayableTrack): PlaybackStream {
  const seconds = track.durationMs ? track.durationMs / 1000 : 0;
  return {
    url: stream.url,
    mimeType: stream.mimeType,
    codec: stream.codec ?? "opus",
    bitrate: seconds > 0 ? Math.round((stream.size * 8) / seconds) : 0,
    expiresAtMs: toTimestamp(stream.expiresAt),
    ...(stream.size ? { contentLength: stream.size } : {}),
  };
}
