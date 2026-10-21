import { executePlaybackEndpoint, InnertubePlanError, type ExecutedInnertubeStream } from "./innertube";
import { getClientVisitorData } from "./visitorSession";

/**
 * Client-side Innertube extraction — the same technique yt-dlp uses.
 *
 * Instead of asking Liner's backend for a playback plan, the client builds and
 * executes the Innertube `player` request itself. These clients return *direct*
 * (unciphered) streaming URLs, so no signature deciphering is needed. Because
 * no Liner backend is involved, playback keeps working even when
 * `api.tryliner.fun` is down.
 *
 * The VISIONOS client goes first because of how googlevideo treats its URLs:
 * ANDROID/IOS URLs reject every request without a bounded Range header
 * (`bytes=0-`, open-ended ranges and plain GETs all answer 403) and cap a URL
 * at 1 MiB of served bytes, which ExoPlayer can never satisfy — it opens
 * progressive media with `Range: bytes=0-`. VISIONOS URLs accept all of those
 * request styles, so full tracks stream normally. ANDROID/IOS remain as
 * best-effort fallbacks (e.g. made-for-kids videos, which VISIONOS refuses).
 *
 * The VISIONOS player request is bot-checked: without a `visitorData` session
 * it answers `LOGIN_REQUIRED` ("Sign in to confirm you're not a bot"), so the
 * client's own residential-IP visitor session (visitorSession.ts) is attached
 * to both the request body and the `X-Goog-Visitor-Id` header.
 */

const PLAYER_ENDPOINT = "https://youtubei.googleapis.com/youtubei/v1/player";

interface InnertubeClientConfig {
  name: "VISIONOS" | "ANDROID" | "IOS";
  /** Numeric X-Youtube-Client-Name value for this client. */
  clientName: number;
  clientVersion: string;
  userAgent: string;
  androidSdkVersion?: number;
  deviceMake?: string;
  deviceModel?: string;
  osName?: string;
  osVersion?: string;
  /** Include `playbackContext.contentPlaybackContext.html5Preference`. */
  wantsPlaybackContext?: boolean;
  /** This client rejects requests that carry no visitorData session. */
  requiresVisitorData?: boolean;
}

/**
 * YouTube rejects obsolete Innertube client versions with HTTP 400
 * (`FAILED_PRECONDITION` / "Precondition check failed"), which kills client-side
 * extraction entirely. These versions are verified to return direct (unciphered)
 * `googlevideo.com` URLs, so no signature deciphering is needed; bump them when
 * YouTube rotates versions.
 */
const CLIENTS: InnertubeClientConfig[] = [
  {
    name: "VISIONOS",
    clientName: 101,
    clientVersion: "1.02",
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 15_7_3) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15",
    deviceMake: "Apple",
    deviceModel: "RealityDevice17,1",
    osName: "visionOS",
    osVersion: "26.5.23O471",
    wantsPlaybackContext: true,
    requiresVisitorData: true,
  },
  {
    name: "ANDROID",
    clientName: 3,
    clientVersion: "20.10.38",
    userAgent: "com.google.android.youtube/20.10.38 (Linux; U; Android 14) gzip",
    androidSdkVersion: 34,
  },
  {
    name: "IOS",
    clientName: 5,
    clientVersion: "20.10.37",
    userAgent: "com.google.ios.youtube/20.10.37 (iPhone16,2; U; CPU iOS 17_5_1 like Mac OS X)",
    deviceModel: "iPhone16,2",
    osName: "iPhone",
    osVersion: "17.5.1.21F90",
  },
];

function buildPlayerPlan(
  videoId: string,
  client: InnertubeClientConfig,
  preferredCodec?: "aac" | "opus",
  visitorData?: string,
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
  if (client.deviceMake !== undefined) {
    clientContext.deviceMake = client.deviceMake;
  }
  if (client.deviceModel !== undefined) {
    clientContext.deviceModel = client.deviceModel;
  }
  if (client.osName !== undefined) {
    clientContext.osName = client.osName;
  }
  if (client.osVersion !== undefined) {
    clientContext.osVersion = client.osVersion;
  }
  // The visionos client answers LOGIN_REQUIRED when the request carries no
  // visitor session, so the token travels in the body context as well.
  if (visitorData) {
    clientContext.visitorData = visitorData;
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
      ...(client.wantsPlaybackContext
        ? { playbackContext: { contentPlaybackContext: { html5Preference: "HTML5_PREF_WANTS" } } }
        : {}),
      contentCheckOk: true,
      racyCheckOk: true,
    },
    visitorData,
    preferredCodec,
  };
}

export interface InnertubeClientResult extends ExecutedInnertubeStream {
  /** Which Innertube client produced the stream. */
  client: string;
}

/**
 * Resolves a playable audio stream for a YouTube `videoId` by executing the
 * Innertube `player` request directly from the client. Tries VISIONOS first
 * (its URLs stream without Range restrictions), then falls back to ANDROID and
 * IOS. Throws `InnertubePlanError` (with an HTTP-like `status`) when no client
 * can serve the video.
 */
export async function extractAudioStream(
  videoId: string,
  preferredCodec?: "aac" | "opus",
  signal?: AbortSignal,
): Promise<InnertubeClientResult> {
  let lastError: unknown = null;
  // Usually already warm from initClientVisitorSession() at boot.
  let visitorData = "";

  for (const client of CLIENTS) {
    try {
      let clientVisitor: string | undefined;
      if (client.requiresVisitorData) {
        if (!visitorData) {
          visitorData = await getClientVisitorData().catch(() => "");
        }
        clientVisitor = visitorData || undefined;
      }
      const plan = buildPlayerPlan(videoId, client, preferredCodec, clientVisitor);
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
