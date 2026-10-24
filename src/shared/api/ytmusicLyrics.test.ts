import { describe, expect, it } from "vitest";
import {
  extractYouTubeMusicLyrics,
  findYouTubeMusicLyricsBrowseId,
  youtubeMusicVideoId,
} from "./ytmusicLyrics";

describe("YouTube Music lyrics fallback", () => {
  it("accepts raw and prefixed video ids", () => {
    expect(youtubeMusicVideoId("dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(youtubeMusicVideoId("ytmusic:dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(youtubeMusicVideoId("liner-track-uuid")).toBeNull();
    expect(youtubeMusicVideoId(undefined)).toBeNull();
  });

  it("finds a lyrics description shelf anywhere in the response", () => {
    const payload = {
      contents: {
        singleColumnBrowseResultsRenderer: {
          tabs: [
            {
              tabRenderer: {
                title: { runs: [{ text: "Lyrics" }] },
                content: {
                  sectionListRenderer: {
                    contents: [
                      {
                        musicDescriptionShelfRenderer: {
                          header: { runs: [{ text: "Lyrics" }] },
                          description: {
                            runs: [
                              { text: "First line of the song\n" },
                              { text: "Second line of the song\n" },
                            ],
                          },
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

    expect(extractYouTubeMusicLyrics(payload)).toBe(
      "First line of the song\nSecond line of the song",
    );
  });

  it("finds the lyrics tab browse id in watch-next", () => {
    const payload = {
      contents: {
        tabs: [
          { tabRenderer: { title: "Up next" } },
          {
            tabRenderer: {
              title: "Lyrics",
              endpoint: {
                browseEndpoint: {
                  browseId: "MPLYt_example",
                  browseEndpointContextSupportedConfigs: {
                    browseEndpointContextMusicConfig: {
                      pageType: "MUSIC_PAGE_TYPE_TRACK_LYRICS",
                    },
                  },
                },
              },
            },
          },
        ],
      },
    };

    expect(findYouTubeMusicLyricsBrowseId(payload)).toBe("MPLYt_example");
    expect(findYouTubeMusicLyricsBrowseId({ tabs: [] })).toBeNull();
  });

  it("ignores empty or unrelated shelves", () => {
    expect(extractYouTubeMusicLyrics({ a: { musicDescriptionShelfRenderer: { description: { runs: [{ text: "short" }] } } } })).toBeNull();
    expect(extractYouTubeMusicLyrics(null)).toBeNull();
  });
});
