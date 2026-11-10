import { useEffect, useState } from "react";
import { mediaUrl, toClientTrack } from "@/shared/api";
import { searchCatalog } from "@/shared/media/innertube/innertubeSearch";
import type {
  SearchAlbumItem,
  SearchPlaylistItem,
  SearchResult,
} from "@/shared/contracts";
import type { PopularItem } from "./usePopularTracks";

/**
 * The self-hosted backend starts each deployment with an empty play graph, so
 * `/v1/explore/popular` can legitimately return zero rows for a while (and a
 * brand-new account has no history either). The home screen would then be an
 * empty page. This hook fills those rows with real YouTube Music catalogue
 * results so the page always has something to play.
 *
 * Queries are seeded with well-known artists rather than "top hits" phrases:
 * phrase searches surface user-uploaded compilation videos ("Top 40 Songs
 * This Week…"), while artist searches return clean studio tracks and albums.
 */

type TrackResult = Extract<SearchResult, { type: "track" }>;
type AlbumResult = SearchAlbumItem;
type PlaylistResult = SearchPlaylistItem;

interface DiscoveryData {
  tracks: PopularItem[];
  recent: PopularItem[];
  albums: PopularItem[];
  playlists: PopularItem[];
}

const EMPTY: DiscoveryData = {
  tracks: [],
  recent: [],
  albums: [],
  playlists: [],
};

const CACHE_TTL = 10 * 60_000;
const TRACK_LIMIT = 20;
const ALBUM_LIMIT = 12;
const PLAYLIST_LIMIT = 12;

const cache = new Map<string, { data: DiscoveryData; timestamp: number }>();

const TRACK_QUERIES = ["The Weeknd", "Taylor Swift", "SZA", "Billie Eilish"];
const RECENT_QUERIES = ["Bad Bunny", "Dua Lipa", "Post Malone"];
const ALBUM_QUERIES = ["Ariana Grande", "Kendrick Lamar"];
const PLAYLIST_QUERIES = ["The Weeknd mix", "Dua Lipa mix", "SZA mix"];

function albumCoverUrl(album: AlbumResult): string {
  if (!album.cover) return "";
  return mediaUrl(album.cover.url ?? "");
}

function playlistCoverUrl(playlist: PlaylistResult): string {
  if (!playlist.cover) return "";
  return mediaUrl(playlist.cover.url ?? "");
}

function toTrackItem(track: TrackResult): PopularItem {
  return {
    type: "track",
    item: toClientTrack(track),
    playCount: 0,
  };
}

function toAlbumItem(album: AlbumResult): PopularItem {
  return {
    type: "album",
    item: {
      id: album.id,
      title: album.title,
      artist: (album.artists ?? [])
        .map((artist) => artist.name)
        .filter(Boolean)
        .join(", "),
      coverUrl: albumCoverUrl(album),
      totalTracks: 0,
      albumType: "album",
    },
    playCount: 0,
  };
}

function toPlaylistItem(playlist: PlaylistResult): PopularItem {
  return {
    type: "playlist",
    item: {
      id: playlist.id,
      title: playlist.title,
      owner: playlist.author ?? "Neritium",
      coverUrl: playlistCoverUrl(playlist),
      totalTracks: 0,
    },
    playCount: 0,
  };
}

function collectTracks(results: SearchResult[], limit = TRACK_LIMIT): PopularItem[] {
  const seen = new Set<string>();
  const items: PopularItem[] = [];
  for (const result of results) {
    if (result.type !== "track" || !result.id || seen.has(result.id)) continue;
    seen.add(result.id);
    items.push(toTrackItem(result));
    if (items.length >= limit) break;
  }
  return items;
}

function collectAlbums(results: SearchResult[]): PopularItem[] {
  const seen = new Set<string>();
  const items: PopularItem[] = [];
  for (const result of results) {
    if (result.type !== "album" || !result.id || seen.has(result.id)) continue;
    seen.add(result.id);
    items.push(toAlbumItem(result));
    if (items.length >= ALBUM_LIMIT) break;
  }
  return items;
}

function collectPlaylists(results: SearchResult[]): PopularItem[] {
  const seen = new Set<string>();
  const items: PopularItem[] = [];
  for (const result of results) {
    if (result.type !== "playlist" || !result.id || seen.has(result.id)) continue;
    seen.add(result.id);
    items.push(toPlaylistItem(result));
    if (items.length >= PLAYLIST_LIMIT) break;
  }
  return items;
}

function fulfilled(results: PromiseSettledResult<SearchResult[]>[]): SearchResult[] {
  return results.flatMap((result) =>
    result.status === "fulfilled" ? result.value : [],
  );
}

function withoutIds(items: PopularItem[], exclude: PopularItem[]): PopularItem[] {
  if (exclude.length === 0) return items;
  const blocked = new Set(exclude.map((item) => item.item.id));
  return items.filter((item) => !blocked.has(item.item.id));
}

export function useDiscoveryFeed(enabled: boolean) {
  const [data, setData] = useState<DiscoveryData>(
    () => cache.get("discovery")?.data ?? EMPTY,
  );
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    const cached = cache.get("discovery");
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      setData(cached.data);
      setIsLoading(false);
      return;
    }

    let active = true;
    setIsLoading(true);

    Promise.allSettled([
      ...TRACK_QUERIES.map((query) => searchCatalog(query, "track")),
      ...RECENT_QUERIES.map((query) => searchCatalog(query, "track")),
      ...ALBUM_QUERIES.map((query) => searchCatalog(query, "album")),
      ...PLAYLIST_QUERIES.map((query) => searchCatalog(query, "playlist")),
    ])
      .then((settled) => {
        if (!active) return;
        let cursor = 0;
        const trackResults = fulfilled(settled.slice(cursor, (cursor += TRACK_QUERIES.length)));
        const recentResults = fulfilled(settled.slice(cursor, (cursor += RECENT_QUERIES.length)));
        const albumResults = fulfilled(settled.slice(cursor, (cursor += ALBUM_QUERIES.length)));
        const playlistResults = fulfilled(settled.slice(cursor));

        const tracks = collectTracks(trackResults);
        const next: DiscoveryData = {
          tracks,
          recent: collectTracks(recentResults).slice(0, 12),
          albums: collectAlbums(albumResults),
          playlists: collectPlaylists(playlistResults),
        };
        // "recent" is shown below "Listening right now": keep the rows distinct.
        next.recent = withoutIds(next.recent, tracks);
        cache.set("discovery", { data: next, timestamp: Date.now() });
        setData(next);
      })
      .finally(() => {
        if (active) setIsLoading(false);
      });

    return () => {
      active = false;
    };
  }, [enabled]);

  return { ...data, isLoading };
}
