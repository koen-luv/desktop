import { BotGuardClient } from "bgutils-js/botguard";
import { WebPoMinter } from "bgutils-js/webpo";
import { getApiBaseUrl } from "@/shared/api/baseUrl";
import { log } from "@/shared/utils/logger";

/**
 * Browser-side PO token minting.
 *
 * This is the website port of `electron/potoken-preload.ts`: YouTube rejects
 * anonymous datacenter traffic ("Sign in to confirm you're not a bot"), and the
 * desktop app answers that with a PO token minted from the BotGuard VM. A tab
 * cannot fetch the challenge, the interpreter script or GenerateIT directly
 * (all cross-origin), so the app's own API relays those three calls and the VM
 * runs here.
 *
 * The token is bound to the video id it was minted for, so tokens are cached per
 * track and dropped when the minter expires.
 */

const REQUEST_KEY = "O43z0dpjhgX20SCx4KAo";
const REFRESH_MARGIN_MS = 10 * 60 * 1000;
const DEFAULT_TTL_SECONDS = 6 * 60 * 60;
const WEB_CLIENT_VERSION = "2.20250925.01.00";
const MAX_CACHED_TOKENS = 24;

interface MinterEntry {
  minter: WebPoMinter;
  expiresAt: number;
}

interface BgChallenge {
  interpreterUrl?: { privateDoNotAccessOrElseTrustedResourceUrlWrappedValue?: string };
  program?: string;
  globalName?: string;
}

export interface PoTokenBundle {
  poToken: string;
  visitorData?: string;
}

let minter: MinterEntry | null = null;
let minterPending: Promise<MinterEntry> | null = null;
const tokenCache = new Map<string, string>();

function relayUrl(path: string): string {
  return `${getApiBaseUrl()}${path}`;
}

async function fetchChallenge(): Promise<{ interpreterUrl: string; program: string; globalName: string }> {
  const response = await fetch(relayUrl("/v1/yt/att"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      context: { client: { clientName: "WEB", clientVersion: WEB_CLIENT_VERSION, hl: "en", gl: "US" } },
      engagementType: "ENGAGEMENT_TYPE_UNBOUND",
    }),
  });
  if (!response.ok) throw new Error(`att relay returned ${response.status}`);
  const challenge = ((await response.json()) as { bgChallenge?: BgChallenge }).bgChallenge;
  const interpreterUrl = challenge?.interpreterUrl?.privateDoNotAccessOrElseTrustedResourceUrlWrappedValue;
  if (!interpreterUrl || !challenge?.program || !challenge.globalName) {
    throw new Error("BotGuard challenge is missing");
  }
  return { interpreterUrl, program: challenge.program, globalName: challenge.globalName };
}

async function fetchInterpreter(interpreterUrl: string): Promise<string> {
  const url = `${relayUrl("/v1/yt/interpreter")}?u=${encodeURIComponent(
    interpreterUrl.startsWith("http") ? interpreterUrl : `https:${interpreterUrl}`,
  )}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`interpreter relay returned ${response.status}`);
  return response.text();
}

async function createMinter(): Promise<MinterEntry> {
  const { interpreterUrl, program, globalName } = await fetchChallenge();
  const script = await fetchInterpreter(interpreterUrl);
  // The BotGuard interpreter expects to be evaluated in the current realm; this
  // is the same step the desktop preload performs.
  new Function(script)();

  const botguard = await BotGuardClient.create({ program, globalName, globalObject: globalThis });
  const webPoSignalOutput: Parameters<typeof WebPoMinter.create>[1] = [];
  const botguardResponse = await botguard.snapshot({ webPoSignalOutput });

  const response = await fetch(relayUrl("/v1/yt/generate-it"), {
    method: "POST",
    headers: { "content-type": "application/json+protobuf" },
    body: JSON.stringify([REQUEST_KEY, botguardResponse]),
  });
  if (!response.ok) throw new Error(`integrity relay returned ${response.status}`);
  const [integrityToken, ttlSeconds] = (await response.json()) as [string | null, number?];
  if (!integrityToken) throw new Error("integrity relay returned no token");

  const webPoMinter = await WebPoMinter.create({ integrityToken }, webPoSignalOutput);
  const ttlMs =
    (typeof ttlSeconds === "number" && ttlSeconds > 0 ? ttlSeconds : DEFAULT_TTL_SECONDS) * 1000;
  return { minter: webPoMinter, expiresAt: Date.now() + Math.max(ttlMs - REFRESH_MARGIN_MS, 60_000) };
}

async function getMinter(): Promise<MinterEntry> {
  if (minter && Date.now() < minter.expiresAt) return minter;
  if (!minterPending) {
    minterPending = createMinter()
      .then((entry) => {
        minter = entry;
        tokenCache.clear();
        return entry;
      })
      .catch((error) => {
        minter = null;
        throw error;
      })
      .finally(() => {
        minterPending = null;
      });
  }
  return minterPending;
}

/**
 * Mints (or returns a cached) PO token for a video id. Returns `null` when
 * minting is impossible — callers then let the backend attempt the request
 * without integrity data rather than failing the track outright.
 */
export async function mintPoToken(videoId: string): Promise<PoTokenBundle | null> {
  if (!videoId) return null;

  const cached = tokenCache.get(videoId);
  if (cached) return { poToken: cached };

  try {
    const entry = await getMinter();
    const token = await entry.minter.mintAsWebsafeString(videoId);
    if (!token) return null;
    tokenCache.set(videoId, token);
    if (tokenCache.size > MAX_CACHED_TOKENS) {
      const oldest = tokenCache.keys().next().value;
      if (oldest) tokenCache.delete(oldest);
    }
    return { poToken: token };
  } catch (error) {
    log(
      "yellow",
      "playback",
      `PO token minting failed (${error instanceof Error ? error.message : String(error)}); resolving without integrity data`,
    );
    return null;
  }
}

/** Test hook: forget the minter and every minted token. */
export function resetPoTokenCache(): void {
  minter = null;
  minterPending = null;
  tokenCache.clear();
}
