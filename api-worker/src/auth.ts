import { HttpError, clampNumber, type Env } from "./http";

export interface AccessUser {
  id: string;
  username: string | null;
}

interface AccessPayload {
  iss: string;
  sub: string;
  username?: string | null;
  iat: number;
  exp: number;
}

const ISSUER = "liner-api";
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const keyCache = new Map<string, Promise<CryptoKey>>();

function hmacKey(secret: string): Promise<CryptoKey> {
  let cached = keyCache.get(secret);
  if (!cached) {
    cached = crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"],
    );
    keyCache.set(secret, cached);
  }
  return cached;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array {
  const padded =
    value.replace(/-/g, "+").replace(/_/g, "/") +
    "=".repeat((4 - (value.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function randomToken(bytes = 32): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return base64Url(buffer);
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function signAccessToken(
  env: Env,
  user: AccessUser,
): Promise<{ token: string; expiresAt: string }> {
  const secret = env.JWT_SECRET;
  if (!secret || secret.length < 32) {
    throw new HttpError(
      500,
      "SERVER_MISCONFIGURED",
      "JWT_SECRET must be set to at least 32 characters.",
    );
  }
  const ttl = clampNumber(Number(env.ACCESS_TOKEN_TTL_SECONDS ?? 900), 60, 86_400);
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(
    encoder.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })),
  );
  const payload: AccessPayload = {
    iss: ISSUER,
    sub: user.id,
    username: user.username,
    iat: now,
    exp: now + ttl,
  };
  const body = base64Url(encoder.encode(JSON.stringify(payload)));
  const unsigned = `${header}.${body}`;
  const signature = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(secret),
    encoder.encode(unsigned),
  );
  return {
    token: `${unsigned}.${base64Url(new Uint8Array(signature))}`,
    expiresAt: new Date(payload.exp * 1000).toISOString(),
  };
}

export async function verifyAccessToken(
  env: Env,
  token: string,
): Promise<AccessUser | null> {
  const secret = env.JWT_SECRET;
  if (!secret || secret.length < 32) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [header, body, signature] = parts;
  try {
    const head = JSON.parse(decoder.decode(fromBase64Url(header))) as {
      alg?: unknown;
    };
    if (head.alg !== "HS256") return null;
    const valid = await crypto.subtle.verify(
      "HMAC",
      await hmacKey(secret),
      fromBase64Url(signature) as BufferSource,
      encoder.encode(`${header}.${body}`),
    );
    if (!valid) return null;
    const payload = JSON.parse(
      decoder.decode(fromBase64Url(body)),
    ) as Partial<AccessPayload>;
    const now = Math.floor(Date.now() / 1000);
    if (
      payload.iss !== ISSUER ||
      typeof payload.sub !== "string" ||
      !payload.sub ||
      typeof payload.exp !== "number" ||
      payload.exp <= now
    ) {
      return null;
    }
    return {
      id: payload.sub,
      username: typeof payload.username === "string" ? payload.username : null,
    };
  } catch {
    return null;
  }
}
