import { app, ipcMain } from "electron";
import path from "node:path";
import fs from "node:fs";
import { execFile } from "node:child_process";

/**
 * yt-dlp fallback (main process).
 *
 * The renderer's Innertube extractor can be refused by YouTube (bot check,
 * missing PO token, changed player response). When that happens, a locally
 * installed yt-dlp is a much more forgiving resolver: it ships its own player
 * clients and is updated independently of the app.
 *
 * Nothing is bundled or downloaded at runtime. The binary is discovered from:
 *   1. `NERITIUM_YTDLP_PATH` / `YTDLP_PATH`
 *   2. `<userData>/bin/yt-dlp[.exe]`  (drop-in location for users)
 *   3. `<resources>/bin/yt-dlp[.exe]`
 *   4. `<app root>/bin/yt-dlp[.exe]`  (unpackaged dev builds)
 *   5. `yt-dlp` on PATH
 */

const YTDLP_TIMEOUT_MS = 20_000;
const YTDLP_PROBE_TIMEOUT_MS = 5_000;
const YTDLP_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
/** How long a failed binary lookup is remembered before probing again. */
const LOOKUP_RETRY_MS = 60_000;

export interface YtDlpStream {
  url: string;
  mimeType: string;
  codec?: string;
  bitrate?: number;
  expiresAtMs: number | null;
}

export type YtDlpResult = { ok: true; stream: YtDlpStream } | { ok: false; error: string };

interface YtDlpRecord {
  url?: string;
  ext?: string;
  acodec?: string;
  abr?: number;
  is_live?: boolean;
  requested_formats?: YtDlpRecord[];
}

function executableName(): string {
  return process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp";
}

function candidatePaths(): string[] {
  const exe = executableName();
  const explicit =
    process.env.NERITIUM_YTDLP_PATH?.trim() || process.env.YTDLP_PATH?.trim() || null;
  const roots = [app.getPath("userData"), process.resourcesPath, process.env.APP_ROOT].filter(
    (root): root is string => typeof root === "string" && root.length > 0,
  );
  return [
    ...(explicit ? [explicit] : []),
    ...roots.map((root) => path.join(root, "bin", exe)),
  ];
}

function canRun(command: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      command,
      ["--version"],
      { timeout: YTDLP_PROBE_TIMEOUT_MS, windowsHide: true },
      (error) => resolve(!error),
    );
  });
}

let probe: Promise<string | null> | null = null;

/** Resolves the binary path once; a miss is retried after LOOKUP_RETRY_MS. */
function findExecutable(): Promise<string | null> {
  if (probe) return probe;

  probe = (async () => {
    for (const candidate of candidatePaths()) {
      try {
        if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) continue;
      } catch {
        continue;
      }
      if (await canRun(candidate)) return candidate;
    }
    return (await canRun(executableName())) ? executableName() : null;
  })().then((found) => {
    if (!found) {
      const timer = setTimeout(() => {
        probe = null;
      }, LOOKUP_RETRY_MS);
      (timer as { unref?: () => void }).unref?.();
    }
    return found;
  });

  return probe;
}

function runYtDlp(binary: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      binary,
      args,
      {
        timeout: YTDLP_TIMEOUT_MS,
        maxBuffer: YTDLP_MAX_OUTPUT_BYTES,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      },
    );
  });
}

function parseRecord(stdout: string): YtDlpRecord | null {
  const lines = stdout.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]!.trim();
    if (!line.startsWith("{")) continue;
    try {
      return JSON.parse(line) as YtDlpRecord;
    } catch {
      // not the JSON line; keep scanning upwards
    }
  }
  return null;
}

function mimeTypeFor(ext: string | undefined, url: string): string {
  switch ((ext ?? "").toLowerCase()) {
    case "m4a":
    case "mp4":
      return "audio/mp4";
    case "webm":
    case "weba":
      return "audio/webm";
    case "mp3":
      return "audio/mpeg";
    case "ogg":
    case "oga":
    case "opus":
      return "audio/ogg";
    case "flac":
      return "audio/flac";
    default:
      break;
  }
  const fromUrl = /[?&]mime=([^&]+)/i.exec(url)?.[1];
  if (fromUrl) {
    try {
      return decodeURIComponent(fromUrl);
    } catch {
      return "audio/mp4";
    }
  }
  return "audio/mp4";
}

function codecFor(acodec: string | undefined): string | undefined {
  const value = (acodec ?? "").toLowerCase();
  if (!value || value === "none") return undefined;
  if (value.includes("opus")) return "opus";
  if (value.includes("mp4a") || value.includes("aac")) return "aac";
  if (value.includes("vorbis")) return "vorbis";
  if (value.includes("flac")) return "flac";
  return undefined;
}

function expiryFromUrl(url: string): number | null {
  try {
    const expire = new URL(url).searchParams.get("expire");
    if (!expire) return null;
    const seconds = Number(expire);
    return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
  } catch {
    return null;
  }
}

/** Pure mapping from a yt-dlp JSON record to the renderer's stream shape. */
export function toYtDlpStream(record: YtDlpRecord): YtDlpStream | null {
  const url = record.url ?? record.requested_formats?.[0]?.url;
  if (!url) return null;
  const codec = codecFor(record.acodec ?? record.requested_formats?.[0]?.acodec);
  const bitrate =
    typeof record.abr === "number" && record.abr > 0 ? Math.round(record.abr * 1000) : undefined;
  return {
    url,
    mimeType: mimeTypeFor(record.ext ?? record.requested_formats?.[0]?.ext, url),
    ...(codec ? { codec } : {}),
    ...(bitrate ? { bitrate } : {}),
    expiresAtMs: expiryFromUrl(url),
  };
}

export async function resolveYtDlp(videoId: string): Promise<YtDlpResult> {
  const binary = await findExecutable();
  if (!binary) {
    return {
      ok: false,
      error: "yt-dlp is not installed (put it on PATH or set NERITIUM_YTDLP_PATH).",
    };
  }

  try {
    const stdout = await runYtDlp(binary, [
      "--no-playlist",
      "--no-warnings",
      "--no-progress",
      "--skip-download",
      "-f",
      "bestaudio/best",
      "-j",
      `https://www.youtube.com/watch?v=${videoId}`,
    ]);
    const record = parseRecord(stdout);
    const stream = record ? toYtDlpStream(record) : null;
    if (!stream) return { ok: false, error: "yt-dlp returned no playable audio format." };
    return { ok: true, stream };
  } catch (error) {
    const detail =
      error instanceof Error
        ? ((error as NodeJS.ErrnoException).code ?? error.message)
        : String(error);
    return { ok: false, error: `yt-dlp failed: ${detail}`.slice(0, 300) };
  }
}

export function registerYtDlpIpc(): void {
  ipcMain.handle("ytdlp:resolve", async (_event, videoId: unknown): Promise<YtDlpResult> => {
    if (typeof videoId !== "string" || !/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
      return { ok: false, error: "A YouTube video id is required." };
    }
    return resolveYtDlp(videoId);
  });
}
