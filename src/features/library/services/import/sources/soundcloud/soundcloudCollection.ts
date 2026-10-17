import type { JsonRecord } from "@/shared/utils/json";

export interface SoundCloudCollection {
  title: string;
  description?: string;
  rawTracks: JsonRecord[];
}

export function createSoundCloudCollection(): SoundCloudCollection {
  return { title: "Imported SoundCloud playlist", rawTracks: [] };
}
