import { describe, it, expect, beforeEach, vi } from "vitest";
import { useDiscordSettingsStore } from "./discordSettingsStore";
import { DEFAULT_DISCORD_CLIENT_ID } from "../contracts";

describe("discordSettingsStore", () => {
  beforeEach(() => {
    // Reset to defaults
    const store = useDiscordSettingsStore.getState();
    store.setEnabled(true);
    store.resetApplicationId();
    store.setShowArtwork(true);
    store.setShowArtistSmallImage(true);
    store.setShowTime(true);
    store.setShowPaused(true);
    store.setShowButton(true);
  });

  it("initializes with expected default values", () => {
    const state = useDiscordSettingsStore.getState();
    expect(state.enabled).toBe(true);
    expect(state.applicationId).toBe(DEFAULT_DISCORD_CLIENT_ID);
    expect(state.showArtwork).toBe(true);
    expect(state.showArtistSmallImage).toBe(true);
    expect(state.showTime).toBe(true);
    expect(state.showPaused).toBe(true);
    expect(state.showButton).toBe(true);
  });

  it("updates and resets custom application ID", () => {
    const store = useDiscordSettingsStore.getState();
    store.setApplicationId("123456789012345678");
    expect(useDiscordSettingsStore.getState().applicationId).toBe("123456789012345678");

    store.resetApplicationId();
    expect(useDiscordSettingsStore.getState().applicationId).toBe(DEFAULT_DISCORD_CLIENT_ID);
  });

  it("updates individual toggle flags", () => {
    const store = useDiscordSettingsStore.getState();

    store.setShowTime(false);
    expect(useDiscordSettingsStore.getState().showTime).toBe(false);

    store.setShowArtistSmallImage(false);
    expect(useDiscordSettingsStore.getState().showArtistSmallImage).toBe(false);

    store.setShowPaused(false);
    expect(useDiscordSettingsStore.getState().showPaused).toBe(false);

    store.setShowButton(false);
    expect(useDiscordSettingsStore.getState().showButton).toBe(false);

    store.setShowArtwork(false);
    expect(useDiscordSettingsStore.getState().showArtwork).toBe(false);

    store.setEnabled(false);
    expect(useDiscordSettingsStore.getState().enabled).toBe(false);
  });

  it("notifies Electron bridge when settings change", () => {
    const notifySpy = vi.fn();
    (window as any).linerElectron = {
      discordUpdateSettings: notifySpy,
    };

    const store = useDiscordSettingsStore.getState();
    store.setShowTime(true);

    expect(notifySpy).toHaveBeenCalledWith({ showTime: true });
  });
});
