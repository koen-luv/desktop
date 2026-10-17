import { asRecord, type JsonRecord, numberValue, stringValue } from "@/shared/utils/json";
import type { ClientImportedTrack } from "../../importTypes";
import { withoutArtistPrefix } from "../../shared/titles";

export function mapSoundCloudTrack(item: JsonRecord): ClientImportedTrack | undefined {
  const publisher = asRecord(item.publisher_metadata);
  const user = asRecord(item.user);
  const publisherArtist = stringValue(publisher?.artist);
  const artist = publisherArtist?.trim() ? publisherArtist.trim() : user?.username;
  const title = typeof item.title === "string" ? withoutArtistPrefix(item.title, publisherArtist) : undefined;
  if (typeof title !== "string" || typeof artist !== "string") return undefined;

  const artwork = stringValue(item.artwork_url)?.replace(/-large(?=\.[a-z]+$)/i, "-t500x500");
  const artistId = typeof user?.id === "number" ? `sc_user_${user.id}` : undefined;
  return {
    sourceId: String(item.id ?? ""),
    title,
    artists: [artist],
    artistIds: [artistId],
    album: stringValue(publisher?.release_title),
    durationMs: numberValue(item.duration),
    ...(artwork ? { coverUrl: artwork } : {}),
  };
}

export function soundCloudCanonicalId(sourceId: string): string {
  return sourceId.startsWith("sc:") ? sourceId : `sc:${sourceId}`;
}
