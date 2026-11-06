import { useEffect, useRef } from "react";
import { useTheme } from "next-themes";
import { useTranslation, type Locale } from "@/languages";
import { useAuthStore } from "@/features/auth/store/authStore";
import { api } from "@/shared/api";
import { useCustomizationStore } from "../store/customizationStore";
import { usePlayerStore } from "@/features/player/store/playerStore";
import { useEqualizerSettingsStore } from "@/features/player/store/equalizerSettingsStore";
import { useShortcutsStore } from "@/features/shortcuts/store/shortcutsStore";
import { useOverlaySettingsStore } from "@/features/overlay/store/overlaySettingsStore";
import { useDiscordSettingsStore } from "@/features/discord/store/discordSettingsStore";
import { useLastfmSettingsStore } from "@/features/lastfm/store/lastfmSettingsStore";
import {
  applySyncedPreferences,
  buildPreferencesSnapshot,
  hasPreferenceContent,
  parseSyncedPreferences,
  type PartialSyncedPreferences,
  type SyncedTheme,
} from "./preferences";

const SYNC_META_KEY = "liner_preferences_sync_v1";
const PUBLISH_DELAY_MS = 650;
const POLL_INTERVAL_MS = 45_000;
const RETRY_DELAY_MS = 15_000;

interface SyncMeta {
  userId: string;
  dirty: boolean;
  updatedAt: string | null;
}

function readMeta(): SyncMeta | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(SYNC_META_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<SyncMeta>;
    if (
      typeof value.userId !== "string" ||
      typeof value.dirty !== "boolean"
    ) {
      return null;
    }
    return {
      userId: value.userId,
      dirty: value.dirty,
      updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : null,
    };
  } catch {
    return null;
  }
}

function writeMeta(meta: SyncMeta): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(SYNC_META_KEY, JSON.stringify(meta));
  } catch {
    // Settings still sync for this session when storage is unavailable.
  }
}

function storedTheme(): SyncedTheme {
  if (typeof localStorage !== "undefined") {
    const value = localStorage.getItem("theme");
    if (value === "light" || value === "dark" || value === "system") {
      return value;
    }
  }
  return "system";
}

function normalizedTheme(theme: string | undefined): SyncedTheme {
  if (theme === "light" || theme === "dark" || theme === "system") {
    return theme;
  }
  return storedTheme();
}

/**
 * Keeps the account's preference document in step across devices.
 *
 * Local changes are coalesced and published shortly after they happen. Other
 * devices pick them up on focus and with a low-frequency poll. The server
 * timestamp is only used to detect a remote change; if this device has
 * unsynced local edits they win until they are published.
 *
 * Deliberately not synced: wallpaper image bytes, playback queue/position,
 * Last.fm session/token secrets, search history, and device-local caches.
 */
export function usePreferencesSync(): void {
  const { theme, setTheme } = useTheme();
  const { locale, setLocale } = useTranslation();
  const status = useAuthStore((state) => state.status);
  const userId = useAuthStore((state) => state.user?.id);

  const themeRef = useRef<string | undefined>(theme);
  const localeRef = useRef<Locale>(locale);
  const setThemeRef = useRef(setTheme);
  const setLocaleRef = useRef(setLocale);
  const sessionRef = useRef<{ checkForChanges: () => void } | null>(null);

  themeRef.current = theme;
  localeRef.current = locale;
  setThemeRef.current = setTheme;
  setLocaleRef.current = setLocale;

  useEffect(() => {
    if (status !== "authenticated" || !userId) return;

    let stopped = false;
    let ready = false;
    let applying = false;
    let publishing = false;
    let dirty = false;
    let lastSnapshot = "";
    let lastRemoteUpdatedAt: string | null = null;
    let publishTimer: ReturnType<typeof setTimeout> | undefined;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let pollTimer: number | undefined;
    const unsubscribes: Array<() => void> = [];

    const snapshotNow = () =>
      buildPreferencesSnapshot(normalizedTheme(themeRef.current), localeRef.current);

    const writeCurrentMeta = (dirtyValue: boolean) => {
      writeMeta({
        userId,
        dirty: dirtyValue,
        updatedAt: lastRemoteUpdatedAt,
      });
    };

    const applyRemote = (
      preferences: PartialSyncedPreferences,
      updatedAt: string,
    ) => {
      if (stopped) return;
      applying = true;
      try {
        applySyncedPreferences(preferences, {
          setTheme: (value) => {
            themeRef.current = value;
            setThemeRef.current(value);
          },
          setLocale: (value) => {
            localeRef.current = value;
            setLocaleRef.current(value);
          },
        });
      } finally {
        applying = false;
      }
      lastRemoteUpdatedAt = updatedAt;
      dirty = false;
      lastSnapshot = JSON.stringify(snapshotNow());
      writeCurrentMeta(false);
    };

    const schedulePublish = (delay = PUBLISH_DELAY_MS) => {
      if (stopped) return;
      if (publishTimer) clearTimeout(publishTimer);
      publishTimer = setTimeout(() => {
        publishTimer = undefined;
        void publish();
      }, delay);
    };

    const markDirty = () => {
      if (dirty) return;
      dirty = true;
      writeCurrentMeta(true);
    };

    const checkForChanges = () => {
      if (!ready || applying || stopped) return;
      const next = JSON.stringify(snapshotNow());
      if (next === lastSnapshot) return;
      markDirty();
      schedulePublish();
    };

    const publish = async () => {
      if (stopped || !ready || publishing) return;
      const snapshot = snapshotNow();
      const serialized = JSON.stringify(snapshot);
      if (!dirty && serialized === lastSnapshot) return;

      publishing = true;
      try {
        const response = await api.updatePreferences(
          snapshot as unknown as Record<string, unknown>,
        );
        if (stopped) return;
        lastRemoteUpdatedAt = response.updatedAt;
        const current = JSON.stringify(snapshotNow());
        lastSnapshot = serialized;
        if (current === serialized) {
          dirty = false;
          writeCurrentMeta(false);
        } else {
          // A slider moved while the request was in flight; save the newer
          // snapshot instead of treating the response as final.
          dirty = true;
          writeCurrentMeta(true);
          schedulePublish(250);
        }
      } catch {
        if (stopped) return;
        dirty = true;
        writeCurrentMeta(true);
        if (retryTimer) clearTimeout(retryTimer);
        retryTimer = setTimeout(() => {
          retryTimer = undefined;
          void publish();
        }, RETRY_DELAY_MS);
      } finally {
        publishing = false;
      }
    };

    const refreshFromServer = async () => {
      if (
        stopped ||
        !ready ||
        applying ||
        publishing ||
        dirty ||
        (typeof document !== "undefined" && document.visibilityState === "hidden")
      ) {
        return;
      }
      try {
        const response = await api.getPreferences();
        if (stopped || !ready || applying || publishing || dirty) return;
        if (
          response.updatedAt &&
          response.updatedAt !== lastRemoteUpdatedAt
        ) {
          const preferences = parseSyncedPreferences(response.preferences);
          if (hasPreferenceContent(preferences)) {
            applyRemote(preferences, response.updatedAt);
          } else {
            lastRemoteUpdatedAt = response.updatedAt;
          }
        }
      } catch {
        // Network/API failures are picked up by the next focus or poll.
      }
    };

    const start = async () => {
      const meta = readMeta();
      const sameUser = meta?.userId === userId;
      lastSnapshot = JSON.stringify(snapshotNow());

      try {
        const response = await api.getPreferences();
        if (stopped) return;
        lastRemoteUpdatedAt = response.updatedAt;
        const preferences = parseSyncedPreferences(response.preferences);
        const hasRemote =
          Boolean(response.updatedAt) && hasPreferenceContent(preferences);

        if (hasRemote) {
          if (sameUser && meta?.dirty) {
            ready = true;
            dirty = true;
            await publish();
          } else {
            applyRemote(preferences, response.updatedAt ?? new Date().toISOString());
            ready = true;
          }
        } else if (!meta || sameUser) {
          ready = true;
          dirty = true;
          writeCurrentMeta(true);
          await publish();
        } else {
          // A different account is signed in on this device and the account
          // has no cloud document yet. Do not upload the previous account's
          // local settings.
          ready = true;
          writeCurrentMeta(false);
        }
      } catch {
        if (stopped) return;
        ready = true;
        if (sameUser && meta?.dirty) {
          dirty = true;
          writeCurrentMeta(true);
          schedulePublish(RETRY_DELAY_MS);
        } else {
          // The remote state is unknown. Wait for a local edit before writing.
          writeCurrentMeta(false);
        }
      }

      if (stopped) return;

      unsubscribes.push(
        useCustomizationStore.subscribe(checkForChanges),
        usePlayerStore.subscribe(checkForChanges),
        useEqualizerSettingsStore.subscribe(checkForChanges),
        useShortcutsStore.subscribe(checkForChanges),
        useOverlaySettingsStore.subscribe(checkForChanges),
        useDiscordSettingsStore.subscribe(checkForChanges),
        useLastfmSettingsStore.subscribe(checkForChanges),
      );

      if (typeof window !== "undefined") {
        window.addEventListener("focus", refreshFromServer);
        pollTimer = window.setInterval(() => {
          void refreshFromServer();
        }, POLL_INTERVAL_MS);
      }
      if (typeof document !== "undefined") {
        document.addEventListener("visibilitychange", onVisibilityChange);
      }
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void refreshFromServer();
      }
    };

    const session = { checkForChanges };
    sessionRef.current = session;
    void start();

    return () => {
      stopped = true;
      if (publishTimer) clearTimeout(publishTimer);
      if (retryTimer) clearTimeout(retryTimer);
      if (pollTimer) clearInterval(pollTimer);
      for (const unsubscribe of unsubscribes) unsubscribe();
      if (typeof window !== "undefined") {
        window.removeEventListener("focus", refreshFromServer);
      }
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisibilityChange);
      }
      if (sessionRef.current === session) sessionRef.current = null;
    };
  }, [status, userId]);

  // Theme and locale live in providers/localStorage rather than Zustand, so
  // compare them after each provider update as well.
  useEffect(() => {
    if (status === "authenticated") sessionRef.current?.checkForChanges();
  }, [theme, locale, status]);
}

export function PreferencesSync(): null {
  usePreferencesSync();
  return null;
}
