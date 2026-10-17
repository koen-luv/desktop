import { asArray, asRecord, recordAt, stringValue } from "@/shared/utils/json";
import { getRuns } from "@/shared/media/innertube/innertubeJson";
import { postInnertube } from "@/shared/media/innertube/innertubeClient";
import type { ClientImportedPlaylist } from "../../importTypes";
import { rethrowIfAborted } from "@/shared/utils/abort";
import { tryFetchJson } from "@/shared/api/tryFetch";
import { withoutArtistPrefix } from "../../shared/titles";
import { youtubeThumbnailUrl } from "./youtubeUrl";

interface VideoMeta {
  title?: string;
  artist?: string;
}

async function fetchOembed(videoId: string, signal?: AbortSignal): Promise<VideoMeta> {
  const watchUrl = `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
  const data = asRecord(
    await tryFetchJson(`https://www.youtube.com/oembed?url=${watchUrl}&format=json`, { signal }),
  );
  return { title: stringValue(data?.title) || undefined, artist: stringValue(data?.author_name) || undefined };
}

async function fetchWatchNext(videoId: string, signal?: AbortSignal): Promise<VideoMeta> {
  try {
    const body = await postInnertube("next", { videoId }, { signal });
    const tabs = asArray(
      recordAt(body, "contents", "singleColumnMusicWatchNextResultsRenderer", "tabbedRenderer", "watchNextTabbedResultsRenderer")
        ?.tabs,
    );
    const panel = recordAt(tabs[0], "tabRenderer", "content", "musicQueueRenderer", "content", "playlistPanelRenderer");
    const item = recordAt(asArray(panel?.contents)[0], "playlistPanelVideoRenderer");
    return {
      title: stringValue(getRuns(item?.title)[0]?.text) || undefined,
      artist: stringValue(getRuns(item?.longBylineText)[0]?.text) || undefined,
    };
  } catch {
    rethrowIfAborted(signal);
    return {};
  }
}

export async function importYoutubeSingleVideo(
  videoId: string,
  rawUrl: string,
  signal?: AbortSignal,
): Promise<ClientImportedPlaylist> {
  const oembed = await fetchOembed(videoId, signal);
  const next = await fetchWatchNext(videoId, signal);
  const title = next.title ?? oembed.title ?? "YouTube Track";
  const artist = next.artist ?? oembed.artist ?? "YouTube";

  const cleanArtist = artist.trim() || "YouTube";
  const cleanTitle = withoutArtistPrefix(title.trim(), cleanArtist) || title.trim();

  return {
    source: "youtube",
    sourceUrl: rawUrl,
    title: cleanTitle,
    tracks: [
      {
        sourceId: videoId,
        title: cleanTitle,
        artists: [cleanArtist],
        coverUrl: youtubeThumbnailUrl(videoId),
      },
    ],
    canonicalTrackIds: [videoId],
  };
}
