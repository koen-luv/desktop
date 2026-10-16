import React, { act } from "react";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createRoot, Root } from "react-dom/client";
import {
  PlayerMorphIcon,
  ICON_PLAY,
  ICON_PAUSE,
  ICON_SHUFFLE_OFF,
  ICON_VOLUME_MUTE,
} from "./morphPlayerIcons";

// @ts-expect-error - act support flag in vitest browserless DOM environment
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe("PlayerMorphIcon rendered markup", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root?.unmount();
    });
    container?.remove();
    container = null;
    root = null;
  });

  it("paints fill on the svg root so shapes inherit it (no lucide stroke)", () => {
    act(() => {
      root?.render(<PlayerMorphIcon icon={ICON_PLAY} size={16} />);
    });

    const svg = container?.querySelector("svg");
    expect(svg?.getAttribute("fill")).toBe("currentColor");
    expect(svg?.getAttribute("fill-rule")).toBe("evenodd");
    // MorphIcon defaults to stroke=currentColor stroke-width=2 (lucide style),
    // which fattens every fill shape — must be off at the root
    expect(svg?.getAttribute("stroke")).toBe("none");

    const path = svg?.querySelector("path");
    expect(path).not.toBeNull();
    // solar Play Bold geometry (canonical resampling rounds to 4 decimals)
    expect(path?.getAttribute("d")?.startsWith("M21.4086 9.3526")).toBe(true);
  });

  it("shows the pause endpoint geometry for the pause icon", () => {
    act(() => {
      root?.render(<PlayerMorphIcon icon={ICON_PAUSE} size={16} />);
    });

    const path = container?.querySelector("path");
    expect(path?.getAttribute("d")?.startsWith("M2 6C2 4.1144")).toBe(true);
  });

  it("uses the solar Outline geometry for the shuffle-off endpoint", () => {
    // the bars flip shuffle with a Bold(on) / Outline(off) static pair; the
    // morph data must mirror that exact weight pair (guards against an
    // accidental weight-swap regressions like fat/inked borders)
    act(() => {
      root?.render(<PlayerMorphIcon icon={ICON_SHUFFLE_OFF} size={18} />);
    });

    const path = container?.querySelector("path");
    expect(path?.getAttribute("d")?.startsWith("M19.4697 4.4697")).toBe(true);
  });

  it("keeps the VolumePicker mute geometry verbatim (solar VolumeCross Bold)", () => {
    act(() => {
      root?.render(<PlayerMorphIcon icon={ICON_VOLUME_MUTE} size={16} />);
    });

    const path = container?.querySelector("path");
    expect(path?.getAttribute("d")?.startsWith("M20.5145 6.3164")).toBe(true);
  });
});
