import { md5 } from "./md5";

const LASTFM_API_URL = "https://ws.audioscrobbler.com/2.0/";

export interface LastfmCredentials {
  apiKey: string;
  apiSecret: string;
}

export interface LastfmSession {
  key: string;
  username: string;
}

export interface LastfmTrackInfo {
  artist: string;
  track: string;
  album?: string;
  /** Track length in milliseconds; Last.fm wants seconds on the wire. */
  durationMs?: number;
}

interface LastfmErrorBody {
  error: number;
  message: string;
}

/**
 * One signed POST per call: `api_sig` is md5 over every request parameter
 * (name + value, sorted by name) followed by the shared secret — the scheme
 * Last.fm documents for all authenticated methods.
 */
async function lastfmRequest<T>(params: Record<string, string>, apiSecret: string): Promise<T> {
  const signatureSource = Object.keys(params)
    .sort()
    .map((key) => `${key}${params[key]}`)
    .join("");
  const apiSig = md5(signatureSource + apiSecret);

  const body = new URLSearchParams({ ...params, api_sig: apiSig, format: "json" });
  const response = await fetch(LASTFM_API_URL, { method: "POST", body });
  const json = (await response.json()) as T & Partial<LastfmErrorBody>;
  if (json && typeof json.error === "number") {
    throw new Error(`Last.fm error ${json.error}: ${json.message || "unknown"}`);
  }
  return json;
}

/** Step 1 of the out-of-band auth flow: request a request token. */
export async function lastfmGetToken(creds: LastfmCredentials): Promise<string> {
  const result = await lastfmRequest<{ token?: string }>(
    { method: "auth.getToken", api_key: creds.apiKey },
    creds.apiSecret,
  );
  if (!result.token) throw new Error("Last.fm did not return an auth token");
  return result.token;
}

/** The page the user opens to grant the token access to their account. */
export function lastfmAuthorizeUrl(apiKey: string, token: string): string {
  return `https://www.last.fm/api/auth?api_key=${encodeURIComponent(apiKey)}&token=${encodeURIComponent(token)}`;
}

/** Step 2: exchange the authorized token for a long-lived session key. */
export async function lastfmGetSession(
  creds: LastfmCredentials,
  token: string,
): Promise<LastfmSession> {
  const result = await lastfmRequest<{ session?: { key?: string; name?: string } }>(
    { method: "auth.getSession", api_key: creds.apiKey, token },
    creds.apiSecret,
  );
  if (!result.session?.key) throw new Error("Last.fm did not return a session key");
  return { key: result.session.key, username: result.session.name || "" };
}

/** "Now playing" banner on the user's Last.fm profile. */
export async function lastfmUpdateNowPlaying(
  creds: LastfmCredentials,
  sessionKey: string,
  trackInfo: LastfmTrackInfo,
): Promise<void> {
  const params: Record<string, string> = {
    method: "track.updateNowPlaying",
    api_key: creds.apiKey,
    sk: sessionKey,
    artist: trackInfo.artist,
    track: trackInfo.track,
  };
  if (trackInfo.album) params.album = trackInfo.album;
  if (trackInfo.durationMs && trackInfo.durationMs > 0) {
    params.duration = String(Math.round(trackInfo.durationMs / 1000));
  }
  await lastfmRequest(params, creds.apiSecret);
}

/**
 * Scrobble a finished listen. `startedAtSeconds` is the unix time the track
 * started playing — Last.fm's documented `timestamp` field.
 */
export async function lastfmScrobble(
  creds: LastfmCredentials,
  sessionKey: string,
  trackInfo: LastfmTrackInfo,
  startedAtSeconds: number,
): Promise<void> {
  const params: Record<string, string> = {
    method: "track.scrobble",
    api_key: creds.apiKey,
    sk: sessionKey,
    artist: trackInfo.artist,
    track: trackInfo.track,
    timestamp: String(startedAtSeconds),
  };
  if (trackInfo.album) params.album = trackInfo.album;
  if (trackInfo.durationMs && trackInfo.durationMs > 0) {
    params.duration = String(Math.round(trackInfo.durationMs / 1000));
  }
  await lastfmRequest(params, creds.apiSecret);
}
