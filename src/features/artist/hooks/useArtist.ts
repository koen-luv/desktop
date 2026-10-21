import { useEffect, useState } from "react";
import {
  api,
  mediaUrl,
  toMaxQualityAvatarUrl,
  toClientTrack,
  type ApiArtist,
  type ApiArtistDetails,
} from "@/shared/api";
import { fetchInnertubeArtist, isChannelId } from "@/shared/api/innertubeArtist";
import type { Track } from "@/shared/types";

export interface ArtistAlbumViewModel {
  id: string;
  title: string;
  coverUrl: string;
  releaseDate?: string;
  totalTracks?: number;
  explicit?: boolean;
}

export interface ArtistReleaseViewModel extends ArtistAlbumViewModel {
  releaseType: "single" | "ep";
}

export interface ArtistPageData {
  title: string;
  description: string;
  coverUrl: string;
  geniusImageUrl?: string;
  geniusAka?: string[];
  geniusUsername?: string;
  monthlyListeners?: string;
  verified: boolean;
  followers?: number;
  totalListens?: number;
  totalTracks?: number;
  tracks: Track[];
  popularSongs: Track[];
  albums: ArtistAlbumViewModel[];
  reposts: Track[];
  singles: ArtistReleaseViewModel[];
}

/**
 * Artist links fall back to the artist display name whenever a track carries no
 * artist id, and the catalog can lose ids over time. Resolving that name
 * through search keeps those taps opening the artist page instead of a dead
 * "Artist not found" screen.
 */
async function resolveArtistIdByName(name: string): Promise<string | null> {
  const query = name.trim();
  if (!query) return null;
  try {
    const results = await api.search(query, "artist");
    const artists: ApiArtist[] = results.items.filter(
      (item): item is ApiArtist => item.type === "artist",
    );
    const exact = artists.find(
      (item) => item.name.trim().toLowerCase() === query.toLowerCase(),
    );
    return (exact ?? artists[0])?.id ?? null;
  } catch {
    return null;
  }
}

function formatBackendArtist(artist: ApiArtistDetails): ArtistPageData {
  const tracks = artist.tracks.map(toClientTrack);
  return {
    title: artist.name,
    monthlyListeners: artist.monthlyListeners,
    verified: Boolean(artist.verified),
    description: artist.bio?.trim() || "",
    coverUrl: artist.cover ? toMaxQualityAvatarUrl(mediaUrl(artist.cover.url)) : "",
    geniusImageUrl: artist.geniusImageUrl ? mediaUrl(artist.geniusImageUrl) : undefined,
    geniusAka: artist.geniusAka,
    geniusUsername: artist.geniusUsername,
    totalTracks: tracks.length,
    tracks,
    popularSongs: tracks.slice(0, 5),
    albums: artist.albums.map((album) => ({
      id: album.id,
      title: album.title,
      coverUrl: album.cover ? mediaUrl(album.cover.url) : "",
      ...(album.year ? { releaseDate: String(album.year) } : {}),
      totalTracks: album.totalTracks ?? album.trackCount,
      explicit: album.explicit,
    })),
    reposts: [],
    singles: artist.singles.map((single) => ({
      id: single.id,
      title: single.title,
      coverUrl: single.cover ? mediaUrl(single.cover.url) : "",
      releaseType: single.releaseType,
      ...(single.year ? { releaseDate: String(single.year) } : {}),
      totalTracks: single.totalTracks ?? single.trackCount,
      explicit: single.explicit,
    })),
  };
}

/**
 * Client-side fallback used when the backend artist route is unavailable.
 * The tracks come straight from the channel's Top songs shelf, so their ids
 * are YouTube videoIds the playback providers can stream directly.
 */
async function loadFromInnertube(channelId: string): Promise<ArtistPageData> {
  const page = await fetchInnertubeArtist(channelId);
  return {
    title: page.title,
    description: page.description,
    coverUrl: page.coverUrl,
    ...(page.subscriberCount ? { monthlyListeners: page.subscriberCount } : {}),
    verified: false,
    totalTracks: page.tracks.length,
    tracks: page.tracks,
    popularSongs: page.tracks.slice(0, 5),
    albums: page.albums,
    reposts: [],
    singles: page.singles.map((single) => ({
      ...single,
      releaseType: single.releaseTypeHint === "ep" ? "ep" : "single",
    })),
  };
}

export function useArtist(id: string | null) {
  const [data, setData] = useState<ArtistPageData | null>(null);
  const [loading, setLoading] = useState<boolean>(Boolean(id));

  useEffect(() => {
    if (!id) {
      setData(null);
      setLoading(false);
      return;
    }

    const artistId = id;
    let active = true;

    setData(null);
    setLoading(true);

    async function loadArtist() {
      try {
        let formatted: ArtistPageData;
        try {
          formatted = formatBackendArtist(await api.getArtist(artistId));
        } catch (backendError) {
          // The deployed API lost its artist and search routes (Fastify
          // answers 404 "Route … not found"), so artist taps fall back to
          // browsing the channel directly through Innertube — the same
          // backend-independent approach the playback providers use.
          const resolvedId = isChannelId(artistId)
            ? artistId
            : await resolveArtistIdByName(artistId);
          if (!resolvedId) throw backendError;
          if (resolvedId !== artistId) {
            try {
              formatted = formatBackendArtist(await api.getArtist(resolvedId));
            } catch {
              formatted = await loadFromInnertube(resolvedId);
            }
          } else {
            formatted = await loadFromInnertube(resolvedId);
          }
        }

        if (!active) return;
        setData(formatted);
      } catch {
        if (active) {
          setData(null);
        }
      } finally {
        if (active) {
          setLoading(false);
        }
      }
    }

    void loadArtist();

    return () => {
      active = false;
    };
  }, [id]);

  return { data, loading };
}
