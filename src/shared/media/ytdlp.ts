/**
 * Renderer side of the desktop yt-dlp fallback.
 *
 * Only the Electron main process can spawn a local binary, so this is a thin
 * wrapper over the preload bridge. It is intentionally absent on Android and in
 * the browser, where `window.neritiumElectron.ytdlpResolve` does not exist.
 */

export interface YtDlpStream {
  url: string;
  mimeType: string;
  codec?: string;
  bitrate?: number;
  expiresAtMs: number | null;
}

/** True when the host can resolve streams through a local yt-dlp binary. */
export function isYtDlpAvailable(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.neritiumElectron?.ytdlpResolve === "function"
  );
}

/**
 * Resolves a YouTube video id through yt-dlp, or null when the bridge is
 * missing, the binary is not installed, or extraction failed. Callers treat
 * null as "this source is unavailable" and keep their normal fallback chain.
 */
export async function resolveYtDlpStream(
  videoId: string,
  signal?: AbortSignal,
): Promise<YtDlpStream | null> {
  if (typeof window === "undefined" || signal?.aborted) return null;
  const resolve = window.neritiumElectron?.ytdlpResolve;
  if (typeof resolve !== "function") return null;

  try {
    const result = await resolve(videoId);
    if (!result?.ok || !result.stream?.url) return null;
    if (signal?.aborted) return null;
    return result.stream;
  } catch {
    return null;
  }
}
