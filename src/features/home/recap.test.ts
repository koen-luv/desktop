import { describe, expect, it } from "vitest";
import type { PlaybackHistoryItem } from "@/shared/contracts/history";
import { buildListeningRecap } from "./recap";

function historyItem(
  id: string,
  title: string,
  artists: unknown,
  listenedAt: string,
  playedDurationMs: number,
): PlaybackHistoryItem {
  return {
    id: `event-${id}-${listenedAt}`,
    playbackSessionId: "playback",
    listeningSessionId: "session",
    track: {
      id,
      title,
      artists,
      coverUrl: "",
      durationMs: 180_000,
    } as PlaybackHistoryItem["track"],
    playedDurationMs,
    completionRate: 1,
    completed: true,
    skipped: false,
    loopCount: 0,
    hasSeekBackward: false,
    listenedAt,
  };
}

function localDate(year: number, month: number, day: number): string {
  return new Date(year, month, day, 12).toISOString();
}

describe("buildListeningRecap", () => {
  it("aggregates plays, artists, listening time, and top periods for the selected year", () => {
    const recap = buildListeningRecap(
      [
        historyItem("track-a", "Song A", [{ name: "Artist A" }], localDate(2026, 1, 5), 120_000),
        historyItem("track-a", "Song A", "Artist A", localDate(2026, 1, 5), 60_000),
        historyItem("track-b", "Song B", [{ name: "Artist A" }, { name: "Artist B" }], localDate(2026, 2, 5), 240_000),
        historyItem("old-track", "Old Song", "Artist C", localDate(2025, 11, 15), 300_000),
        historyItem("bad-date", "Unknown date", "Artist D", "not-a-date", 300_000),
      ],
      2026,
    );

    expect(recap.plays).toBe(3);
    expect(recap.listenedMs).toBe(420_000);
    expect(recap.uniqueTracks).toBe(2);
    expect(recap.uniqueArtists).toBe(2);
    expect(recap.activeDays).toBe(2);
    expect(recap.topTracks[0]).toMatchObject({ id: "track-a", plays: 2 });
    expect(recap.topArtists[0]).toMatchObject({ name: "Artist A", plays: 3 });
    expect(recap.topMonth).toBe("March");
    expect(recap.topDay).toBeTruthy();
  });

  it("returns an empty recap when there is no valid listening history", () => {
    expect(buildListeningRecap([], 2026)).toMatchObject({
      year: 2026,
      plays: 0,
      listenedMs: 0,
      uniqueTracks: 0,
      uniqueArtists: 0,
      activeDays: 0,
      topTracks: [],
      topArtists: [],
      topMonth: null,
      topDay: null,
    });
  });
});
