import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { debouncedStorage } from "@/shared/utils/storage";
import {
  DEFAULT_DISCORD_SETTINGS,
  DEFAULT_DISCORD_CLIENT_ID,
  type DiscordRpcSettings,
  type DiscordStatusDisplayType,
} from "../contracts";

interface DiscordSettingsState extends DiscordRpcSettings {
  setEnabled: (enabled: boolean) => void;
  setApplicationId: (applicationId: string) => void;
  resetApplicationId: () => void;
  setStatusDisplayType: (statusDisplayType: DiscordStatusDisplayType) => void;
  setShowArtwork: (showArtwork: boolean) => void;
  setShowArtistSmallImage: (showArtistSmallImage: boolean) => void;
  setShowTime: (showTime: boolean) => void;
  setShowPaused: (showPaused: boolean) => void;
  setShowButton: (showButton: boolean) => void;
  setShowDownloadButton: (showDownloadButton: boolean) => void;
}

function notifyElectron(patch: Partial<DiscordRpcSettings>) {
  if (typeof window !== "undefined" && window.linerElectron?.discordUpdateSettings) {
    window.linerElectron.discordUpdateSettings(patch);
  }
}

const VALID_STATUS_DISPLAY_TYPES: readonly DiscordStatusDisplayType[] = [
  "artist",
  "title",
  "artist_title",
  "title_artist",
  "app",
] as const;

export const useDiscordSettingsStore = create<DiscordSettingsState>()(
  persist(
    (set) => ({
      ...DEFAULT_DISCORD_SETTINGS,
      setEnabled: (enabled) => {
        set({ enabled });
        notifyElectron({ enabled });
      },
      setApplicationId: (rawId) => {
        if (typeof rawId !== "string") {
          set({ applicationId: DEFAULT_DISCORD_CLIENT_ID });
          notifyElectron({ applicationId: DEFAULT_DISCORD_CLIENT_ID });
          return;
        }
        const trimmed = rawId.trim();
        if (!trimmed || trimmed === DEFAULT_DISCORD_CLIENT_ID) {
          set({ applicationId: DEFAULT_DISCORD_CLIENT_ID });
          notifyElectron({ applicationId: DEFAULT_DISCORD_CLIENT_ID });
          return;
        }
        if (/^\d{17,20}$/.test(trimmed)) {
          set({ applicationId: trimmed });
          notifyElectron({ applicationId: trimmed });
        }
      },
      resetApplicationId: () => {
        set({ applicationId: DEFAULT_DISCORD_CLIENT_ID });
        notifyElectron({ applicationId: DEFAULT_DISCORD_CLIENT_ID });
      },
      setStatusDisplayType: (statusDisplayType) => {
        set({ statusDisplayType });
        notifyElectron({ statusDisplayType });
      },
      setShowArtwork: (showArtwork) => {
        set({ showArtwork });
        notifyElectron({ showArtwork });
      },
      setShowArtistSmallImage: (showArtistSmallImage) => {
        set({ showArtistSmallImage });
        notifyElectron({ showArtistSmallImage });
      },
      setShowTime: (showTime) => {
        set({ showTime });
        notifyElectron({ showTime });
      },
      setShowPaused: (showPaused) => {
        set({ showPaused });
        notifyElectron({ showPaused });
      },
      setShowButton: (showButton) => {
        set({ showButton });
        notifyElectron({ showButton });
      },
      setShowDownloadButton: (showDownloadButton) => {
        set({ showDownloadButton });
        notifyElectron({ showDownloadButton });
      },
    }),
    {
      name: "liner_discord_settings_v1",
      storage: createJSONStorage(() => debouncedStorage),
      partialize: (state): DiscordRpcSettings => ({
        enabled: state.enabled,
        applicationId: state.applicationId,
        statusDisplayType: state.statusDisplayType,
        showArtwork: state.showArtwork,
        showArtistSmallImage: state.showArtistSmallImage,
        showTime: state.showTime,
        showPaused: state.showPaused,
        showButton: state.showButton,
        showDownloadButton: state.showDownloadButton,
      }),
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        if (typeof state.enabled !== "boolean") {
          state.setEnabled(DEFAULT_DISCORD_SETTINGS.enabled);
        }
        if (
          typeof state.applicationId !== "string" ||
          !state.applicationId.trim() ||
          state.applicationId === "1165957668758900787" ||
          !/^\d{17,20}$/.test(state.applicationId.trim())
        ) {
          state.setApplicationId(DEFAULT_DISCORD_CLIENT_ID);
        }
        if (!VALID_STATUS_DISPLAY_TYPES.includes(state.statusDisplayType)) {
          state.setStatusDisplayType(DEFAULT_DISCORD_SETTINGS.statusDisplayType);
        }
        if (typeof state.showArtwork !== "boolean") {
          state.setShowArtwork(DEFAULT_DISCORD_SETTINGS.showArtwork);
        }
        if (typeof state.showArtistSmallImage !== "boolean") {
          state.setShowArtistSmallImage(DEFAULT_DISCORD_SETTINGS.showArtistSmallImage);
        }
        if (typeof state.showTime !== "boolean") {
          state.setShowTime(DEFAULT_DISCORD_SETTINGS.showTime);
        }
        if (typeof state.showPaused !== "boolean") {
          state.setShowPaused(DEFAULT_DISCORD_SETTINGS.showPaused);
        }
        if (typeof state.showButton !== "boolean") {
          state.setShowButton(DEFAULT_DISCORD_SETTINGS.showButton);
        }
        if (typeof state.showDownloadButton !== "boolean") {
          state.setShowDownloadButton(DEFAULT_DISCORD_SETTINGS.showDownloadButton);
        }
      },
    }
  )
);
