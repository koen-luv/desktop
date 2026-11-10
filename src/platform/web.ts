import type { NeritiumElectronApi, DeeplinkTarget } from "../../electron/preload";
import { APP_VERSION } from "@/shared/config/version";
import {
  getServerTimeOffset,
  signCoverUrl,
  signMonitorRequest,
  signRawPayload,
  syncServerTime,
} from "./signerWasm";

/**
 * Website port of the platform boundary.
 *
 * The renderer only ever talks to `window.neritiumElectron`; on the desktop that
 * object is the Electron preload, on Android it is a compatibility object built
 * from the Kotlin bridge. In a plain browser neither exists, so this module
 * installs the same contract backed by browser APIs only.
 *
 * What genuinely cannot exist in a tab is left absent rather than stubbed:
 * window controls, the overlay window, Discord RPC, LAN device control and the
 * updater. The app already guards every one of them with optional chaining, so
 * the UI hides those surfaces instead of offering dead buttons.
 */

function hasBridge(): boolean {
  if (typeof window === "undefined") return false;
  return Boolean(window.neritiumElectron || window.NeritiumAndroid);
}

/** True when the renderer runs in a browser tab with no native shell. */
export function isWebApp(): boolean {
  if (typeof window === "undefined") return false;
  if (window.NeritiumAndroid) return false;
  // The shim below reports platform "web", so this stays true after install;
  // Electron reports process.platform and Android reports "android".
  return window.neritiumElectron?.platform === "web";
}

function downloadBlob(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  // Chromium needs the URL to outlive the click; revoke on the next task.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function safeFileName(name: string, fallback: string): string {
  return (
    name
      .replace(/[^A-Za-z0-9._-]/g, "_")
      .slice(0, 120) || fallback
  );
}

function localStorageBytes(): number {
  try {
    let total = 0;
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i) ?? "";
      total += (key.length + (localStorage.getItem(key)?.length ?? 0)) * 2;
    }
    return total;
  } catch {
    return 0;
  }
}

async function estimateQuota(): Promise<{ usage: number; quota: number }> {
  try {
    const estimate = await navigator.storage?.estimate?.();
    return { usage: estimate?.usage ?? 0, quota: estimate?.quota ?? 0 };
  } catch {
    return { usage: 0, quota: 0 };
  }
}

async function clearCacheApi(): Promise<boolean> {
  try {
    if (typeof caches === "undefined") return false;
    const names = await caches.keys();
    await Promise.all(names.map((name) => caches.delete(name)));
    return true;
  } catch {
    return false;
  }
}

/**
 * Installs the browser implementation of the platform contract. No-op on
 * desktop and Android, where a real bridge is already present.
 */
export function installWebPlatform(): void {
  if (typeof window === "undefined" || hasBridge()) return;

  const deeplinkListeners = new Set<(target: DeeplinkTarget) => void>();

  const compatibility: Partial<NeritiumElectronApi> = {
    platform: "web",
    isHyprland: false,

    // Same production WASM signer the desktop main process and Android use.
    signMonitorRequest: async (input) => {
      try {
        return await signMonitorRequest(input);
      } catch (error) {
        return { error: String(error instanceof Error ? error.message : error) };
      }
    },
    signCoverUrl: async (payload) => {
      try {
        return await signCoverUrl(payload);
      } catch {
        return payload;
      }
    },
    signRawPayload: async (payload) => {
      try {
        const bytes =
          payload instanceof Uint8Array ? payload : Uint8Array.from(payload as number[]);
        return await signRawPayload(bytes);
      } catch {
        return "";
      }
    },
    syncServerTime: async (dateHeaderOrMs) => syncServerTime(dateHeaderOrMs),
    getServerTimeOffset: async () => getServerTimeOffset(),

    getAppVersion: async () => APP_VERSION,

    // No installer in a browser: the app updates when the site is redeployed.
    checkForUpdates: async () => ({ available: false }),
    downloadUpdate: async () => ({
      success: false,
      error: "The website is always the current version.",
    }),
    quitAndInstall: async () => false,
    onUpdateAvailable: () => () => {},
    onUpdateDownloadProgress: () => () => {},
    onUpdateDownloaded: () => () => {},
    onUpdateError: () => () => {},

    getCacheStats: async () => {
      const { usage } = await estimateQuota();
      const storage = await estimateQuota();
      return {
        cacheSize: usage,
        httpCacheSize: 0,
        codeCacheSize: 0,
        serviceWorkerSize: 0,
        indexedDbSize: Math.max(0, storage.usage - localStorageBytes()),
        localStorageSize: localStorageBytes(),
        blobStorageSize: 0,
        cachePath: "browser storage",
      };
    },
    clearCoversCache: async () => clearCacheApi(),
    clearHttpCache: async () => clearCacheApi(),
    clearAudioCache: async () => clearCacheApi(),

    // The browser has no folder to reveal; downloads are what it can do.
    openDownloads: async () => false,
    openExportFolder: async () => false,
    openCacheFolder: async () => false,

    saveDump: async ({ filename, content }) => {
      try {
        const name = safeFileName(filename, `neritium-dump-${Date.now()}.json`);
        downloadBlob(name, new Blob([content], { type: "application/json" }));
        return { success: true, filePath: name };
      } catch (error) {
        return { success: false, error: String(error instanceof Error ? error.message : error) };
      }
    },

    // Favicon is handled by useAppIconSync in the DOM; nothing native to set.
    setAppIcon: async () => {},

    onDeeplink: (cb) => {
      deeplinkListeners.add(cb);
      return () => deeplinkListeners.delete(cb);
    },

    // Browser reachability probe: what the page itself can observe. The check
    // type is shared with the desktop diagnostics, so the shape must match.
    diagnoseNetwork: async (hosts) => ({
      dns: [],
      tcp: [],
      tls: [],
      controls: await Promise.all(
        hosts.map(async (host) => {
          const startedAt = performance.now();
          try {
            await fetch(`https://${host}/`, { method: "HEAD", mode: "no-cors", cache: "no-store" });
            return {
              name: host,
              ok: true,
              ms: Math.round(performance.now() - startedAt),
            };
          } catch (error) {
            return {
              name: host,
              ok: false,
              ms: Math.round(performance.now() - startedAt),
              error: String(error instanceof Error ? error.message : error),
            };
          }
        }),
      ),
      trace: null,
      platform: "web",
    }),
  };

  window.neritiumElectron = compatibility as NeritiumElectronApi;
  document.documentElement.dataset.platform = "web";
  document.documentElement.classList.add("platform-web");
}
