import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, Root } from "react-dom/client";
import { act } from "react";

const session = vi.hoisted(() => ({ userId: "user-a" }));
const getDailyMixes = vi.hoisted(() => vi.fn());

vi.mock("@/shared/api", () => ({
  api: { getDailyMixes },
  getAuthSession: () => ({ user: { id: session.userId } }),
  mediaUrl: (url: string) => url,
  toClientTrack: (track: any) => ({
    id: track.id,
    title: track.title,
    artists: track.artists || "",
    coverUrl: "",
    durationMs: 0,
    playCount: 0,
  }),
}));

import { useDailyMixes } from "./useDailyMixes";

function mixesFor(owner: string) {
  return {
    items: [
      {
        id: "daily-mix-1",
        title: `${owner} mix`,
        description: "",
        clusterArtists: [`${owner} artist`],
        trackCount: 1,
        tracks: [{ id: `${owner}-track`, title: "t", artists: `${owner} artist` }],
      },
    ],
  };
}

function Probe() {
  const { data } = useDailyMixes();
  return <div data-testid="titles">{data.map((mix) => mix.title).join("|")}</div>;
}

describe("useDailyMixes account switch", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    getDailyMixes.mockImplementation(async () => mixesFor(session.userId));
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.removeChild(container);
  });

  it("never shows the previous account's cached mixes after signing in as someone else", async () => {
    session.userId = "user-a";
    await act(async () => {
      root.render(<Probe />);
    });
    expect(container.textContent).toBe("user-a mix");

    act(() => root.unmount());
    root = createRoot(container);
    session.userId = "user-b";

    let firstPaint = "";
    getDailyMixes.mockImplementation(async () => {
      firstPaint = container.textContent ?? "";
      return mixesFor("user-b");
    });
    await act(async () => {
      root.render(<Probe />);
    });

    expect(firstPaint).not.toContain("user-a");
    expect(container.textContent).toBe("user-b mix");
    expect(getDailyMixes).toHaveBeenCalledTimes(2);
  });
});
