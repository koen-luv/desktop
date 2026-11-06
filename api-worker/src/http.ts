export const MAX_BODY_BYTES = 1_000_000;

export interface Env {
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_ROLE_KEY?: string;
  JWT_SECRET?: string;
  TURNSTILE_MODE?: string;
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET?: string;
  ACCESS_TOKEN_TTL_SECONDS?: string;
  REFRESH_TOKEN_TTL_DAYS?: string;
  ALLOWED_ORIGINS?: string;
}

export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

export function stringField(
  value: unknown,
  field: string,
  min: number,
  max: number,
  trim = true,
): string {
  if (typeof value !== "string") {
    throw new HttpError(400, "INVALID_INPUT", `${field} is required.`);
  }
  const text = trim ? value.trim() : value;
  if (text.length < min || text.length > max) {
    throw new HttpError(
      400,
      "INVALID_INPUT",
      `${field} must be between ${min} and ${max} characters.`,
    );
  }
  return text;
}

export function optionalStringField(
  value: unknown,
  field: string,
  max: number,
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new HttpError(400, "INVALID_INPUT", `${field} must be a string.`);
  }
  if (value.length > max) {
    throw new HttpError(400, "INVALID_INPUT", `${field} is too long.`);
  }
  return value;
}

export function optionalBooleanField(
  value: unknown,
  field: string,
): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") {
    throw new HttpError(400, "INVALID_INPUT", `${field} must be a boolean.`);
  }
  return value;
}

export function numberField(
  value: unknown,
  field: string,
  min: number,
  max: number,
): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new HttpError(400, "INVALID_INPUT", `${field} must be a number.`);
  }
  return clampNumber(value, min, max);
}

export function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

export function emailField(value: unknown): string {
  const email = stringField(value, "email", 3, 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new HttpError(400, "INVALID_INPUT", "Enter a valid email address.");
  }
  return email;
}

export function usernameField(value: unknown): string {
  const username = stringField(value, "username", 3, 30).toLowerCase();
  if (!/^[a-z0-9_]{3,30}$/.test(username)) {
    throw new HttpError(
      400,
      "INVALID_USERNAME",
      "Username must be 3-30 lowercase characters (a-z, 0-9, _).",
    );
  }
  return username;
}

/** Opaque, stable pagination cursor. Callers never see offsets. */
export function encodeOffset(offset: number): string {
  return btoa(String(offset))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export function decodeOffset(cursor: string | null): number {
  if (!cursor) return 0;
  try {
    const parsed = Number(
      atob(cursor.replace(/-/g, "+").replace(/_/g, "/")),
    );
    return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : 0;
  } catch {
    return 0;
  }
}

export function getRequestId(request: Request): string {
  const supplied = request.headers.get("x-request-id");
  if (supplied && /^[A-Za-z0-9._:-]{1,128}$/.test(supplied)) return supplied;
  return crypto.randomUUID();
}

function corsHeaders(request: Request, env: Env): Record<string, string> {
  const configured = (env.ALLOWED_ORIGINS ?? "*")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const origin = request.headers.get("origin");
  const headers: Record<string, string> = {
    "access-control-allow-methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
    "access-control-allow-headers":
      "authorization,content-type,x-request-id,x-client-version,x-platform,x-user-id,x-user-name,x-session-id",
    "access-control-expose-headers": "x-request-id",
    "access-control-max-age": "86400",
    vary: "Origin",
  };
  if (configured.includes("*")) headers["access-control-allow-origin"] = "*";
  else if (origin && configured.includes(origin)) {
    headers["access-control-allow-origin"] = origin;
  }
  return headers;
}

export function preflight(request: Request, env: Env): Response | null {
  if (request.method !== "OPTIONS") return null;
  return new Response(null, {
    status: 204,
    headers: corsHeaders(request, env),
  });
}

export function json(
  body: unknown,
  request: Request,
  env: Env,
  status = 200,
  extra?: Record<string, string>,
): Response {
  const headers = new Headers(corsHeaders(request, env));
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  headers.set("x-request-id", getRequestId(request));
  for (const [key, value] of Object.entries(extra ?? {})) {
    headers.set(key, value);
  }
  return new Response(JSON.stringify(body), { status, headers });
}

export function empty(request: Request, env: Env): Response {
  return new Response(null, {
    status: 204,
    headers: {
      ...corsHeaders(request, env),
      "cache-control": "no-store",
      "x-request-id": getRequestId(request),
    },
  });
}

export function failure(error: unknown, request: Request, env: Env): Response {
  if (error instanceof HttpError) {
    return json(
      { code: error.code, message: error.message },
      request,
      env,
      error.status,
    );
  }
  console.error(
    "[liner-api] unhandled error",
    error instanceof Error ? (error.stack ?? error.message) : String(error),
  );
  return json(
    { code: "INTERNAL_ERROR", message: "Something went wrong. Try again." },
    request,
    env,
    500,
  );
}

export async function readJson<T = Record<string, unknown>>(
  request: Request,
): Promise<T> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new HttpError(413, "PAYLOAD_TOO_LARGE", "The request body is too large.");
  }
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) {
    throw new HttpError(413, "PAYLOAD_TOO_LARGE", "The request body is too large.");
  }
  if (!text.trim()) return {} as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new HttpError(400, "INVALID_INPUT", "The request body must be valid JSON.");
  }
}

export function requireEnv(value: string | undefined, name: string): string {
  if (!value) {
    throw new HttpError(
      500,
      "SERVER_MISCONFIGURED",
      `${name} is not configured on this server.`,
    );
  }
  return value;
}
