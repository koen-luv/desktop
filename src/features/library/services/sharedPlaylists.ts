import { getValidAccessToken } from "@/shared/api/auth-session";
import { api } from "@/shared/api";

export const SHARED_PLAYLIST_PREFIX = "shared:";
const DEFAULT_SHARED_PLAYLISTS_URL =
  "https://liner-shared-playlists.lucabatarcian.workers.dev";
const sharedPlaylistsUrl = (
  import.meta.env.VITE_SHARED_PLAYLISTS_URL as string | undefined
)?.trim().replace(/\/+$/, "") || DEFAULT_SHARED_PLAYLISTS_URL;
const isConfigured = Boolean(sharedPlaylistsUrl);

export function areSharedPlaylistsConfigured(): boolean {
  return isConfigured;
}

export interface SharedPlaylistMember {
  id: string;
  role: "owner" | "editor";
  username?: string | null;
  displayName?: string | null;
  avatarUrl?: string | null;
  addedAt: string;
}

export interface SharedPlaylistItem {
  id: string;
  track: Record<string, unknown>;
  position: number;
  addedBy: string;
  addedAt: string;
}

export interface SharedPlaylist {
  id: string;
  sourcePlaylistId: string;
  ownerId: string;
  title: string;
  description?: string | null;
  coverUrl?: string | null;
  createdAt: string;
  updatedAt: string;
  revision: number;
  role: "owner" | "editor";
  trackCount?: number;
  members?: SharedPlaylistMember[];
  items?: SharedPlaylistItem[];
}

export function isSharedPlaylistId(id: string): boolean {
  return id.startsWith(SHARED_PLAYLIST_PREFIX);
}

export function getSharedPlaylistId(id: string): string {
  return isSharedPlaylistId(id) ? id.slice(SHARED_PLAYLIST_PREFIX.length) : id;
}

async function sharedRequest<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  if (!isConfigured) {
    throw new Error(
      "Shared playlists are not configured for this app build. Deploy the playlist Worker and set VITE_SHARED_PLAYLISTS_URL.",
    );
  }
  const token = await getValidAccessToken();
  if (!token) throw new Error("Sign in to use collaborative playlists.");

  const response = await fetch(`${sharedPlaylistsUrl}${path}`, {
    ...init,
    headers: {
      ...(init.body ? { "content-type": "application/json" } : {}),
      authorization: `Bearer ${token}`,
      ...init.headers,
    },
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as
      | { error?: unknown }
      | null;
    const message =
      typeof body?.error === "string"
        ? body.error
        : `Collaborative playlist request failed (${response.status}).`;
    throw new Error(message);
  }
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

export async function listSharedPlaylists(): Promise<SharedPlaylist[]> {
  if (!isConfigured) return [];
  const response = await sharedRequest<{ items: SharedPlaylist[] }>("/playlists");
  return response.items;
}

export async function getSharedPlaylist(id: string): Promise<SharedPlaylist> {
  const response = await sharedRequest<{ playlist: SharedPlaylist }>(
    `/playlists/${encodeURIComponent(getSharedPlaylistId(id))}`,
  );
  return response.playlist;
}

export async function createSharedPlaylist(sourcePlaylistId: string): Promise<SharedPlaylist> {
  const response = await sharedRequest<{ playlist: SharedPlaylist }>("/playlists", {
    method: "POST",
    body: JSON.stringify({ sourcePlaylistId }),
  });
  return response.playlist;
}

export async function invitePlaylistCollaborator(
  playlistId: string,
  userId: string,
): Promise<SharedPlaylist> {
  const response = await sharedRequest<{ playlist: SharedPlaylist }>(
    `/playlists/${encodeURIComponent(getSharedPlaylistId(playlistId))}/collaborators`,
    { method: "POST", body: JSON.stringify({ userId }) },
  );
  return response.playlist;
}

export function removePlaylistCollaborator(
  playlistId: string,
  userId: string,
): Promise<void> {
  return sharedRequest<void>(
    `/playlists/${encodeURIComponent(getSharedPlaylistId(playlistId))}/collaborators/${encodeURIComponent(userId)}`,
    { method: "DELETE" },
  );
}

export function leaveSharedPlaylist(playlistId: string, userId: string): Promise<void> {
  return removePlaylistCollaborator(playlistId, userId);
}

export function deleteSharedPlaylist(playlistId: string): Promise<void> {
  return sharedRequest<void>(
    `/playlists/${encodeURIComponent(getSharedPlaylistId(playlistId))}`,
    { method: "DELETE" },
  );
}

export async function addSharedPlaylistTrack(
  playlistId: string,
  trackId: string,
): Promise<void> {
  const track = await api.getTrack(trackId);
  await sharedRequest(
    `/playlists/${encodeURIComponent(getSharedPlaylistId(playlistId))}/tracks`,
    { method: "POST", body: JSON.stringify({ track }) },
  );
}

export function removeSharedPlaylistTrack(
  playlistId: string,
  itemId: string,
): Promise<void> {
  return sharedRequest<void>(
    `/playlists/${encodeURIComponent(getSharedPlaylistId(playlistId))}/tracks/${encodeURIComponent(itemId)}`,
    { method: "DELETE" },
  );
}

export function moveSharedPlaylistTrack(
  playlistId: string,
  itemId: string,
  beforeItemId: string | null,
): Promise<void> {
  return sharedRequest<void>(
    `/playlists/${encodeURIComponent(getSharedPlaylistId(playlistId))}/tracks/${encodeURIComponent(itemId)}/move`,
    { method: "PATCH", body: JSON.stringify({ beforeItemId }) },
  );
}
