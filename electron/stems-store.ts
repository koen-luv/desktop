import { app } from "electron";
import path from "node:path";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { ipcMain } from "electron";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";

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

/**
 * The renderer feeds these paths straight into `HTMLAudioElement.src`, so
 * they must be URLs. An absolute OS path ("C:\\Users\\...") is parsed as a
 * relative URL and never loads — which made every cached stem silent.
 */
function toRendererStems(stems: CachedStem[]): CachedStem[] {
  return stems.map((stem) => ({ name: stem.name, path: pathToFileURL(stem.path).href }));
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
    typeof trackId === "string" ? toRendererStems(cachedStems(trackId)) : [],
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
      return { ok: true as const, ...result, stems: toRendererStems(result.stems) };
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
const LOCAL_DEMUCS_TIMEOUT_MS = 15 * 60 * 1000;
const execFileAsync = promisify(execFile);

/**
 * Local Demucs (the real implementation of stem separation).
 *
 * When the `demucs` CLI is installed, separation runs on this machine: the
 * track is downloaded, split by `htdemucs` into vocals/drums/bass/other, and
 * the four stems land in the same on-disk cache the mixer already reads. No
 * account, no service and no upload — the audio never leaves the computer.
 *
 * `NERITIUM_DEMUCS_PATH` points at a specific executable (a venv, a wrapper);
 * otherwise `demucs` is looked up on PATH. A miss is retried after a minute so
 * installing Demucs while the app is open does not require a restart.
 */
let demucsProbe: Promise<string | null> | null = null;

function demucsCandidates(): string[] {
  const configured = process.env.NERITIUM_DEMUCS_PATH?.trim();
  return configured ? [configured] : ["demucs"];
}

async function probeDemucs(): Promise<string | null> {
  for (const candidate of demucsCandidates()) {
    try {
      await execFileAsync(candidate, ["--version"], { timeout: 8_000, windowsHide: true });
      return candidate;
    } catch {
      // Try the next candidate.
    }
  }
  return null;
}

/** Path/command of a usable local Demucs, or null when it is not installed. */
export function findDemucs(): Promise<string | null> {
  if (!demucsProbe) {
    demucsProbe = probeDemucs().then((found) => {
      if (!found) {
        const retry = setTimeout(() => {
          demucsProbe = null;
        }, 60_000);
        retry.unref?.();
      }
      return found;
    });
  }
  return demucsProbe;
}

async function downloadAudioFile(audioUrl: string, destination: string): Promise<void> {
  const response = await fetch(audioUrl, {
    headers: {
      // The same browser identity the playback path uses; YouTube's CDN
      // answers a bare Node fetch with 403.
      "user-agent":
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      accept: "audio/*,*/*;q=0.8",
    },
  });
  if (!response.ok) {
    throw new Error(`Could not fetch the track audio (HTTP ${response.status}).`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.byteLength === 0) throw new Error("The track audio was empty.");
  fs.writeFileSync(destination, bytes);
}

function runDemucs(runner: string, input: string, outDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(runner, ["-n", "htdemucs", "-o", outDir, input], {
      windowsHide: true,
    });
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("Local Demucs timed out after 15 minutes."));
    }, LOCAL_DEMUCS_TIMEOUT_MS);
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-4_000);
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(new Error(`Could not run demucs: ${error.message}`));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`Demucs exited with code ${code}${stderr ? `: ${stderr.trim()}` : ""}`));
    });
  });
}

/**
 * Separates with the local CLI and copies the four stems into the cache.
 * Demucs writes `<outDir>/htdemucs/<input name>/<stem>.wav`; any of the four
 * names it produces is cached, so a model that only finds three stems still
 * yields a usable mixer.
 */
export async function separateWithLocalDemucs(
  trackId: string,
  audioUrl: string,
  runner: string,
): Promise<CachedStem[]> {
  if (!/^https?:\/\//i.test(audioUrl)) {
    throw new Error("A playable audio URL is required for separation.");
  }
  const workDir = fs.mkdtempSync(path.join(app.getPath("temp"), "neritium-demucs-"));
  try {
    // Keep a real extension: torchaudio/ffmpeg sniffers are unreliable on an
    // extension-less stream, and Demucs needs to load the file before splitting.
    const input = path.join(workDir, `input${extensionFor(audioUrl, null)}`);
    await downloadAudioFile(audioUrl, input);
    const outDir = path.join(workDir, "out");
    await runDemucs(runner, input, outDir);

    const modelDir = path.join(outDir, "htdemucs");
    const targetDir = stemDir(trackId);
    fs.mkdirSync(targetDir, { recursive: true });
    let written = 0;
    if (fs.existsSync(modelDir)) {
      for (const entry of fs.readdirSync(modelDir)) {
        const folder = path.join(modelDir, entry);
        if (!fs.statSync(folder).isDirectory()) continue;
        for (const file of fs.readdirSync(folder)) {
          const name = path.parse(file).name;
          if (!STEM_NAMES.has(name)) continue;
          fs.copyFileSync(
            path.join(folder, file),
            path.join(targetDir, `${name}${path.extname(file)}`),
          );
          written += 1;
        }
      }
    }
    if (written < 2) throw new Error("Demucs produced fewer than two stems.");
    return cachedStems(trackId);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

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

      // A track is separated exactly once: reuse the cache before spending
      // minutes (local) or a large upload (remote) on it again.
      const alreadyCached = cachedStems(trackId);
      if (alreadyCached.length >= 2) {
        return { ok: true as const, stems: toRendererStems(alreadyCached), cached: true as const };
      }

      // Local Demucs first: no upload, no service, and it keeps working
      // offline. The hosted endpoint stays as the fallback for machines that
      // do not have the CLI installed.
      const localRunner = await findDemucs();
      if (localRunner) {
        try {
          const stems = await separateWithLocalDemucs(trackId, audioUrl, localRunner);
          return { ok: true as const, stems: toRendererStems(stems), cached: false as const };
        } catch (localError) {
          const message =
            localError instanceof Error ? localError.message : "Local Demucs failed";
          // Fall through to the hosted endpoint, but keep the local reason in
          // case that also fails.
          try {
            const stems = await separateWithDemucs(
              trackId,
              audioUrl,
              typeof endpoint === "string" && /^https?:\/\//i.test(endpoint)
                ? endpoint
                : undefined,
            );
            return { ok: true as const, stems: toRendererStems(stems), cached: false as const };
          } catch (remoteError) {
            return {
              ok: false as const,
              error: `${message} / hosted separation also failed: ${
                remoteError instanceof Error ? remoteError.message : String(remoteError)
              }`,
            };
          }
        }
      }

      try {
        const stems = await separateWithDemucs(
          trackId,
          audioUrl,
          typeof endpoint === "string" && /^https?:\/\//i.test(endpoint) ? endpoint : undefined,
        );
        return { ok: true as const, stems: toRendererStems(stems), cached: false as const };
      } catch (error) {
        return {
          ok: false as const,
          error: `${error instanceof Error ? error.message : "Stem separation failed"}. Install Demucs locally (pip install demucs) or set LINER_DEMUCS_ENDPOINT to a compatible service.`,
        };
      }
    },
  );
}
