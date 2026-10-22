import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Track } from "@/shared/types";
import { SourceError, type SourceProvider } from "./types";
import {
  __setCustomProviders,
  invalidateCachedStream,
  resolvePlayback,
} from "./sourceResolver";

const track: Track = {
  id: "dQw4w9WgXcQ",
  title: "Song",
  artists: "Artist",
  durationMs: 200_000,
  coverUrl: "",
  playCount: 0,
};

function makeProvider(
  id: string,
  priority: number,
  losslessCapable: boolean,
  calls: string[],
  fail = false,
): SourceProvider {
  return {
    id,
    label: id,
    priority,
    losslessCapable,
    supports: () => true,
    matchConfidence: () => 1,
    async resolve(ctx) {
      calls.push(ctx.quality);
      if (fail) throw new SourceError("unavailable", "no master", id, 404);
      return {
        url: `https://cdn.example/${id}.flac`,
        mimeType: "audio/flac",
        codec: "flac",
        expiresAtMs: Date.now() + 600_000,
        providerId: id,
        providerTrackId: track.id,
        quality: ctx.quality,
        resolvedAt: Date.now(),
      };
    },
  };
}

describe("source resolver quality tiers", () => {
  beforeEach(() => {
    invalidateCachedStream(track.id);
  });

  afterEach(() => {
    __setCustomProviders(null);
    invalidateCachedStream(track.id);
  });

  it("keeps priority order for lossy tiers", async () => {
    const calls: string[] = [];
    __setCustomProviders([
      makeProvider("youtube", 110, false, calls),
      makeProvider("liner", 100, true, calls),
    ]);

    const resolution = await resolvePlayback({ track, quality: "high" });

    expect(resolution.providerId).toBe("youtube");
    expect(calls).toEqual(["high"]);
  });

  it("tries the lossless-capable source first when lossless is selected", async () => {
    const calls: string[] = [];
    __setCustomProviders([
      makeProvider("youtube", 110, false, calls),
      makeProvider("liner", 100, true, calls),
    ]);

    const resolution = await resolvePlayback({ track, quality: "lossless" });

    expect(resolution.providerId).toBe("liner");
    expect(resolution.stream.quality).toBe("lossless");
    expect(calls).toEqual(["lossless"]);
  });

  it("falls back to the lossy source when no lossless master exists", async () => {
    const calls: string[] = [];
    __setCustomProviders([
      makeProvider("youtube", 110, false, calls),
      makeProvider("liner", 100, true, calls, true),
    ]);

    const resolution = await resolvePlayback({ track, quality: "lossless" });

    expect(resolution.providerId).toBe("youtube");
    expect(calls).toEqual(["lossless", "lossless"]);
  });
});
