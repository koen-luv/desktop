import { executePlaybackEndpoint, InnertubePlanError, type ExecutedInnertubeStream } from "./innertube";

/**
 * Client-side Innertube extraction — the same technique yt-dlp uses.
 *
 * Instead of asking Liner's backend for a playback plan, the client builds and
 * executes the Innertube `player` request itself. The ANDROID and IOS Innertube
 * clients return *direct* (unciphered) streaming URLs, so no signature
 * deciphering is needed. Because no Liner backend is involved, playback keeps
 * working even when `api.tryliner.fun` is down.
 */

const PLAYER_ENDPOINT = "https://youtubei.googleapis.com/youtubei/v1/player";

interface InnertubeClientConfig {
  name: "ANDROID" | "IOS";
  /** Numeric X-Youtube-Client-Name value for this client. */
  clientName: number;
  clientVersion: string;
  userAgent: string;
  androidSdkVersion?: number;
}

const CLIENTS: InnertubeClientConfig[] = [
  {
    name: "ANDROID",
    clientName: 3,
    clientVersion: "19.09.37",
    userAgent: "com.google.android.youtube/19.09.37 (Linux; U; Android 14) gzip",
    androidSdkVersion: 34,
  },
  {
    name: "IOS",
    clientName: 5,
    clientVersion: "19.09.3",
    userAgent: "com.google.ios.youtube/19.09.3 (iPhone14,3; U; CPU iOS 17_0 like Mac OS X;)",
  },
];

function buildPlayerPlan(
  videoId: string,
  client: InnertubeClientConfig,
  preferredCodec?: "aac" | "opus",
) {
  const clientContext: Record<string, unknown> = {
    clientName: client.name,
    clientVersion: client.clientVersion,
    hl: "en",
    gl: "US",
  };
  if (client.androidSdkVersion !== undefined) {
    clientContext.androidSdkVersion = client.androidSdkVersion;
  }

  return {
    endpoint: PLAYER_ENDPOINT,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": client.userAgent,
      "X-Youtube-Client-Name": String(client.clientName),
      "X-Youtube-Client-Version": client.clientVersion,
    },
    body: {
      videoId,
      context: { client: clientContext },
      contentCheckOk: true,
      racyCheckOk: true,
    },
    preferredCodec,
  };
}

export interface InnertubeClientResult extends ExecutedInnertubeStream {
  /** Which Innertube client produced the stream. */
  client: string;
}

/**
 * Resolves a playable audio stream for a YouTube `videoId` by executing the
 * Innertube `player` request directly from the client. Tries ANDROID first
 * (direct URLs, no cipher) and falls back to IOS. Throws `InnertubePlanError`
 * (with an HTTP-like `status`) when no client can serve the video.
 */
export async function extractAudioStream(
  videoId: string,
  preferredCodec?: "aac" | "opus",
  signal?: AbortSignal,
): Promise<InnertubeClientResult> {
  let lastError: unknown = null;

  for (const client of CLIENTS) {
    try {
      const plan = buildPlayerPlan(videoId, client, preferredCodec);
      const result = await executePlaybackEndpoint(plan, signal);
      return { ...result, client: client.name };
    } catch (err) {
      // Cancellation must propagate; a per-client failure just tries the next.
      if (err instanceof DOMException && err.name === "AbortError") throw err;
      lastError = err;
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new InnertubePlanError("Innertube client extraction failed", 0);
}
