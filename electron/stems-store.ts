import { app } from "electron";
import path from "node:path";
import fs from "node:fs";
import { ipcMain } from "electron";

/**
 * Stem cache (main process).
 *
 * Separated stems are expensive to produce, so they are written once under
 * `userData/stems/<trackId>/` and reused on every later play. The renderer only
 * receives local file paths — it never re-downloads, and nothing is kept in
 * memory between sessions.
 *
 * Downloading happens here rather than in the renderer because stem hosts are
 * arbitrary and would otherwise be at the mercy of CORS.
 */

export interface StemInput {
  name: string;
  url: string;
}

export interface CachedStem {
  name: string;
  path: string;
}

const STEM_NAMES = new Set(["vocals", "drums", "bass", "other"]);

function safeId(trackId: string): string {
  return trackId.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 80);
}

function stemDir(trackId: string): string {
  return path.join(app.getPath("userData"), "stems", safeId(trackId));
}

function extensionFor(url: string, contentType: string | null): string {
  const type = (contentType || "").toLowerCase();
  if (type.includes("webm")) return "weba";
  if (type.includes("mpeg") || type.includes("mp3")) return "mp3";
  if (type.includes("ogg")) return "ogg";
  if (type.includes("wav")) return "wav";
  const match = /\.(m4a|mp3|ogg|wav|weba|webm|flac)(?:\?|$)/i.exec(url);
  return match ? match[1].toLowerCase() : "m4a";
}

/** Existing stems for a track, or [] when it has never been separated. */
export function cachedStems(trackId: string): CachedStem[] {
  const dir = stemDir(trackId);
  if (!fs.existsSync(dir)) return [];
  const found: CachedStem[] = [];
  for (const entry of fs.readdirSync(dir)) {
    const name = entry.split(".")[0];
    if (!STEM_NAMES.has(name)) continue;
    found.push({ name, path: path.join(dir, entry) });
  }
  return found.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Downloads any missing stem files and returns all four paths. Already-cached
 * stems are never fetched again.
 */
export async function ensureStems(
  trackId: string,
  stems: StemInput[],
): Promise<{ stems: CachedStem[]; cached: string[]; downloaded: string[] }> {
  const dir = stemDir(trackId);
  fs.mkdirSync(dir, { recursive: true });
  const before = new Set(cachedStems(trackId).map((stem) => stem.name));
  const downloaded: string[] = [];

  for (const stem of stems) {
    if (!STEM_NAMES.has(stem.name)) continue;
    if (before.has(stem.name)) continue;
    if (!/^https?:\/\//i.test(stem.url)) continue;

    const response = await fetch(stem.url);
    if (!response.ok) {
      throw new Error(`Stem "${stem.name}" download failed (HTTP ${response.status})`);
    }
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength === 0) {
      throw new Error(`Stem "${stem.name}" download returned no data`);
    }
    const ext = extensionFor(stem.url, response.headers.get("content-type"));
    fs.writeFileSync(path.join(dir, `${stem.name}.${ext}`), bytes);
    downloaded.push(stem.name);
  }

  return {
    stems: cachedStems(trackId),
    cached: [...before],
    downloaded,
  };
}

/** Deletes cached stems for one track (or all of them). */
export function clearStems(trackId?: string): boolean {
  try {
    if (trackId) {
      fs.rmSync(stemDir(trackId), { recursive: true, force: true });
    } else {
      fs.rmSync(path.join(app.getPath("userData"), "stems"), { recursive: true, force: true });
    }
    return true;
  } catch {
    return false;
  }
}

export function registerStemCacheIpc(): void {
  ipcMain.handle("stems:cached", (_event, trackId: unknown) =>
    typeof trackId === "string" ? cachedStems(trackId) : [],
  );

  ipcMain.handle("stems:ensure", async (_event, trackId: unknown, stems: unknown) => {
    if (typeof trackId !== "string" || !Array.isArray(stems)) {
      return { ok: false as const, error: "A track id and stem list are required." };
    }
    try {
      const result = await ensureStems(
        trackId,
        stems.filter(
          (stem): stem is StemInput =>
            Boolean(stem) &&
            typeof (stem as StemInput).name === "string" &&
            typeof (stem as StemInput).url === "string",
        ),
      );
      return { ok: true as const, ...result };
    } catch (error) {
      return {
        ok: false as const,
        error: error instanceof Error ? error.message : "Could not cache stems",
      };
    }
  });

  ipcMain.handle("stems:clear", (_event, trackId: unknown) =>
    clearStems(typeof trackId === "string" ? trackId : undefined),
  );
}

/**
 * Separation through the hosted Demucs API.
 *
 * That service takes a base64 song and returns four base64 mp3s inline, so the
 * work happens here in the main process: the renderer never handles multi-MB
 * payloads, nothing has to pass through the Worker's body limits, and the files
 * land in the cache directory so a track is separated exactly once.
 */

/** Override with LINER_DEMUCS_ENDPOINT; this is the public demo instance. */
const DEFAULT_DEMUCS_ENDPOINT = "https://demucs-api-hwbhnojdya-uc.a.run.app";
const DEMUCS_TIMEOUT_MS = 10 * 60 * 1000;

function demucsEndpoint(): string {
  const configured = process.env.LINER_DEMUCS_ENDPOINT?.trim();
  return (configured && /^https?:\/\//i.test(configured) ? configured : DEFAULT_DEMUCS_ENDPOINT).replace(
    /\/+$/,
    "",
  );
}

interface DemucsResponse {
  drums?: string;
  bass?: string;
  other?: string;
  vocals?: string;
}

export async function separateWithDemucs(
  trackId: string,
  audioUrl: string,
  endpoint = demucsEndpoint(),
): Promise<CachedStem[]> {
  if (!/^https?:\/\//i.test(audioUrl)) {
    throw new Error("A playable audio URL is required for separation.");
  }

  const audioResponse = await fetch(audioUrl);
  if (!audioResponse.ok) {
    throw new Error(`Could not fetch the track audio (HTTP ${audioResponse.status})`);
  }
  const audioBytes = Buffer.from(await audioResponse.arrayBuffer());
  if (audioBytes.byteLength === 0) throw new Error("The track audio was empty.");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DEMUCS_TIMEOUT_MS);
  let payload: DemucsResponse;
  try {
    const response = await fetch(`${endpoint}/predict`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ instances: [{ b64: audioBytes.toString("base64") }] }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(
        `Demucs returned HTTP ${response.status}${detail ? `: ${detail.slice(0, 160)}` : ""}`,
      );
    }
    payload = (await response.json()) as DemucsResponse;
  } finally {
    clearTimeout(timer);
  }

  const dir = stemDir(trackId);
  fs.mkdirSync(dir, { recursive: true });
  let written = 0;
  for (const name of ["vocals", "drums", "bass", "other"] as const) {
    const encoded = payload[name];
    if (typeof encoded !== "string" || encoded.length === 0) continue;
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.byteLength === 0) continue;
    fs.writeFileSync(path.join(dir, `${name}.mp3`), bytes);
    written += 1;
  }

  if (written < 2) throw new Error("Demucs returned fewer than two stems.");
  return cachedStems(trackId);
}

export function registerDemucsIpc(): void {
  ipcMain.handle(
    "stems:separate",
    async (_event, trackId: unknown, audioUrl: unknown, endpoint: unknown) => {
      if (typeof trackId !== "string" || typeof audioUrl !== "string") {
        return { ok: false as const, error: "A track id and audio URL are required." };
      }
      try {
        const stems = await separateWithDemucs(
          trackId,
          audioUrl,
          typeof endpoint === "string" && /^https?:\/\//i.test(endpoint) ? endpoint : undefined,
        );
        return { ok: true as const, stems };
      } catch (error) {
        return {
          ok: false as const,
          error: error instanceof Error ? error.message : "Stem separation failed",
        };
      }
    },
  );
}
