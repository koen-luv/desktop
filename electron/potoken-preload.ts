import { ipcRenderer } from "electron";
import { BotGuardClient } from "bgutils-js/botguard";
import { buildURL, GOOG_API_KEY } from "bgutils-js/utils";
import { WebPoMinter } from "bgutils-js/webpo";

const REQUEST_KEY = "O43z0dpjhgX20SCx4KAo";
const REFRESH_MARGIN_MS = 10 * 60 * 1000;
const DEFAULT_TTL_SECONDS = 6 * 60 * 60;
const WEB_CLIENT_VERSION = "2.20250925.01.00";

interface MinterEntry {
  minter: WebPoMinter;
  expiresAt: number;
}

interface BgChallenge {
  interpreterUrl?: { privateDoNotAccessOrElseTrustedResourceUrlWrappedValue?: string };
  program?: string;
  globalName?: string;
}

interface MintRequest {
  id: number;
  identifier: string;
}

let current: MinterEntry | null = null;
let pending: Promise<MinterEntry> | null = null;

async function fetchChallenge(): Promise<{ interpreterUrl: string; program: string; globalName: string }> {
  const response = await fetch("/youtubei/v1/att/get?prettyPrint=false", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      context: { client: { clientName: "WEB", clientVersion: WEB_CLIENT_VERSION, hl: "en", gl: "US" } },
      engagementType: "ENGAGEMENT_TYPE_UNBOUND",
    }),
  });
  if (!response.ok) throw new Error(`att/get returned ${response.status}`);
  const challenge = ((await response.json()) as { bgChallenge?: BgChallenge }).bgChallenge;
  const interpreterUrl = challenge?.interpreterUrl?.privateDoNotAccessOrElseTrustedResourceUrlWrappedValue;
  if (!interpreterUrl || !challenge?.program || !challenge.globalName) throw new Error("BotGuard challenge is missing");
  return { interpreterUrl, program: challenge.program, globalName: challenge.globalName };
}

async function createMinter(): Promise<MinterEntry> {
  const { interpreterUrl, program, globalName } = await fetchChallenge();
  const script = (await ipcRenderer.invoke("potoken:interpreter", `https:${interpreterUrl}`)) as string;
  new Function(script)();
  const botguard = await BotGuardClient.create({ program, globalName, globalObject: globalThis });
  const webPoSignalOutput: Parameters<typeof WebPoMinter.create>[1] = [];
  const botguardResponse = await botguard.snapshot({ webPoSignalOutput });
  const response = await fetch(buildURL("GenerateIT", true), {
    method: "POST",
    headers: {
      "content-type": "application/json+protobuf",
      "x-goog-api-key": GOOG_API_KEY,
      "x-user-agent": "grpc-web-javascript/0.1",
    },
    body: JSON.stringify([REQUEST_KEY, botguardResponse]),
  });
  if (!response.ok) throw new Error(`GenerateIT returned ${response.status}`);
  const [integrityToken, ttlSeconds] = (await response.json()) as [string | null, number?];
  if (!integrityToken) throw new Error("GenerateIT returned no integrity token");
  const minter = await WebPoMinter.create({ integrityToken }, webPoSignalOutput);
  const ttlMs = (typeof ttlSeconds === "number" && ttlSeconds > 0 ? ttlSeconds : DEFAULT_TTL_SECONDS) * 1000;
  return { minter, expiresAt: Date.now() + Math.max(ttlMs - REFRESH_MARGIN_MS, 60_000) };
}

async function getMinter(): Promise<MinterEntry> {
  if (current && Date.now() < current.expiresAt) return current;
  if (!pending) {
    pending = createMinter()
      .then((entry) => {
        current = entry;
        return entry;
      })
      .finally(() => {
        pending = null;
      });
  }
  return pending;
}

ipcRenderer.on("potoken:mint", async (_event, request: MintRequest) => {
  try {
    const entry = await getMinter();
    const token = await entry.minter.mintAsWebsafeString(request.identifier);
    ipcRenderer.send("potoken:result", { id: request.id, token });
  } catch (error) {
    current = null;
    ipcRenderer.send("potoken:result", { id: request.id, error: error instanceof Error ? error.message : String(error) });
  }
});

window.addEventListener("DOMContentLoaded", () => ipcRenderer.send("potoken:ready"));
