import { getAndroidBridge, onNativeEvent } from "./index";

/**
 * Hosts that do not send usable CORS headers (YouTube visitor bootstrap and the
 * Innertube player). API traffic is handled by the Kotlin bridge for write
 * methods because the production API duplicates Access-Control-Allow-Origin,
 * which Chromium rejects; GETs (including SSE lyrics) are transparently proxied
 * by the WebView layer with corrected CORS headers.
 */
const NATIVE_ONLY_HOST =
  /(^|\.)youtube\.com$|(^|\.)googlevideo\.com$|(^|\.)ytimg\.com$|(^|\.)googleusercontent\.com$|(^|\.)ggpht\.com$/i;
const LINER_API_HOST = /(^|\.)tryliner\.fun$/i;

interface NativeHttpResponse {
  id?: string;
  status?: number;
  ok?: boolean;
  error?: string;
  body?: string;
  headers?: Record<string, string>;
}

function headersToObject(headers: HeadersInit | undefined): Record<string, string> {
  if (!headers) return {};
  if (headers instanceof Headers) {
    const out: Record<string, string> = {};
    headers.forEach((value, key) => {
      out[key] = value;
    });
    return out;
  }
  if (Array.isArray(headers)) {
    return Object.fromEntries(headers);
  }
  return { ...(headers as Record<string, string>) };
}

function bodyToText(body: BodyInit | null | undefined): string | null {
  if (body == null) return null;
  if (typeof body === "string") return body;
  if (body instanceof URLSearchParams) return body.toString();
  return null;
}

function abortError(): DOMException {
  return new DOMException("Aborted", "AbortError");
}

async function nativeFetch(
  bridge: NonNullable<typeof window.LinerAndroid>,
  method: string,
  url: string,
  init: RequestInit,
): Promise<Response> {
  const id =
    typeof crypto !== "undefined" && crypto.randomUUID
      ? crypto.randomUUID()
      : `req_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

  const payload = await new Promise<NativeHttpResponse>((resolve, reject) => {
    let settled = false;
    const finish = (
      action: "resolve" | "reject",
      value: NativeHttpResponse | Error,
    ) => {
      if (settled) return;
      settled = true;
      off();
      clearTimeout(timer);
      init.signal?.removeEventListener("abort", onAbort);
      if (action === "resolve") resolve(value as NativeHttpResponse);
      else reject(value as Error);
    };

    const off = onNativeEvent("httpResponse", (event) => {
      const response = event as NativeHttpResponse;
      if (!response || response.id !== id) return;
      if (!response.status) {
        finish("reject", new TypeError(response.error || "Network request failed"));
      } else {
        finish("resolve", response);
      }
    });

    const onAbort = () => finish("reject", abortError());
    init.signal?.addEventListener("abort", onAbort, { once: true });

    const timer = setTimeout(() => {
      finish("reject", new TypeError("Native request timed out"));
    }, 45_000);

    try {
      bridge.httpRequest(id, method, url, JSON.stringify(headersToObject(init.headers)), bodyToText(init.body));
    } catch (error) {
      finish("reject", error instanceof Error ? error : new Error(String(error)));
    }
  });

  const responseHeaders = new Headers();
  for (const [key, value] of Object.entries(payload.headers ?? {})) {
    if (value) responseHeaders.set(key, value);
  }

  const status = payload.status as number;
  const body =
    status === 204 || status === 205 || status === 304 ? null : (payload.body ?? "");
  return new Response(body, {
    status,
    statusText: payload.ok ? "OK" : "",
    headers: responseHeaders,
  });
}

export async function platformFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<Response> {
  const bridge = getAndroidBridge();
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;

  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    return fetch(input, init);
  }

  const method = (init.method || "GET").toUpperCase();
  const nativeOnly =
    NATIVE_ONLY_HOST.test(host) || (LINER_API_HOST.test(host) && method !== "GET");

  if (!bridge || !nativeOnly || !/^https?:/i.test(url)) {
    return fetch(input, init);
  }
  if (init.body != null && bodyToText(init.body) === null) {
    return fetch(input, init);
  }
  if (init.signal?.aborted) throw abortError();

  return nativeFetch(bridge, method, url, init);
}
