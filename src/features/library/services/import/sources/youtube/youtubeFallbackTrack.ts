import { asArray, asRecord, findFirst, type JsonRecord, recordAt, stringValue } from "@/shared/utils/json";
import { getRuns, getText } from "@/shared/media/innertube/innertubeJson";
import type { ClientImportedTrack } from "../../importTypes";
import { youtubeThumbnailUrl } from "./youtubeUrl";

function columnText(renderer: JsonRecord, index: number): JsonRecord | undefined {
  return recordAt(asArray(renderer.flexColumns)[index], "musicResponsiveListItemFlexColumnRenderer", "text");
}

function resolveVideoId(renderer: JsonRecord, titleColumn: JsonRecord | undefined): string | undefined {
  const titleWatch = recordAt(getRuns(titleColumn)[0], "navigationEndpoint", "watchEndpoint");
  const playWatch = recordAt(
    renderer.overlay,
    "musicItemThumbnailOverlayRenderer",
    "content",
    "musicPlayButtonRenderer",
    "playNavigationEndpoint",
    "watchEndpoint",
  );
  const candidates = [asRecord(renderer.playlistItemData)?.videoId, titleWatch?.videoId, playWatch?.videoId];
  const found = candidates.find((value) => value !== undefined && value !== null);
  return stringValue(found);
}

function isArtistRun(run: JsonRecord): boolean {
  const text = typeof run.text === "string" ? run.text.trim() : "";
  return Boolean(text) && text !== "•" && !/^\d+([.,]\d+)?\s*(views|view|plays|play)/i.test(text);
}

function artistIdFromRun(run: JsonRecord | undefined): string | undefined {
  const endpoint = recordAt(run, "navigationEndpoint", "browseEndpoint");
  const pageType = recordAt(endpoint, "browseEndpointContextSupportedConfigs", "browseEndpointContextMusicConfig")
    ?.pageType;
  const isArtist = pageType === "MUSIC_PAGE_TYPE_ARTIST" || pageType === "MUSIC_PAGE_TYPE_USER_CHANNEL";
  return isArtist ? stringValue(endpoint?.browseId) : undefined;
}

function thumbnailUrl(renderer: JsonRecord, videoId: string): string {
  const thumbnailObject = findFirst(renderer, "musicThumbnailRenderer") ?? asRecord(renderer.thumbnail);
  const thumbnails = asArray(asRecord(thumbnailObject?.thumbnail)?.thumbnails).map(asRecord);
  return stringValue(thumbnails.at(-1)?.url) ?? youtubeThumbnailUrl(videoId);
}

export function parseFallbackTrack(rawRenderer: unknown, seenIds: Set<string>): ClientImportedTrack | undefined {
  const renderer = asRecord(rawRenderer);
  if (!renderer) return undefined;
  const titleColumn = columnText(renderer, 0);
  const videoId = resolveVideoId(renderer, titleColumn);
  const trackTitle = getText(titleColumn) ?? getText(renderer.title);
  if (!videoId || !trackTitle || seenIds.has(videoId)) return undefined;
  seenIds.add(videoId);

  const artistRuns = getRuns(columnText(renderer, 1)).filter(isArtistRun);
  const firstArtist = typeof artistRuns[0]?.text === "string" ? artistRuns[0].text.trim() : "";

  return {
    sourceId: videoId,
    title: trackTitle,
    artists: [firstArtist || "YouTube"],
    artistIds: [artistIdFromRun(artistRuns[0])],
    album: typeof artistRuns[1]?.text === "string" ? artistRuns[1].text.trim() : undefined,
    coverUrl: thumbnailUrl(renderer, videoId),
  };
}
