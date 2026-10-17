import { InnertubeError, postInnertube, type InnertubeProfile } from "./innertubeClient";
import { resetClientVisitorData } from "@/shared/api/visitorSession";
import {
  extractAudioFormats,
  playabilityError,
  requiresBotCheck,
  selectBestAudioFormat,
  toResolvedStream,
  type ResolvedAudioStream,
} from "./innertubeAudioFormats";

export type { ResolvedAudioStream } from "./innertubeAudioFormats";

export const VISIONOS_PROFILE: InnertubeProfile = {
  clientName: "VISIONOS",
  clientVersion: "1.04",
  clientIdHeader: "101",
  origin: "https://music.youtube.com",
  userAgent: "com.google.visionos.youtube/1.04(RealityDevice17,1; U; CPU visionOS 26_6_0 like Mac OS X; en_US)",
  extraContext: {
    osName: "visionOS",
    osVersion: "26.6.0.23O770",
    deviceMake: "Apple",
    deviceModel: "RealityDevice17,1",
    platform: "MOBILE",
  },
};

export const ANDROID_VR_PROFILE: InnertubeProfile = {
  clientName: "ANDROID_VR",
  clientVersion: "1.65.10",
  clientIdHeader: "28",
  origin: "https://www.youtube.com",
  userAgent:
    "com.google.android.apps.youtube.vr.oculus/1.65.10 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip",
  includeUserAgentInContext: true,
  extraContext: {
    osName: "Android",
    osVersion: "12L",
    deviceMake: "Oculus",
    deviceModel: "Quest 3",
    androidSdkVersion: 32,
    buildId: "SQ3A.220605.009.A1",
    packageName: "com.google.android.apps.youtube.vr.oculus",
  },
};

export const PLAYBACK_PROFILES: readonly InnertubeProfile[] = [VISIONOS_PROFILE, ANDROID_VR_PROFILE];

let lastWorkingProfile: InnertubeProfile | null = null;

export function resetPlaybackProfilePreference(): void {
  lastWorkingProfile = null;
}

function orderedProfiles(profiles: readonly InnertubeProfile[]): readonly InnertubeProfile[] {
  if (!lastWorkingProfile || !profiles.includes(lastWorkingProfile)) return profiles;
  return [lastWorkingProfile, ...profiles.filter((profile) => profile !== lastWorkingProfile)];
}

async function assertStreamReachable(url: string, signal?: AbortSignal): Promise<void> {
  const probe = new URL(url);
  probe.searchParams.set("range", "0-0");
  const response = await fetch(probe.toString(), { signal });
  await response.body?.cancel().catch(() => undefined);
  if (!response.ok) throw new InnertubeError(`stream url rejected with ${response.status}`, response.status);
}

export interface ResolveAudioOptions {
  signal?: AbortSignal;
  preferredCodec?: "opus" | "aac";
  profiles?: readonly InnertubeProfile[];
}

export function toVideoId(trackId: string): string | null {
  const videoId = trackId.replace(/^yt:/, "");
  return /^[a-zA-Z0-9_-]{11}$/.test(videoId) ? videoId : null;
}

async function resolveWithProfile(
  videoId: string,
  profile: InnertubeProfile,
  options: ResolveAudioOptions,
): Promise<ResolvedAudioStream> {
  const request = () =>
    postInnertube("player", { videoId, contentCheckOk: true, racyCheckOk: true }, { profile, signal: options.signal });
  let response = await request();
  if (requiresBotCheck(response)) {
    resetClientVisitorData();
    response = await request();
  }
  const unplayable = playabilityError(response);
  if (unplayable) throw new InnertubeError(unplayable, 403);
  const best = selectBestAudioFormat(extractAudioFormats(response), options.preferredCodec);
  if (!best) throw new InnertubeError(`${profile.clientName} returned no direct audio formats.`, 502);
  const stream = toResolvedStream(best);
  await assertStreamReachable(stream.url, options.signal);
  return stream;
}

export async function resolveDirectAudioStream(
  trackId: string,
  options: ResolveAudioOptions = {},
): Promise<ResolvedAudioStream> {
  const videoId = toVideoId(trackId);
  if (!videoId) throw new InnertubeError(`Track ${trackId} is not a YouTube video.`, 400);
  const failures: string[] = [];
  for (const profile of orderedProfiles(options.profiles ?? PLAYBACK_PROFILES)) {
    try {
      const stream = await resolveWithProfile(videoId, profile, options);
      lastWorkingProfile = profile;
      return stream;
    } catch (error) {
      if (options.signal?.aborted) throw error;
      failures.push(`${profile.clientName}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new InnertubeError(`Direct audio resolution failed (${failures.join("; ")}).`, 502);
}
