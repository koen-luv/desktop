import type { Track } from "@/shared/types";

/**
 * How a playlist is displayed. `custom` is the stored server order, which is
 * also the only mode where drag-to-reorder is allowed; every other mode is a
 * view-only sort and never touches the playlist's revision.
 */
export type PlaylistSortKey = "custom" | "title" | "artist" | "album" | "recent" | "oldest";

export const PLAYLIST_SORT_KEYS: PlaylistSortKey[] = [
  "custom",
  "title",
  "artist",
  "album",
  "recent",
  "oldest",
];

export const PLAYLIST_SORT_LABEL_KEYS: Record<PlaylistSortKey, string> = {
  custom: "playlist.sort.custom",
  title: "playlist.sort.title",
  artist: "playlist.sort.artist",
  album: "playlist.sort.album",
  recent: "playlist.sort.recent",
  oldest: "playlist.sort.oldest",
};

const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

function valueOf(track: Track, key: Exclude<PlaylistSortKey, "custom" | "recent" | "oldest">): string {
  if (key === "title") return track.title ?? "";
  if (key === "artist") return track.artists ?? "";
  return track.album?.title ?? "";
}

function addedAt(track: Track): number {
  if (!track.playlistAddedAt) return Number.NaN;
  const parsed = Date.parse(track.playlistAddedAt);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

/**
 * Returns a new array sorted for display, or the same reference for `custom`.
 * The sort is stable: missing values go last and equal keys keep their server
 * order, so the list never shuffles between renders.
 */
export function sortPlaylistTracks(tracks: Track[], key: PlaylistSortKey): Track[] {
  if (key === "custom" || tracks.length < 2) return tracks;

  const rows = tracks.map((track, index) => ({ track, index }));
  rows.sort((a, b) => {
    if (key === "recent" || key === "oldest") {
      const at = addedAt(a.track);
      const bt = addedAt(b.track);
      const aValid = Number.isFinite(at);
      const bValid = Number.isFinite(bt);
      if (aValid && bValid && at !== bt) return key === "recent" ? bt - at : at - bt;
      if (aValid !== bValid) return aValid ? -1 : 1;
      return a.index - b.index;
    }

    const aValue = valueOf(a.track, key);
    const bValue = valueOf(b.track, key);
    // Albums/artists without a value belong at the end, not at the top.
    if (!aValue && bValue) return 1;
    if (aValue && !bValue) return -1;

    const primary = collator.compare(aValue, bValue);
    if (primary !== 0) return primary;

    // Same album or artist: alphabetical within the group, then server order.
    const secondary = collator.compare(a.track.title ?? "", b.track.title ?? "");
    if (secondary !== 0) return secondary;
    return a.index - b.index;
  });

  return rows.map((row) => row.track);
}
