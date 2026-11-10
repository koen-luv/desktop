/**
 * What this client is allowed to do, independent of which shell hosts it.
 *
 * The website port installs a `window.neritiumElectron`-compatible shim, so
 * "a bridge object exists" no longer means "a native shell exists". Everything
 * that depends on calling third-party hosts directly must ask here instead of
 * probing `window` itself.
 */

interface ShellWindow {
  neritiumElectron?: { platform?: string };
  NeritiumAndroid?: unknown;
}

/**
 * True when the renderer may call YouTube hosts directly.
 *
 * Electron runs with web security relaxed and Android routes those hosts
 * through the native OkHttp bridge. A browser tab is blocked by CORS, so it must
 * go through the app's own backend instead.
 */
export function canCallYoutubeDirectly(): boolean {
  if (typeof window === "undefined") return false;
  const w = window as unknown as ShellWindow;
  if (w.NeritiumAndroid) return true;
  return Boolean(w.neritiumElectron) && w.neritiumElectron?.platform !== "web";
}
