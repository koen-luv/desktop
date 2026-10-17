import { describe, it, expect, vi, beforeEach } from "vitest";
import { useDiscordSettingsStore } from "./discordSettingsStore";

describe("discordSettingsStore", () => {
  const configure = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    (window as unknown as { linerElectron?: unknown }).linerElectron = {
      discordRpcConfigure: configure,
    };
    // Raw setState (not the actions) so resetting doesn't emit notifications.
    useDiscordSettingsStore.setState({ enabled: false, clientId: "" });
  });

  it("defaults to disabled with an empty client id", () => {
    const s = useDiscordSettingsStore.getState();
    expect(s.enabled).toBe(false);
    expect(s.clientId).toBe("");
  });

  it("pushes the (still empty) client id when enabled toggles on", () => {
    useDiscordSettingsStore.getState().setEnabled(true);
    expect(useDiscordSettingsStore.getState().enabled).toBe(true);
    expect(configure).toHaveBeenCalledWith("", true);
  });

  it("trims the client id and pushes it with the current enabled flag", () => {
    useDiscordSettingsStore.getState().setEnabled(true);
    configure.mockClear();

    useDiscordSettingsStore.getState().setClientId("  123456789012345678  ");
    expect(useDiscordSettingsStore.getState().clientId).toBe("123456789012345678");
    expect(configure).toHaveBeenCalledWith("123456789012345678", true);
  });

  it("does not notify electron when it isn't present (web/android)", () => {
    (window as unknown as { linerElectron?: unknown }).linerElectron = undefined;
    expect(() => useDiscordSettingsStore.getState().setEnabled(true)).not.toThrow();
  });
});
