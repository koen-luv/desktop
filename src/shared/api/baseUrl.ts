/**
 * The backend in this repository (`api-worker/`) is the only API the app talks
 * to. `wrangler.toml` names the Worker `liner-api`, so a deploy lands at
 * `https://liner-api.<account>.workers.dev`; this is the account the release
 * workflow builds against. Point `VITE_API_URL` at your own deploy (or at
 * `http://localhost:8787` while running `pnpm dev:api`) to change it without
 * touching code.
 */
export const SELF_HOSTED_API = "https://liner-api.lucabatarcian.workers.dev";

/** @deprecated Upstream hosted API. Kept only as a reference; not used. */
export const UPSTREAM_HOSTED_API = "https://api.tryliner.fun";

export const DEFAULT_PRIMARY_API = SELF_HOSTED_API;

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function isSecureBaseUrl(url: string): boolean {
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === "https:" || (protocol === "http:" && LOOPBACK_HOSTS.has(hostname));
  } catch {
    return false;
  }
}

export function resolveApiBaseUrl(envUrl: string | undefined): string {
  const clean = envUrl?.trim().replace(/\/+$/, "");
  return clean && isSecureBaseUrl(clean) ? clean : DEFAULT_PRIMARY_API;
}

const baseUrl = resolveApiBaseUrl(import.meta.env.VITE_API_URL as string | undefined);

export function getApiBaseUrl(): string {
  return baseUrl;
}
