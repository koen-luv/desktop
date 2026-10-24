import React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/shared/api";
import { useListeningRecap } from "./useListeningRecap";

vi.mock("@/shared/api", () => ({
  api: { getHistory: vi.fn() },
}));

vi.mock("./sessionAwareLoad", () => ({
  useSessionOwner: () => "recap-test-user",
}));

function historyItem(id: string, listenedAt: string) {
  return {
    id: `event-${id}`,
    playbackSessionId: "playback",
    listeningSessionId: "session",
    track: {
      id,
      title: `Track ${id}`,
      artists: [{ id: "artist-1", name: "Test Artist" }],
      durationMs: 180_000,
      cover: { url: "", width: 0, height: 0 },
    },
    playedDurationMs: 90_000,
    completionRate: 0.5,
    completed: false,
    skipped: false,
    loopCount: 0,
    hasSeekBackward: false,
    listenedAt,
  };
}

describe("useListeningRecap", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    vi.clearAllMocks();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("paginates the current year and stops when history reaches an older year", async () => {
    vi.mocked(api.getHistory)
      .mockResolvedValueOnce({
        items: [historyItem("current", new Date(2026, 4, 12, 12).toISOString())],
        nextCursor: "older-page",
      })
      .mockResolvedValueOnce({
        items: [historyItem("previous", new Date(2025, 11, 12, 12).toISOString())],
        nextCursor: "more-history",
      });

    let recap: ReturnType<typeof useListeningRecap> | undefined;
    function TestComponent() {
      recap = useListeningRecap(2026);
      return <button onClick={() => void recap?.load()}>Load recap</button>;
    }

    await act(async () => {
      root.render(<TestComponent />);
    });
    await act(async () => {
      container.querySelector("button")?.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(recap?.data?.plays).toBe(1);
    expect(recap?.data?.topTracks[0]?.id).toBe("current");
    expect(api.getHistory).toHaveBeenCalledTimes(2);
    expect(api.getHistory).toHaveBeenNthCalledWith(1, undefined, 100);
    expect(api.getHistory).toHaveBeenNthCalledWith(2, "older-page", 100);
  });
});
