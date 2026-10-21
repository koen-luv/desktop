import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { debouncedStorage } from "@/shared/utils/storage";
import { lastfmGetSession, type LastfmCredentials } from "../lib/lastfmClient";

/**
 * Liner's own Last.fm API application (registered by the project owner).
 * Shipped as the default so scrobbling works without any setup; users can
 * still paste their own key/secret to override.
 */
const LASTFM_DEFAULT_API_KEY = "e7bad882b0268344492d389582f21514";
const LASTFM_DEFAULT_API_SECRET = "429ffb72c7aa50452e15a7d303c778ff";

/** Effective credentials: user-provided values win, otherwise the built-in app. */
export function resolveLastfmCredentials(
  apiKey: string | undefined,
  apiSecret: string | undefined,
): LastfmCredentials {
  return {
    apiKey: (apiKey ?? "").trim() || LASTFM_DEFAULT_API_KEY,
    apiSecret: (apiSecret ?? "").trim() || LASTFM_DEFAULT_API_SECRET,
  };
}

export interface LastfmSettings {
  /** Master switch for now-playing + scrobble submission. */
  enabled: boolean;
  /** User-provided Last.fm API application key. */
  apiKey: string;
  /** User-provided Last.fm API application secret. */
  apiSecret: string;
  /** Long-lived session key obtained via the out-of-band auth flow. */
  sessionKey: string | null;
  /** Last.fm username the session belongs to (for the settings UI). */
  username: string | null;
}

interface LastfmSettingsState extends LastfmSettings {
  setEnabled: (enabled: boolean) => void;
  setApiKey: (apiKey: string) => void;
  setApiSecret: (apiSecret: string) => void;
  /** Exchanges an authorized request token for a session and stores it. */
  connect: (token: string) => Promise<void>;
  disconnect: () => void;
}

export const useLastfmSettingsStore = create<LastfmSettingsState>()(
  persist(
    (set, get) => ({
      enabled: false,
      apiKey: "",
      apiSecret: "",
      sessionKey: null,
      username: null,

      setEnabled: (enabled) => set({ enabled }),
      setApiKey: (apiKey) => set({ apiKey: apiKey.trim() }),
      setApiSecret: (apiSecret) => set({ apiSecret: apiSecret.trim() }),

      connect: async (token) => {
        const { apiKey, apiSecret } = resolveLastfmCredentials(get().apiKey, get().apiSecret);
        const session = await lastfmGetSession({ apiKey, apiSecret }, token);
        set({ sessionKey: session.key, username: session.username, enabled: true });
      },

      disconnect: () => set({ sessionKey: null, username: null }),
    }),
    {
      name: "liner_lastfm_settings_v1",
      storage: createJSONStorage(() => debouncedStorage),
      partialize: (state) => ({
        enabled: state.enabled,
        apiKey: state.apiKey,
        apiSecret: state.apiSecret,
        sessionKey: state.sessionKey,
        username: state.username,
      }),
    },
  ),
);

/** Effective credentials for a settings snapshot (built-in app as fallback). */
export function lastfmCredentials(state: LastfmSettings): LastfmCredentials {
  return resolveLastfmCredentials(state.apiKey, state.apiSecret);
}
