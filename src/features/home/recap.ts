import type { PlaybackHistoryItem } from "@/shared/contracts/history";

export interface RecapTrack {
  id: string;
  title: string;
  artists: string;
  coverUrl: string;
  plays: number;
  listenedMs: number;
}

export interface RecapArtist {
  name: string;
  plays: number;
  listenedMs: number;
}

export interface ListeningRecap {
  year: number;
  isPartial: boolean;
  plays: number;
  listenedMs: number;
  uniqueTracks: number;
  uniqueArtists: number;
  activeDays: number;
  topTracks: RecapTrack[];
  topArtists: RecapArtist[];
  topMonth: string | null;
  topDay: string | null;
  monthlyListeningMs: number[];
}

function artistNames(track: PlaybackHistoryItem["track"]): string[] {
  const rawArtists: unknown = track.artists;
  if (Array.isArray(rawArtists)) {
    return rawArtists
      .map((artist) => {
        if (typeof artist === "string") return artist.trim();
        if (artist && typeof artist === "object" && "name" in artist) {
          const name = (artist as { name?: unknown }).name;
          return typeof name === "string" ? name.trim() : "";
        }
        return "";
      })
      .filter(Boolean);
  }
  if (typeof rawArtists === "string") {
    return rawArtists.split(",").map((artist) => artist.trim()).filter(Boolean);
  }
  return [];
}

export function buildListeningRecap(
  history: PlaybackHistoryItem[],
  year: number,
  isPartial = false,
): ListeningRecap {
  const tracks = new Map<string, RecapTrack>();
  const artists = new Map<string, RecapArtist>();
  const months = new Map<number, number>();
  const days = new Map<string, number>();
  const activeDays = new Set<string>();
  let plays = 0;
  let listenedMs = 0;

  for (const entry of history) {
    const track = entry.track;
    const listenedAtMs = Date.parse(entry.listenedAt);
    const durationMs = Number.isFinite(entry.playedDurationMs)
      ? Math.max(0, entry.playedDurationMs)
      : 0;
    if (
      !track?.id ||
      !Number.isFinite(listenedAtMs) ||
      new Date(listenedAtMs).getFullYear() !== year ||
      durationMs <= 0
    ) {
      continue;
    }

    const listenedAt = new Date(listenedAtMs);
    const dayKey = `${listenedAt.getFullYear()}-${listenedAt.getMonth()}-${listenedAt.getDate()}`;
    plays += 1;
    listenedMs += durationMs;
    activeDays.add(dayKey);
    months.set(listenedAt.getMonth(), (months.get(listenedAt.getMonth()) ?? 0) + durationMs);
    days.set(dayKey, (days.get(dayKey) ?? 0) + durationMs);

    const existingTrack = tracks.get(track.id);
    if (existingTrack) {
      existingTrack.plays += 1;
      existingTrack.listenedMs += durationMs;
    } else {
      tracks.set(track.id, {
        id: track.id,
        title: track.title || "Unknown track",
        artists: artistNames(track).join(", "),
        coverUrl: track.cover?.url || "",
        plays: 1,
        listenedMs: durationMs,
      });
    }

    for (const name of new Set(artistNames(track))) {
      const key = name.toLocaleLowerCase();
      const existingArtist = artists.get(key);
      if (existingArtist) {
        existingArtist.plays += 1;
        existingArtist.listenedMs += durationMs;
      } else {
        artists.set(key, { name, plays: 1, listenedMs: durationMs });
      }
    }
  }

  const monthIndex = [...months.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const topDayKey = [...days.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const topDayParts = topDayKey?.split("-").map(Number);
  const topDay =
    topDayParts?.length === 3
      ? new Date(topDayParts[0], topDayParts[1], topDayParts[2]).toLocaleDateString(undefined, {
          month: "long",
          day: "numeric",
        })
      : null;

  return {
    year,
    isPartial,
    plays,
    listenedMs,
    uniqueTracks: tracks.size,
    uniqueArtists: artists.size,
    activeDays: activeDays.size,
    topTracks: [...tracks.values()]
      .sort((a, b) => b.plays - a.plays || b.listenedMs - a.listenedMs)
      .slice(0, 5),
    topArtists: [...artists.values()]
      .sort((a, b) => b.plays - a.plays || b.listenedMs - a.listenedMs)
      .slice(0, 5),
    topMonth:
      monthIndex === undefined
        ? null
        : new Date(year, monthIndex, 1).toLocaleDateString(undefined, { month: "long" }),
    topDay,
    monthlyListeningMs: Array.from({ length: 12 }, (_, month) => months.get(month) ?? 0),
  };
}
