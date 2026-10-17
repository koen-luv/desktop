import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

interface DiscordSettingsState {
  /** Master switch. Presence is also implicitly off while clientId is empty. */
  enabled: boolean;
  /** Discord application (client) id. Empty disables the feature entirely. */
  clientId: string;
  setEnabled: (enabled: boolean) => void;
  setClientId: (clientId: string) => void;
}

const DEFAULTS = { enabled: false, clientId: "" };

function notifyElectron(clientId: string, enabled: boolean): void {
  if (typeof window !== "undefined" && window.linerElectron?.discordRpcConfigure) {
    window.linerElectron.discordRpcConfigure(clientId, enabled);
  }
}

export const useDiscordSettingsStore = create<DiscordSettingsState>()(
  persist(
    (set, get) => ({
      ...DEFAULTS,
      setEnabled: (enabled) => {
        set({ enabled });
        notifyElectron(get().clientId, enabled);
      },
      setClientId: (clientId) => {
        // Client ids are numeric snowflakes; trim so a stray paste-space
        // doesn't produce an unusable id.
        const normalized = clientId.trim();
        set({ clientId: normalized });
        notifyElectron(normalized, get().enabled);
      },
    }),
    {
      name: "liner_discord_settings_v1",
      storage: createJSONStorage(() => localStorage),
      onRehydrateStorage: () => (state) => {
        // Push the persisted config to the main process so presence connects on
        // startup, not only after the user touches the setting.
        if (state) notifyElectron(state.clientId, state.enabled);
      },
    },
  ),
);
