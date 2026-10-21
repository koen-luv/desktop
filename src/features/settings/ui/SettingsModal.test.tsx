import React, { act } from "react";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRoot, Root } from "react-dom/client";
import SettingsModal from "./SettingsModal";
import { useModalStore } from "@/features/library/store/modalStore";
import { createTranslatorSync } from "@/languages";

// StorageTab imports lottie-web, whose player touches a canvas getContext()
// that jsdom does not implement. The animation never starts under test.
vi.mock("lottie-web", () => ({
  default: {
    loadAnimation: () => ({ destroy: () => {}, setSpeed: () => {}, pause: () => {} }),
  },
}));

const tEn = createTranslatorSync("en");

const CATEGORY_TITLES = [
  tEn("settings.categories.playback.title"),
  tEn("settings.categories.appearance.title"),
  tEn("settings.categories.overlay.title"),
  tEn("settings.categories.storage.title"),
  tEn("settings.categories.about.title"),
];

let container: HTMLDivElement;
let root: Root;

const text = (el: Element | null | undefined) =>
  (el?.textContent ?? "").replace(/\s+/g, " ").trim();

const bodyText = () => text(document.body);

const buttons = () => Array.from(document.body.querySelectorAll<HTMLButtonElement>("button"));

const buttonIncluding = (needle: string) =>
  buttons().find((btn) => text(btn).includes(needle));

const buttonByAria = (label: string) =>
  document.body.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);

const click = async (el: Element | null | undefined, what: string) => {
  if (!el) throw new Error(`missing element to click: ${what}`);
  await act(async () => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  });
};

const typeIntoSettingsSearch = async (value: string) => {
  const input = document.body.querySelector<HTMLInputElement>(
    `input[placeholder="${tEn("settings.search_placeholder")}"]`,
  );
  if (!input) throw new Error("settings search input not found");
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

describe("SettingsModal two-level menus", () => {
  beforeEach(() => {
    if (!window.matchMedia) {
      window.matchMedia = ((query: string) => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => false,
      })) as unknown as typeof window.matchMedia;
    }

    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    useModalStore.setState({ settingsOpen: true });
    delete (window as { LinerAndroid?: unknown }).LinerAndroid;
    delete (window as { linerElectron?: unknown }).linerElectron;
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    container.parentNode?.removeChild(container);
    useModalStore.setState({ settingsOpen: false });
    delete (window as { LinerAndroid?: unknown }).LinerAndroid;
    delete (window as { linerElectron?: unknown }).linerElectron;
    vi.restoreAllMocks();
  });

  it("shows grouped category menus instead of every tab at once", async () => {
    await act(async () => {
      root.render(<SettingsModal />);
    });

    for (const title of CATEGORY_TITLES) {
      expect(buttonIncluding(title), `category menu row for "${title}"`).toBeTruthy();
    }

    // no setting rows and no section content on the top level
    expect(bodyText()).not.toContain(tEn("settings.autoplay_similar.title"));
    expect(bodyText()).not.toContain(tEn("settings.sleep_timer.title"));

    // search + account footer live on the menu screen
    expect(document.body.querySelector(`input[placeholder="${tEn("settings.search_placeholder")}"]`)).toBeTruthy();
    expect(buttonByAria(tEn("settings.profile.sign_out"))).toBeTruthy();

    // help links stay available
    expect(buttonIncluding(tEn("settings.docs"))).toBeTruthy();
    expect(buttonIncluding(tEn("settings.support"))).toBeTruthy();
  });

  it("opens one category in its own screen and returns with back", async () => {
    await act(async () => {
      root.render(<SettingsModal />);
    });

    await click(buttonIncluding(CATEGORY_TITLES[0]), "Playback & Audio category");

    // category header + its stacked sections
    expect(text(document.body.querySelector("h3"))).toBe(CATEGORY_TITLES[0]);
    expect(bodyText()).toContain(tEn("settings.tabs.playback"));
    expect(bodyText()).toContain(tEn("settings.audio.title"));

    // other menus are not on screen next to it
    expect(bodyText()).not.toContain(CATEGORY_TITLES[1]);
    expect(bodyText()).not.toContain(CATEGORY_TITLES[3]);

    // account footer belongs to the menu screen only
    expect(buttonByAria(tEn("settings.profile.sign_out"))).toBeNull();

    await click(buttonByAria(tEn("common.back")), "back button");

    expect(bodyText()).toContain(CATEGORY_TITLES[1]);
    expect(bodyText()).toContain(CATEGORY_TITLES[3]);
    expect(buttonByAria(tEn("settings.profile.sign_out"))).toBeTruthy();
    expect(bodyText()).not.toContain(tEn("settings.autoplay_similar.title"));
  });

  it("leaves the desktop-only overlay category out on Android", async () => {
    (window as { LinerAndroid?: unknown }).LinerAndroid = {};

    await act(async () => {
      root.render(<SettingsModal />);
    });

    expect(bodyText()).not.toContain(tEn("settings.categories.overlay.title"));
    expect(bodyText()).toContain(CATEGORY_TITLES[0]);
    expect(bodyText()).toContain(CATEGORY_TITLES[3]);
  });

  it("keeps the category on Android when the native Discord bridge exists", async () => {
    // Android always installs the compatibility shim (main.tsx), which is what
    // exposes the discord* methods; simulate both halves of the host here.
    (window as { LinerAndroid?: unknown }).LinerAndroid = {};
    (window as { linerElectron?: unknown }).linerElectron = {
      discordUpdateState: () => {},
    };

    await act(async () => {
      root.render(<SettingsModal />);
    });

    // On Android the category renders as "Discord" and carries the Discord
    // section alone (the floating overlay is desktop-only).
    expect(bodyText()).toContain(tEn("settings.tabs.discord"));
    await click(buttonIncluding(tEn("settings.tabs.discord")), "discord category");

    // Discord rows render; the desktop-only floating-overlay controls do not.
    expect(bodyText()).toContain(tEn("settings.discord.enable.title"));
    expect(bodyText()).toContain(tEn("settings.discord.show_artwork.title"));
    expect(bodyText()).not.toContain(tEn("settings.overlay.enabled.title"));
    expect(bodyText()).not.toContain(tEn("settings.overlay.position.title"));
  });

  it("searches across sections, then filters rows inside the opened one", async () => {
    await act(async () => {
      root.render(<SettingsModal />);
    });

    await typeIntoSettingsSearch(tEn("settings.sleep_timer.title"));

    // top level collapses to matching sections only
    expect(bodyText()).not.toContain(CATEGORY_TITLES[1]);
    expect(bodyText()).not.toContain(CATEGORY_TITLES[3]);
    expect(bodyText()).toContain(CATEGORY_TITLES[0]);
    expect(bodyText()).not.toContain(tEn("settings.sleep_timer.title"));

    await click(buttonIncluding(CATEGORY_TITLES[0]), "playback search result");

    // inside the category only the matching section/rows remain
    expect(bodyText()).toContain(tEn("settings.sleep_timer.title"));
    expect(bodyText()).not.toContain(tEn("settings.track_double_click.title"));
    expect(bodyText()).not.toContain(tEn("settings.storage.usage_title"));
  });
});
