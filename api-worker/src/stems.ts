import { HttpError, corsHeaders, getRequestId, json, type Env } from "./http";

/**
 * Stem separation (vocals / drums / bass / other).
 *
 * This cannot run in a Worker: Demucs-class models need a GPU and minutes of
 * memory, not a 128 MB isolate. The Worker is therefore the app's front door to
 * a separation service you run yourself:
 *
 *   STEMS_SERVICE_URL   e.g. https://stems.example.com  (POST /separate)
 *   STEMS_SERVICE_TOKEN optional bearer token sent to that service
 *
 * The service contract is deliberately tiny so any wrapper around demucs works:
 *
 *   POST {STEMS_SERVICE_URL}/separate
 *   { "trackId": "...", "audioUrl": "https://..." }
 *   → { "stems": [ { "name": "vocals"|"drums"|"bass"|"other", "url": "https://..." } ] }
 *
 * With no service configured the endpoint answers 501 STEMS_UNAVAILABLE, which
 * the client shows as "not set up" instead of pretending the feature exists.
 */

const STEM_NAMES = new Set(["vocals", "drums", "bass", "other"]);
const UNAVAILABLE_MESSAGE =
  "Stem separation is not configured on this server. Point STEMS_SERVICE_URL at a Demucs service to enable it.";

interface StemServiceResponse {
  stems?: { name?: string; url?: string }[];
  error?: string;
}

export async function handleStemsRequest(
  request: Request,
  env: Env,
  trackId: string,
): Promise<Response> {
  const serviceUrl = env.STEMS_SERVICE_URL?.trim().replace(/\/+$/, "");
  if (!serviceUrl) {
    throw new HttpError(501, "STEMS_UNAVAILABLE", UNAVAILABLE_MESSAGE);
  }
  if (!/^https?:\/\//i.test(serviceUrl)) {
    throw new HttpError(500, "STEMS_MISCONFIGURED", "STEMS_SERVICE_URL must be an http(s) URL.");
  }

  const body = (await request.json().catch(() => ({}))) as { audioUrl?: string };
  const audioUrl = typeof body.audioUrl === "string" ? body.audioUrl.trim() : "";
  if (!audioUrl || !/^https?:\/\//i.test(audioUrl)) {
    throw new HttpError(400, "INVALID_INPUT", "A playable audioUrl is required to separate stems.");
  }

  const upstream = await fetch(`${serviceUrl}/separate`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(env.STEMS_SERVICE_TOKEN ? { authorization: `Bearer ${env.STEMS_SERVICE_TOKEN}` } : {}),
    },
    body: JSON.stringify({ trackId, audioUrl }),
  }).catch((error: unknown) => {
    throw new HttpError(
      502,
      "STEMS_SERVICE_UNREACHABLE",
      `Separation service unreachable: ${error instanceof Error ? error.message : String(error)}`,
    );
  });

  if (!upstream.ok) {
    const detail = await upstream.text().catch(() => "");
    throw new HttpError(
      502,
      "STEMS_SERVICE_FAILED",
      `Separation service returned HTTP ${upstream.status}${detail ? `: ${detail.slice(0, 200)}` : ""}`,
    );
  }

  const payload = (await upstream.json().catch(() => ({}))) as StemServiceResponse;
  const stems = (payload.stems ?? [])
    .filter((stem) => typeof stem?.url === "string" && /^https?:\/\//i.test(stem.url))
    .map((stem) => ({
      // Only the four names the mixer knows how to show.
      name: STEM_NAMES.has(String(stem.name)) ? String(stem.name) : "other",
      url: stem.url as string,
    }));

  if (stems.length < 2) {
    throw new HttpError(
      502,
      "STEMS_SERVICE_FAILED",
      "Separation service returned fewer than two usable stems.",
    );
  }

  return json({ trackId, stems }, request, env);
}

/** Availability probe used by the client before offering the menu entry. */
export function stemsAvailable(env: Env): boolean {
  return Boolean(env.STEMS_SERVICE_URL?.trim());
}

export function stemsStatusResponse(request: Request, env: Env): Response {
  const headers = corsHeaders(request, env);
  return new Response(
    JSON.stringify({
      available: stemsAvailable(env),
      ...(stemsAvailable(env) ? {} : { reason: UNAVAILABLE_MESSAGE }),
    }),
    {
      status: 200,
      headers: {
        ...headers,
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "x-request-id": getRequestId(request),
      },
    },
  );
}
