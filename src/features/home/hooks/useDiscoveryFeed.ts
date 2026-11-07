import { useEffect, useState } from "react";
import { mediaUrl, toClientTrack } from "@/shared/api";
import { searchCatalog } from "@/shared/media/innertube/innertubeSearch";
import type { SearchAlbumItem, SearchResult } from "@/shared/contracts";
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

interface DiscoveryData {
  tracks: PopularItem[];
  albums: PopularItem[];
}

const CACHE_TTL = 10 * 60_000;
const TRACK_LIMIT = 20;
const ALBUM_LIMIT = 12;

const cache = new Map<string, { data: DiscoveryData; timestamp: number }>();

const TRACK_QUERIES = [
  "The Weeknd",
  "Taylor Swift",
  "SZA",
  "Billie Eilish",
  "Bad Bunny",
];

const ALBUM_QUERIES = ["Dua Lipa", "Kendrick Lamar", "Ariana Grande"];

function albumCoverUrl(album: AlbumResult): string {
  if (!album.cover) return "";
  return mediaUrl(album.cover.url ?? "");
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

function collectTracks(results: SearchResult[]): PopularItem[] {
  const seen = new Set<string>();
  const items: PopularItem[] = [];
  for (const result of results) {
    if (result.type !== "track" || !result.id || seen.has(result.id)) continue;
    seen.add(result.id);
    items.push(toTrackItem(result));
    if (items.length >= TRACK_LIMIT) break;
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

function fulfilled(results: PromiseSettledResult<SearchResult[]>[]): SearchResult[] {
  return results.flatMap((result) =>
    result.status === "fulfilled" ? result.value : [],
  );
}

export function useDiscoveryFeed(enabled: boolean) {
  const [data, setData] = useState<DiscoveryData>(
    () => cache.get("discovery")?.data ?? { tracks: [], albums: [] },
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
      ...ALBUM_QUERIES.map((query) => searchCatalog(query, "album")),
    ])
      .then((settled) => {
        if (!active) return;
        const trackResults = fulfilled(settled.slice(0, TRACK_QUERIES.length));
        const albumResults = fulfilled(settled.slice(TRACK_QUERIES.length));

        const next: DiscoveryData = {
          tracks: collectTracks(trackResults),
          albums: collectAlbums(albumResults),
        };
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
