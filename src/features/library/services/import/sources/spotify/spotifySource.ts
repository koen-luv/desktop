import type { ClientImportedPlaylist, ClientImportedTrack } from "../../importTypes";
import { rethrowIfAborted } from "@/shared/utils/abort";
import { fetchSpotifyEmbed } from "./spotifyEmbed";
import { fetchSpotifyPlaylistTracks } from "./spotifyPathfinder";
import { parseSpotifyUrl, resolveSpotifyUrl, type SpotifyEntityType } from "./spotifyUrl";

function defaultTitle(entityType: SpotifyEntityType): string {
  if (entityType === "album") return "Imported Spotify album";
  if (entityType === "track") return "Imported Spotify track";
  return "Imported Spotify playlist";
}

async function tryPathfinder(entityId: string, signal?: AbortSignal): Promise<ClientImportedTrack[]> {
  try {
    return await fetchSpotifyPlaylistTracks(entityId, signal);
  } catch {
    rethrowIfAborted(signal);
    return [];
  }
}

export async function importSpotify(rawUrl: string, signal?: AbortSignal): Promise<ClientImportedPlaylist> {
  const resolvedUrl = await resolveSpotifyUrl(rawUrl, signal);
  const { type: entityType, id: entityId } = parseSpotifyUrl(resolvedUrl);
  const embed = await fetchSpotifyEmbed(entityType, entityId, defaultTitle(entityType), signal);
  const title = embed.title ?? defaultTitle(entityType);
  const base = {
    source: "spotify" as const,
    sourceUrl: rawUrl,
    title,
    ...(embed.description ? { description: embed.description } : {}),
  };

  if (entityType === "playlist") {
    const tracks = await tryPathfinder(entityId, signal);
    if (tracks.length > 0) return { ...base, tracks };
  }
  if (embed.tracks.length > 0) return { ...base, tracks: embed.tracks };
  throw new Error("No tracks found in the Spotify playlist.");
}
