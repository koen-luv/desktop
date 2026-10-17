import { describe, it, expect } from "vitest";
import { buildDiscordPresence } from "./buildPresence";

const base = {
  status: "playing" as const,
  title: "Song",
  artist: "Artist",
  album: "Album",
  positionMs: 30_000,
  nowMs: 1_700_000_000_000,
};

describe("buildDiscordPresence", () => {
  it("returns null when there is no title to show", () => {
    expect(buildDiscordPresence({ ...base, title: "   " })).toBeNull();
  });

  it("builds a playing presence with an elapsed start timestamp", () => {
    const activity = buildDiscordPresence(base)!;
    expect(activity.details).toBe("Song");
    expect(activity.state).toBe("Artist");
    expect(activity.instance).toBe(false);
    expect(activity.timestamps?.start).toBe(
      Math.floor((base.nowMs - base.positionMs) / 1000),
    );
  });

  it("omits timestamps when paused and flags it on the state line", () => {
    const activity = buildDiscordPresence({ ...base, status: "paused" })!;
    expect(activity.timestamps).toBeUndefined();
    expect(activity.state).toBe("Paused • Artist");
  });

  it("only attaches cover art for a public http(s) url", () => {
    const withUrl = buildDiscordPresence({
      ...base,
      coverUrl: "https://covers.example/x.jpg",
    })!;
    expect(withUrl.assets?.large_image).toBe("https://covers.example/x.jpg");
    expect(withUrl.assets?.large_text).toBe("Album");

    const nonPublic = buildDiscordPresence({ ...base, coverUrl: "liner://signed/abc" })!;
    expect(nonPublic.assets).toBeUndefined();

    const empty = buildDiscordPresence({ ...base, coverUrl: "" })!;
    expect(empty.assets).toBeUndefined();
  });

  it("truncates over-long fields to Discord's 128-char limit", () => {
    const long = "x".repeat(300);
    const activity = buildDiscordPresence({ ...base, title: long })!;
    expect(activity.details!.length).toBe(128);
    expect(activity.details!.endsWith("…")).toBe(true);
  });
});
