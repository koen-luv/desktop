import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from "vitest";
import type { DiscordPresenceNotification } from "@/shared/contracts";
import { buildPresenceNotification, DiscordCloudPresence } from "./cloud";
import { DEFAULT_DISCORD_SETTINGS, type DiscordRpcStatePayload } from "./contracts";

type Send = (notification: DiscordPresenceNotification) => Promise<unknown>;

const payload: DiscordRpcStatePayload = {
  status: "playing",
  track: {
    id: "dQw4w9WgXcQ",
    title: "Track title",
    artist: "Artist",
    artistId: "UC123",
    album: "Album",
    coverUrl: "https://covers.tryliner.fun/a.jpg",
    durationMs: 213000,
  },
  positionMs: 42000.6,
  durationMs: 213000,
  artistImageUrl: "https://covers.tryliner.fun/artist.jpg",
};

describe("buildPresenceNotification", () => {
  it("keeps the playback payload and copies the display settings", () => {
    const settings = { ...DEFAULT_DISCORD_SETTINGS, statusDisplayType: "title_artist" as const };
    const notification = buildPresenceNotification(payload, settings);

    expect(notification.status).toBe("playing");
    expect(notification.track).toEqual(payload.track);
    expect(notification.positionMs).toBe(42001);
    expect(notification.durationMs).toBe(213000);
    expect(notification.artistImageUrl).toBe("https://covers.tryliner.fun/artist.jpg");
    expect(notification.settings).toEqual({
      enabled: true,
      statusDisplayType: "title_artist",
      showArtwork: true,
      showArtistSmallImage: true,
      showTime: true,
      showPaused: true,
      showButton: true,
      showDownloadButton: true,
    });
  });

  it("omits the artist image and clamps negative positions", () => {
    const notification = buildPresenceNotification(
      { ...payload, positionMs: -500, artistImageUrl: undefined },
      DEFAULT_DISCORD_SETTINGS,
    );

    expect(notification.positionMs).toBe(0);
    expect("artistImageUrl" in notification).toBe(false);
  });

  it("clears the activity for an idle payload", () => {
    const notification = buildPresenceNotification(
      { status: "idle", track: null, positionMs: 0, durationMs: 0 },
      { ...DEFAULT_DISCORD_SETTINGS, enabled: false },
    );

    expect(notification.status).toBe("idle");
    expect(notification.track).toBeNull();
    expect(notification.settings.enabled).toBe(false);
  });
});

describe("DiscordCloudPresence", () => {
  let now = 1_000_000;
  let send: Mock<Send>;
  let presence: DiscordCloudPresence;

  const notification = (title: string) =>
    buildPresenceNotification(
      { ...payload, track: { ...payload.track!, title } },
      DEFAULT_DISCORD_SETTINGS,
    );

  beforeEach(() => {
    vi.useFakeTimers();
    now = 1_000_000;
    send = vi.fn<Send>().mockResolvedValue(undefined);
    presence = new DiscordCloudPresence(send, () => now);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("sends the first update immediately and drops duplicates", () => {
    presence.queue(notification("one"));
    expect(send).toHaveBeenCalledTimes(1);

    presence.queue(notification("one"));
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("rate limits changes to one update every four seconds", async () => {
    presence.queue(notification("one"));
    presence.queue(notification("two"));
    expect(send).toHaveBeenCalledTimes(1);

    now += 2_000;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(send).toHaveBeenCalledTimes(1);

    now += 2_000;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][0].track?.title).toBe("two");
  });

  it("sends only the latest pending update", async () => {
    presence.queue(notification("one"));
    presence.queue(notification("two"));
    presence.queue(notification("three"));

    now += 4_000;
    await vi.advanceTimersByTimeAsync(4_000);

    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][0].track?.title).toBe("three");
  });

  it("clears the activity immediately, without waiting for the interval", () => {
    presence.queue(notification("one"));
    presence.clear(DEFAULT_DISCORD_SETTINGS);

    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][0].status).toBe("idle");
    expect(send.mock.calls[1][0].track).toBeNull();
  });

  it("retries a failed update on the next change", async () => {
    send.mockRejectedValueOnce(new Error("network"));
    presence.queue(notification("one"));
    await vi.advanceTimersByTimeAsync(0);

    now += 4_000;
    presence.queue(notification("one"));
    await vi.advanceTimersByTimeAsync(4_000);

    expect(send).toHaveBeenCalledTimes(2);
  });
});
