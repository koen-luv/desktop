import { HttpError, corsHeaders, getRequestId, json, type Env } from "./http";

/**
 * YouTube relays for the website port.
 *
 * The desktop app mints PO tokens itself (electron/potoken-preload.ts) from a
 * YouTube-origin page, which is what gets its player requests past "Sign in to
 * confirm you're not a bot". A browser tab cannot do the same directly: every
 * one of those calls is cross-origin. These three relays forward exactly those
 * calls — nothing else — so the renderer can run the same bgutils flow:
 *
 *   POST /v1/yt/att          → youtubei/v1/att/get (BotGuard challenge)
 *   GET  /v1/yt/interpreter  → the BotGuard interpreter script
 *   POST /v1/yt/generate-it  → GenerateIT (integrity token)
 *
 * The token produced this way is then sent back to
 * `POST /v1/tracks/:id/playback`, which is where it is actually used.
 */

const ALLOWED_HOSTS = new Set([
  "www.youtube.com",
  "youtube.com",
  "music.youtube.com",
  "www.google.com",
  "jnn-pa.googleapis.com",
]);

function assertAllowed(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new HttpError(400, "INVALID_URL", "A valid URL is required.");
  }
  if (url.protocol !== "https:" || !ALLOWED_HOSTS.has(url.hostname)) {
    throw new HttpError(400, "BLOCKED_URL", `Relay does not forward to ${url.hostname}.`);
  }
  return url;
}

function relayHeaders(request: Request, env: Env, contentType: string): Headers {
  const headers = new Headers(corsHeaders(request, env));
  headers.set("content-type", contentType);
  headers.set("cache-control", "no-store");
  headers.set("x-request-id", getRequestId(request));
  return headers;
}

export async function handleAttRelay(request: Request, env: Env): Promise<Response> {
  const body = await request.text().catch(() => "");
  if (!body) throw new HttpError(400, "INVALID_INPUT", "A challenge request body is required.");

  const upstream = await fetch("https://www.youtube.com/youtubei/v1/att/get?prettyPrint=false", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://www.youtube.com" },
    body,
  }).catch((error: unknown) => {
    throw new HttpError(
      502,
      "RELAY_FAILED",
      `Challenge relay failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  });

  if (!upstream.ok) {
    throw new HttpError(502, "RELAY_FAILED", `Challenge relay returned HTTP ${upstream.status}.`);
  }
  const payload = await upstream.text();
  return new Response(payload, {
    status: 200,
    headers: relayHeaders(request, env, "application/json; charset=utf-8"),
  });
}

export async function handleInterpreterRelay(
  request: Request,
  env: Env,
  url: URL,
): Promise<Response> {
  const target = url.searchParams.get("u");
  if (!target) throw new HttpError(400, "INVALID_INPUT", "An interpreter URL is required.");
  const interpreter = assertAllowed(target);

  const upstream = await fetch(interpreter.toString(), {
    headers: { accept: "text/javascript,*/*" },
  }).catch((error: unknown) => {
    throw new HttpError(
      502,
      "RELAY_FAILED",
      `Interpreter relay failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  });
  if (!upstream.ok) {
    throw new HttpError(502, "RELAY_FAILED", `Interpreter relay returned HTTP ${upstream.status}.`);
  }
  const script = await upstream.text();
  if (script.length > 2_000_000) {
    throw new HttpError(502, "RELAY_FAILED", "Interpreter script is unexpectedly large.");
  }
  return new Response(script, {
    status: 200,
    headers: relayHeaders(request, env, "text/javascript; charset=utf-8"),
  });
}

export async function handleGenerateItRelay(request: Request, env: Env): Promise<Response> {
  const body = await request.text().catch(() => "");
  if (!body) throw new HttpError(400, "INVALID_INPUT", "A snapshot payload is required.");

  const upstream = await fetch(
    "https://jnn-pa.googleapis.com/$rpc/google.internal.waa.v1.Waa/GenerateIT",
    {
      method: "POST",
      headers: {
        "content-type": "application/json+protobuf",
        "x-goog-api-key": "AIzaSyDyT5W0Jh49F30Pqqtyfdf7pDLFKLJoAnw",
        "x-user-agent": "grpc-web-javascript/0.1",
      },
      body,
    },
  ).catch((error: unknown) => {
    throw new HttpError(
      502,
      "RELAY_FAILED",
      `Integrity relay failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  });

  if (!upstream.ok) {
    throw new HttpError(502, "RELAY_FAILED", `Integrity relay returned HTTP ${upstream.status}.`);
  }
  const payload = await upstream.text();
  return new Response(payload, {
    status: 200,
    headers: relayHeaders(request, env, "application/json; charset=utf-8"),
  });
}

export function jsonRelayError(request: Request, env: Env, error: unknown): Response {
  const message = error instanceof Error ? error.message : String(error);
  return json({ code: "RELAY_FAILED", message }, request, env, 502);
}
