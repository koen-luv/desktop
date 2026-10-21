import { describe, it, expect, vi, beforeEach } from "vitest";
import { platformFetch } from "@/platform/http";
import { getClientVisitorData } from "./visitorSession";
import { fetchInnertubeArtist, isChannelId } from "./innertubeArtist";

vi.mock("@/platform/http", () => ({ platformFetch: vi.fn() }));
vi.mock("./visitorSession", () => ({ getClientVisitorData: vi.fn() }));

const fetchMock = vi.mocked(platformFetch);
const visitorMock = vi.mocked(getClientVisitorData);

const CHANNEL = "UCejLdc9Key38LT0OzLQt4Pw";

// Trimmed shapes of the real WEB_REMIX / WEB channel responses.
const MUSIC_PAGE = {
  header: {
    musicImmersiveHeaderRenderer: {
      title: { runs: [{ text: "ONDA ANDAR" }] },
      thumbnail: {
        musicThumbnailRenderer: {
          thumbnail: {
            thumbnails: [
              { url: "https://yt3.googleusercontent.com/abc=w540-h225-p-l90-rj" },
              { url: "https://yt3.googleusercontent.com/abc=w1440-h600-p-l90-rj" },
            ],
          },
        },
      },
      subscriptionButton: {
        subscribeButtonRenderer: {
          longSubscriberCountText: { runs: [{ text: "18.3K subscribers" }] },
        },
      },
    },
  },
  contents: {
    singleColumnBrowseResultsRenderer: {
      tabs: [
        {
          tabRenderer: {
            content: {
              sectionListRenderer: {
                contents: [
                  {
                    musicShelfRenderer: {
                      title: { runs: [{ text: "Top songs" }] },
                      contents: [
                        {
                          musicResponsiveListItemRenderer: {
                            flexColumns: [
                              { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: "cachalot" }] } } },
                              { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: "ONDA ANDAR" }] } } },
                              { musicResponsiveListItemFlexColumnRenderer: { text: { runs: [{ text: "7.8M plays" }] } } },
                            ],
                            thumbnail: {
                              musicThumbnailRenderer: {
                                thumbnail: { thumbnails: [{ url: "https://yt3.googleusercontent.com/art=w60-h60-l90-rj" }] },
                              },
                            },
                            overlay: {
                              musicItemThumbnailOverlayRenderer: {
                                content: {
                                  musicPlayButtonRenderer: {
                                    playNavigationEndpoint: { watchEndpoint: { videoId: "Zrq71nOI3C4" } },
                                  },
                                },
                              },
                            },
                          },
                        },
                      ],
                    },
                  },
                  {
                    musicCarouselShelfRenderer: {
                      header: { musicCarouselShelfBasicHeaderRenderer: { title: { runs: [{ text: "Albums" }] } } },
                      contents: [
                        {
                          musicTwoRowItemRenderer: {
                            title: { runs: [{ text: "KIDSCRY2DAY" }] },
                            subtitle: { runs: [{ text: "2026" }] },
                            thumbnailRenderer: {
                              musicThumbnailRenderer: {
                                thumbnail: { thumbnails: [{ url: "https://yt3.googleusercontent.com/alb=w226-h226-l90-rj" }] },
                              },
                            },
                            navigationEndpoint: { browseEndpoint: { browseId: "MPREb_gS1hiE10hlq" } },
                          },
                        },
                      ],
                    },
                  },
                  {
                    musicCarouselShelfRenderer: {
                      header: { musicCarouselShelfBasicHeaderRenderer: { title: { runs: [{ text: "Singles & EPs" }] } } },
                      contents: [
                        {
                          musicTwoRowItemRenderer: {
                            title: { runs: [{ text: "one way ticket" }] },
                            subtitle: { runs: [{ text: "Single" }, { text: " • " }, { text: "2026" }] },
                            thumbnailRenderer: {
                              musicThumbnailRenderer: {
                                thumbnail: { thumbnails: [{ url: "https://yt3.googleusercontent.com/sgl=w226-h226-l90-rj" }] },
                              },
                            },
                            navigationEndpoint: { browseEndpoint: { browseId: "MPREb_8rxUucZA5mn" } },
                          },
                        },
                        {
                          musicTwoRowItemRenderer: {
                            title: { runs: [{ text: "night ep" }] },
                            subtitle: { runs: [{ text: "EP" }, { text: " • " }, { text: "2025" }] },
                            thumbnailRenderer: {
                              musicThumbnailRenderer: {
                                thumbnail: { thumbnails: [{ url: "https://yt3.googleusercontent.com/epx=w226-h226-l90-rj" }] },
                              },
                            },
                            navigationEndpoint: { browseEndpoint: { browseId: "MPREb_ep123" } },
                          },
                        },
                      ],
                    },
                  },
                ],
              },
            },
          },
        },
      ],
    },
  },
};

const WEB_PAGE = {
  metadata: {
    channelMetadataRenderer: {
      title: "ONDA ANDAR - Topic",
      description: "ONDA ANDAR — рэп-исполнитель",
      avatar: { thumbnails: [{ url: "https://yt3.googleusercontent.com/av=w240-h240-l90-rj" }] },
    },
  },
};

function jsonResponse(payload: unknown, ok = true, status = 200): Response {
  return { ok, status, json: async () => payload } as unknown as Response;
}

function requestedClients(): string[] {
  return fetchMock.mock.calls.map(([, init]) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    return body?.context?.client?.clientName ?? "?";
  });
}

describe("fetchInnertubeArtist", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    visitorMock.mockReset();
    visitorMock.mockResolvedValue("VD123");
    fetchMock.mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      const clientName = body?.context?.client?.clientName;
      return jsonResponse(clientName === "WEB_REMIX" ? MUSIC_PAGE : WEB_PAGE);
    });
  });

  it("accepts only YouTube channel ids", async () => {
    expect(isChannelId(CHANNEL)).toBe(true);
    expect(isChannelId("Taylor Swift")).toBe(false);
    expect(isChannelId("UC123")).toBe(false);
    await expect(fetchInnertubeArtist("Taylor Swift")).rejects.toThrow(/Not a YouTube channel id/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("merges the Music shelves with the WEB metadata", async () => {
    const page = await fetchInnertubeArtist(CHANNEL);

    // Music header wins the title; description/avatar come from WEB metadata.
    expect(page.title).toBe("ONDA ANDAR");
    expect(page.description).toBe("ONDA ANDAR — рэп-исполнитель");
    expect(page.coverUrl).toBe("https://yt3.googleusercontent.com/av=w544-h544-l90-rj");
    expect(page.subscriberCount).toBe("18.3K subscribers");

    expect(page.tracks).toHaveLength(1);
    expect(page.tracks[0]).toMatchObject({
      id: "Zrq71nOI3C4",
      title: "cachalot",
      artists: "ONDA ANDAR",
      artistId: CHANNEL,
      playCount: 7_800_000,
      durationMs: 0,
    });
    expect(page.tracks[0].coverUrl).toBe("https://yt3.googleusercontent.com/art=w544-h544-l90-rj");

    expect(page.albums).toEqual([
      {
        id: "MPREb_gS1hiE10hlq",
        title: "KIDSCRY2DAY",
        coverUrl: "https://yt3.googleusercontent.com/alb=w544-h544-l90-rj",
        releaseDate: "2026",
      },
    ]);
    expect(page.singles).toHaveLength(2);
    expect(page.singles[0]).toMatchObject({ id: "MPREb_8rxUucZA5mn", releaseDate: "2026" });
    expect(page.singles[0].releaseTypeHint).toBeUndefined();
    expect(page.singles[1]).toMatchObject({ id: "MPREb_ep123", releaseDate: "2025", releaseTypeHint: "ep" });
  });

  it("sends the visitor session with both client requests", async () => {
    await fetchInnertubeArtist(CHANNEL);

    expect(requestedClients().sort()).toEqual(["WEB", "WEB_REMIX"]);
    for (const [, init] of fetchMock.mock.calls) {
      const body = JSON.parse(String(init?.body ?? "{}"));
      expect(body.browseId).toBe(CHANNEL);
      expect(body.context.client.visitorData).toBe("VD123");
    }
  });

  it("survives the WEB request failing by falling back to Music-only data", async () => {
    fetchMock.mockImplementation(async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      if (body?.context?.client?.clientName === "WEB") return jsonResponse({}, false, 500);
      return jsonResponse(MUSIC_PAGE);
    });

    const page = await fetchInnertubeArtist(CHANNEL);

    expect(page.title).toBe("ONDA ANDAR");
    expect(page.description).toBe("");
    // No WEB avatar: cover falls back to the Music header art, squared.
    expect(page.coverUrl).toBe("https://yt3.googleusercontent.com/abc=w544-h544-p-l90-rj");
    expect(page.tracks).toHaveLength(1);
  });

  it("throws when both clients fail", async () => {
    fetchMock.mockImplementation(async () => jsonResponse({}, false, 404));
    await expect(fetchInnertubeArtist(CHANNEL)).rejects.toThrow();
  });
});
