/**
 * Six-digit join codes for the listen party.
 *
 * A code is only a room key: the WebRTC offer and the guest's answer are parked
 * in the relay worker (see `party-worker/`) for ten minutes, so joining is
 * "type six digits" instead of pasting two multi-kilobyte codes at each other.
 * With no relay configured the sheet keeps the manual exchange it always had.
 */

export const PARTY_JOIN_CODE_LENGTH = 6;
const DEFAULT_PARTY_RELAY_URL = "https://liner-party.lucabatarcian.workers.dev";

const POLL_INTERVAL_MS = 1_000;
const REQUEST_TIMEOUT_MS = 15_000;
const ANSWER_WAIT_MS = 10 * 60 * 1000;

function relayBase(): string {
  const configured =
    (import.meta.env.VITE_PARTY_RELAY_URL as string | undefined)?.trim() ?? "";
  return (configured || DEFAULT_PARTY_RELAY_URL).replace(/\/+$/, "");
}

export function isPartyRelayEnabled(): boolean {
  return relayBase().length > 0;
}

/** Six digits or nothing; spaces and dashes from a chat app are tolerated. */
export function normalizeJoinCode(input: string): string | null {
  const digits = input.trim().replace(/[\s-]/g, "");
  return new RegExp(`^\\d{${PARTY_JOIN_CODE_LENGTH}}$`).test(digits) ? digits : null;
}

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

function abortError(): Error {
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}

async function call(path: string, init: RequestInit = {}): Promise<Response> {
  const base = relayBase();
  if (!base) throw new Error("party relay is not configured");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    return await fetch(`${base}${path}`, {
      ...init,
      signal: controller.signal,
      headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    });
  } finally {
    clearTimeout(timer);
  }
}

/** Host: park the offer, get back the code to read out loud. */
export async function createRelayRoom(offer: string): Promise<string> {
  const response = await call("/rooms", {
    method: "POST",
    body: JSON.stringify({ offer }),
  });
  if (!response.ok) throw new Error(`relay refused the room (${response.status})`);

  const body = (await response.json()) as { code?: unknown };
  const code = typeof body.code === "string" ? normalizeJoinCode(body.code) : null;
  if (!code) throw new Error("relay returned an unusable code");
  return code;
}

/** Guest: read the offer the host parked under this code. */
export async function fetchRelayOffer(code: string): Promise<string> {
  const room = normalizeJoinCode(code);
  if (!room) throw new Error("invalid party code");

  const response = await call(`/rooms/${room}`);
  if (response.status === 404) throw new Error("party code not found or expired");
  if (!response.ok) throw new Error(`relay lookup failed (${response.status})`);

  const body = (await response.json()) as { offer?: unknown };
  if (typeof body.offer !== "string" || body.offer.length === 0) {
    throw new Error("relay returned no offer");
  }
  return body.offer;
}

/** Guest: hand the answer back so the host can pick it up. */
export async function submitRelayAnswer(code: string, answer: string): Promise<void> {
  const room = normalizeJoinCode(code);
  if (!room) throw new Error("invalid party code");

  const response = await call(`/rooms/${room}/answer`, {
    method: "PUT",
    body: JSON.stringify({ answer }),
  });
  if (!response.ok) throw new Error(`relay rejected the answer (${response.status})`);
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Host: long-poll the room until the guest's answer lands. */
export async function waitForRelayAnswer(
  code: string,
  signal?: AbortSignal,
): Promise<string> {
  const room = normalizeJoinCode(code);
  if (!room) throw new Error("invalid party code");

  const deadline = Date.now() + ANSWER_WAIT_MS;
  for (;;) {
    if (signal?.aborted) throw abortError();

    const response = await call(`/rooms/${room}/answer`);
    if (response.ok) {
      const body = (await response.json()) as { answer?: unknown };
      if (typeof body.answer === "string" && body.answer.length > 0) return body.answer;
    } else if (response.status !== 404) {
      throw new Error(`relay poll failed (${response.status})`);
    }

    if (Date.now() >= deadline) throw new Error("party code expired");
    await delay(POLL_INTERVAL_MS, signal);
  }
}

/** Best effort: free the code as soon as the handshake is done or abandoned. */
export async function closeRelayRoom(code: string | null): Promise<void> {
  const room = normalizeJoinCode(code ?? "");
  if (!room) return;
  try {
    await call(`/rooms/${room}`, { method: "DELETE" });
  } catch {
    // The room expires on its own; nothing to recover here.
  }
}
