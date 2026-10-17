import { asArray, asRecord, type JsonRecord } from "@/shared/media/innertube/innertubeJson";
import { rethrowIfAborted } from "../../shared/http";
import { rememberSoundCloudClientId, SOUNDCLOUD_API } from "@/shared/media/soundcloud";

const STUB_CHUNK_SIZE = 50;

function stubIds(rawTracks: JsonRecord[]): number[] {
  return rawTracks.flatMap((track) =>
    typeof track.id === "number" && typeof track.title !== "string" ? [track.id] : [],
  );
}

async function fetchChunk(
  chunkIds: number[],
  clientId: string,
  hydrated: Map<string, JsonRecord>,
  signal?: AbortSignal,
): Promise<boolean> {
  const endpoint = new URL(`${SOUNDCLOUD_API}/tracks`);
  endpoint.searchParams.set("ids", chunkIds.join(","));
  endpoint.searchParams.set("client_id", clientId);
  const response = await fetch(endpoint.toString(), { signal });
  if (!response.ok) return false;
  const data = asArray((await response.json()) as unknown).map(asRecord);
  for (const track of data) {
    if (track && typeof track.id === "number") hydrated.set(String(track.id), track);
  }
  return data.length > 0;
}

export async function hydrateSoundCloudStubs(
  rawTracks: JsonRecord[],
  clientIds: string[],
  signal?: AbortSignal,
): Promise<JsonRecord[]> {
  const ids = stubIds(rawTracks);
  const hydrated = new Map<string, JsonRecord>();
  for (let start = 0; start < ids.length; start += STUB_CHUNK_SIZE) {
    const chunkIds = ids.slice(start, start + STUB_CHUNK_SIZE);
    for (const clientId of clientIds) {
      try {
        if (await fetchChunk(chunkIds, clientId, hydrated, signal)) {
          rememberSoundCloudClientId(clientId);
          break;
        }
      } catch {
        rethrowIfAborted(signal);
      }
    }
  }
  return rawTracks.map((track) => (typeof track.id === "number" ? hydrated.get(String(track.id)) ?? track : track));
}
