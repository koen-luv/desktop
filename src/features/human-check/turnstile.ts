/**
 * The Turnstile widget created for Liner. The site key is public — it only names
 * the widget; the matching secret stays on the api and is never shipped here.
 * `VITE_TURNSTILE_SITE_KEY` lets a build point at a different widget (a staging
 * one, or a replacement key) without a code change.
 */
export const TURNSTILE_SITE_KEY =
  (import.meta.env.VITE_TURNSTILE_SITE_KEY as string | undefined)?.trim() ||
  "0x4AAAAAAFwIpK7QKp-h3zap";

// explicit rendering: the widget is mounted by the react component, not scanned
// out of the dom on script load
const SCRIPT_SRC =
  "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

export interface TurnstileOptions {
  sitekey: string;
  action?: string;
  theme?: "light" | "dark" | "auto";
  language?: string;
  size?: "normal" | "compact" | "flexible";
  callback?: (token: string) => void;
  "error-callback"?: (code?: string) => void;
  "expired-callback"?: () => void;
  "timeout-callback"?: () => void;
}

export interface TurnstileApi {
  render(container: HTMLElement, options: TurnstileOptions): string | undefined;
  reset(widgetId?: string): void;
  remove(widgetId?: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let loading: Promise<TurnstileApi> | null = null;

/**
 * Loads Cloudflare's script once and resolves with the global api. Turnstile is
 * only defined after the script has executed, so resolving on `load` is what
 * makes `render` safe to call immediately.
 */
export function loadTurnstile(): Promise<TurnstileApi> {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return Promise.reject(new Error("Turnstile needs a browser"));
  }
  if (window.turnstile) return Promise.resolve(window.turnstile);
  if (loading) return loading;

  loading = new Promise<TurnstileApi>((resolve, reject) => {
    const script = document.createElement("script");
    script.src = SCRIPT_SRC;
    script.async = true;
    script.defer = true;
    script.onload = () => {
      if (window.turnstile) resolve(window.turnstile);
      else reject(new Error("Turnstile did not initialise"));
    };
    script.onerror = () => reject(new Error("Turnstile failed to load"));
    document.head.appendChild(script);
  }).catch((error: unknown) => {
    // a later attempt may still succeed (offline, blocked, flaky dns)
    loading = null;
    throw error;
  });

  return loading;
}
