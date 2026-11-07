/**
 * Discord channel webhooks.
 *
 * Rich Presence needs a Discord client on the same machine. A channel webhook
 * needs nothing: the user pastes a webhook URL once and Liner can announce new
 * songs or share a playlist from any device, including phones and the web.
 */

import { api } from "@/shared/api";

export interface DiscordWebhookSettings {
  enabled: boolean;
  url: string;
}

export const DEFAULT_DISCORD_WEBHOOK_SETTINGS: DiscordWebhookSettings = {
  enabled: false,
  url: "",
};

const WEBHOOK_URL_PATTERN =
  /^https:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/(?:v\d+\/)?webhooks\/\d+\/[\w-]+$/i;

/** Only our own webhook URLs are accepted, so a pasted channel link never leaks a token elsewhere. */
export function isValidDiscordWebhookUrl(value: string): boolean {
  return WEBHOOK_URL_PATTERN.test(value.trim());
}

interface DiscordEmbed {
  title?: string;
  description?: string;
  url?: string;
  color?: number;
  thumbnail?: { url: string };
  footer?: { text: string };
  timestamp?: string;
}

interface DiscordWebhookPayload {
  username?: string;
  content?: string;
  embeds?: DiscordEmbed[];
}

const EMBED_COLOR = 0x8b5cf6;

async function postDiscordWebhook(
  url: string,
  payload: DiscordWebhookPayload,
): Promise<void> {
  if (!isValidDiscordWebhookUrl(url)) {
    throw new Error("Invalid Discord webhook URL");
  }
  // Discord rejects requests that carry a browser origin. The API forwards the
  // message instead, which keeps the feature working in every WebView too.
  await api.sendDiscordWebhook(
    url.trim(),
    payload as unknown as Record<string, unknown>,
  );
}

export interface DiscordWebhookTrack {
  id: string;
  title: string;
  artist: string;
  album?: string;
  coverUrl?: string;
}

export async function sendNowPlayingWebhook(
  url: string,
  track: DiscordWebhookTrack,
): Promise<void> {
  const description = [track.artist, track.album].filter(Boolean).join(" · ");
  await postDiscordWebhook(url, {
    username: "Liner",
    embeds: [
      {
        title: track.title,
        url: `https://link.tryliner.fun/track?id=${encodeURIComponent(track.id)}`,
        description: description || undefined,
        color: EMBED_COLOR,
        ...(track.coverUrl ? { thumbnail: { url: track.coverUrl } } : {}),
        footer: { text: "Now playing on Liner" },
        timestamp: new Date().toISOString(),
      },
    ],
  });
}

export interface DiscordWebhookPlaylist {
  id?: string;
  title: string;
  trackCount?: number;
  coverUrl?: string;
}

export async function sendPlaylistWebhook(
  url: string,
  playlist: DiscordWebhookPlaylist,
): Promise<void> {
  const description =
    typeof playlist.trackCount === "number"
      ? `${playlist.trackCount} ${playlist.trackCount === 1 ? "track" : "tracks"}`
      : undefined;
  await postDiscordWebhook(url, {
    username: "Liner",
    embeds: [
      {
        title: playlist.title,
        ...(playlist.id
          ? {
              url: `https://link.tryliner.fun/playlist?id=${encodeURIComponent(playlist.id)}`,
            }
          : {}),
        description,
        color: EMBED_COLOR,
        ...(playlist.coverUrl ? { thumbnail: { url: playlist.coverUrl } } : {}),
        footer: { text: "Shared from Liner" },
      },
    ],
  });
}

export async function sendTestWebhook(url: string): Promise<void> {
  await postDiscordWebhook(url, {
    username: "Liner",
    content: "Liner is connected to this channel.",
  });
}
