import { createServer, type Server } from "node:http";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Spotify account connect (desktop only).
 *
 * Authorization Code + PKCE against the user's own Spotify account. There is no
 * client secret here and none may be added: the client id is public and PKCE is
 * what protects the code exchange.
 *
 * Spotify requires an exact redirect-URI match and only allows `https` or a
 * loopback address, so the flow opens the system browser and catches the
 * callback on a fixed loopback port. Register exactly:
 *
 *   http://127.0.0.1:43821/callback
 */

export const SPOTIFY_CLIENT_ID = "6c8070649a5d44d3a11599a57510d654";
export const SPOTIFY_REDIRECT_URI = "http://127.0.0.1:43821/callback";
const CALLBACK_PORT = 43821;
const CALLBACK_PATH = "/callback";

/** Read-only scopes: the user's own playlists and liked songs. */
const SCOPES = [
  "playlist-read-private",
  "playlist-read-collaborative",
  "user-library-read",
].join(" ");

const AUTHORIZE_URL = "https://accounts.spotify.com/authorize";
const TOKEN_URL = "https://accounts.spotify.com/api/token";
const AUTH_TIMEOUT_MS = 5 * 60 * 1000;

export interface SpotifyTokens {
  accessToken: string;
  refreshToken: string;
  /** Epoch ms. */
  expiresAt: number;
  scope: string;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

let activeServer: Server | null = null;

function base64Url(buffer: Buffer): string {
  return buffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function createPkcePair(): { verifier: string; challenge: string } {
  const verifier = base64Url(randomBytes(64));
  const challenge = base64Url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

function callbackPage(message: string): string {
  return (
    `<!doctype html><meta charset="utf-8"><title>Neritium</title>` +
    `<body style="font:16px system-ui;padding:32px;background:#101014;color:#f4f3f8">` +
    `<p>${message}</p></body>`
  );
}

async function exchangeCode(
  code: string,
  verifier: string,
  fetchImpl: typeof fetch,
): Promise<SpotifyTokens> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: SPOTIFY_REDIRECT_URI,
    client_id: SPOTIFY_CLIENT_ID,
    code_verifier: verifier,
  });

  const response = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const payload = (await response.json().catch(() => ({}))) as TokenResponse;
  if (!response.ok || !payload.access_token || !payload.refresh_token) {
    throw new Error(
      payload.error_description ||
        payload.error ||
        `Spotify token exchange failed (${response.status})`,
    );
  }
  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token,
    expiresAt: Date.now() + (payload.expires_in ?? 3600) * 1000,
    scope: payload.scope ?? SCOPES,
  };
}

/**
 * Waits for the loopback callback and resolves with tokens, or rejects on
 * timeout, a mismatched `state`, or an OAuth error response.
 */
function awaitCallback(
  fetchImpl: typeof fetch,
  verifier: string,
  state: string,
): Promise<SpotifyTokens> {
  return new Promise<SpotifyTokens>((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const close = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      if (activeServer) {
        try {
          activeServer.close();
        } catch {
          // already closed
        }
        activeServer = null;
      }
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      close();
      reject(error);
    };
    const succeed = (tokens: SpotifyTokens) => {
      if (settled) return;
      settled = true;
      close();
      resolve(tokens);
    };

    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", SPOTIFY_REDIRECT_URI);
      if (url.pathname !== CALLBACK_PATH) {
        response.writeHead(404).end();
        return;
      }

      const respond = (status: number, message: string) => {
        response.writeHead(status, { "content-type": "text/html; charset=utf-8" });
        response.end(callbackPage(message));
      };

      const error = url.searchParams.get("error");
      if (error) {
        respond(400, "Spotify did not authorize this request. You can close this tab.");
        fail(new Error(`Spotify authorization failed: ${error}`));
        return;
      }

      if (!safeEqual(url.searchParams.get("state") ?? "", state)) {
        respond(400, "State mismatch. Close this tab and start again from Neritium.");
        fail(new Error("Spotify authorization returned an unexpected state."));
        return;
      }

      const code = url.searchParams.get("code");
      if (!code) {
        respond(400, "Spotify returned no authorization code.");
        fail(new Error("Spotify returned no authorization code."));
        return;
      }

      respond(200, "Connected. You can close this tab and return to Neritium.");
      exchangeCode(code, verifier, fetchImpl).then(succeed, fail);
    });

    activeServer = server;
    server.on("error", (error: NodeJS.ErrnoException) => {
      fail(
        new Error(
          error.code === "EADDRINUSE"
            ? `Port ${CALLBACK_PORT} is already in use; close whatever is using it and try again.`
            : `Could not start the Spotify callback listener: ${error.message}`,
        ),
      );
    });
    server.listen(CALLBACK_PORT, "127.0.0.1");

    timer = setTimeout(() => fail(new Error("Spotify authorization timed out.")), AUTH_TIMEOUT_MS);
  });
}

/**
 * Runs the full connect flow: opens the browser, waits for the loopback
 * callback, exchanges the code. `openExternal` is injected so this module does
 * not depend on Electron and can be tested without a browser.
 */
export async function connectSpotifyAccount(options: {
  openExternal: (url: string) => void | Promise<void>;
  fetchImpl?: typeof fetch;
  /** Test hooks: pin the PKCE verifier and state. */
  verifier?: string;
  state?: string;
}): Promise<SpotifyTokens> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const verifier = options.verifier ?? createPkcePair().verifier;
  const challenge = base64Url(createHash("sha256").update(verifier).digest());
  const state = options.state ?? base64Url(randomBytes(16));

  const tokens = awaitCallback(fetchImpl, verifier, state);

  const authorizeUrl = new URL(AUTHORIZE_URL);
  authorizeUrl.searchParams.set("client_id", SPOTIFY_CLIENT_ID);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("redirect_uri", SPOTIFY_REDIRECT_URI);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");
  authorizeUrl.searchParams.set("code_challenge", challenge);
  authorizeUrl.searchParams.set("scope", SCOPES);
  authorizeUrl.searchParams.set("state", state);

  await options.openExternal(authorizeUrl.toString());
  return tokens;
}

/** Exchanges a refresh token for a new access token (client id only, no secret). */
export async function refreshSpotifyTokens(
  refreshToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<SpotifyTokens> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: SPOTIFY_CLIENT_ID,
  });
  const response = await fetchImpl(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  const payload = (await response.json().catch(() => ({}))) as TokenResponse;
  if (!response.ok || !payload.access_token) {
    throw new Error(
      payload.error_description ||
        payload.error ||
        `Spotify token refresh failed (${response.status})`,
    );
  }
  return {
    accessToken: payload.access_token,
    refreshToken: payload.refresh_token ?? refreshToken,
    expiresAt: Date.now() + (payload.expires_in ?? 3600) * 1000,
    scope: payload.scope ?? SCOPES,
  };
}
