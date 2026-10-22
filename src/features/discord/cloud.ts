import { api } from "@/shared/api";
import type {
  DiscordCloudStatus,
  DiscordLinkSession,
  DiscordLinkStatus,
  DiscordPresenceNotification,
} from "@/shared/contracts";
import { nativeOpenExternal } from "@/platform";
import type { DiscordRpcSettings, DiscordRpcStatePayload } from "./contracts";

/**
 * Cloud presence (PreMiD's model).
 *
 * Discord's local RPC only exists next to a desktop client, so a phone can never
 * reach it. Instead the account is linked once (`/v1/me/discord/link`, completed
 * in the browser) and playback is reported to the backend, which keeps the
 * activity alive through Discord's Social SDK. The wire contract lives in
 * `@/shared/contracts/discord`; the backend side is described in
 * docs/discord-cloud.md.
 *
 * Sends are rate limited the same way as the desktop manager (electron/discord.ts):
 * one update per 4 s, skipped when nothing changed, so Discord's own limit is
 * never approached.
 */

const MIN_SEND_INTERVAL_MS = 4_000;

export function buildPresenceNotification(
  payload: DiscordRpcStatePayload,
  settings: DiscordRpcSettings,
): DiscordPresenceNotification {
  return {
    status: payload.status,
    track: payload.track,
    positionMs: Math.max(0, Math.round(payload.positionMs)),
    durationMs: Math.max(0, Math.round(payload.durationMs)),
    ...(payload.artistImageUrl ? { artistImageUrl: payload.artistImageUrl } : {}),
    settings: {
      enabled: settings.enabled,
      statusDisplayType: settings.statusDisplayType,
      showArtwork: settings.showArtwork,
      showArtistSmallImage: settings.showArtistSmallImage,
      showTime: settings.showTime,
      showPaused: settings.showPaused,
      showButton: settings.showButton,
      showDownloadButton: settings.showDownloadButton,
    },
  };
}

type Send = (notification: DiscordPresenceNotification) => Promise<unknown>;

export class DiscordCloudPresence {
  private lastSentJson: string | null = null;
  private lastSentAt = 0;
  private pending: DiscordPresenceNotification | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly send: Send = (notification) => api.sendDiscordPresence(notification),
    private readonly now: () => number = Date.now,
  ) {}

  queue(notification: DiscordPresenceNotification): void {
    const json = JSON.stringify(notification);
    if (json === this.lastSentJson) return;
    if (this.pending && JSON.stringify(this.pending) === json) return;
    this.pending = notification;
    if (this.timer) return;
    this.flushWhenAllowed();
  }

  /** Clear the activity (unlink, disable, logout). Not rate limited: Discord has to see it. */
  clear(settings: DiscordRpcSettings): void {
    this.cancel();
    const notification: DiscordPresenceNotification = {
      status: "idle",
      track: null,
      positionMs: 0,
      durationMs: 0,
      settings: buildPresenceNotification(
        { status: "idle", track: null, positionMs: 0, durationMs: 0 },
        settings,
      ).settings,
    };
    this.lastSentJson = JSON.stringify(notification);
    this.lastSentAt = this.now();
    void this.send(notification).catch(() => {});
  }

  /** Forget the throttling state (new account, new backend session). */
  reset(): void {
    this.cancel();
    this.lastSentJson = null;
    this.lastSentAt = 0;
  }

  private flushWhenAllowed(): void {
    const wait = Math.max(0, MIN_SEND_INTERVAL_MS - (this.now() - this.lastSentAt));
    if (wait > 0) {
      this.timer = setTimeout(() => {
        this.timer = null;
        this.flushWhenAllowed();
      }, wait);
      return;
    }
    const notification = this.pending;
    this.pending = null;
    if (!notification) return;
    this.lastSentJson = JSON.stringify(notification);
    this.lastSentAt = this.now();
    void this.send(notification).catch(() => {
      // A failed push must never surface as a playback error; the next change retries.
      this.lastSentJson = null;
    });
  }

  private cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending = null;
  }
}

export const cloudPresence = new DiscordCloudPresence();

/** Open the browser sign-in page. Android/iOS use the native browser, Electron its window-open handler. */
export function openDiscordLink(url: string): boolean {
  if (!/^https:\/\//i.test(url)) return false;
  if (nativeOpenExternal(url)) return true;
  if (typeof window === "undefined" || typeof window.open !== "function") return false;
  window.open(url, "_blank", "noopener,noreferrer");
  return true;
}

export function isDiscordCloudMissing(err: unknown): boolean {
  const status =
    typeof err === "object" && err !== null && "status" in err
      ? Number((err as { status?: unknown }).status)
      : NaN;
  return status === 404 || status === 501;
}

export async function fetchDiscordCloudStatus(): Promise<DiscordCloudStatus> {
  return api.getDiscordCloudStatus();
}

export async function startDiscordLink(): Promise<DiscordLinkSession> {
  return api.startDiscordLink();
}

export async function fetchDiscordLinkStatus(id: string): Promise<DiscordLinkStatus> {
  return api.getDiscordLinkStatus(id);
}

export async function unlinkDiscord(): Promise<void> {
  return api.unlinkDiscord();
}
