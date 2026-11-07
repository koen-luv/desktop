import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { debouncedStorage } from "@/shared/utils/storage";
import {
  DEFAULT_DISCORD_WEBHOOK_SETTINGS,
  type DiscordWebhookSettings,
} from "../webhook";

interface DiscordWebhookState extends DiscordWebhookSettings {
  setEnabled: (enabled: boolean) => void;
  setUrl: (url: string) => void;
}

export const useDiscordWebhookStore = create<DiscordWebhookState>()(
  persist(
    (set) => ({
      ...DEFAULT_DISCORD_WEBHOOK_SETTINGS,
      setEnabled: (enabled) => set({ enabled }),
      setUrl: (url) => set({ url }),
    }),
    {
      name: "liner_discord_webhook_v1",
      storage: createJSONStorage(() => debouncedStorage),
      partialize: (state): DiscordWebhookSettings => ({
        enabled: state.enabled,
        url: state.url,
      }),
    },
  ),
);
