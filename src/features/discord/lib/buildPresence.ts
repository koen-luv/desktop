import type { DiscordActivity } from "../../../../electron/discordRpc";

export interface DiscordPresenceInput {
  status: "idle" | "loading" | "playing" | "paused" | "error";
  title: string;
  artist: string;
  album: string;
  coverUrl?: string;
  positionMs: number;
  nowMs: number;
}

const MAX_FIELD = 128;

function clampField(text: string | undefined | null): string | undefined {
  const value = (text ?? "").trim();
  if (!value) return undefined;
  return value.length > MAX_FIELD ? `${value.slice(0, MAX_FIELD - 1)}…` : value;
}

/**
 * Turns current playback state into a Discord activity.
 *
 * Returns `null` when there is nothing worth showing (no title), which the
 * caller treats as "clear presence". Cover art is only attached when the cover
 * is a plain public http(s) URL — Discord fetches it server-side, and Liner's
 * signed/expiring cover links simply won't render (presence still works).
 */
export function buildDiscordPresence(input: DiscordPresenceInput): DiscordActivity | null {
  const title = clampField(input.title);
  if (!title) return null;

  const artist = clampField(input.artist);
  const album = clampField(input.album);
  const playing = input.status === "playing";

  const activity: DiscordActivity = { details: title, instance: false };

  // Second line: the artist, prefixed with "Paused" only when not playing.
  const state = [playing ? null : "Paused", artist].filter(Boolean).join(" • ");
  if (state) activity.state = state;

  // Elapsed timer is anchored to `start`; Discord ticks it live, so we only
  // send it while playing (a paused track would otherwise keep counting).
  if (playing) {
    const startSec = Math.floor((input.nowMs - Math.max(0, input.positionMs)) / 1000);
    activity.timestamps = { start: startSec };
  }

  const cover = (input.coverUrl ?? "").trim();
  if (cover && /^https?:\/\//i.test(cover)) {
    activity.assets = { large_image: cover, large_text: album || title };
  }

  return activity;
}
