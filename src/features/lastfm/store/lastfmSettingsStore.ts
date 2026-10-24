import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { debouncedStorage } from "@/shared/utils/storage";
import { lastfmGetSession, type LastfmCredentials } from "../lib/lastfmClient";

/**
 * Liner's own Last.fm API application (registered by the project owner).
 * It is the only credential source — the settings UI no longer accepts
 * user-provided keys, so scrobbling works without any setup.
 */
const LASTFM_DEFAULT_API_KEY = "e7bad882b0268344492d389582f21514";
const LASTFM_DEFAULT_API_SECRET = "429ffb72c7aa50452e15a7d303c778ff";

/** Effective credentials: always the built-in Liner application. */
export function resolveLastfmCredentials(
  _apiKey?: string,
  _apiSecret?: string,
): LastfmCredentials {
  return {
    apiKey: LASTFM_DEFAULT_API_KEY,
    apiSecret: LASTFM_DEFAULT_API_SECRET,
  };
}

export interface LastfmSettings {
  /** Master switch for now-playing + scrobble submission. */
  enabled: boolean;
  /** Long-lived session key obtained via the out-of-band auth flow. */
  sessionKey: string | null;
  /** Last.fm username the session belongs to (for the settings UI). */
  username: string | null;
  /**
   * Request token waiting for the user to approve it in Last.fm's browser
   * page. Persisted because the authorization page opens outside the app — a
   * settings tab unmount or a killed WebView must not lose the pending token,
   * otherwise the approval can never be exchanged for a session.
   */
  pendingToken: string | null;
  /** Epoch ms the pending token was requested (when it is stale enough to auto-finish). */
  pendingTokenAt: number | null;
}

interface LastfmSettingsState extends LastfmSettings {
  setEnabled: (enabled: boolean) => void;
  /** Remembers a freshly requested token until the browser approval comes back. */
  setPendingToken: (token: string | null) => void;
  /** Exchanges an authorized request token for a session and stores it. */
  connect: (token: string) => Promise<void>;
  disconnect: () => void;
}

export const useLastfmSettingsStore = create<LastfmSettingsState>()(
  persist(
    (set, get) => ({
      enabled: false,
      sessionKey: null,
      username: null,
      pendingToken: null,
      pendingTokenAt: null,

      setEnabled: (enabled) => set({ enabled }),
      setPendingToken: (pendingToken) =>
        set({ pendingToken, pendingTokenAt: pendingToken ? Date.now() : null }),

      connect: async (token) => {
        const session = await lastfmGetSession(resolveLastfmCredentials(), token);
        set({
          sessionKey: session.key,
          username: session.username,
          enabled: true,
          pendingToken: null,
          pendingTokenAt: null,
        });
      },

      disconnect: () =>
        set({ sessionKey: null, username: null, pendingToken: null, pendingTokenAt: null }),
    }),
    {
      name: "liner_lastfm_settings_v1",
      storage: createJSONStorage(() => debouncedStorage),
      partialize: (state) => ({
        enabled: state.enabled,
        sessionKey: state.sessionKey,
        username: state.username,
        pendingToken: state.pendingToken,
        pendingTokenAt: state.pendingTokenAt,
      }),
      merge: (persisted, current) => {
        const saved = { ...((persisted ?? {}) as Record<string, unknown>) };
        // apiKey/apiSecret were removed from the store; strip any persisted
        // copies so an old custom key can never come back.
        delete saved.apiKey;
        delete saved.apiSecret;
        const merged = { ...current, ...(saved as Partial<LastfmSettingsState>) } as LastfmSettingsState;
        // Builds from before the master switch existed stored a session with
        // no `enabled` flag. Scrobbling was implicitly on for them, so keep it
        // on instead of silently leaving authorized users disabled forever.
        if (saved.sessionKey && typeof saved.enabled !== "boolean") {
          merged.enabled = true;
        }
        return merged;
      },
    },
  ),
);

/** Effective credentials for a settings snapshot (always the built-in app). */
export function lastfmCredentials(
  _state?: Pick<LastfmSettings, never>,
): LastfmCredentials {
  return resolveLastfmCredentials();
}
