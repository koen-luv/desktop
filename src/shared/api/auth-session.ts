import type { AuthTokens, AuthUser } from "../contracts";
import { syncServerTime } from "./serverTime";

export type { AuthTokens, AuthUser };

import { getApiBaseUrl } from "./baseUrl";
 
const STORAGE_KEY = "liner_auth_session";

let session: AuthTokens | null = null;
let refreshPromise: Promise<AuthTokens | null> | null = null;

function load(): AuthTokens | null {
  if (typeof window === "undefined") return null;
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value ? (JSON.parse(value) as AuthTokens) : null;
  } catch {
    return null;
  }
}

function emit() {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event("auth:changed"));
  }
}

export function getAuthSession(): AuthTokens | null {
  if (!session) session = load();
  return session;
}

// another window of this app (or a previous launch that finished a refresh)
// may rotate the tokens in storage; keep the in-memory copy in step so we never
// refresh with a token that has already been used
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key !== STORAGE_KEY) return;
    session = load();
    emit();
  });
}

export function setAuthSession(next: AuthTokens | null): void {
  session = next;
  if (typeof window !== "undefined") {
    if (next) localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    else localStorage.removeItem(STORAGE_KEY);
  }
  emit();
}

export function getAccessToken(): string | null {
  return getAuthSession()?.accessToken ?? null;
}

/**
 * Returns the timestamp in milliseconds when the access token expires,
 * or null if unknown.
 */
export function getSessionExpiryMs(s: AuthTokens | null): number | null {
  if (!s) return null;
  if (s.accessTokenExpiresAt) {
    const t =
      typeof s.accessTokenExpiresAt === "number"
        ? s.accessTokenExpiresAt
        : new Date(s.accessTokenExpiresAt).getTime();
    if (!isNaN(t) && t > 0) {
      // If t is in seconds (e.g. 10-digit unix timestamp), convert to ms
      return t < 10_000_000_000 ? t * 1000 : t;
    }
  }
  if (s.expiresAt) {
    const t =
      typeof s.expiresAt === "number"
        ? s.expiresAt < 10_000_000_000
          ? s.expiresAt * 1000
          : s.expiresAt
        : new Date(s.expiresAt).getTime();
    if (!isNaN(t) && t > 0) return t;
  }
  return null;
}

/**
 * Returns a valid access token. If a refresh is already in progress, awaits it.
 * If the current access token is about to expire (< 120s) or already expired,
 * proactively triggers a single atomic session refresh and returns the fresh access token.
 */
export async function getValidAccessToken(): Promise<string | null> {
  // If a refresh is ALREADY in flight, await it to prevent concurrent requests from using stale tokens
  if (refreshPromise) {
    const refreshed = await refreshPromise;
    return refreshed?.accessToken ?? getAuthSession()?.accessToken ?? null;
  }

  const current = getAuthSession();
  if (!current?.accessToken) return null;

  const expiresAtMs = getSessionExpiryMs(current);
  // If token expiry is known and expires in less than 2 minutes (120s), proactively refresh
  if (expiresAtMs !== null && expiresAtMs - Date.now() < 120_000) {
    const refreshed = await refreshAuthSession();
    if (refreshed?.accessToken) return refreshed.accessToken;
    // If refresh failed (e.g. transient network glitch), but token is still within validity window,
    // fallback to current token rather than failing immediately
    if (expiresAtMs > Date.now()) return current.accessToken;
    return null;
  }

  return current.accessToken;
}

/**
 * Performs a mutex-locked atomic refresh of the auth session.
 * Guaranteed to only initiate one in-flight refresh request across all parallel callers.
 */
export function refreshAuthSession(): Promise<AuthTokens | null> {
  if (refreshPromise) {
    return refreshPromise;
  }

  const current = getAuthSession();
  if (!current?.refreshToken) {
    return Promise.resolve(null);
  }

  // Synchronously assign the promise to immediately lock out any concurrent callers
  refreshPromise = (async () => {
    try {
      let response = await postRefresh(current.refreshToken);

      if (response.status === 401 || response.status === 403) {
        // 1) the token may already have been rotated elsewhere (another window,
        //    or a refresh that finished just before a reload): adopt it
        const rotated = rotatedElsewhere(current.refreshToken);
        if (rotated) return rotated;
        // 2) a rejected signature / timestamp is also a 401. postRefresh has just
        //    re-synced the clock from this response's Date header, so one fresh,
        //    re-signed attempt tells a bad signature apart from a dead token
        const firstReason = await describeRejection(response);
        response = await postRefresh(current.refreshToken);
        if (response.status === 401 || response.status === 403) {
          const again = rotatedElsewhere(current.refreshToken);
          if (again) return again;
          const reason = await describeRejection(response);
          // only now is the refresh token really dead: sign out, and say why in the log
          console.warn(
            `[Auth] signed out: refresh rejected twice (${firstReason}; ${reason})`,
          );
          const latest = getAuthSession();
          if (latest?.refreshToken === current.refreshToken) {
            setAuthSession(null);
          }
          return null;
        }
      }

      if (!response.ok) {
        // 5xx / 429 / anything transient: keep the session, try again later
        console.warn(`[Auth] refresh failed with ${response.status}, keeping the session`);
        return null;
      }

      const next = (await response.json()) as AuthTokens;
      // Preserve existing user info and metadata
      const merged: AuthTokens = {
        ...current,
        ...next,
        user: next.user || current.user,
      };

      setAuthSession(merged);
      return merged;
    } catch (err) {
      console.error("[Auth] refreshAuthSession request failed:", err);
      return null;
    } finally {
      refreshPromise = null;
    }
  })();

  return refreshPromise;
}

async function postRefresh(refreshToken: string): Promise<Response> {
  const body = JSON.stringify({ refreshToken });
  const response = await fetch(`${getApiBaseUrl()}/v1/auth/refresh`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body,
  });
  const dateHeader = response.headers?.get?.("date");
  if (dateHeader) {
    syncServerTime(dateHeader);
  }
  return response;
}

/** a newer session (different refresh token) saved by someone else, if any */
function rotatedElsewhere(usedRefreshToken: string): AuthTokens | null {
  const stored = load();
  if (stored?.refreshToken && stored.refreshToken !== usedRefreshToken) {
    session = stored;
    emit();
    return stored;
  }
  return null;
}

async function describeRejection(response: Response): Promise<string> {
  try {
    const data = (await response.clone?.().json?.()) as Record<string, unknown> | undefined;
    const code = typeof data?.code === "string" ? data.code : "";
    const message =
      typeof data?.message === "string" ? data.message : typeof data?.error === "string" ? data.error : "";
    return [String(response.status), code, message].filter(Boolean).join(" ");
  } catch {
    return String(response.status);
  }
}

export async function clearAuthSession(): Promise<void> {
  let current = getAuthSession();
  const expiryMs = getSessionExpiryMs(current);
  if (current && expiryMs !== null && expiryMs <= Date.now()) {
    current = (await refreshAuthSession()) ?? current;
  }
  setAuthSession(null);
  if (!current?.refreshToken) return;
  const body = JSON.stringify({ refreshToken: current.refreshToken });
  const response = await fetch(`${getApiBaseUrl()}/v1/auth/logout`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${current.accessToken}`,
    },
    body,
  }).catch(() => undefined);
  if (response?.headers) {
    const logoutDate = response.headers?.get?.("date");
    if (logoutDate) syncServerTime(logoutDate);
  }
}
