/**
 * PO token (proof-of-origin) minting facade for YouTube Music extraction.
 *
 * InnerTubeX separates two bindings, and YouTube enforces them separately:
 *
 *  - `video`-bound tokens attest GVS media requests and travel as `pot=` on the
 *    googlevideo URL. A video-bound token must never be reused for the player
 *    request (Metrolist docs/innertube.md).
 *  - `visitor`-bound tokens attest the player request itself
 *    (`serviceIntegrityDimensions.poToken`) when YouTube answers LOGIN_REQUIRED.
 *
 * Minting runs in the app shell (Electron BotGuard VM via
 * `window.neritiumElectron.mintPoToken`, or the browser relay in
 * `poTokenClient.ts`). Both minters accept an arbitrary binding string, so the
 * same pipeline serves both kinds. When no minter exists the extractor proceeds
 * tokenless — some clients still serve anonymous traffic.
 */

import { mintBoundPoToken as mintViaRelay } from "@/shared/media/innertube/poTokenClient";

export type YtPoTokenBinding = "video" | "visitor";

export interface YtPoTokenRequest {
  binding: YtPoTokenBinding;
  /** videoId for `video` binding, visitorData for `visitor` binding. */
  bindingKey: string;
}

const MAX_CACHED_TOKENS = 32;
const tokenCache = new Map<string, string>();

function cacheKey(request: YtPoTokenRequest): string {
  return `${request.binding}:${request.bindingKey}`;
}

/** Whether any PO token minter is wired up on this platform. */
export function canMintYtPoToken(): boolean {
  if (typeof window !== "undefined" && typeof window.neritiumElectron?.mintPoToken === "function") {
    return true;
  }
  return typeof window !== "undefined";
}

/**
 * Mints (or returns a cached) PO token for the given binding. Returns `null`
 * when minting is impossible or fails — callers then continue tokenless rather
 * than failing the track outright.
 */
export async function getYtPoToken(request: YtPoTokenRequest): Promise<string | null> {
  if (!request.bindingKey) return null;
  const key = cacheKey(request);
  const cached = tokenCache.get(key);
  if (cached) return cached;

  try {
    const mint =
      typeof window !== "undefined" ? window.neritiumElectron?.mintPoToken : undefined;
    const token = mint ? await mint(request.bindingKey) : (await mintViaRelay(request.bindingKey))?.poToken;
    if (!token) return null;
    tokenCache.set(key, token);
    if (tokenCache.size > MAX_CACHED_TOKENS) {
      const oldest = tokenCache.keys().next().value;
      if (oldest) tokenCache.delete(oldest);
    }
    return token;
  } catch {
    return null;
  }
}

/** Test hook: forget every minted token. */
export function resetYtPoTokenCache(): void {
  tokenCache.clear();
}
