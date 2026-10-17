import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Track } from "@/shared/types";

const mocks = vi.hoisted(() => ({
  bridge: null as unknown,
  onNativeEvent: vi.fn(),
  getCachedStream: vi.fn(),
  resolvePlaybackStream: vi.fn(),
}));

vi.mock("@/platform", () => ({
  getAndroidBridge: () => mocks.bridge,
  onNativeEvent: mocks.onNativeEvent,
}));

vi.mock("./playbackSource", () => ({
  getCachedStream: mocks.getCachedStream,
  resolvePlaybackStream: mocks.resolvePlaybackStream,
}));

import { downloadFileName, downloadTrack, extensionForMimeType } from "./downloadTrack";

const track: Track = {
  id: "abc123",
  title: "Song Title",
  artists: "Artist Name",
  coverUrl: "",
  durationMs: 180_000,
  playCount: 0,
};

const freshStream = {
  url: "https://redirector.example.com/videoplayback?id=abc123",
  mimeType: "audio/webm",
  codec: "opus",
  bitrate: 128_000,
  expiresAtMs: Date.now() + 600_000,
  providerId: "innertube-client",
  providerTrackId: "abc123",
  resolvedAt: Date.now(),
};

describe("downloadFileName", () => {
  it("maps stream mime types to file extensions", () => {
    expect(extensionForMimeType("audio/webm; codecs=opus")).toBe("weba");
    expect(extensionForMimeType("audio/mp4")).toBe("m4a");
    expect(extensionForMimeType("")).toBe("m4a");
  });

  it("sanitizes filesystem-hostile characters out of the name", () => {
    const hostile: Track = { ...track, title: "Song/Title", artists: "Artist: Name" };
    expect(downloadFileName(hostile, "audio/webm")).toBe("Song Title - Artist Name.weba");
  });
});

describe("downloadTrack", () => {
  beforeEach(() => {
    mocks.bridge = null;
    mocks.onNativeEvent.mockReset();
    mocks.getCachedStream.mockReset().mockReturnValue(null);
    mocks.resolvePlaybackStream.mockReset().mockResolvedValue(freshStream);

    // jsdom does not implement object URLs, so stub them like the runtime tests do
    if (!globalThis.URL.createObjectURL) {
      globalThis.URL.createObjectURL = vi.fn((_blob: Blob) => "blob:mock-audio-url");
    } else {
      vi.spyOn(globalThis.URL, "createObjectURL").mockReturnValue("blob:mock-audio-url");
    }
    if (!globalThis.URL.revokeObjectURL) {
      globalThis.URL.revokeObjectURL = vi.fn();
    } else {
      vi.spyOn(globalThis.URL, "revokeObjectURL").mockImplementation(() => {});
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("saves through an anchor download when there is no native bridge", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(new Blob(["audio-bytes"], { type: "audio/webm" }), { status: 200 }),
    );
    const anchor: { href?: string; download?: string } = {};
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      anchor.href = this.href;
      anchor.download = this.download;
    });

    const result = await downloadTrack(track);

    expect(result.success).toBe(true);
    expect(anchor.href).toBe("blob:mock-audio-url");
    expect(anchor.download).toBe("Song Title - Artist Name.weba");
    expect(mocks.resolvePlaybackStream).toHaveBeenCalledWith(track, undefined);
  });

  it("reuses a still-valid cached stream instead of re-resolving", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(new Blob(["x"]), { status: 200 }));
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    mocks.getCachedStream.mockReturnValue({ ...freshStream });

    const result = await downloadTrack(track);

    expect(result.success).toBe(true);
    expect(mocks.resolvePlaybackStream).not.toHaveBeenCalled();
  });

  it("re-resolves when the cached stream URL has expired", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(new Blob(["x"]), { status: 200 }));
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    mocks.getCachedStream.mockReturnValue({ ...freshStream, expiresAtMs: Date.now() - 1_000 });

    const result = await downloadTrack(track);

    expect(result.success).toBe(true);
    expect(mocks.resolvePlaybackStream).toHaveBeenCalledWith(track, undefined);
  });

  it("surfaces the HTTP status when the browser fetch fails", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("forbidden", { status: 403 }));

    const result = await downloadTrack(track);

    expect(result.success).toBe(false);
    expect(result.error).toContain("403");
  });

  it("delegates to the native Android download and resolves its event result", async () => {
    let listener: ((payload: unknown) => void) | null = null;
    mocks.onNativeEvent.mockImplementation(
      (_type: string, callback: (payload: unknown) => void) => {
        listener = callback;
        return () => {
          listener = null;
        };
      },
    );
    const downloadAudio = vi.fn((id: string) => {
      setTimeout(() => {
        listener?.({ id, success: true, filePath: "content://media/external/downloads/42" });
      }, 0);
    });
    mocks.bridge = { downloadAudio };

    const result = await downloadTrack(track);

    expect(downloadAudio).toHaveBeenCalledTimes(1);
    const args = downloadAudio.mock.calls[0] as unknown as string[];
    expect(args[1]).toBe(freshStream.url);
    expect(args[2]).toBe("Song Title - Artist Name.weba");
    expect(args[3]).toBe("audio/webm");
    expect(args[0].length).toBeGreaterThan(8);
    expect(result).toEqual({ success: true, filePath: "content://media/external/downloads/42" });
  });

  it("propagates a native download failure", async () => {
    let listener: ((payload: unknown) => void) | null = null;
    mocks.onNativeEvent.mockImplementation(
      (_type: string, callback: (payload: unknown) => void) => {
        listener = callback;
        return () => {
          listener = null;
        };
      },
    );
    const downloadAudio = vi.fn((id: string) => {
      setTimeout(() => {
        listener?.({ id, success: false, error: "Download failed (HTTP 403)" });
      }, 0);
    });
    mocks.bridge = { downloadAudio };

    const result = await downloadTrack(track);

    expect(result.success).toBe(false);
    expect(result.error).toBe("Download failed (HTTP 403)");
  });
});
