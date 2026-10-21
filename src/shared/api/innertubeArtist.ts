import type { Track } from "@/shared/types";
import { executeInnertubeJson, InnertubePlanError, type InnertubePlan } from "./innertube";
import { getClientVisitorData } from "./visitorSession";

/**
 * Client-side Innertube artist extraction.
 *
 * The deployed API lost its artist routes (`GET /v1/artists/:id` answers 404
 * "Route … not found" from Fastify), so artist pages must not depend on the
 * backend. This module browses the artist's YouTube channel directly through
 * Innertube — the same backend-independent approach as innertubeClient.ts for
 * playback. Two clients are queried in parallel:
 *
 * - WEB_REMIX (YouTube Music): channel header (title, art, subscriber count)
 *   plus the songs shelf and the "Albums"/"Singles & EPs" carousels. Song
 *   items carry real videoIds, so every fallback track plays through the
 *   existing playback providers.
 * - WEB: `channelMetadataRenderer` — channel description and square avatar,
 *   which the Music client does not return.
 *
 * Like the player request, browse calls need the client's visitor session
 * (visitorSession.ts) or YouTube answers "confirm you're not a bot".
 */

const BROWSE_ENDPOINT = "https://youtubei.googleapis.com/youtubei/v1/browse";

const WEB_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

const MUSIC_CLIENT = {
  name: "WEB_REMIX",
  number: 67,
  version: "1.20251014.01.00",
  userAgent: WEB_UA,
} as const;

const WEB_CLIENT = {
  name: "WEB",
  number: 1,
  version: "2.20251014.01.00",
  userAgent: WEB_UA,
} as const;

export interface InnertubeArtistRelease {
  id: string;
  title: string;
  coverUrl: string;
  releaseDate?: string;
  /** Present on shelf items whose subtitle starts with "EP". */
  releaseTypeHint?: "ep";
}

export interface InnertubeArtistPage {
  title: string;
  description: string;
  coverUrl: string;
  /** e.g. "18.3K subscribers" — shown near the artist name. */
  subscriberCount?: string;
  tracks: Track[];
  albums: InnertubeArtistRelease[];
  singles: InnertubeArtistRelease[];
}

export function isChannelId(value: string): boolean {
  return /^UC[\w-]{22}$/.test(value);
}

/* ------------------------------------------------------------------ *
 * Minimal Innertube response shapes (only the fields we consume).     *
 * ------------------------------------------------------------------ */

interface Text {
  simpleText?: string;
  runs?: { text?: string }[];
}
interface Thumbnails {
  thumbnails?: { url?: string }[];
}
interface NavEndpoint {
  watchEndpoint?: { videoId?: string };
  browseEndpoint?: { browseId?: string };
}
interface ResponsiveItem {
  musicResponsiveListItemRenderer?: {
    flexColumns?: { musicResponsiveListItemFlexColumnRenderer?: { text?: Text } }[];
    thumbnail?: { musicThumbnailRenderer?: { thumbnail?: Thumbnails } };
    overlay?: {
      musicItemThumbnailOverlayRenderer?: {
        content?: { musicPlayButtonRenderer?: { playNavigationEndpoint?: NavEndpoint } };
      };
    };
  };
}
interface TwoRowItem {
  musicTwoRowItemRenderer?: {
    title?: Text;
    subtitle?: Text;
    thumbnailRenderer?: { musicThumbnailRenderer?: { thumbnail?: Thumbnails } };
    navigationEndpoint?: NavEndpoint;
  };
}
interface MusicShelf {
  musicShelfRenderer?: { title?: Text; contents?: ResponsiveItem[] };
}
interface CarouselShelf {
  musicCarouselShelfRenderer?: {
    header?: { musicCarouselShelfBasicHeaderRenderer?: { title?: Text } };
    contents?: TwoRowItem[];
  };
}
interface Section {
  musicShelfRenderer?: MusicShelf["musicShelfRenderer"];
  musicCarouselShelfRenderer?: CarouselShelf["musicCarouselShelfRenderer"];
}
interface MusicChannelPage {
  header?: {
    musicImmersiveHeaderRenderer?: {
      title?: Text;
      thumbnail?: { musicThumbnailRenderer?: { thumbnail?: Thumbnails } };
      subscriptionButton?: {
        subscribeButtonRenderer?: {
          longSubscriberCountText?: Text;
          subscriberCountText?: Text;
          shortSubscriberCountText?: Text;
        };
      };
    };
  };
  contents?: {
    singleColumnBrowseResultsRenderer?: {
      tabs?: { tabRenderer?: { content?: { sectionListRenderer?: { contents?: Section[] } } } }[];
    };
  };
}
interface WebChannelPage {
  metadata?: {
    channelMetadataRenderer?: { title?: string; description?: string; avatar?: Thumbnails };
  };
}

/* ------------------------------------------------------------------ *
 * Parsing helpers                                                     *
 * ------------------------------------------------------------------ */

function text(value?: Text | string): string {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (value.simpleText) return value.simpleText;
  return (value.runs ?? []).map((run) => run.text ?? "").join("");
}

/**
 * yt3 avatar URLs take size parameters; request a square crop at a usable
 * resolution instead of the shelf's 60/120px preview or the banner-shaped
 * header crop.
 */
function squareCover(thumbnails?: Thumbnails): string {
  const urls = (thumbnails?.thumbnails ?? [])
    .map((entry) => entry.url)
    .filter((url): url is string => Boolean(url));
  return (urls[urls.length - 1] ?? "").replace(/=w\d+-h\d+/, "=w544-h544");
}

/** "7.8M plays" → 7_800_000, "220K plays" → 220_000, unparseable → 0. */
function parseCompactCount(value: string): number {
  const match = value.match(/^([\d.,]+)\s*([KMBkmb])?/);
  if (!match) return 0;
  const amount = Number.parseFloat(match[1].replace(",", "."));
  if (!Number.isFinite(amount)) return 0;
  const multiplier = { K: 1e3, k: 1e3, M: 1e6, m: 1e6, B: 1e9, b: 1e9 }[match[2] ?? ""] ?? 1;
  return Math.round(amount * multiplier);
}

function buildBrowsePlan(
  channelId: string,
  client: typeof MUSIC_CLIENT | typeof WEB_CLIENT,
  visitorData?: string,
): InnertubePlan {
  const clientContext: Record<string, unknown> = {
    clientName: client.name,
    clientVersion: client.version,
    hl: "en",
    gl: "US",
  };
  if (visitorData) clientContext.visitorData = visitorData;
  return {
    endpoint: BROWSE_ENDPOINT,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": client.userAgent,
      "X-Youtube-Client-Name": String(client.number),
      "X-Youtube-Client-Version": client.version,
    },
    body: { browseId: channelId, context: { client: clientContext } },
    visitorData,
  };
}

function songsToTracks(channelId: string, shelf: MusicShelf["musicShelfRenderer"]): Track[] {
  const tracks: Track[] = [];
  for (const item of shelf?.contents ?? []) {
    const row = item.musicResponsiveListItemRenderer;
    if (!row) continue;
    const columns = (row.flexColumns ?? []).map((column) =>
      text(column.musicResponsiveListItemFlexColumnRenderer?.text),
    );
    const videoId =
      row.overlay?.musicItemThumbnailOverlayRenderer?.content?.musicPlayButtonRenderer
        ?.playNavigationEndpoint?.watchEndpoint?.videoId;
    if (!videoId || !columns[0]) continue;
    tracks.push({
      id: videoId,
      title: columns[0],
      artists: columns[1] || "",
      artistId: channelId,
      coverUrl: squareCover(row.thumbnail?.musicThumbnailRenderer?.thumbnail),
      // The Music client's song shelf omits durations; the player fills the
      // real value in once a track starts playing.
      durationMs: 0,
      playCount: parseCompactCount(columns[2] ?? ""),
    });
  }
  return tracks;
}

function shelfToReleases(shelf: CarouselShelf["musicCarouselShelfRenderer"]): InnertubeArtistRelease[] {
  const releases: InnertubeArtistRelease[] = [];
  for (const item of shelf?.contents ?? []) {
    const row = item.musicTwoRowItemRenderer;
    if (!row) continue;
    const id = row.navigationEndpoint?.browseEndpoint?.browseId;
    const title = text(row.title);
    if (!id || !title) continue;
    const subtitle = text(row.subtitle);
    const year = subtitle.match(/\b(?:19|20)\d{2}\b/)?.[0];
    releases.push({
      id,
      title,
      coverUrl: squareCover(row.thumbnailRenderer?.musicThumbnailRenderer?.thumbnail),
      ...(year ? { releaseDate: year } : {}),
      ...( /^\s*EP\b/i.test(subtitle) ? { releaseTypeHint: "ep" as const } : {}),
    });
  }
  return releases;
}

/* ------------------------------------------------------------------ *
 * Public API                                                          *
 * ------------------------------------------------------------------ */

/**
 * Fetches an artist page for a YouTube channel id (`UC…`) by browsing the
 * channel through Innertube. Throws `InnertubePlanError` when neither client
 * can serve the channel.
 */
export async function fetchInnertubeArtist(
  channelId: string,
  signal?: AbortSignal,
): Promise<InnertubeArtistPage> {
  if (!isChannelId(channelId)) {
    throw new InnertubePlanError(`Not a YouTube channel id: ${channelId}`, 400);
  }

  const visitorData = (await getClientVisitorData().catch(() => "")) || undefined;

  const [music, web] = await Promise.allSettled([
    executeInnertubeJson<MusicChannelPage>(buildBrowsePlan(channelId, MUSIC_CLIENT, visitorData), signal),
    executeInnertubeJson<WebChannelPage>(buildBrowsePlan(channelId, WEB_CLIENT, visitorData), signal),
  ]);

  if (music.status === "rejected" && web.status === "rejected") {
    throw music.reason instanceof Error
      ? music.reason
      : new InnertubePlanError("Innertube channel browse failed", 0);
  }

  const musicPage = music.status === "fulfilled" ? music.value : null;
  const webPage = web.status === "fulfilled" ? web.value : null;

  const header = musicPage?.header?.musicImmersiveHeaderRenderer;
  const metadata = webPage?.metadata?.channelMetadataRenderer;

  const title = text(header?.title) || metadata?.title || "";
  if (!title) {
    throw new InnertubePlanError("Channel page had no usable content", 404);
  }

  let tracks: Track[] = [];
  let albums: InnertubeArtistRelease[] = [];
  let singles: InnertubeArtistRelease[] = [];
  const sections =
    musicPage?.contents?.singleColumnBrowseResultsRenderer?.tabs?.[0]?.tabRenderer?.content
      ?.sectionListRenderer?.contents ?? [];
  for (const section of sections) {
    if (section.musicShelfRenderer && tracks.length === 0) {
      const candidate = section.musicShelfRenderer;
      if ((candidate.contents ?? []).some((item) => item.musicResponsiveListItemRenderer)) {
        tracks = songsToTracks(channelId, candidate);
        continue;
      }
    }
    if (section.musicCarouselShelfRenderer) {
      const shelfTitle = text(
        section.musicCarouselShelfRenderer.header?.musicCarouselShelfBasicHeaderRenderer?.title,
      );
      if (/^albums?$/i.test(shelfTitle) && albums.length === 0) {
        albums = shelfToReleases(section.musicCarouselShelfRenderer);
      } else if (/^(?:singles?|eps?|singles?\s*&\s*eps?)$/i.test(shelfTitle) && singles.length === 0) {
        singles = shelfToReleases(section.musicCarouselShelfRenderer);
      }
    }
  }

  const subscriberCount =
    text(header?.subscriptionButton?.subscribeButtonRenderer?.longSubscriberCountText) ||
    text(header?.subscriptionButton?.subscribeButtonRenderer?.subscriberCountText) ||
    text(header?.subscriptionButton?.subscribeButtonRenderer?.shortSubscriberCountText) ||
    undefined;

  return {
    title,
    description: metadata?.description ?? "",
    coverUrl: squareCover(metadata?.avatar) || squareCover(header?.thumbnail?.musicThumbnailRenderer?.thumbnail),
    ...(subscriberCount ? { subscriberCount } : {}),
    tracks,
    albums,
    singles,
  };
}
