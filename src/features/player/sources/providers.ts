import type { Track } from "@/shared/types";
import { api } from "@/shared/api";
import { extractAudioStream } from "@/shared/api/innertubeClient";
import { isCodecSupported, canExecuteDirectInnertubePlans } from "./codecSupport";
import {
  classifySourceError,
  resolveDirectInnertubeStream,
  resolveProxyInnertubeStream,
  resolveSessionStream,
  streamExpiryMs,
} from "../engine/streamResolverLegacy";
import type { ResolveContext, ResolvedStream, SourceProvider } from "./types";

/**
 * Legitimate playback sources for Liner.
 *
 * Every provider resolves streams through the app's existing signed playback
 * session API (`POST /v1/tracks/:id/playback`). No stream URL is invented and
 * no provider endpoint is scraped:
 *
 *  - `liner-auto`         — one session request, server-selected transport and
 *                           codec. This is the app's historical behaviour and
 *                           the most reliable path.
 *  - `liner-direct-aac`   — direct Innertube player request, MP4/AAC.
 *  - `liner-direct-opus`  — direct Innertube player request, WebM/Opus.
 *  - `liner-proxy-aac`    — Liner's own proxy transport (explicit request).
 *
 * Providers are ranked by expected reliability and codec compatibility, so a
 * browser that cannot decode Opus (e.g. Safari) never receives an Opus stream.
 * Direct providers only run where the renderer may call youtube.com directly
 * (Electron / Android native bridge); elsewhere the proxy fallback serves.
 */

interface LinerProviderConfig {
  id: string;
  label: string;
  priority: number;
  /** "auto" = let the server pick the transport in a single round-trip. */
  transport: "auto" | "direct" | "proxy";
  preferredCodec?: "aac" | "opus";
  /** mime/codec pair that must be decodable on this platform. */
  mime?: string;
  codec?: string;
  /** Direct execution requires a CORS-privileged renderer. */
  requiresDirectExecution?: boolean;
}

function createLinerProvider(config: LinerProviderConfig): SourceProvider {
  return {
    id: config.id,
    priority: config.priority,
    label: config.label,

    supports(track: Track): boolean {
      if (!track?.id) return false;
      if (config.requiresDirectExecution && !canExecuteDirectInnertubePlans()) return false;
      if (config.mime && !isCodecSupported(config.mime, config.codec)) return false;
      return true;
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
        if (config.transport === "auto") {
          // Let the server pick the transport — unless this renderer cannot
          // execute Innertube plans directly (plain browser, no CORS bypass),
          // in which case explicitly request the proxy transport.
          const transport = canExecuteDirectInnertubePlans() ? undefined : "proxy";
          const session = await api.createPlaybackSession(
            ctx.track.id,
            config.preferredCodec,
            ctx.signal,
            transport,
          );
          return await resolveSessionStream(ctx.track, session, options);
        }
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

/** Server-selected transport — one round-trip, handles either response shape. */
export const linerAutoProvider = createLinerProvider({
  id: "liner-auto",
  label: "Liner",
  priority: 100,
  transport: "auto",
});

export const linerDirectAacProvider = createLinerProvider({
  id: "liner-direct-aac",
  label: "Liner (direct, MP4/AAC)",
  priority: 90,
  transport: "direct",
  preferredCodec: "aac",
  mime: "audio/mp4",
  codec: "mp4a.40.2",
  requiresDirectExecution: true,
});

export const linerDirectOpusProvider = createLinerProvider({
  id: "liner-direct-opus",
  label: "Liner (direct, WebM/Opus)",
  priority: 85,
  transport: "direct",
  preferredCodec: "opus",
  mime: "audio/webm",
  codec: "opus",
  requiresDirectExecution: true,
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

/**
 * Client-side Innertube extraction (the yt-dlp technique). Runs the Innertube
 * `player` request directly from the renderer, so it needs no Liner backend and
 * keeps working when `api.tryliner.fun` is down. Highest priority: it resolves
 * from the exact videoId (track.id), so the recording is always the one asked
 * for. The Liner providers below remain as fallbacks.
 */
export const innertubeClientProvider: SourceProvider = {
  id: "innertube-client",
  priority: 110,
  label: "YouTube (client extraction)",

  supports(track: Track): boolean {
    if (!track?.id) return false;
    // Only where the renderer may call Innertube directly (Electron / Android
    // native bridge); a plain browser would be blocked by CORS.
    return canExecuteDirectInnertubePlans();
  },

  matchConfidence(): number {
    // Resolved by the exact videoId, so it is the same recording.
    return 1;
  },

  async resolve(ctx: ResolveContext): Promise<ResolvedStream> {
    // Prefer Opus where the platform can decode it, otherwise AAC/MP4.
    const preferredCodec = isCodecSupported("audio/webm", "opus") ? "opus" : "aac";
    try {
      const result = await extractAudioStream(ctx.track.id, preferredCodec, ctx.signal);
      return {
        url: result.url,
        mimeType: result.mimeType,
        codec: result.codec,
        bitrate: result.bitrate,
        expiresAtMs: streamExpiryMs(result.url),
        providerId: "innertube-client",
        providerTrackId: ctx.track.id,
        resolvedAt: Date.now(),
      };
    } catch (err) {
      throw classifySourceError(err, "innertube-client");
    }
  },
};

/** Default ordered provider list. Ordering is by priority (descending). */
export const defaultSourceProviders: SourceProvider[] = [
  innertubeClientProvider,
  linerAutoProvider,
  linerDirectAacProvider,
  linerDirectOpusProvider,
  linerProxyAacProvider,
];
