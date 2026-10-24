import { postInnertube } from "@/shared/media/innertube/innertubeClient";

/**
 * Plain lyrics fallback from YouTube Music.
 *
 * The Liner backend aggregates several lyric providers, but some tracks only
 * have lyrics on YouTube Music itself. The watch-next response carries a
 * `musicDescriptionShelfRenderer` for the "Lyrics" tab; it is plain text (no
 * timestamps), so it is only used when no synced provider was found.
 */

const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;

export function youtubeMusicVideoId(trackId: string | undefined | null): string | null {
  if (!trackId) return null;
  const normalized = trackId.startsWith("ytmusic:") ? trackId.slice("ytmusic:".length) : trackId;
  return VIDEO_ID.test(normalized) ? normalized : null;
}

function collectText(value: unknown, out: string[]): void {
  if (typeof value === "string") {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectText(entry, out);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const entry of Object.values(value as Record<string, unknown>)) {
    collectText(entry, out);
  }
}

/** Finds the browse id of the "Lyrics" tab in a watch-next response. The tab
 *  itself carries no content, so a second browse request is required. */
export function findYouTubeMusicLyricsBrowseId(payload: unknown): string | null {
  let found: string | null = null;

  const visit = (value: unknown): void => {
    if (found || !value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const entry of value) {
        visit(entry);
        if (found) return;
      }
      return;
    }
    const record = value as Record<string, unknown>;
    const endpoint = record.browseEndpoint as
      | {
          browseId?: unknown;
          browseEndpointContextSupportedConfigs?: {
            browseEndpointContextMusicConfig?: { pageType?: unknown };
          };
        }
      | undefined;
    const pageType =
      endpoint?.browseEndpointContextSupportedConfigs?.browseEndpointContextMusicConfig
        ?.pageType;
    if (pageType === "MUSIC_PAGE_TYPE_TRACK_LYRICS" && typeof endpoint?.browseId === "string") {
      found = endpoint.browseId;
      return;
    }
    for (const entry of Object.values(record)) visit(entry);
  };

  visit(payload);
  return found;
}

/** Finds lyrics text in a YouTube Music JSON response without depending on the
 *  exact nesting (the watch-next shape changes between client versions). */
export function extractYouTubeMusicLyrics(payload: unknown): string | null {
  let best: string | null = null;

  const visit = (value: unknown): void => {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry);
      return;
    }
    const record = value as Record<string, unknown>;

    const shelf = record.musicDescriptionShelfRenderer as
      | { description?: unknown; header?: unknown }
      | undefined;
    if (shelf && shelf.description) {
      const parts: string[] = [];
      collectText(shelf.description, parts);
      const text = parts
        .join("")
        .replace(/\r\n/g, "\n")
        .replace(/\n{3,}/g, "\n\n")
        .trim();
      if (text.length >= 20 && (!best || text.length > best.length)) {
        best = text;
      }
    }

    for (const entry of Object.values(record)) visit(entry);
  };

  visit(payload);
  return best;
}

export async function fetchYouTubeMusicLyrics(
  trackId: string,
  signal?: AbortSignal,
): Promise<{ content: string; provider: string } | null> {
  const videoId = youtubeMusicVideoId(trackId);
  if (!videoId) return null;

  try {
    const payload = await postInnertube("next", { videoId }, { signal });
    const browseId = findYouTubeMusicLyricsBrowseId(payload);
    // The lyrics tab in watch-next has an endpoint but no content; browsing it
    // returns the plain-text description shelf. Fall back to the next payload
    // in case a future response starts inlining it.
    const lyricsPayload = browseId
      ? await postInnertube("browse", { browseId }, { signal })
      : payload;
    const content = extractYouTubeMusicLyrics(lyricsPayload);
    return content ? { content, provider: "ytmusic" } : null;
  } catch {
    return null;
  }
}
