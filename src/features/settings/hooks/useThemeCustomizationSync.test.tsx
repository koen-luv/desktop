import React, { act } from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createRoot, Root } from "react-dom/client";
import { useThemeCustomizationSync } from "./useThemeCustomizationSync";
import { useCustomizationStore } from "../store/customizationStore";

const mockSetTheme = vi.fn();

vi.mock("next-themes", () => ({
  useTheme: () => ({
    theme: "light",
    resolvedTheme: "light",
    setTheme: mockSetTheme,
  }),
}));

function Harness() {
  useThemeCustomizationSync();
  return null;
}

describe("useThemeCustomizationSync", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    vi.clearAllMocks();
    useCustomizationStore.getState().resetAll();
  });

  afterEach(() => {
    if (root && container) {
      act(() => {
        root!.unmount();
      });
      document.body.removeChild(container);
    }
    root = null;
    container = null;
    document.body.innerHTML = "";
  });

  function mount() {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => {
      root!.render(<Harness />);
    });
  }

  it("does not force a theme switch even when wallpaper glass is active", () => {
    useCustomizationStore.getState().setBackgroundImage("data:image/png;base64,mock");
    mount();
    expect(mockSetTheme).not.toHaveBeenCalled();
  });

  it("does not call setTheme when there is no wallpaper", () => {
    mount();
    expect(mockSetTheme).not.toHaveBeenCalled();
  });
});
