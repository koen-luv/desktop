import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { debouncedStorage } from "@/shared/utils/storage";
import type { PlaylistSortKey } from "../utils/playlistSort";

/**
 * Per-playlist presentation prefs that belong to this device rather than the
 * server: a custom cover image (the API has no cover field, so the compressed
 * data URL lives here) and the chosen sort order. Both are keyed by playlist
 * id and survive restarts, on desktop, Android and iOS alike.
 */
interface PlaylistViewState {
  covers: Record<string, string>;
  sortBy: Record<string, PlaylistSortKey>;
  setCover: (playlistId: string, dataUrl: string) => void;
  clearCover: (playlistId: string) => void;
  setSort: (playlistId: string, sort: PlaylistSortKey) => void;
  /** Drops the cover and sort for a deleted playlist. */
  forgetPlaylist: (playlistId: string) => void;
}

export const usePlaylistViewStore = create<PlaylistViewState>()(
  persist(
    (set) => ({
      covers: {},
      sortBy: {},
      setCover: (playlistId, dataUrl) =>
        set((state) => ({ covers: { ...state.covers, [playlistId]: dataUrl } })),
      clearCover: (playlistId) =>
        set((state) => {
          const covers = { ...state.covers };
          delete covers[playlistId];
          return { covers };
        }),
      setSort: (playlistId, sort) =>
        set((state) => ({ sortBy: { ...state.sortBy, [playlistId]: sort } })),
      forgetPlaylist: (playlistId) =>
        set((state) => {
          const covers = { ...state.covers };
          const sortBy = { ...state.sortBy };
          delete covers[playlistId];
          delete sortBy[playlistId];
          return { covers, sortBy };
        }),
    }),
    {
      name: "liner:playlist-view-v1",
      storage: createJSONStorage(() => debouncedStorage),
    },
  ),
);

/** The user-picked cover for a playlist, when one is set. */
export function usePlaylistCoverOverride(playlistId?: string | null): string | undefined {
  return usePlaylistViewStore((state) =>
    playlistId ? state.covers[playlistId] : undefined,
  );
}

/** The saved sort order for a playlist; missing means the custom order. */
export function usePlaylistSortKey(playlistId?: string | null): PlaylistSortKey {
  return usePlaylistViewStore((state) =>
    playlistId ? (state.sortBy[playlistId] ?? "custom") : "custom",
  );
}

