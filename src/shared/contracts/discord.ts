// Discord presence wire contract.
//
// The desktop app talks to the local Discord client directly (electron/discord.ts,
// DiscordRpc.kt on Android); mobile cannot, because Discord's local RPC only
// exists next to a desktop client. The cloud path mirrors PreMiD's model: the
// app links the user's Discord account to their Liner account, then reports the
// playback state to the backend (`/v1/me/discord/*`), which maintains the
// presence through Discord's Social SDK on the user's behalf.
//
// See docs/discord-cloud.md for the flow the backend has to implement.

export type DiscordPresenceStatus =
  | "playing"
  | "paused"
  | "loading"
  | "buffering"
  | "idle"
  | "error";

export interface DiscordPresenceTrack {
  id: string;
  title: string;
  artist: string;
  artistId?: string;
  album?: string;
  coverUrl?: string;
  durationMs: number;
}

export interface DiscordPresenceSettings {
  enabled: boolean;
  statusDisplayType: "artist" | "title" | "artist_title" | "title_artist" | "app";
  showArtwork: boolean;
  showArtistSmallImage: boolean;
  showTime: boolean;
  showPaused: boolean;
  showButton: boolean;
  showDownloadButton: boolean;
}

/** `POST /v1/me/discord/presence` body. */
export interface DiscordPresenceNotification {
  status: DiscordPresenceStatus;
  track: DiscordPresenceTrack | null;
  positionMs: number;
  durationMs: number;
  artistImageUrl?: string;
  /** The backend builds the activity, so it needs the same display options as the desktop client. */
  settings: DiscordPresenceSettings;
}

/** `POST /v1/me/discord/link` response: a one-time browser URL plus the poll handle. */
export interface DiscordLinkSession {
  id: string;
  url: string;
  expiresInMs?: number;
}

export type DiscordLinkState = "pending" | "linked" | "expired" | "error";

/** `GET /v1/me/discord/link/{id}` response. */
export interface DiscordLinkStatus {
  status: DiscordLinkState;
  username?: string;
  message?: string;
}

/** `GET /v1/me/discord` response. */
export interface DiscordCloudStatus {
  linked: boolean;
  username?: string;
}
