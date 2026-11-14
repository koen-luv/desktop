/**
 * Signature deciphering + n-transform (throttling parameter) service.
 *
 * YouTube's web clients return `signatureCipher`/`cipher` format payloads
 * instead of plain URLs: a scrambled signature that must be run through the
 * `process()` function extracted from the player script, plus an `n` parameter
 * whose transformation throttles the media host when left untouched. This is
 * the "QuackJS" step in Metrolist's pipeline (docs/innertube.md: "QuackJS
 * handles signature and throttling transforms separately from PO-token
 * attestation").
 *
 * The heavy lifting is delegated to youtubei.js's `Player`, which downloads the
 * player script, extracts the transform pipeline and evaluates it through
 * `Platform.shim.eval`. `Player#decipher` applies both the signature and the
 * n-transform and returns a ready-to-play URL.
 */

import { Platform, Player } from "youtubei.js/web";
import { log } from "@/shared/utils/logger";

let evaluatorInstalled = false;

/** Installs the JS evaluator youtubei.js needs to run the player transforms. */
export function installPlayerEvaluator(): void {
  if (evaluatorInstalled) return;
  Platform.shim.eval = async (data, env) => {
    const args = [env.n, env.sp, env.sig].map((value) => JSON.stringify(value ?? ""));
    return new Function(`${data.output}\nreturn process(${args.join(", ")});`)();
  };
  evaluatorInstalled = true;
}

let playerPromise: Promise<Player> | null = null;

async function getPlayer(): Promise<Player> {
  installPlayerEvaluator();
  if (!playerPromise) {
    playerPromise = Player.create(undefined, (input, init) => fetch(input, init)).catch((error) => {
      playerPromise = null;
      throw error;
    });
  }
  return playerPromise;
}

/**
 * `signatureTimestamp` the player script expects in the request's
 * `playbackContext` — required by ciphered/JS-driven clients. `null` when the
 * player script cannot be fetched (callers then skip those clients).
 */
export async function getSignatureTimestamp(): Promise<number | null> {
  try {
    const player = await getPlayer();
    return typeof player.signature_timestamp === "number" ? player.signature_timestamp : null;
  } catch {
    return null;
  }
}

export interface CipheredFormat {
  url?: string;
  signatureCipher?: string;
  cipher?: string;
}

/**
 * Resolves a format to a ready media URL: signatures deciphered and the `n`
 * parameter transformed. Direct URLs pass through untouched (decipher() still
 * applies the n-transform when present). A stale player script is retried once
 * with a fresh download — the common failure mode when YouTube rotates the
 * player. Throws when the format cannot be resolved at all.
 */
export async function decipherFormatUrl(format: CipheredFormat, signal?: AbortSignal): Promise<string> {
  const attempt = async (player: Player): Promise<string> => {
    const url = await player.decipher(format.url, format.signatureCipher, format.cipher);
    if (!url) throw new Error("player decipher returned no url");
    return url;
  };
  throwIfAborted(signal);
  try {
    return await attempt(await getPlayer());
  } catch (firstError) {
    if (signal?.aborted) throw firstError;
    log("yellow", "playback", `decipher failed, refreshing player script: ${String(firstError)}`);
    playerPromise = null;
    throwIfAborted(signal);
    return attempt(await getPlayer());
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException("Aborted", "AbortError");
}

/** Test hook: drop the cached player script. */
export function resetCipherCache(): void {
  playerPromise = null;
}
