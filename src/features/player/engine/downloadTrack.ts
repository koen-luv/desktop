import { getAndroidBridge, onNativeEvent } from "@/platform";
import { log } from "@/shared/utils/logger";
import type { Track } from "@/shared/types";
import { getCachedStream, resolvePlaybackStream } from "./playbackSource";

/**
 * Explicit "save this song to disk" path.
 *
 * Playback itself never stores audio (streaming only — see AUTO_CACHE_AUDIO in
 * the runtimes), so a song file is written only when the user presses the
 * Download action for the current song. Android downloads natively (OkHttp →
 * MediaStore), which sidesteps CORS and lands the file in the public Downloads
 * folder; web and Electron save the fetched blob through an anchor download.
 */

export interface DownloadResult {
  success: boolean;
  /** Content URI / path the file was written to (Android only). */
  filePath?: string;
  error?: string;
}

interface NativeDownloadPayload {
  id?: string;
  success?: boolean;
  filePath?: string;
  error?: string;
}

const ANDROID_DOWNLOAD_TIMEOUT_MS = 180_000;
/** Reuse an already-resolved stream only while its URL is still comfortably valid. */
const STREAM_FRESHNESS_MARGIN_MS = 15_000;

export function extensionForMimeType(mimeType: string): string {
  const mime = (mimeType || "").toLowerCase();
  if (mime.includes("webm")) return "weba";
  if (mime.includes("mp4") || mime.includes("m4a")) return "m4a";
  if (mime.includes("mpeg") || mime.includes("mp3")) return "mp3";
  return "m4a";
}

export function downloadFileName(track: Track, mimeType: string): string {
  const base = `${track.title}${track.artists ? ` - ${track.artists}` : ""}`
    .replace(/[\\/:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  return `${base || "liner-track"}.${extensionForMimeType(mimeType)}`;
}

function makeRequestId(): string {
  return typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `dl_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

async function saveOnAndroid(
  url: string,
  filename: string,
  mimeType: string,
): Promise<DownloadResult> {
  const bridge = getAndroidBridge();
  if (!bridge?.downloadAudio) {
    return { success: false, error: "Native download is unavailable in this build" };
  }
  const id = makeRequestId();
  return new Promise<DownloadResult>((resolve) => {
    let settled = false;
    const finish = (result: DownloadResult) => {
      if (settled) return;
      settled = true;
      off();
      clearTimeout(timer);
      resolve(result);
    };
    const off = onNativeEvent("audioDownload", (event) => {
      const payload = event as NativeDownloadPayload;
      if (!payload || payload.id !== id) return;
      if (payload.success) {
        finish({ success: true, filePath: payload.filePath });
      } else {
        finish({ success: false, error: payload.error || "Could not save file" });
      }
    });
    const timer = setTimeout(
      () => finish({ success: false, error: "Download timed out" }),
      ANDROID_DOWNLOAD_TIMEOUT_MS,
    );
    try {
      bridge.downloadAudio(id, url, filename, mimeType);
    } catch (error) {
      finish({ success: false, error: error instanceof Error ? error.message : String(error) });
    }
  });
}

async function saveViaBrowser(url: string, filename: string): Promise<DownloadResult> {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      return { success: false, error: `Download failed (HTTP ${response.status})` };
    }
    const blob = await response.blob();
    const objectUrl = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = objectUrl;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 5_000);
    return { success: true };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Resolves the current playable stream for `track` (reusing the in-memory
 * resolution when its URL is still valid) and saves it as a file. Never called
 * implicitly — only from the explicit Download action.
 */
export async function downloadTrack(
  track: Track,
  signal?: AbortSignal,
): Promise<DownloadResult> {
  const cached = getCachedStream(track.id);
  const cachedIsFresh =
    cached !== null &&
    (cached.expiresAtMs === null || Date.now() < cached.expiresAtMs - STREAM_FRESHNESS_MARGIN_MS);
  const stream = cachedIsFresh && cached ? cached : await resolvePlaybackStream(track, signal);
  const filename = downloadFileName(track, stream.mimeType);

  const bridge = getAndroidBridge();
  const result = bridge
    ? await saveOnAndroid(stream.url, filename, stream.mimeType)
    : await saveViaBrowser(stream.url, filename);

  log(
    result.success ? "green" : "red",
    "download",
    result.success
      ? `saved ${filename}${result.filePath ? ` → ${result.filePath}` : ""}`
      : `download failed for ${track.title}: ${result.error}`,
  );
  return result;
}
