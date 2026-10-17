import type { ResolvedAudioStream } from "@/shared/media/innertube";
import type { ResolvedSoundCloudStream } from "@/shared/media/soundcloud";
import type { Track } from "@/shared/types";

interface PlaybackStreamFormat {
  mimeType: string;
  codec: string;
  bitrate: number;
  contentLength?: number;
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
