import { create } from "zustand";
import { getAuthSession } from "@/shared/api/auth-session";
import {
  cloudPresence,
  fetchDiscordCloudStatus,
  fetchDiscordLinkStatus,
  isDiscordCloudMissing,
  openDiscordLink,
  startDiscordLink,
  unlinkDiscord,
} from "../cloud";
import { useDiscordSettingsStore } from "./discordSettingsStore";

export type DiscordCloudMode = "unknown" | "available" | "unavailable";
export type DiscordLinkError = "expired" | "failed" | null;

interface DiscordCloudState {
  /** Whether the backend exposes the cloud presence endpoints at all. */
  mode: DiscordCloudMode;
  linked: boolean;
  username?: string;
  linking: boolean;
  error: DiscordLinkError;
  refresh: () => Promise<void>;
  startLink: () => Promise<void>;
  unlink: () => Promise<void>;
}

const LINK_POLL_INTERVAL_MS = 2_000;
const DEFAULT_LINK_TTL_MS = 5 * 60_000;

// Invalidates an in-flight poll when the user starts over, unlinks or logs out.
let linkAttempt = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const useDiscordCloudStore = create<DiscordCloudState>()((set, get) => ({
  mode: "unknown",
  linked: false,
  username: undefined,
  linking: false,
  error: null,

  refresh: async () => {
    if (!getAuthSession()) {
      if (get().linked) cloudPresence.clear(useDiscordSettingsStore.getState());
      cloudPresence.reset();
      linkAttempt += 1;
      set({ linked: false, username: undefined, linking: false, error: null });
      return;
    }
    try {
      const status = await fetchDiscordCloudStatus();
      set({
        mode: "available",
        linked: status.linked,
        username: status.linked ? status.username : undefined,
        error: null,
      });
      if (!status.linked) cloudPresence.reset();
    } catch (err) {
      if (isDiscordCloudMissing(err)) {
        set({ mode: "unavailable", linked: false, username: undefined, linking: false });
      }
      // Network/auth failures keep the last known state; presence pushes retry themselves.
    }
  },

  startLink: async () => {
    if (get().linking) return;
    const attempt = ++linkAttempt;
    set({ linking: true, error: null });

    let session: Awaited<ReturnType<typeof startDiscordLink>>;
    try {
      session = await startDiscordLink();
    } catch (err) {
      if (isDiscordCloudMissing(err)) {
        set({ mode: "unavailable", linking: false });
      } else {
        set({ linking: false, error: "failed" });
      }
      return;
    }

    if (attempt !== linkAttempt) return;
    if (!openDiscordLink(session.url)) {
      set({ linking: false, error: "failed" });
      return;
    }

    const deadline = Date.now() + (session.expiresInMs ?? DEFAULT_LINK_TTL_MS);
    while (attempt === linkAttempt && Date.now() < deadline) {
      await sleep(LINK_POLL_INTERVAL_MS);
      if (attempt !== linkAttempt) return;
      const status = await fetchDiscordLinkStatus(session.id).catch(() => null);
      if (!status) continue;
      if (status.status === "linked") {
        cloudPresence.reset();
        set({
          mode: "available",
          linked: true,
          username: status.username,
          linking: false,
          error: null,
        });
        return;
      }
      if (status.status === "expired") {
        set({ linking: false, error: "expired" });
        return;
      }
      if (status.status === "error") {
        set({ linking: false, error: "failed" });
        return;
      }
    }
    if (attempt === linkAttempt) set({ linking: false, error: "expired" });
  },

  unlink: async () => {
    linkAttempt += 1;
    const settings = useDiscordSettingsStore.getState();
    const wasLinked = get().linked;
    set({ linking: false, error: null });
    try {
      await unlinkDiscord();
    } catch (err) {
      if (!isDiscordCloudMissing(err)) {
        set({ error: "failed" });
        return;
      }
    }
    if (wasLinked) cloudPresence.clear(settings);
    cloudPresence.reset();
    set({ linked: false, username: undefined });
  },
}));
