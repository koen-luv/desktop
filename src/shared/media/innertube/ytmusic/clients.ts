/**
 * YouTube Music playback client catalog — the InnerTubeX/Metrolist approach.
 *
 * Each entry describes one Innertube `player` identity together with everything
 * the extractor must know about it: how the request is built (signature
 * timestamp, PO tokens), what kind of stream URLs it returns (direct vs.
 * signature-ciphered), and which HTTP headers the media request needs.
 *
 * The catalog follows Metrolist's `PlaybackClientCatalog`: stable clients first
 * (WEB_REMIX is the YouTube Music workhorse), then the direct-URL mobile
 * clients this app has historically used (VISIONOS, ANDROID_VR, ANDROID, IOS),
 * then experimental identities as a last resort. Known-broken clients are kept
 * only as tail fallbacks so a rotation on YouTube's side heals without an app
 * release — the health tracker cools them down after their first failure.
 */

/** How a PO token must be bound when it is used. */
export type PoTokenBindingKind =
  /** No PO token involved. */
  | "none"
  /** Bound to the visitorData session (player-request attestation). */
  | "visitor"
  /** Bound to the videoId (GVS media attestation, travels as `pot=`). */
  | "video";

/** How the client's stream URLs arrive. */
export type YtUrlStyle =
  /** Formats carry a playable `url` directly. */
  | "direct"
  /** Formats carry `signatureCipher`/`cipher` and must be deciphered. */
  | "cipher";

export interface YtMusicClientConfig {
  /** Stable id, also used in diagnostics and health tracking. */
  id: string;
  label: string;
  /** `X-Youtube-Client-Name` / `context.client.clientName`. */
  clientName: string;
  clientVersion: string;
  /** Numeric client id sent as `X-Youtube-Client-Name`. */
  clientIdHeader: string;
  userAgent: string;
  /** Media-request origin/referer (web clients only). */
  origin?: string;
  referer?: string;
  /** PO token binding for `serviceIntegrityDimensions.poToken` on the player request. */
  playerPoToken: PoTokenBindingKind;
  /** Video-bound PO token appended to the media URL as `pot=`. */
  gvsPoToken: "none" | "optional" | "required";
  /** Include `playbackContext.contentPlaybackContext.html5Preference`. */
  wantsPlaybackContext: boolean;
  /** Include `signatureTimestamp` (required by ciphered/JS-driven clients). */
  wantsSignatureTimestamp: boolean;
  /** The kind of stream URLs this client returns. */
  urlStyle: YtUrlStyle;
  /** googlevideo refuses open-ended requests for this client's URLs. */
  boundedRangeOnly: boolean;
  /** This client answers LOGIN_REQUIRED without a visitor session. */
  requiresVisitorData?: boolean;
  /** Extra fields merged into `context.client`. */
  extraContext?: Record<string, unknown>;
  /** Higher priority clients are attempted first. */
  priority: number;
}

const WEB_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

/**
 * Alternative client configurations, ordered intent-first. Versions match the
 * identities verified by the InnerTubeX catalog (see Metrolist docs/innertube.md).
 */
export const YT_MUSIC_CLIENTS: readonly YtMusicClientConfig[] = [
  {
    // The YouTube Music web client. Ciphered URLs (deciphered + n-transformed
    // by the cipher service), GVS URLs need the video-bound PO token.
    id: "WEB_REMIX",
    label: "YouTube Music (WEB_REMIX)",
    clientName: "WEB_REMIX",
    clientVersion: "1.20260707.12.00",
    clientIdHeader: "67",
    userAgent: WEB_USER_AGENT,
    origin: "https://music.youtube.com",
    referer: "https://music.youtube.com/",
    playerPoToken: "none",
    gvsPoToken: "required",
    wantsPlaybackContext: true,
    wantsSignatureTimestamp: true,
    urlStyle: "cipher",
    boundedRangeOnly: false,
    priority: 100,
  },
  {
    // Historically the most reliable direct-URL client in this app: its URLs
    // accept plain GETs and open-ended ranges, so full tracks stream normally.
    id: "VISIONOS",
    label: "YouTube Music (visionOS)",
    clientName: "VISIONOS",
    clientVersion: "1.04",
    clientIdHeader: "101",
    userAgent:
      "com.google.visionos.youtube/1.04(RealityDevice17,1; U; CPU visionOS 26_6_0 like Mac OS X; en_US)",
    playerPoToken: "none",
    gvsPoToken: "none",
    wantsPlaybackContext: true,
    wantsSignatureTimestamp: false,
    urlStyle: "direct",
    boundedRangeOnly: false,
    requiresVisitorData: true,
    extraContext: {
      osName: "visionOS",
      osVersion: "26.6.0.23O770",
      deviceMake: "Apple",
      deviceModel: "RealityDevice17,1",
      platform: "MOBILE",
    },
    priority: 90,
  },
  {
    id: "ANDROID_VR",
    label: "YouTube Music (Android VR)",
    clientName: "ANDROID_VR",
    clientVersion: "1.65.10",
    clientIdHeader: "28",
    userAgent:
      "com.google.android.apps.youtube.vr.oculus/1.65.10 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip",
    playerPoToken: "none",
    gvsPoToken: "none",
    wantsPlaybackContext: false,
    wantsSignatureTimestamp: false,
    urlStyle: "direct",
    boundedRangeOnly: true,
    extraContext: {
      osName: "Android",
      osVersion: "12L",
      deviceMake: "Oculus",
      deviceModel: "Quest 3",
      androidSdkVersion: 32,
      buildId: "SQ3A.220605.009.A1",
      packageName: "com.google.android.apps.youtube.vr.oculus",
    },
    priority: 80,
  },
  {
    id: "ANDROID",
    label: "YouTube Music (Android)",
    clientName: "ANDROID",
    clientVersion: "20.10.38",
    clientIdHeader: "3",
    userAgent: "com.google.android.youtube/20.10.38 (Linux; U; Android 14) gzip",
    playerPoToken: "none",
    gvsPoToken: "none",
    wantsPlaybackContext: false,
    wantsSignatureTimestamp: false,
    urlStyle: "direct",
    boundedRangeOnly: true,
    extraContext: { androidSdkVersion: 34 },
    priority: 60,
  },
  {
    id: "IOS",
    label: "YouTube Music (iOS)",
    clientName: "IOS",
    clientVersion: "20.10.37",
    clientIdHeader: "5",
    userAgent: "com.google.ios.youtube/20.10.37 (iPhone16,2; U; CPU iOS 17_5_1 like Mac OS X)",
    playerPoToken: "none",
    gvsPoToken: "none",
    wantsPlaybackContext: false,
    wantsSignatureTimestamp: false,
    urlStyle: "direct",
    boundedRangeOnly: true,
    extraContext: { deviceModel: "iPhone16,2", osName: "iPhone", osVersion: "17.5.1.21F90" },
    priority: 50,
  },
  {
    // Experimental identities from the InnerTubeX catalog. They rotate between
    // working and HTTP 400 on YouTube's side, so they sit at the tail and the
    // health tracker cools them down after a single FAILED_PRECONDITION.
    id: "ANDROID_MUSIC",
    label: "YouTube Music (Android Music)",
    clientName: "ANDROID_MUSIC",
    clientVersion: "5.34.51",
    clientIdHeader: "21",
    userAgent: "com.google.android.apps.youtube.music/5.34.51 (Linux; U; Android 11) gzip",
    playerPoToken: "none",
    gvsPoToken: "none",
    wantsPlaybackContext: false,
    wantsSignatureTimestamp: false,
    urlStyle: "direct",
    boundedRangeOnly: true,
    extraContext: {
      osName: "Android",
      osVersion: "11",
      androidSdkVersion: 30,
    },
    priority: 10,
  },
  {
    id: "IOS_MUSIC",
    label: "YouTube Music (iOS Music)",
    clientName: "IOS_MUSIC",
    clientVersion: "7.27.0",
    clientIdHeader: "26",
    userAgent: "com.google.ios.youtubemusic/7.27.0 (iPhone16,2; U; CPU iOS 18_1_0 like Mac OS X;)",
    playerPoToken: "none",
    gvsPoToken: "none",
    wantsPlaybackContext: false,
    wantsSignatureTimestamp: false,
    urlStyle: "direct",
    boundedRangeOnly: true,
    extraContext: {
      deviceMake: "Apple",
      deviceModel: "iPhone16,2",
      osName: "iPhone",
      osVersion: "18.1.0.22B83",
      platform: "MOBILE",
    },
    priority: 5,
  },
];

export function findYtMusicClient(id: string): YtMusicClientConfig | undefined {
  return YT_MUSIC_CLIENTS.find((client) => client.id === id);
}

export type ClientFailureKind = "bot_check" | "stale_client" | "playability" | "network";

interface HealthEntry {
  failures: number;
  /** Client must not be tried again before this wall-clock time. */
  cooldownUntil: number;
}

/** Consecutive-failure threshold before a client is paused. */
const FAILURES_BEFORE_COOLDOWN = 2;
/** First cooldown window; doubles per additional failure cluster. */
const COOLDOWN_BASE_MS = 60_000;
const COOLDOWN_MAX_MS = 15 * 60_000;
/** A stale identity (HTTP 400 FAILED_PRECONDITION) is paused immediately. */
const STALE_CLIENT_COOLDOWN_MS = 10 * 60_000;

/**
 * Per-client reliability memory — the InnerTubeX `ClientHealthTracker` idea.
 *
 * Repeatedly failing clients (stale versions, bot walls, dead identities) are
 * paused for a while so extraction retries stop burning time and error lines on
 * them; a success clears the record. State is per-session and per-JS-realm.
 */
export class YtMusicClientHealth {
  private readonly entries = new Map<string, HealthEntry>();

  isAvailable(clientId: string, now = Date.now()): boolean {
    const entry = this.entries.get(clientId);
    return !entry || entry.cooldownUntil <= now;
  }

  recordSuccess(clientId: string): void {
    this.entries.delete(clientId);
  }

  recordFailure(clientId: string, kind: ClientFailureKind, now = Date.now()): void {
    const entry = this.entries.get(clientId) ?? { failures: 0, cooldownUntil: 0 };
    entry.failures += 1;
    if (kind === "stale_client") {
      entry.cooldownUntil = now + STALE_CLIENT_COOLDOWN_MS;
    } else if (entry.failures >= FAILURES_BEFORE_COOLDOWN) {
      const backoff = Math.min(COOLDOWN_BASE_MS * 2 ** (entry.failures - FAILURES_BEFORE_COOLDOWN), COOLDOWN_MAX_MS);
      entry.cooldownUntil = now + backoff;
    }
    this.entries.set(clientId, entry);
  }

  reset(): void {
    this.entries.clear();
  }
}

/** Shared session-level health state used by the extractor. */
export const ytMusicClientHealth = new YtMusicClientHealth();
