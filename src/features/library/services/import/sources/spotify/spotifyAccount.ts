import type { ClientImportedPlaylist, ClientImportedTrack } from "../../importTypes";
import { log } from "@/shared/utils/logger";

/**
 * Spotify account import (desktop only).
 *
 * Unlike the link importer — which reads a public embed/pathfinder page — this
 * uses the Spotify Web API with the user's own authorization, so private
 * playlists and liked songs are reachable, and nothing is scraped.
 *
 * Tokens live in `sessionStorage`: they die with the window, are never written to
 * IndexedDB, and never appear in the diagnostics dump. PKCE is handled in the
 * main process (`electron/spotify-oauth.ts`); the refresh token is the only
 * long-lived secret and it stays in this renderer session.
 */

const STORAGE_KEY = "neritium_spotify_account_v1";
const API_BASE = "https://api.spotify.com/v1";
/** Spotify caps a page at 50 and liked songs can be thousands deep. */
const PAGE_SIZE = 50;
const MAX_PAGES = 200;

interface StoredAccount {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

export interface SpotifyAccountPlaylist {
  id: string;
  name: string;
  description?: string;
  trackCount: number;
  ownerName?: string;
  isPublic: boolean;
}

interface SpotifyApiTrack {
  id: string | null;
  name?: string;
  duration_ms?: number;
  artists?: { name?: string }[];
  album?: { name?: string; images?: { url?: string }[] };
  track?: SpotifyApiTrack;
  is_local?: boolean;
}

interface SpotifyPage<T> {
  items?: T[];
  next?: string | null;
  total?: number;
}

function readAccount(): StoredAccount | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredAccount>;
    if (!parsed.accessToken || !parsed.refreshToken) return null;
    return {
      accessToken: parsed.accessToken,
      refreshToken: parsed.refreshToken,
      expiresAt: Number(parsed.expiresAt) || 0,
    };
  } catch {
    return null;
  }
}

function writeAccount(account: StoredAccount | null): void {
  try {
    if (!account) sessionStorage.removeItem(STORAGE_KEY);
    else sessionStorage.setItem(STORAGE_KEY, JSON.stringify(account));
  } catch {
    // private mode: the connection simply lasts for this session only
  }
}

export function isSpotifyAccountAvailable(): boolean {
  return typeof window !== "undefined" && typeof window.neritiumElectron?.spotifyConnect === "function";
}

export function isSpotifyAccountConnected(): boolean {
  return readAccount() !== null;
}

export function disconnectSpotifyAccount(): void {
  writeAccount(null);
}

/** Connects (or reconnects) the account and stores the session tokens. */
export async function connectSpotifyAccount(): Promise<void> {
  const bridge = window.neritiumElectron;
  if (!bridge?.spotifyConnect) {
    throw new Error("Connecting a Spotify account is only available in the desktop app.");
  }
  const result = await bridge.spotifyConnect();
  if (!result.ok) throw new Error(result.error);
  writeAccount({
    accessToken: result.tokens.accessToken,
    refreshToken: result.tokens.refreshToken,
    expiresAt: result.tokens.expiresAt,
  });
}

async function accessToken(): Promise<string> {
  const account = readAccount();
  if (!account) throw new Error("Connect your Spotify account first.");
  if (Date.now() < account.expiresAt - 60_000) return account.accessToken;

  const bridge = window.neritiumElectron;
  if (!bridge?.spotifyRefresh) throw new Error("Spotify session expired; reconnect the account.");
  const refreshed = await bridge.spotifyRefresh(account.refreshToken);
  if (!refreshed.ok) {
    writeAccount(null);
    throw new Error(refreshed.error);
  }
  writeAccount({
    accessToken: refreshed.tokens.accessToken,
    refreshToken: refreshed.tokens.refreshToken,
    expiresAt: refreshed.tokens.expiresAt,
  });
  return refreshed.tokens.accessToken;
}

async function spotifyGet<T>(pathOrUrl: string): Promise<T> {
  const token = await accessToken();
  const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${API_BASE}${pathOrUrl}`;
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
  });
  if (response.status === 401) {
    writeAccount(null);
    throw new Error("Spotify rejected the session; reconnect your account.");
  }
  if (!response.ok) {
    throw new Error(`Spotify request failed (${response.status})`);
  }
  return (await response.json()) as T;
}

function toTrack(entry: SpotifyApiTrack): ClientImportedTrack | null {
  // Playlist entries wrap the track; saved-track entries are flat objects.
  const track = entry.track ?? entry;
  if (!track || track.is_local) return null;
  const title = track.name?.trim();
  const artists = (track.artists ?? [])
    .map((artist) => artist.name?.trim() ?? "")
    .filter(Boolean);
  if (!title || artists.length === 0) return null;

  const cover = track.album?.images?.[0]?.url;
  return {
    // Spotify ids are the stable cross-reference for matching.
    sourceId: track.id ?? `${title}:${artists.join(",")}`,
    title,
    artists,
    ...(track.album?.name ? { album: track.album.name } : {}),
    ...(track.duration_ms ? { durationMs: track.duration_ms } : {}),
    ...(cover ? { coverUrl: cover } : {}),
  };
}

async function readAllPages<T>(firstPath: string): Promise<T[]> {
  const items: T[] = [];
  let next: string | null = firstPath;
  let pages = 0;
  while (next && pages < MAX_PAGES) {
    const page: SpotifyPage<T> = await spotifyGet<SpotifyPage<T>>(next);
    items.push(...(page.items ?? []));
    next = page.next ?? null;
    pages += 1;
  }
  if (next) log("yellow", "import", `spotify: stopped paging after ${MAX_PAGES} pages`);
  return items;
}

interface RawPlaylist {
  id?: string;
  name?: string;
  description?: string;
  tracks?: { total?: number };
  owner?: { display_name?: string };
  public?: boolean;
}

export async function listSpotifyPlaylists(): Promise<SpotifyAccountPlaylist[]> {
  const playlists = await readAllPages<RawPlaylist>("/me/playlists?limit=50");

  return playlists.flatMap((playlist) => {
    if (!playlist.id) return [];
    const id = playlist.id;
    return [
      {
        id,
        name: playlist.name?.trim() || "Untitled playlist",
        ...(playlist.description?.trim() ? { description: playlist.description.trim() } : {}),
        trackCount: playlist.tracks?.total ?? 0,
        ...(playlist.owner?.display_name ? { ownerName: playlist.owner.display_name } : {}),
        isPublic: Boolean(playlist.public),
      },
    ];
  });
}

export async function importSpotifyAccountPlaylist(
  playlistId: string,
  playlistName?: string,
): Promise<ClientImportedPlaylist> {
  const entries = await readAllPages<SpotifyApiTrack>(
    `/playlists/${encodeURIComponent(playlistId)}/tracks?limit=100&market=from_token`,
  );
  const tracks = entries
    .map(toTrack)
    .filter((track): track is ClientImportedTrack => track !== null);

  if (tracks.length === 0) {
    throw new Error("That playlist has no importable tracks.");
  }
  return {
    source: "spotify",
    sourceUrl: `https://open.spotify.com/playlist/${playlistId}`,
    title: playlistName?.trim() || "Imported Spotify playlist",
    tracks,
  };
}

/** Liked songs, as a playlist-shaped import so it flows through the same path. */
export async function importSpotifyLikedSongs(): Promise<ClientImportedPlaylist> {
  const entries = await readAllPages<SpotifyApiTrack>("/me/tracks?limit=50");
  const tracks = entries
    .map(toTrack)
    .filter((track): track is ClientImportedTrack => track !== null);

  if (tracks.length === 0) {
    throw new Error("No liked songs were found on that account.");
  }
  return {
    source: "spotify",
    sourceUrl: "https://open.spotify.com/collection/tracks",
    title: "Spotify liked songs",
    tracks,
  };
}
