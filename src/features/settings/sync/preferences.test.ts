import { describe, expect, it } from "vitest";
import {
  applySyncedPreferences,
  buildPreferencesSnapshot,
  hasPreferenceContent,
  parseSyncedPreferences,
} from "./preferences";
import { useLastfmSettingsStore } from "@/features/lastfm/store/lastfmSettingsStore";

describe("parseSyncedPreferences", () => {
  it("keeps supported values and drops secrets and invalid fields", () => {
    const parsed = parseSyncedPreferences({
      version: 1,
      theme: "dark",
      locale: "uk",
      appearance: {
        backgroundBlur: 999,
        backgroundDim: -2,
        playerElementOrder: ["volume", "bogus", "controls"],
        sidebar: { opacity: 60, blur: 20, dim: 15 },
      },
      playback: {
        volume: 2,
        repeat: "all",
        audioQuality: "ultra",
        transitionPreset: "off",
      },
      equalizer: { enabled: true, gains: [1, 2, 3, 4, 5] },
      shortcuts: {
        global: { toggleOverlay: "Control+Shift+O" },
        mainApp: { playPause: "Space" },
      },
      overlay: { position: "middle", alwaysOnTop: false },
      discord: { statusDisplayType: "bogus", showTime: false },
      lastfm: { enabled: true, sessionKey: "must-not-sync" },
    });

    expect(parsed.theme).toBe("dark");
    expect(parsed.locale).toBe("uk");
    expect(parsed.appearance?.backgroundBlur).toBe(40);
    expect(parsed.appearance?.backgroundDim).toBe(0);
    expect(parsed.appearance?.playerElementOrder?.[0]).toBe("volume");
    expect(parsed.appearance?.playerElementOrder).toHaveLength(5);
    expect(parsed.appearance?.playerElementOrder).not.toContain("bogus");
    expect(parsed.playback?.volume).toBe(1);
    expect(parsed.playback?.repeat).toBe("all");
    expect(parsed.playback?.audioQuality).toBeUndefined();
    expect(parsed.playback?.transitionPreset).toBe("off");
    expect(parsed.equalizer?.gains).toEqual([1, 2, 3, 4, 5]);
    expect(parsed.shortcuts?.global?.toggleOverlay).toBe("Control+Shift+O");
    expect(parsed.shortcuts?.mainApp?.playPause).toBe("Space");
    expect(parsed.overlay?.position).toBeUndefined();
    expect(parsed.overlay?.alwaysOnTop).toBe(false);
    expect(parsed.discord?.statusDisplayType).toBeUndefined();
    expect(parsed.discord?.showTime).toBe(false);
    expect(parsed.lastfm).toEqual({ enabled: true });
  });

  it("treats malformed payloads as empty preferences", () => {
    expect(parseSyncedPreferences(null)).toEqual({});
    expect(parseSyncedPreferences([])).toEqual({});
    expect(parseSyncedPreferences("nope")).toEqual({});
    expect(parseSyncedPreferences({ appearance: [], playback: null })).toEqual({});
  });
});

describe("hasPreferenceContent", () => {
  it("ignores version-only documents", () => {
    expect(hasPreferenceContent({ version: 1 })).toBe(false);
    expect(hasPreferenceContent({})).toBe(false);
  });

  it("counts real values, including a disabled Last.fm switch", () => {
    expect(hasPreferenceContent({ lastfm: { enabled: false } })).toBe(true);
    expect(hasPreferenceContent({ theme: "system" })).toBe(true);
  });
});

describe("applySyncedPreferences", () => {
  it("never overwrites local Last.fm credentials with a synced switch", () => {
    useLastfmSettingsStore.setState({
      sessionKey: "local-session-key",
      username: "local-user",
      enabled: false,
      pendingToken: null,
      pendingTokenAt: null,
    });

    applySyncedPreferences(
      { lastfm: { enabled: true } },
      { setTheme: () => {}, setLocale: () => {} },
    );

    expect(useLastfmSettingsStore.getState().enabled).toBe(true);
    expect(useLastfmSettingsStore.getState().sessionKey).toBe("local-session-key");
    expect(useLastfmSettingsStore.getState().username).toBe("local-user");

    useLastfmSettingsStore.setState({
      sessionKey: null,
      username: null,
      enabled: false,
      pendingToken: null,
      pendingTokenAt: null,
    });
  });
});

describe("buildPreferencesSnapshot", () => {
  it("contains settings but no wallpaper payload or Last.fm secret", () => {
    const snapshot = buildPreferencesSnapshot("system", "en");

    expect(snapshot.theme).toBe("system");
    expect(snapshot.locale).toBe("en");
    expect(snapshot.appearance).not.toHaveProperty("backgroundImage");
    expect(snapshot.lastfm).toEqual({ enabled: expect.any(Boolean) });
    expect(snapshot).not.toHaveProperty("sessionKey");
    expect(snapshot).not.toHaveProperty("queue");
    expect(snapshot).not.toHaveProperty("currentTrack");
  });
});
