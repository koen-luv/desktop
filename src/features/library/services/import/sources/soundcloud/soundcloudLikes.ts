import { asArray, asRecord, type JsonRecord } from "@/shared/media/innertube/innertubeJson";
import { stringValue } from "../../shared/fields";
import { SOUNDCLOUD_API } from "@/shared/media/soundcloud";
import type { SoundCloudCollection } from "./soundcloudCollection";

const MAX_LIKES_PAGES = 20;

export function isSoundCloudUserEntity(body: JsonRecord, isLikesUrl: boolean): boolean {
  return body.kind === "user" || isLikesUrl || (typeof body.id === "number" && !body.tracks);
}

function likedTrack(item: unknown): JsonRecord | undefined {
  const record = asRecord(item);
  return asRecord(record?.track) ?? (record?.kind === "track" ? record : undefined);
}

function nextLikesUrl(nextHref: unknown, clientId: string): string | null {
  const href = stringValue(nextHref);
  if (!href?.trim()) return null;
  const url = new URL(href);
  url.searchParams.set("client_id", clientId);
  return url.toString();
}

export async function collectSoundCloudLikes(
  body: JsonRecord,
  fallbackUsername: string,
  clientId: string,
  collection: SoundCloudCollection,
  signal?: AbortSignal,
): Promise<void> {
  const username = stringValue(body.username) ?? fallbackUsername;
  collection.title = `${username} — Likes`;
  collection.description = `Liked tracks from SoundCloud user ${username}`;

  let nextUrl: string | null = `${SOUNDCLOUD_API}/users/${String(body.id)}/likes?limit=50&client_id=${clientId}`;
  let pageCount = 0;
  while (nextUrl && pageCount < MAX_LIKES_PAGES) {
    pageCount += 1;
    const response = await fetch(nextUrl, { signal });
    if (!response.ok) break;
    const likesBody = asRecord((await response.json()) as unknown);
    for (const item of asArray(likesBody?.collection)) {
      const track = likedTrack(item);
      if (track) collection.rawTracks.push(track);
    }
    nextUrl = nextLikesUrl(likesBody?.next_href, clientId);
  }
}
