import { getApiBaseUrl } from "./baseUrl";

export type HumanCheckAction = "login" | "register";
export type HumanCheckMode = "off" | "optional" | "required";

export interface HumanCheckRequest {
  action: HumanCheckAction;
  mode: Exclude<HumanCheckMode, "off">;
  /**
   * The api's edge also wants its own clearance cookie. Only a check page served
   * from the api origin can mint that, so the client asks for that page instead
   * of rendering the widget itself.
   */
  edge?: boolean;
  /** Public key returned by the server's challenge, so self-hosted widgets work without a rebuild. */
  siteKey?: string;
}

export type HumanCheckPrompt = (
  request: HumanCheckRequest,
) => Promise<string | null>;

export class HumanCheckCancelledError extends Error {
  constructor() {
    super("The human check was closed.");
    this.name = "HumanCheckCancelledError";
  }
}

let prompt: HumanCheckPrompt | null = null;

export function setHumanCheckPrompt(next: HumanCheckPrompt | null): void {
  prompt = next;
}

export function humanCheckPageUrl(
  action: HumanCheckAction,
  theme?: "light" | "dark",
): string {
  const params = new URLSearchParams({ action });
  if (theme) params.set("theme", theme);
  return `${getApiBaseUrl()}/v1/auth/verify?${params.toString()}`;
}

export function humanCheckOrigin(): string {
  return new URL(getApiBaseUrl()).origin;
}

export function isHumanCheckMode(value: unknown): value is HumanCheckMode {
  return value === "off" || value === "optional" || value === "required";
}

export async function runHumanCheck(
  action: HumanCheckAction,
  mode: HumanCheckMode,
  edge = false,
  siteKey?: string,
): Promise<string | undefined> {
  if (mode === "off") return undefined;
  const token = prompt ? await prompt({ action, mode, edge, siteKey }) : null;
  if (token) return token;
  if (mode === "required") throw new HumanCheckCancelledError();
  return undefined;
}
