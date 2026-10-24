import { describe, expect, it } from "vitest";
import type { Track } from "@/shared/types";
import { sortPlaylistTracks } from "./playlistSort";

const track = (partial: Partial<Track> & Pick<Track, "id" | "title">): Track => ({
  artists: "",
  coverUrl: "",
  durationMs: 180_000,
  playCount: 0,
  ...partial,
});

const tracks: Track[] = [
  track({ id: "1", title: "Zebra", artists: "Beta", album: { id: "a", title: "Second" }, playlistAddedAt: "2026-10-02T10:00:00Z" }),
  track({ id: "2", title: "apple", artists: "Alpha", album: { id: "b", title: "First" }, playlistAddedAt: "2026-10-04T10:00:00Z" }),
  track({ id: "3", title: "Mango", artists: "Gamma", playlistAddedAt: "2026-10-01T10:00:00Z" }),
  track({ id: "4", title: "Banana", artists: "Delta", album: { id: "a", title: "Second" }, playlistAddedAt: "2026-10-03T10:00:00Z" }),
];

const titles = (list: Track[]) => list.map((t) => t.title);

describe("sortPlaylistTracks", () => {
  it("leaves custom order untouched (same reference)", () => {
    expect(sortPlaylistTracks(tracks, "custom")).toBe(tracks);
  });

  it("sorts titles alphabetically, case-insensitive", () => {
    expect(titles(sortPlaylistTracks(tracks, "title"))).toEqual([
      "apple",
      "Banana",
      "Mango",
      "Zebra",
    ]);
  });

  it("sorts by artist", () => {
    expect(titles(sortPlaylistTracks(tracks, "artist"))).toEqual([
      "apple",
      "Zebra",
      "Banana",
      "Mango",
    ]);
  });

  it("groups albums and puts missing albums last", () => {
    expect(titles(sortPlaylistTracks(tracks, "album"))).toEqual([
      "apple",
      "Banana",
      "Zebra",
      "Mango",
    ]);
  });

  it("shows the most recently added items first, unknown dates last", () => {
    expect(titles(sortPlaylistTracks(tracks, "recent"))).toEqual([
      "apple",
      "Banana",
      "Zebra",
      "Mango",
    ]);
  });

  it("does not mutate the input", () => {
    const before = titles(tracks);
    sortPlaylistTracks(tracks, "title");
    expect(titles(tracks)).toEqual(before);
  });
});
