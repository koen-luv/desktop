import { innertubeCatalog } from "@/shared/media/innertube";
import { isAbortError } from "@/shared/utils/abort";
import { log } from "@/shared/utils/logger";
import type {
  AlbumDetails,
  ArtistDetails,
  CatalogPlaylistDetails,
  RadioResponse,
  SearchResponse,
  SearchType,
  Track,
  TrackDetails,
} from "@/shared/contracts";

const SERVER_ONLY_ID = /^sc[:_]/i;

export function isClientCatalogId(id: string): boolean {
  return !SERVER_ONLY_ID.test(id.trim());
}

async function preferClient<T>(label: string, client: () => Promise<T>, server: () => Promise<T>): Promise<T> {
  try {
    return await client();
  } catch (error) {
    if (isAbortError(error)) throw error;
    log("yellow", "catalog", `${label} failed on client, using server fallback`, error);
    return server();
  }
}

const SNAPSHOT_TIMEOUT_MS = 4000;

async function resolveSnapshot(id: string): Promise<Track | undefined> {
  if (!isClientCatalogId(id)) return undefined;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SNAPSHOT_TIMEOUT_MS);
  try {
    const details = await innertubeCatalog.getTrack(id, controller.signal);
    return {
      id: details.id,
      title: details.title,
      artists: details.artists,
      durationMs: details.durationMs,
      ...(details.album ? { album: details.album } : {}),
      ...(details.cover ? { cover: details.cover } : {}),
      ...(details.explicit !== undefined ? { explicit: details.explicit } : {}),
    };
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

export const clientCatalog = {
  resolveSnapshot,

  search(query: string, type: SearchType, server: () => Promise<SearchResponse>): Promise<SearchResponse> {
    return preferClient(
      "search",
      async () => ({ items: await innertubeCatalog.search(query, type) }),
      server,
    );
  },

  getTrack(id: string, server: () => Promise<TrackDetails>): Promise<TrackDetails> {
    if (!isClientCatalogId(id)) return server();
    return preferClient("track", () => innertubeCatalog.getTrack(id), server);
  },

  getRadio(id: string, k: number | undefined, server: () => Promise<RadioResponse>): Promise<RadioResponse> {
    if (!isClientCatalogId(id)) return server();
    return preferClient("radio", () => innertubeCatalog.getRadio(id, { k }), server);
  },

  getAlbum(id: string, server: () => Promise<AlbumDetails>): Promise<AlbumDetails> {
    if (!isClientCatalogId(id)) return server();
    return preferClient("album", () => innertubeCatalog.getAlbum(id), server);
  },

  getArtist(id: string, server: () => Promise<ArtistDetails>): Promise<ArtistDetails> {
    if (!isClientCatalogId(id)) return server();
    return preferClient("artist", () => innertubeCatalog.getArtist(id), server);
  },

  getPlaylist(id: string, server: () => Promise<CatalogPlaylistDetails>): Promise<CatalogPlaylistDetails> {
    if (!isClientCatalogId(id)) return server();
    return preferClient("playlist", () => innertubeCatalog.getPlaylist(id), server);
  },
};
