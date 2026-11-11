import { getApiBaseUrl } from "@/shared/api/baseUrl";
import { getAuthSession } from "@/shared/api/auth-session";
import { log } from "@/shared/utils/logger";

/**
 * Stem separation client.
 *
 * The separation itself runs off-device (Demucs-class models need a GPU), so
 * this module is deliberately thin: ask the backend whether a separator is
 * configured, request stems for a track, and hand back signed URLs.
 *
 * Nothing here fabricates stems — when no service is configured the backend
 * answers `STEMS_UNAVAILABLE` and the caller hides the feature.
 */

export type StemName = "vocals" | "drums" | "bass" | "other";

export interface Stem {
  name: StemName;
  url: string;
}

export interface StemSeparationResult {
  trackId: string;
  stems: Stem[];
}

export class StemsUnavailableError extends Error {
  readonly code = "STEMS_UNAVAILABLE";
}

const STATUS_TTL_MS = 5 * 60 * 1000;

let statusCache: { available: boolean; at: number } | null = null;

async function authHeaders(): Promise<Record<string, string>> {
  const session = await getAuthSession();
  return {
    "content-type": "application/json",
    ...(session?.accessToken ? { authorization: `Bearer ${session.accessToken}` } : {}),
  };
}

/** Whether this deployment can separate stems (cached for a few minutes). */
export async function isStemSeparationAvailable(): Promise<boolean> {
  if (statusCache && Date.now() - statusCache.at < STATUS_TTL_MS) {
    return statusCache.available;
  }
  try {
    const response = await fetch(`${getApiBaseUrl()}/v1/stems/status`, {
      headers: await authHeaders(),
    });
    if (!response.ok) return false;
    const body = (await response.json()) as { available?: boolean };
    const available = Boolean(body.available);
    statusCache = { available, at: Date.now() };
    return available;
  } catch (error) {
    log(
      "yellow",
      "stems",
      `availability probe failed: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}

/** Test hook: forget the cached availability answer. */
export function resetStemsStatusCache(): void {
  statusCache = null;
}

/**
 * Requests separation for a track. `audioUrl` must be a URL the separation
 * service can fetch — the app passes the resolved playback URL, not the raw
 * page, so the service never has to scrape anything.
 */
export async function separateStems(
  trackId: string,
  audioUrl: string,
  signal?: AbortSignal,
): Promise<StemSeparationResult> {
  const response = await fetch(
    `${getApiBaseUrl()}/v1/tracks/${encodeURIComponent(trackId)}/stems`,
    {
      method: "POST",
      headers: await authHeaders(),
      body: JSON.stringify({ audioUrl }),
      signal,
    },
  );

  if (response.status === 501) {
    statusCache = { available: false, at: Date.now() };
    throw new StemsUnavailableError(
      "Stem separation is not configured on this server.",
    );
  }

  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { message?: string };
    throw new Error(body.message || `Stem separation failed (${response.status})`);
  }

  const payload = (await response.json()) as StemSeparationResult;
  return { trackId: payload.trackId ?? trackId, stems: payload.stems ?? [] };
}
