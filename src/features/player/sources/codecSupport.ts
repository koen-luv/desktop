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
      // "no" = definitely unsupported. "maybe"/"probably" = usable.
      supported = canary.canPlayType(type) !== "no";
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

/** Test hook — resets memoized probe results. */
export function resetCodecProbeCache(): void {
  probeCache.clear();
}
