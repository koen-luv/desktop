import { useCallback, useState } from "react";
import { api, getAuthSession } from "@/shared/api";
import { notifyLibraryChanged, evictPlaylistFromCache } from "./usePlaylists";
import { usePlaylistViewStore } from "../store/playlistViewStore";
import { applyOptimisticLike, applyOptimisticUnlike } from "./useLikedTracks";
import {
  addSharedPlaylistTrack,
  deleteSharedPlaylist,
  isSharedPlaylistId,
  leaveSharedPlaylist,
  moveSharedPlaylistTrack,
  removeSharedPlaylistTrack,
} from "../services/sharedPlaylists";

type Options = {
  onSuccess?: (...args: any[]) => void;
  onError?: (error: unknown) => void;
  onSettled?: () => void;
};

function useMutation<T, R = unknown>(action: (input: T) => Promise<R>) {
  const [isPending, setIsPending] = useState(false);
  const mutateAsync = useCallback(
    async (input: T): Promise<R> => {
      setIsPending(true);
      try {
        const result = await action(input);
        notifyLibraryChanged();
        return result;
      } finally {
        setIsPending(false);
      }
    },
    [action]
  );
  const mutate = useCallback(
    (input: T, options?: Options) => {
      void mutateAsync(input)
        .then((value) => options?.onSuccess?.(value))
        .catch((error) => options?.onError?.(error))
        .finally(() => options?.onSettled?.());
    },
    [mutateAsync]
  );
  return { mutate, mutateAsync, isPending };
}

export function useAddPlaylistTracks() {
  return useMutation(
    async ({ playlistId, trackId }: { playlistId: string; trackId: string }) => {
      if (isSharedPlaylistId(playlistId)) {
        await addSharedPlaylistTrack(playlistId, trackId);
      } else {
        await api.addPlaylistTrack(playlistId, trackId);
      }
    },
  );
}

export function useRemovePlaylistTracks() {
  return useMutation(({ playlistId, itemId }: { playlistId: string; itemId: string }) =>
    isSharedPlaylistId(playlistId)
      ? removeSharedPlaylistTrack(playlistId, itemId)
      : api.removePlaylistItem(playlistId, itemId),
  );
}

export function useReorderPlaylistTracks() {
  return useMutation(
    async ({
      playlistId,
      itemId,
      beforeItemId,
      revision,
    }: {
      playlistId: string;
      itemId: string;
      beforeItemId: string | null;
      revision: number;
    }) => {
      if (isSharedPlaylistId(playlistId)) {
        await moveSharedPlaylistTrack(playlistId, itemId, beforeItemId);
      } else {
        await api.movePlaylistItem(playlistId, itemId, beforeItemId, revision);
      }
    },
  );
}

export function useCreatePlaylist() {
  return useMutation(({ title, description }: { title: string; description?: string }) =>
    api.createPlaylist({ title, description })
  );
}

export function useDeletePlaylist() {
  return useMutation(async ({ playlistId }: { playlistId: string }) => {
    evictPlaylistFromCache(playlistId);
    usePlaylistViewStore.getState().forgetPlaylist(playlistId);
    return isSharedPlaylistId(playlistId)
      ? deleteSharedPlaylist(playlistId)
      : api.deletePlaylist(playlistId);
  });
}

export function useSaveExternalItem() {
  return useMutation(
    ({
      type,
      id,
      snapshot,
    }: {
      type: "album" | "artist" | "playlist";
      id: string;
      snapshot?: Record<string, unknown>;
    }) => api.saveCollection(`${type}s` as "albums" | "artists" | "playlists", id, snapshot),
  );
}

export function useRemoveExternalItem() {
  return useMutation(
    async ({
      type,
      id,
      isOwned,
    }: {
      type: "album" | "artist" | "playlist";
      id: string;
      isOwned?: boolean;
    }) => {
      if (type === "playlist") {
        evictPlaylistFromCache(id);
        if (isSharedPlaylistId(id)) {
          if (isOwned === false) {
            const userId = getAuthSession()?.user.id;
            if (!userId) throw new Error("Sign in to leave this shared playlist.");
            return leaveSharedPlaylist(id, userId);
          }
          return deleteSharedPlaylist(id);
        }
        if (isOwned === false) {
          return api.removeCollection("playlists", id);
        }
        try {
          const res = await api.deletePlaylist(id);
          // purge any saved collection reference in case it was both created and saved
          await api.removeCollection("playlists", id).catch(() => {});
          return res;
        } catch (err: unknown) {
          if (isOwned === true) {
            throw err;
          }
          // fall back to removing from saved collections if playlist was not owned
          return api.removeCollection("playlists", id);
        }
      }
      return api.removeCollection(`${type}s` as "albums" | "artists", id);
    },
  );
}

type TrackMutationInput = string | { trackId: string; [key: string]: unknown };
const trackIdFrom = (input: TrackMutationInput) =>
  typeof input === "string" ? input : input.trackId;

/** The API has no batch endpoint for either direction, so bulk work is grouped
 * in small parallel batches to keep the requests honest without flooding it. */
const BULK_BATCH_SIZE = 4;

function batches<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export function useSaveLikedSongsToPlaylist() {
  const [isPending, setIsPending] = useState(false);
  const [saved, setSaved] = useState(0);

  const mutateAsync = useCallback(
    async ({ trackIds, title }: { trackIds: string[]; title: string }) => {
      if (trackIds.length === 0) throw new Error("There are no liked songs to save yet.");
      setIsPending(true);
      setSaved(0);
      try {
        const playlist = await api.createPlaylist({ title });
        let done = 0;
        for (const batch of batches(trackIds, BULK_BATCH_SIZE)) {
          const results = await Promise.allSettled(
            batch.map((trackId) => api.addPlaylistTrack(playlist.id, trackId)),
          );
          done += results.filter((result) => result.status === "fulfilled").length;
          setSaved(done);
        }
        notifyLibraryChanged();
        if (done === 0) {
          await api.deletePlaylist(playlist.id).catch(() => {});
          throw new Error("None of the liked songs could be added to the playlist.");
        }
        return { playlist, added: done, skipped: trackIds.length - done };
      } finally {
        setIsPending(false);
      }
    },
    [],
  );

  return { mutateAsync, isPending, saved };
}

export function useLikePlaylistTracks() {
  const [isPending, setIsPending] = useState(false);
  const [liked, setLiked] = useState(0);

  const mutateAsync = useCallback(async ({ trackIds }: { trackIds: string[] }) => {
    if (trackIds.length === 0) return { liked: 0, failed: 0 };
    setIsPending(true);
    setLiked(0);
    try {
      let done = 0;
      let failed = 0;
      for (const batch of batches(trackIds, BULK_BATCH_SIZE)) {
        const results = await Promise.allSettled(batch.map((trackId) => api.likeTrack(trackId)));
        done += results.filter((result) => result.status === "fulfilled").length;
        failed += results.filter((result) => result.status === "rejected").length;
        setLiked(done);
      }
      notifyLibraryChanged();
      return { liked: done, failed };
    } finally {
      setIsPending(false);
    }
  }, []);

  return { mutateAsync, isPending, liked };
}

export function useLikeTrack() {
  const [isPending, setIsPending] = useState(false);

  const mutateAsync = useCallback(async (input: TrackMutationInput) => {
    const trackId = trackIdFrom(input);
    setIsPending(true);
    const rollback = applyOptimisticLike(trackId);
    try {
      const result = await api.likeTrack(trackId);
      notifyLibraryChanged();
      return result;
    } catch (err) {
      rollback();
      throw err;
    } finally {
      setIsPending(false);
    }
  }, []);

  const mutate = useCallback(
    (input: TrackMutationInput, options?: Options) => {
      void mutateAsync(input)
        .then((value) => options?.onSuccess?.(value))
        .catch((error) => options?.onError?.(error))
        .finally(() => options?.onSettled?.());
    },
    [mutateAsync]
  );

  return { mutate, mutateAsync, isPending };
}

export function useUnlikeTrack() {
  const [isPending, setIsPending] = useState(false);

  const mutateAsync = useCallback(async (input: TrackMutationInput) => {
    const trackId = trackIdFrom(input);
    setIsPending(true);
    const rollback = applyOptimisticUnlike(trackId);
    try {
      const result = await api.unlikeTrack(trackId);
      notifyLibraryChanged();
      return result;
    } catch (err) {
      rollback();
      throw err;
    } finally {
      setIsPending(false);
    }
  }, []);

  const mutate = useCallback(
    (input: TrackMutationInput, options?: Options) => {
      void mutateAsync(input)
        .then((value) => options?.onSuccess?.(value))
        .catch((error) => options?.onError?.(error))
        .finally(() => options?.onSettled?.());
    },
    [mutateAsync]
  );

  return { mutate, mutateAsync, isPending };
}
