import { useEffect, useState } from "react";
import { api, toClientTrack } from "@/shared/api";
import { fetchInnertubeArtist, isChannelId } from "@/shared/api/innertubeArtist";
import type { PlaybackHistoryItem } from "@/shared/contracts/history";
import type { PopularItem } from "./usePopularTracks";
import { useSessionOwner } from "./sessionAwareLoad";

const DAY_MS = 24 * 60 * 60 * 1000;
const FORGOTTEN_AFTER_DAYS = 14;
const HISTORY_PAGES = 3;

async function fetchHistoryPages(): Promise<PlaybackHistoryItem[]> {
  const items: PlaybackHistoryItem[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < HISTORY_PAGES; page += 1) {
    const response = await api.getHistory(cursor, 100);
    items.push(...(response.items || []));
    cursor = response.nextCursor ?? undefined;
    if (!cursor) break;
  }
  return items;
}

/**
 * Tracks that were loved once but have not been heard in a while. Uses the
 * server history (not the local queue), so it survives reinstalls and works on
 * every shell.
 */
export function useForgottenMemories(limit = 20) {
  const owner = useSessionOwner();
  const [data, setData] = useState<PopularItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let active = true;
    setIsLoading(true);
    fetchHistoryPages()
      .then((history) => {
        if (!active) return;
        const newestByTrack = new Map<string, PlaybackHistoryItem>();
        for (const entry of history) {
          if (!entry.track?.id) continue;
          const previous = newestByTrack.get(entry.track.id);
          const currentAt = Date.parse(entry.listenedAt || "");
          const previousAt = previous ? Date.parse(previous.listenedAt || "") : -Infinity;
          if (!previous || (Number.isFinite(currentAt) && currentAt > previousAt)) {
            newestByTrack.set(entry.track.id, entry);
          }
        }

        const cutoff = Date.now() - FORGOTTEN_AFTER_DAYS * DAY_MS;
        const forgotten = [...newestByTrack.values()]
          .filter((entry) => {
            const listenedAt = Date.parse(entry.listenedAt || "");
            return Number.isFinite(listenedAt) && listenedAt < cutoff;
          })
          .sort((a, b) => Date.parse(a.listenedAt) - Date.parse(b.listenedAt))
          .slice(0, limit)
          .map<PopularItem>((entry) => ({
            type: "track",
            item: toClientTrack(entry.track),
            playCount: Math.max(1, Math.round(entry.playedDurationMs / 1000)),
          }));

        setData(forgotten);
      })
      .catch(() => {
        if (active) setData([]);
      })
      .finally(() => {
        if (active) setIsLoading(false);
      });

    return () => {
      active = false;
    };
  }, [owner, limit]);

  return { data, isLoading };
}

/**
 * Albums and singles released recently by artists the listener already plays.
 * Artist pages come from Innertube because the deployed backend has no artist
 * routes; failures simply hide the section.
 */
export function useNewReleases(limit = 12) {
  const owner = useSessionOwner();
  const [data, setData] = useState<PopularItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    let active = true;
    setIsLoading(true);

    (async () => {
      const [history, liked] = await Promise.allSettled([
        fetchHistoryPages(),
        api.listLikedTracks(100),
      ]);

      const artistIds = new Set<string>();
      if (history.status === "fulfilled") {
        for (const entry of history.value) {
          const track = entry.track as any;
          for (const artist of track?.artistList ?? []) {
            if (artist?.id && isChannelId(artist.id)) artistIds.add(artist.id);
          }
          if (track?.artistId && isChannelId(track.artistId)) {
            artistIds.add(track.artistId);
          }
          if (artistIds.size >= 4) break;
        }
      }
      if (artistIds.size < 3 && liked.status === "fulfilled") {
        for (const { track } of liked.value.items || []) {
          const raw = track as any;
          for (const artist of raw.artistList ?? []) {
            if (artist?.id && isChannelId(artist.id)) artistIds.add(artist.id);
          }
          if (raw.artistId && isChannelId(raw.artistId)) artistIds.add(raw.artistId);
          if (artistIds.size >= 4) break;
        }
      }

      const pages = await Promise.allSettled(
        [...artistIds].slice(0, 4).map((id) => fetchInnertubeArtist(id)),
      );

      const currentYear = new Date().getFullYear();
      const seen = new Set<string>();
      const releases: { year: number; item: PopularItem }[] = [];
      for (const page of pages) {
        if (page.status !== "fulfilled") continue;
        for (const release of [...page.value.albums, ...page.value.singles]) {
          if (!release.id || seen.has(release.id)) continue;
          const year = Number.parseInt((release.releaseDate || "").slice(0, 4), 10);
          if (Number.isFinite(year) && year < currentYear - 1) continue;
          seen.add(release.id);
          releases.push({
            year: Number.isFinite(year) ? year : 0,
            item: {
              type: "album",
              item: {
                id: release.id,
                title: release.title,
                artist: page.value.title,
                coverUrl: release.coverUrl,
                totalTracks: 0,
                albumType: release.releaseTypeHint === "ep" ? "ep" : "album",
              },
              playCount: 0,
            },
          });
        }
      }

      if (!active) return;
      releases.sort((a, b) => b.year - a.year);
      setData(releases.slice(0, limit).map((entry) => entry.item));
    })()
      .catch(() => {
        if (active) setData([]);
      })
      .finally(() => {
        if (active) setIsLoading(false);
      });

    return () => {
      active = false;
    };
  }, [owner, limit]);

  return { data, isLoading };
}
