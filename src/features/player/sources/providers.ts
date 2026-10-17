import type { Track } from "@/shared/types";
import { isCodecSupported } from "./codecSupport";
import {
  classifySourceError,
  resolveDirectInnertubeStream,
  resolveProxyInnertubeStream,
} from "../engine/streamResolver";
import type { ResolveContext, ResolvedStream, SourceProvider } from "./types";

/**
 * Legitimate playback sources for Liner.
 *
 * Every provider resolves streams through the app's existing signed playback
 * session API (`POST /v1/tracks/:id/playback`). No stream URL is invented and
 * no provider endpoint is scraped:
 *
 *  - `liner-direct-opus`  — direct Innertube player request, WebM/Opus (default).
 *  - `liner-direct-aac`   — direct Innertube player request, MP4/AAC.
 *  - `liner-proxy-aac`    — Liner's own proxy transport (used when the resolver
 *                           explicitly supports it; 404 otherwise).
 *
 * Providers are ranked by expected reliability and codec compatibility, so a
 * browser that cannot decode Opus (e.g. Safari) never receives an Opus stream.
 */

interface LinerProviderConfig {
  id: string;
  label: string;
  priority: number;
  transport: "direct" | "proxy";
  preferredCodec?: "aac" | "opus";
  /** mime/codec pair that must be decodable on this platform. */
  mime: string;
  codec?: string;
}

function createLinerProvider(config: LinerProviderConfig): SourceProvider {
  return {
    id: config.id,
    priority: config.priority,
    label: config.label,

    supports(track: Track): boolean {
      if (!track?.id) return false;
      return isCodecSupported(config.mime, config.codec);
    },

    matchConfidence(): number {
      // Streams are resolved by the exact catalog id we ask for, so any
      // returned recording is the requested one unless the provider says
      // otherwise (validated in the resolver via `providerTrackId`).
      return 1;
    },

    async resolve(ctx: ResolveContext): Promise<ResolvedStream> {
      const options = {
        signal: ctx.signal,
        preferredCodec: config.preferredCodec,
        providerId: config.id,
      };
      try {
        if (config.transport === "proxy") {
          return await resolveProxyInnertubeStream(ctx.track, options);
        }
        return await resolveDirectInnertubeStream(ctx.track, options);
      } catch (err) {
        throw classifySourceError(err, config.id);
      }
    },
  };
}

export const linerDirectOpusProvider = createLinerProvider({
  id: "liner-direct-opus",
  label: "Liner (direct, WebM/Opus)",
  priority: 100,
  transport: "direct",
  mime: "audio/webm",
  codec: "opus",
});

export const linerDirectAacProvider = createLinerProvider({
  id: "liner-direct-aac",
  label: "Liner (direct, MP4/AAC)",
  priority: 90,
  transport: "direct",
  preferredCodec: "aac",
  mime: "audio/mp4",
  codec: "mp4a.40.2",
});

export const linerProxyAacProvider = createLinerProvider({
  id: "liner-proxy-aac",
  label: "Liner (proxy transport)",
  priority: 70,
  transport: "proxy",
  preferredCodec: "aac",
  mime: "audio/mp4",
  codec: "mp4a.40.2",
});

/** Default ordered provider list. Ordering is by priority (descending). */
export const defaultSourceProviders: SourceProvider[] = [
  linerDirectOpusProvider,
  linerDirectAacProvider,
  linerProxyAacProvider,
];
