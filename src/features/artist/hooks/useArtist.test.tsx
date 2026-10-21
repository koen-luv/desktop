import React, { act } from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRoot, Root } from "react-dom/client";
import { api } from "@/shared/api";
import { fetchInnertubeArtist } from "@/shared/api/innertubeArtist";
import { useArtist, type ArtistPageData } from "./useArtist";

vi.mock("@/shared/api", () => ({
  api: {
    getArtist: vi.fn(),
    search: vi.fn(),
  },
  mediaUrl: (url: string) => url,
  toMaxQualityAvatarUrl: (url: string) => url,
  toClientTrack: <T,>(track: T) => track,
}));

vi.mock("@/shared/api/innertubeArtist", () => ({
  fetchInnertubeArtist: vi.fn(),
  isChannelId: (value: string) => /^UC[\w-]{22}$/.test(value),
}));

const getArtist = vi.mocked(api.getArtist);
const search = vi.mocked(api.search);
const fetchInnertubeArtistMock = vi.mocked(fetchInnertubeArtist);

const artistDetails = (name: string, id = "UC000") => ({
  type: "artist" as const,
  id,
  name,
  verified: false,
  bio: "",
  tracks: [],
  albums: [],
  singles: [],
});

let container: HTMLDivElement;
let root: Root;
let latest: { data: ArtistPageData | null; loading: boolean } | null = null;

function Probe({ id }: { id: string }) {
  latest = useArtist(id);
  return null;
}

const flush = async () => {
  await act(async () => {
    for (let i = 0; i < 6; i++) {
      await Promise.resolve();
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

describe("useArtist id resolution", () => {
  beforeEach(() => {
    latest = null;
    getArtist.mockReset();
    search.mockReset();
    fetchInnertubeArtistMock.mockReset();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it("loads the artist directly when the id is a catalog id", async () => {
    getArtist.mockResolvedValue(artistDetails("Drake"));

    await act(async () => {
      root.render(<Probe id="UCECJhbsxgI5hWFz8EU0TY-g" />);
    });
    await flush();

    expect(latest?.data?.title).toBe("Drake");
    expect(search).not.toHaveBeenCalled();
  });

  it("resolves a display name through search before giving up", async () => {
    getArtist
      .mockRejectedValueOnce(new Error("Artist not found"))
      .mockResolvedValueOnce(artistDetails("Taylor Swift", "UC789"));
    search.mockResolvedValue({
      items: [
        { type: "artist", id: "UC789", name: "Taylor Swift" },
        { type: "artist", id: "UC000", name: "Taylor Swift Fan Page" },
      ],
    });

    await act(async () => {
      root.render(<Probe id="Taylor Swift" />);
    });
    await flush();

    // ArtistLink falls back to the display name when a track carries no artist
    // id; that name must be resolved through search instead of dying as a
    // "Artist not found" screen.
    expect(search).toHaveBeenCalledWith("Taylor Swift", "artist");
    expect(getArtist).toHaveBeenNthCalledWith(1, "Taylor Swift");
    expect(getArtist).toHaveBeenNthCalledWith(2, "UC789");
    expect(latest?.data?.title).toBe("Taylor Swift");
    expect(latest?.loading).toBe(false);
  });

  it("prefers the exact name match over the first search result", async () => {
    getArtist
      .mockRejectedValueOnce(new Error("Artist not found"))
      .mockResolvedValueOnce(artistDetails("Mirror Boys", "UC222"));
    search.mockResolvedValue({
      items: [
        { type: "artist", id: "UC111", name: "Mirror Boys Tribute" },
        { type: "artist", id: "UC222", name: "mirror boys" },
      ],
    });

    await act(async () => {
      root.render(<Probe id="Mirror Boys" />);
    });
    await flush();

    expect(getArtist).toHaveBeenNthCalledWith(2, "UC222");
    expect(latest?.data?.title).toBe("Mirror Boys");
  });

  it("stays empty when neither the id nor the name resolves", async () => {
    getArtist.mockRejectedValue(new Error("Artist not found"));
    search.mockRejectedValue(new Error("offline"));

    await act(async () => {
      root.render(<Probe id="Nobody" />);
    });
    await flush();

    expect(latest?.data).toBeNull();
    expect(latest?.loading).toBe(false);
    expect(fetchInnertubeArtistMock).not.toHaveBeenCalled();
  });

  it("browses Innertube directly when the backend artist route 404s", async () => {
    const channelId = "UCECJhbsxgI5hWFz8EU0TY-g";
    getArtist.mockRejectedValue(
      new Error(`Route GET:/v1/artists/${channelId} not found`),
    );
    fetchInnertubeArtistMock.mockResolvedValue({
      title: "ONDA ANDAR",
      description: "bio",
      coverUrl: "cover",
      subscriberCount: "18.3K subscribers",
      tracks: [
        {
          id: "Zrq71nOI3C4",
          title: "cachalot",
          artists: "ONDA ANDAR",
          artistId: channelId,
          coverUrl: "art",
          durationMs: 0,
          playCount: 7_800_000,
        },
      ],
      albums: [],
      singles: [],
    });

    await act(async () => {
      root.render(<Probe id={channelId} />);
    });
    await flush();

    // A channel id must go straight to the Innertube browse fallback: the
    // backend artist route is gone and the name search is dead as well.
    expect(fetchInnertubeArtistMock).toHaveBeenCalledWith(channelId);
    expect(search).not.toHaveBeenCalled();
    expect(latest?.data?.title).toBe("ONDA ANDAR");
    expect(latest?.data?.monthlyListeners).toBe("18.3K subscribers");
    expect(latest?.data?.popularSongs[0]?.id).toBe("Zrq71nOI3C4");
    expect(latest?.loading).toBe(false);
  });

  it("browses Innertube with the resolved id when the backend lookup dies", async () => {
    const channelId = "UC789abcdefghijkmnopqrstuv";
    getArtist.mockRejectedValue(new Error("Artist not found"));
    search.mockResolvedValue({
      items: [{ type: "artist", id: channelId, name: "Taylor Swift" }],
    });
    fetchInnertubeArtistMock.mockResolvedValue({
      title: "Taylor Swift",
      description: "",
      coverUrl: "",
      tracks: [],
      albums: [],
      singles: [],
    });

    await act(async () => {
      root.render(<Probe id="Taylor Swift" />);
    });
    await flush();

    expect(getArtist).toHaveBeenNthCalledWith(1, "Taylor Swift");
    expect(getArtist).toHaveBeenNthCalledWith(2, channelId);
    expect(fetchInnertubeArtistMock).toHaveBeenCalledWith(channelId);
    expect(latest?.data?.title).toBe("Taylor Swift");
  });
});
