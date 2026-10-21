import { useEffect } from "react";
import { getAndroidBridge, onNativeEvent } from "@/platform";
import { api, mediaUrl, toClientTrack } from "@/shared/api";
import { playerEngine } from "@/features/player/engine/playerEngine";
import type { Track } from "@/shared/types";

/**
 * Android Auto browse tree, served from the renderer.
 *
 * The native media library session forwards browse/search requests as
 * `autoBrowseQuery` events ({ id, kind, arg }); this hook answers them through
 * the `autoBrowseResponse` bridge method with
 * `{ items: [{ id, title, subtitle, artwork, playable }] }`. Playback requests
 * arrive as `autoPlay` events ({ mediaId } or { query }) and are resolved back
 * into a full track + queue so normal playback (next/prev, notification, state)
 * behaves exactly like a UI-initiated play.
 */

const TRACK_PREFIX = "liner.track:";
const PLAYLIST_PREFIX = "liner.playlist:";

interface ServedEntry {
  track: Track;
  queue: Track[];
  context: string | null;
  contextCover: string | null;
}

/** Media id → the play context it was served in, for resolving play requests. */
const served = new Map<string, ServedEntry>();

interface BrowseQuery {
  id?: string;
  kind?: string;
  arg?: string;
}

interface AutoPlayRequest {
  mediaId?: string;
  query?: string;
}

function trackItem(track: Track, queue: Track[], context: string | null, contextCover: string | null) {
  const id = TRACK_PREFIX + track.id;
  served.set(id, { track, queue, context, contextCover });
  return {
    id,
    title: track.title,
    subtitle: track.artists,
    artwork: track.coverUrl ? mediaUrl(track.coverUrl) : "",
    playable: true,
  };
}

function folderItem(id: string, title: string, subtitle: string) {
  return { id, title, subtitle, artwork: "", playable: false };
}

function isTrackItem(item: { type?: string }): boolean {
  return item.type === "track";
}

async function buildItems(kind: string, arg: string): Promise<unknown[]> {
  switch (kind) {
    case "recents": {
      const response = await api.getHistory(undefined, 30);
      const seen = new Set<string>();
      const tracks: Track[] = [];
      for (const entry of response.items) {
        const track = toClientTrack(entry.track);
        if (!track.id || seen.has(track.id)) continue;
        seen.add(track.id);
        tracks.push(track);
      }
      return tracks.map((track) => trackItem(track, tracks, "Recently played", null));
    }
    case "playlists": {
      const response = await api.listPlaylists();
      return response.items.map((playlist) =>
        folderItem(PLAYLIST_PREFIX + playlist.id, playlist.title, playlist.description ?? ""),
      );
    }
    case "playlist": {
      const details = await api.getPlaylist(arg);
      const tracks = (details.tracks ?? []).map((track) => toClientTrack(track)).filter((t) => t.id);
      return tracks.map((track) => trackItem(track, tracks, details.title, null));
    }
    case "queue": {
      const snapshot = playerEngine.getSnapshot();
      const queue = [...snapshot.queue];
      const context = snapshot.playbackContext ?? "Queue";
      const contextCover = snapshot.playbackContextCover ?? null;
      return queue.map((track) => trackItem(track, queue, context, contextCover));
    }
    case "search": {
      if (!arg.trim()) return [];
      const response = await api.search(arg);
      const tracks = response.items
        .filter(isTrackItem)
        .map((item) => toClientTrack(item))
        .filter((track) => track.id);
      return tracks.map((track) => trackItem(track, tracks, arg, null));
    }
    default:
      return [];
  }
}

function respond(requestId: string, items: unknown[]) {
  getAndroidBridge()?.autoBrowseResponse(requestId, JSON.stringify({ items }));
}

async function handleAutoPlay(request: AutoPlayRequest) {
  if (request.query) {
    try {
      const response = await api.search(request.query);
      const tracks = response.items
        .filter(isTrackItem)
        .map((item) => toClientTrack(item))
        .filter((track) => track.id);
      const first = tracks[0];
      if (first) await playerEngine.playTrack(first, tracks, request.query, null);
    } catch (error) {
      console.warn("[auto] search playback failed:", error);
    }
    return;
  }

  const mediaId = request.mediaId;
  if (!mediaId || !mediaId.startsWith(TRACK_PREFIX)) return;

  let entry = served.get(mediaId);
  if (!entry) {
    // The renderer restarted since the list was served: recover from the live
    // queue so a play tap still works without re-browsing.
    const snapshot = playerEngine.getSnapshot();
    const queue = [...snapshot.queue];
    const track = queue.find((item) => TRACK_PREFIX + item.id === mediaId);
    if (track) {
      entry = {
        track,
        queue,
        context: snapshot.playbackContext ?? "Queue",
        contextCover: snapshot.playbackContextCover ?? null,
      };
    }
  }
  if (!entry) return;
  await playerEngine.playTrack(entry.track, entry.queue, entry.context, entry.contextCover);
}

function parsePayload<T>(payload: unknown): T | null {
  // The platform dispatcher pre-parses JSON payloads, but stay tolerant of
  // raw strings so either shape works.
  if (typeof payload === "string") {
    try {
      return JSON.parse(payload) as T;
    } catch {
      return null;
    }
  }
  if (payload && typeof payload === "object") return payload as T;
  return null;
}

/** Registers the Android Auto browse/play handlers for the lifetime of the app. */
export function useAutoSync(): void {
  useEffect(() => {
    const offQuery = onNativeEvent("autoBrowseQuery", (payload) => {
      const request = parsePayload<BrowseQuery>(payload);
      const id = request?.id;
      if (!request || !id) return;
      buildItems(request.kind ?? "", request.arg ?? "")
        .then((items) => respond(id, items))
        .catch((error) => {
          // Answer empty instead of leaving the client spinner running; the
          // native side also times out if no answer arrives at all.
          console.warn("[auto] browse query failed:", request.kind, error);
          respond(id, []);
        });
    });

    const offPlay = onNativeEvent("autoPlay", (payload) => {
      const request = parsePayload<AutoPlayRequest>(payload);
      if (!request) return;
      void handleAutoPlay(request);
    });

    return () => {
      offQuery();
      offPlay();
    };
  }, []);
}
