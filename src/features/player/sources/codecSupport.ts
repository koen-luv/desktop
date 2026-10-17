/**
 * Platform audio codec capability probing.
 *
 * Liner resolves streams from providers that can serve either WebM/Opus or
 * MP4/AAC depending on the client. Browsers such as Safari cannot decode
 * WebM/Opus at all — historically that surfaced as "song fails to play" with an
 * endless spinner. Providers consult this probe so an undecodable codec is
 * never requested in the first place.
 */

const probeCache = new Map<string, boolean>();

type Canary = { canPlayType(type: string): string };

function getCanary(): Canary | null {
  if (typeof document === "undefined") return null;
  try {
    return document.createElement("audio") as unknown as Canary;
  } catch {
    return null;
  }
}

export function isCodecSupported(mimeType: string, codec?: string): boolean {
  const key = `${mimeType};${codec ?? ""}`;
  const cached = probeCache.get(key);
  if (cached !== undefined) return cached;

  const canary = getCanary();
  let supported = true;

  if (canary && typeof canary.canPlayType === "function") {
    const type = codec ? `${mimeType}; codecs="${codec}"` : mimeType;
    try {
      // `canPlayType` returns "" (not "no") when a type is definitely
      // unsupported, "maybe"/"probably" when usable. If the probe cannot even
      // recognise plain MP3 (e.g. jsdom / native runtimes), it provides no
      // signal at all and we must not gate providers on it.
      const baseline = canary.canPlayType("audio/mpeg");
      supported = baseline === "" ? true : canary.canPlayType(type) !== "";
    } catch {
      supported = true;
    }
  }

  // Unknown mime types must not be filtered out (native runtimes / exotic containers).
  if (!mimeType.startsWith("audio/") && !mimeType.startsWith("video/")) {
    supported = true;
  }

  probeCache.set(key, supported);
  return supported;
}

let directPlanSupport: boolean | null = null;

/**
 * Whether the client can execute signed Innertube plans directly.
 *
 * The renderer must be allowed to call youtube.com (Electron runs with
 * `webSecurity: false` + CORS header injection; Android routes YouTube hosts
 * through the native OkHttp bridge). A plain browser cannot — so direct
 * providers are skipped there and the server's proxy transport is used
 * instead of burning retries on requests CORS will always block.
 */
export function canExecuteDirectInnertubePlans(): boolean {
  if (directPlanSupport !== null) return directPlanSupport;
  if (typeof window === "undefined") {
    directPlanSupport = false;
    return false;
  }
  const w = window as unknown as { linerElectron?: unknown; LinerAndroid?: unknown };
  directPlanSupport = Boolean(w.linerElectron || w.LinerAndroid);
  return directPlanSupport;
}

/** Test hook — resets memoized probe results. */
export function resetCodecProbeCache(): void {
  probeCache.clear();
  directPlanSupport = null;
}
