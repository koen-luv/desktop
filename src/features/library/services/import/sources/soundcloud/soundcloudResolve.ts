import { asArray, asRecord, isRecord, trimmedString } from "@/shared/utils/json";
import { rethrowIfAborted } from "@/shared/utils/abort";
import { rememberSoundCloudClientId, SOUNDCLOUD_API } from "@/shared/media/soundcloud";
import type { SoundCloudCollection } from "./soundcloudCollection";
import { collectSoundCloudLikes, isSoundCloudUserEntity } from "./soundcloudLikes";
import { isSoundCloudLikesUrl, soundCloudPathParts } from "./soundcloudUrl";

async function resolveWithClientId(
  canonicalUrl: string,
  clientId: string,
  collection: SoundCloudCollection,
  signal?: AbortSignal,
): Promise<boolean> {
  const endpoint = new URL(`${SOUNDCLOUD_API}/resolve`);
  endpoint.searchParams.set("url", canonicalUrl);
  endpoint.searchParams.set("client_id", clientId);
  const response = await fetch(endpoint.toString(), { signal });
  if (!response.ok) return false;
  const body = asRecord((await response.json()) as unknown);

  if (body && isSoundCloudUserEntity(body, isSoundCloudLikesUrl(canonicalUrl))) {
    await collectSoundCloudLikes(body, soundCloudPathParts(canonicalUrl)[0], clientId, collection, signal);
    if (collection.rawTracks.length > 0) return true;
  }

  const title = trimmedString(body?.title);
  const description = trimmedString(body?.description);
  if (title) collection.title = title;
  if (description) collection.description = description;
  collection.rawTracks.push(...asArray(body?.tracks).filter(isRecord));
  return collection.rawTracks.length > 0;
}

export async function resolveSoundCloudApi(
  canonicalUrl: string,
  clientIds: string[],
  collection: SoundCloudCollection,
  signal?: AbortSignal,
): Promise<void> {
  for (const clientId of clientIds) {
    try {
      if (await resolveWithClientId(canonicalUrl, clientId, collection, signal)) {
        rememberSoundCloudClientId(clientId);
        return;
      }
    } catch {
      rethrowIfAborted(signal);
    }
  }
}
