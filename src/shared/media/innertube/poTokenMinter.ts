import { BotGuardClient } from "bgutils-js/botguard";
import { buildURL, GOOG_API_KEY } from "bgutils-js/utils";
import { WebPoMinter } from "bgutils-js/webpo";
import type { Innertube } from "youtubei.js/web";

const REQUEST_KEY = "O43z0dpjhgX20SCx4KAo";
const REFRESH_MARGIN_MS = 10 * 60 * 1000;
const DEFAULT_TTL_SECONDS = 6 * 60 * 60;
const MINT_TIMEOUT_MS = 15_000;

interface MinterEntry {
  visitorData: string;
  minter: WebPoMinter;
  expiresAt: number;
}

let current: MinterEntry | null = null;
let pending: Promise<MinterEntry> | null = null;

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function loadInterpreter(innertube: Innertube): Promise<{ program: string; globalName: string }> {
  const challenge = await innertube.getAttestationChallenge("ENGAGEMENT_TYPE_UNBOUND");
  const bg = challenge.bg_challenge;
  if (!bg) throw new Error("BotGuard challenge is missing");
  const interpreterUrl = bg.interpreter_url.private_do_not_access_or_else_trusted_resource_url_wrapped_value;
  const script = await (await fetch(`https:${interpreterUrl}`)).text();
  new Function(script)();
  return { program: bg.program, globalName: bg.global_name };
}

async function createMinter(innertube: Innertube, visitorData: string): Promise<MinterEntry> {
  const { program, globalName } = await loadInterpreter(innertube);
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
  const [integrityToken, ttlSeconds] = (await response.json()) as [string, number?];
  if (!integrityToken) throw new Error("GenerateIT returned no integrity token");
  const minter = await WebPoMinter.create({ integrityToken }, webPoSignalOutput);
  const ttlMs = (typeof ttlSeconds === "number" && ttlSeconds > 0 ? ttlSeconds : DEFAULT_TTL_SECONDS) * 1000;
  return { visitorData, minter, expiresAt: Date.now() + Math.max(ttlMs - REFRESH_MARGIN_MS, 60_000) };
}

async function getMinter(innertube: Innertube, visitorData: string): Promise<WebPoMinter> {
  if (current && current.visitorData === visitorData && Date.now() < current.expiresAt) return current.minter;
  if (!pending) {
    pending = withTimeout(createMinter(innertube, visitorData), MINT_TIMEOUT_MS, "PO token minter")
      .then((entry) => {
        current = entry;
        return entry;
      })
      .finally(() => {
        pending = null;
      });
  }
  return (await pending).minter;
}

export async function mintContentPoToken(innertube: Innertube, visitorData: string, videoId: string): Promise<string> {
  const minter = await getMinter(innertube, visitorData);
  return minter.mintAsWebsafeString(videoId);
}

export function resetPoTokenMinter(): void {
  current = null;
}
