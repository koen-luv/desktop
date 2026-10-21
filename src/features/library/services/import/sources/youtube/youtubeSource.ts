import { postInnertube } from "@/shared/media/innertube/innertubeClient";
import type { ClientImportedPlaylist, ClientImportedTrack } from "../../importTypes";
import { extractInnertubeContinuationToken, fetchInnertubeContinuation } from "./youtubeContinuation";
import { parseYoutubePlaylistHeader } from "./youtubeHeader";
import { importYoutubeSingleVideo } from "./youtubeSingleVideo";
import { parseInnertubeTracks } from "./youtubeTracks";
import { playlistIdFromYoutube, videoIdFromYoutube } from "./youtubeUrl";

const MAX_CONTINUATION_PAGES = 50;

async function collectContinuations(
  initialBody: unknown,
  seenIds: Set<string>,
  tracks: ClientImportedTrack[],
  signal?: AbortSignal,
): Promise<void> {
  let token = extractInnertubeContinuationToken(initialBody);
  let pageCount = 0;
  while (token && pageCount < MAX_CONTINUATION_PAGES) {
    pageCount += 1;
    const body = await fetchInnertubeContinuation(token, signal);
    if (!body) break;
    const previousCount = tracks.length;
    parseInnertubeTracks(body, seenIds, tracks);
    const nextToken = extractInnertubeContinuationToken(body);
    if (!nextToken || nextToken === token || tracks.length === previousCount) break;
    token = nextToken;
  }
}

export async function importYoutube(rawUrl: string, signal?: AbortSignal): Promise<ClientImportedPlaylist> {
  const playlistId = playlistIdFromYoutube(rawUrl);
  if (!playlistId) {
    const videoId = videoIdFromYoutube(rawUrl);
    if (videoId) return importYoutubeSingleVideo(videoId, rawUrl, signal);
    throw new Error("YouTube URL must contain a valid playlist or video identifier.");
  }

  const body = await postInnertube("browse", { browseId: playlistId }, { signal });
  const header = parseYoutubePlaylistHeader(body);
  const tracks: ClientImportedTrack[] = [];
  const seenIds = new Set<string>();
  parseInnertubeTracks(body, seenIds, tracks);
  await collectContinuations(body, seenIds, tracks, signal);

  if (tracks.length === 0) {
    throw new Error("No tracks could be extracted from this YouTube playlist. Check if the playlist is public.");
  }

  return {
    source: "youtube",
    sourceUrl: rawUrl,
    ...header,
    tracks,
    canonicalTrackIds: tracks.map((track) => track.sourceId),
  };
}
