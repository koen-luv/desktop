import { asRecord } from "@/shared/media/innertube/innertubeJson";
import { tryFetchJson, tryFetchText } from "../../shared/http";

export interface SpotifyTotpSecret {
  secret: string;
  version: number;
}

export const FALLBACK_SPOTIFY_SECRET: SpotifyTotpSecret = {
  secret: ',7/*F("rLJ2oxaKL^f+E1xvP@N',
  version: 61,
};

export function extractSpotifySecret(js: string): SpotifyTotpSecret | undefined {
  const match = js.match(/\[\{secret:['"]([^'"]+)['"],version:(\d+)\}/);
  return match ? { secret: match[1], version: Number(match[2]) } : undefined;
}

export async function fetchSpotifySecret(signal?: AbortSignal): Promise<SpotifyTotpSecret> {
  const html = await tryFetchText("https://open.spotify.com/", { signal });
  const scriptMatch = html?.match(
    /src="(https:\/\/open\.spotifycdn\.com\/cdn\/build\/web-player\/web-player\.[a-f0-9]+\.js)"/,
  );
  if (!scriptMatch?.[1]) return FALLBACK_SPOTIFY_SECRET;
  const js = await tryFetchText(scriptMatch[1], { signal });
  return (js && extractSpotifySecret(js)) || FALLBACK_SPOTIFY_SECRET;
}

export async function fetchSpotifyServerTime(signal?: AbortSignal): Promise<number | null> {
  const data = asRecord(await tryFetchJson("https://open.spotify.com/api/server-time", { signal }));
  const serverTime = Number(data?.serverTime);
  return data && !Number.isNaN(serverTime) ? serverTime : null;
}
