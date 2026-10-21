import { getClientVisitorData } from "@/shared/api/visitorSession";

export type InnertubeEndpoint = "search" | "browse" | "next" | "player";

export interface InnertubeProfile {
  clientName: string;
  clientVersion: string;
  clientIdHeader: string;
  origin: string;
  userAgent?: string;
  includeUserAgentInContext?: boolean;
  extraContext?: Record<string, string | number>;
}

export const WEB_REMIX_PROFILE: InnertubeProfile = {
  clientName: "WEB_REMIX",
  clientVersion: "1.20260911.08.00",
  clientIdHeader: "67",
  origin: "https://music.youtube.com",
};

export const USER_AGENT_HEADER_OVERRIDE = "x-liner-user-agent";

export class InnertubeError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "InnertubeError";
  }
}

export interface InnertubeRequestOptions {
  profile?: InnertubeProfile;
  signal?: AbortSignal;
}

function buildClientContext(profile: InnertubeProfile, visitorData: string): Record<string, unknown> {
  return {
    clientName: profile.clientName,
    clientVersion: profile.clientVersion,
    hl: "en",
    gl: "US",
    ...(visitorData ? { visitorData } : {}),
    ...(profile.includeUserAgentInContext && profile.userAgent ? { userAgent: profile.userAgent } : {}),
    ...profile.extraContext,
  };
}

function buildHeaders(profile: InnertubeProfile, visitorData: string): Record<string, string> {
  return {
    "content-type": "application/json",
    accept: "application/json",
    "x-youtube-client-name": profile.clientIdHeader,
    "x-youtube-client-version": profile.clientVersion,
    "x-origin": profile.origin,
    ...(visitorData ? { "x-goog-visitor-id": visitorData } : {}),
    ...(profile.userAgent ? { [USER_AGENT_HEADER_OVERRIDE]: profile.userAgent } : {}),
  };
}

export async function postInnertube(
  endpoint: InnertubeEndpoint,
  body: Record<string, unknown>,
  options: InnertubeRequestOptions = {},
): Promise<unknown> {
  const profile = options.profile ?? WEB_REMIX_PROFILE;
  const visitorData = await getClientVisitorData().catch(() => "");
  const url = `${profile.origin}/youtubei/v1/${endpoint}?prettyPrint=false`;
  const payload = {
    ...body,
    context: {
      client: buildClientContext(profile, visitorData),
      user: { lockedSafetyMode: false },
    },
  };

  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: buildHeaders(profile, visitorData),
      body: JSON.stringify(payload),
      signal: options.signal,
    });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new InnertubeError("YouTube Music is unreachable.", 0);
  }

  if (!response.ok) {
    throw new InnertubeError(`YouTube Music ${endpoint} failed with HTTP ${response.status}.`, response.status);
  }

  try {
    return (await response.json()) as unknown;
  } catch {
    throw new InnertubeError(`YouTube Music ${endpoint} returned invalid JSON.`, 502);
  }
}
