import type { LinerElectronApi, DeeplinkTarget } from "../../electron/preload";
import {
  getServerTimeOffset,
  signCoverUrl as wasmSignCoverUrl,
  signMonitorRequest as wasmSignMonitorRequest,
  signRawPayload as wasmSignRawPayload,
  syncServerTime as wasmSyncServerTime,
} from "./signerWasm";

/**
 * Native bridge exposed by the Android host WebView as `window.LinerAndroid`.
 * Every method is implemented in Kotlin; none are placeholders.
 */
export interface LinerAndroidBridge {
  getVersion(): string;
  getPlatform(): string;
  /**
   * Cached APK update check (JSON: { available, version?, url?, releaseNotes? });
   * a stale cache refreshes from the published GitHub release in the
   * background and emits `updateAvailable` when a newer build exists.
   */
  updaterCheck(): string;
  /** Downloads the APK found by `updaterCheck` and opens the system installer. */
  updaterInstall(): void;
  openExternal(url: string): void;
  shareText(text: string): void;
  copyText(text: string): void;
  saveDump(filename: string, content: string): string;
  getCacheStats(): string;
  reportStorageUsage(localStorageBytes: number, indexedDbBytes: number): void;
  getInsets(): string;
  setLightSystemBars(light: boolean): void;
  /**
   * Starts an allowlisted native HTTP request. The response is delivered
   * asynchronously as an `httpResponse` event carrying { id, status, ok,
   * headers, body } or { id, status: 0, error }.
   */
  httpRequest(
    requestId: string,
    method: string,
    url: string,
    headersJson: string,
    body: string | null,
  ): void;
  /**
   * Downloads an audio stream to the device's public Downloads folder. The
   * result is delivered asynchronously as an `audioDownload` event carrying
   * { id, success, filePath?, error? }.
   */
  downloadAudio(requestId: string, url: string, filename: string, mimeType: string): void;
  /**
   * Answers a pending Android Auto browse query. The native side emits an
   * `autoBrowseQuery` event carrying { id, kind, arg }; the renderer replies
   * through this method with { items: [{ id, title, subtitle, artwork,
   * playable }] }.
   */
  autoBrowseResponse(requestId: string, payloadJson: string): void;
  openAppStorageSettings(): void;
  openDownloads(): void;
  clearCoversCache(): boolean;
  clearAudioCache(): boolean;
  clearHttpCache(): boolean;
  audioLoad(payload: string): void;
  audioPause(): void;
  audioResume(): void;
  audioSeek(positionMs: number): void;
  audioStop(): void;
  audioSetVolume(volume: number): void;
  audioSetSpeed(rate: number): void;
  audioSetPitch(semitones: number): void;
  audioSetReverb(level: number): void;
  /**
   * Schedules native playback to pause at an absolute epoch-ms deadline
   * (0 cancels). Enforced by the Media3 service so it fires even with the
   * screen off / app backgrounded, then emitted as a `sleepTimerFired` event.
   */
  audioSleepAt(deadlineMs: number): void;
  /**
   * Overlapping crossfade support: `audioCrossfadeLoad` prepares the incoming
   * song on a hidden second ExoPlayer (audible only at volume), then
   * `audioCrossfadeStart` runs the equal-power blend + EQ sweep natively over
   * `durationMs` and, at the end, promotes the incoming player to main (the
   * MediaSession follows via LinerForwardingPlayer) and emits a
   * `crossfadeCompleted` event with the new track id. `audioCrossfadeCancel`
   * aborts the blend and restores the main player's volume.
   */
  audioCrossfadeLoad(payload: string): void;
  audioCrossfadeStart(durationMs: number): void;
  audioCrossfadeCancel(): void;
  audioState(): string;
  audioCache(url: string, trackId: string, mimeType: string, limitBytes: number): void;
  audioSetCacheLimit(limitBytes: number): void;
  audioClearCache(): boolean;
  requestNotificationPermission(): void;
  setKeepScreenOn(on: boolean): void;
  /**
   * Discord Rich Presence state updates (the renderer sends raw state payloads;
   * the native side builds the activity). Kotlin talks WebSocket to the
   * signed-in Discord client's local RPC endpoint — the Android counterpart of
   * the Electron main-process client (electron/discord.ts).
   */
  discordUpdateState(payloadJson: string): void;
  /** Settings patch (JSON-serialized Partial<DiscordRpcSettings>). */
  discordUpdateSettings(settingsJson: string): void;
  /** Current RPC connection status as JSON: `{ connected, username? }`. */
  discordGetStatus(): string;
}

export type NativeMediaCommand =
  | { type: "play" }
  | { type: "pause" }
  | { type: "next" }
  | { type: "prev" }
  | { type: "seek"; positionMs: number };

type NativeEventListener = (payload: unknown) => void;
const nativeListeners = new Map<string, Set<NativeEventListener>>();
let mediaCommandHandler: ((command: NativeMediaCommand) => void) | null = null;
let backHandler: (() => boolean) | null = null;

export function isAndroidApp(): boolean {
  return typeof window !== "undefined" && Boolean(window.LinerAndroid);
}

export function getAndroidBridge(): LinerAndroidBridge | null {
  return typeof window !== "undefined" ? (window.LinerAndroid ?? null) : null;
}

export function onNativeEvent(type: string, listener: NativeEventListener): () => void {
  let set = nativeListeners.get(type);
  if (!set) {
    set = new Set();
    nativeListeners.set(type, set);
  }
  set.add(listener);
  return () => {
    set!.delete(listener);
    if (set!.size === 0) nativeListeners.delete(type);
  };
}

export function registerMediaCommandHandler(
  handler: ((command: NativeMediaCommand) => void) | null,
): void {
  mediaCommandHandler = handler;
}

export function setBackHandler(handler: (() => boolean) | null): void {
  backHandler = handler;
}

function emitNative(type: string, rawPayload: string): void {
  let payload: unknown = rawPayload;
  try {
    payload = rawPayload ? JSON.parse(rawPayload) : undefined;
  } catch {
    // plain string payloads (e.g. media commands) stay strings
  }
  const set = nativeListeners.get(type);
  if (set) for (const listener of set) listener(payload);
}

declare global {
  interface Window {
    LinerAndroid?: LinerAndroidBridge;
    /** Called by the native host for hardware/gesture back. Returns true when consumed. */
    __linerHandleBack?: () => boolean;
    /** Called by the native host to deliver events (deeplinks, media buttons). */
    __linerAndroidEmit?: (type: string, payload: string) => void;
    /** Registered by the Android playback runtime for notification/media-button commands. */
    __linerAndroidMediaCommand?: (command: string, payload: string) => void;
  }
}

function emptyCacheStats(cachePath: string) {
  return {
    cacheSize: 0,
    httpCacheSize: 0,
    codeCacheSize: 0,
    serviceWorkerSize: 0,
    indexedDbSize: 0,
    localStorageSize: 0,
    blobStorageSize: 0,
    audioCacheSize: 0,
    cachePath,
  };
}

/** Applies Android system-bar / cutout insets as CSS variables (in CSS px). */
function applyNativeInsets(raw: string): void {
  try {
    const parsed = JSON.parse(raw) as {
      top?: number;
      bottom?: number;
      left?: number;
      right?: number;
      scale?: number;
    };
    const root = document.documentElement;
    root.style.setProperty("--inset-top", `${Math.max(0, parsed.top ?? 0)}px`);
    root.style.setProperty("--inset-bottom", `${Math.max(0, parsed.bottom ?? 0)}px`);
    root.style.setProperty("--inset-left", `${Math.max(0, parsed.left ?? 0)}px`);
    root.style.setProperty("--inset-right", `${Math.max(0, parsed.right ?? 0)}px`);
  } catch {
    // keep CSS env() fallbacks
  }
}

function measureLocalStorageBytes(): number {
  try {
    let total = 0;
    for (let i = 0; i < localStorage.length; i += 1) {
      const key = localStorage.key(i) ?? "";
      const value = localStorage.getItem(key) ?? "";
      total += (key.length + value.length) * 2;
    }
    return total;
  } catch {
    return 0;
  }
}

/**
 * Installs the Android implementations of the platform boundary the renderer
 * already consumes. Desktop continues to use the Electron preload bridge; on
 * Android the same contract is served by Kotlin plus the original WASM signer.
 */
export function installAndroidPlatform(): void {
  if (typeof window === "undefined" || !window.LinerAndroid) return;

  const bridge = window.LinerAndroid;
  const deeplinkListeners = new Set<(target: DeeplinkTarget) => void>();

  window.__linerAndroidEmit = (type, payload) => {
    if (type === "insets") {
      applyNativeInsets(payload);
      return;
    }
    if (type === "deeplink") {
      let target: DeeplinkTarget | null = null;
      try {
        const parsed = JSON.parse(payload) as DeeplinkTarget;
        if (parsed && typeof parsed.id === "string") target = parsed;
      } catch {
        return;
      }
      if (target) for (const listener of deeplinkListeners) listener(target);
      return;
    }
    if (type === "mediaCommand") {
      let command: NativeMediaCommand | null = null;
      try {
        const parsed = JSON.parse(payload) as any;
        if (parsed && typeof parsed === "object") {
          if (parsed.type && typeof parsed.type === "string") {
            command = parsed as NativeMediaCommand;
          } else if (parsed.command && typeof parsed.command === "string") {
            const c = parsed.command;
            if (c === "next" || c === "previous") {
              command = { type: c === "previous" ? "prev" : "next" } as NativeMediaCommand;
            } else if (c === "play" || c === "pause" || c === "prev") {
              command = { type: c } as NativeMediaCommand;
            }
          }
        }
      } catch {
        return;
      }
      if (command) mediaCommandHandler?.(command);
      return;
    }
    emitNative(type, payload);
  };

  window.__linerHandleBack = () => {
    if (backHandler) return backHandler();
    if (window.history.length > 1) {
      window.history.back();
      return true;
    }
    return false;
  };

  const compatibility: Partial<LinerElectronApi> = {
    platform: "android",
    isHyprland: false,
    signMonitorRequest: async (input) => {
      try {
        return wasmSignMonitorRequest(input);
      } catch (err) {
        return { error: String(err instanceof Error ? err.message : err) };
      }
    },
    signCoverUrl: async (payload) => {
      try {
        return wasmSignCoverUrl(payload);
      } catch (err) {
        console.error("[Signer] Android cover signer error:", err);
        return payload;
      }
    },
    signRawPayload: async (payload) => {
      try {
        const bytes = payload instanceof Uint8Array ? payload : Uint8Array.from(payload as number[]);
        return wasmSignRawPayload(bytes);
      } catch {
        return "";
      }
    },
    syncServerTime: async (dateHeaderOrMs) => wasmSyncServerTime(dateHeaderOrMs),
    getServerTimeOffset: async () => getServerTimeOffset(),
    getAppVersion: async () => bridge.getVersion(),
    // Updater: the Android shell checks the published release itself, download
    // and install are handled natively (DownloadManager + package installer).
    checkForUpdates: async () => {
      if (typeof bridge.updaterCheck !== "function") return { available: false };
      try {
        const parsed = JSON.parse(bridge.updaterCheck()) as {
          available?: boolean;
          version?: string;
          releaseNotes?: string;
          error?: string;
        };
        return {
          available: Boolean(parsed.available && parsed.version),
          version: parsed.version,
          releaseNotes: parsed.releaseNotes,
          error: parsed.error,
        };
      } catch {
        return { available: false };
      }
    },
    downloadUpdate: async () => {
      if (typeof bridge.updaterInstall !== "function") {
        return { success: false, error: "Updates are unavailable on this platform" };
      }
      try {
        bridge.updaterInstall();
        return { success: true };
      } catch (err) {
        return { success: false, error: String(err instanceof Error ? err.message : err) };
      }
    },
    quitAndInstall: async () => true,
    onUpdateAvailable: (cb) =>
      onNativeEvent("updateAvailable", (payload) => {
        if (payload && typeof payload === "object" && "version" in payload) {
          cb(payload as { version: string; releaseNotes?: string });
        }
      }),
    onUpdateDownloadProgress: () => () => {},
    onUpdateDownloaded: (cb) =>
      onNativeEvent("updateDownloaded", (payload) => {
        if (payload && typeof payload === "object" && "version" in payload) {
          cb(payload as { version: string });
        }
      }),
    onUpdateError: (cb) =>
      onNativeEvent("updateError", (payload) => {
        if (payload && typeof payload === "object" && "message" in payload) {
          cb(payload as { message: string });
        }
      }),
    getCacheStats: async () => {
      try {
        let siteDataBytes = 0;
        try {
          const estimate = await navigator.storage?.estimate?.();
          if (estimate && typeof estimate.usage === "number") {
            siteDataBytes = estimate.usage;
          }
        } catch {
          // StorageManager unavailable; native caches are still measured.
        }
        bridge.reportStorageUsage(measureLocalStorageBytes(), siteDataBytes);
        const parsed = JSON.parse(bridge.getCacheStats()) as ReturnType<typeof emptyCacheStats>;
        return { ...emptyCacheStats(parsed.cachePath || ""), ...parsed };
      } catch {
        return emptyCacheStats("");
      }
    },
    openCacheFolder: async () => {
      bridge.openAppStorageSettings();
      return true;
    },
    openDownloads: async () => {
      bridge.openDownloads();
      return true;
    },
    openExportFolder: async () => {
      bridge.openDownloads();
      return true;
    },
    saveDump: async ({ filename, content }) => {
      try {
        return JSON.parse(bridge.saveDump(filename, content));
      } catch (err) {
        return { success: false, error: String(err instanceof Error ? err.message : err) };
      }
    },
    clearCoversCache: async () => bridge.clearCoversCache(),
    clearAudioCache: async () => bridge.clearAudioCache(),
    clearHttpCache: async () => bridge.clearHttpCache(),
    onDeeplink: (cb) => {
      deeplinkListeners.add(cb);
      return () => deeplinkListeners.delete(cb);
    },
    // Discord Rich Presence: same contract as the Electron preload (discord.ts),
    // served by the Kotlin WebSocket client (DiscordRpc.kt). Payloads are
    // stringified here because @JavascriptInterface methods take plain types.
    discordUpdateState: (state) => bridge.discordUpdateState(JSON.stringify(state ?? null)),
    discordUpdateSettings: (settings) => bridge.discordUpdateSettings(JSON.stringify(settings ?? null)),
    getDiscordStatus: async () => {
      try {
        return JSON.parse(bridge.discordGetStatus()) as { connected: boolean; username?: string };
      } catch {
        return { connected: false };
      }
    },
  };

  window.linerElectron = compatibility as LinerElectronApi;
  document.documentElement.dataset.platform = "android";
  document.documentElement.classList.add("platform-android");

  try {
    applyNativeInsets(bridge.getInsets());
  } catch {
    // CSS env() fallback remains active
  }

  const syncSystemBars = () => {
    const attr = document.documentElement.getAttribute("data-theme");
    const light =
      attr === "light" ||
      (attr !== "dark" &&
        !window.matchMedia?.("(prefers-color-scheme: dark)")?.matches);
    bridge.setLightSystemBars(light);
  };
  try {
    new MutationObserver(syncSystemBars).observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme", "class"],
    });
    syncSystemBars();
    setTimeout(syncSystemBars, 400);
  } catch {
    // System bar styling is cosmetic; never block startup on it.
  }
}

export function nativeShare(text: string): boolean {
  const bridge = getAndroidBridge();
  if (!bridge) return false;
  bridge.shareText(text);
  return true;
}

export function nativeCopy(text: string): boolean {
  const bridge = getAndroidBridge();
  if (!bridge) return false;
  bridge.copyText(text);
  return true;
}

export function nativeOpenExternal(url: string): boolean {
  const bridge = getAndroidBridge();
  if (!bridge || !/^https?:\/\//i.test(url)) return false;
  bridge.openExternal(url);
  return true;
}
