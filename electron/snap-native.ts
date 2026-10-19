// Drives the native snap preview add-on (native/snap-preview, windows only).
//
// The add-on owns a popup window whose content is a DWM composition tree: a live
// blur (HostBackdropBrush) inside a rounded clip that the compositor animates.
// This controller only decides *what* to animate; frames are produced by DWM at
// the display refresh rate, so there is no per-frame work in the app.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { screen, type BrowserWindow, type Display, type Rectangle } from "electron";
import { cubicBezier, lerpEdges, toEdges, type Edges } from "./window-drag.js";

interface SnapPreviewAddon {
  init(): boolean;
  hasBackdrop(): boolean;
  setArea(x: number, y: number, width: number, height: number): void;
  setStyle(argbTint: number, radiusPx: number): void;
  show(afterHwnd: Buffer | null): void;
  hide(): void;
  animate(from: Edges, to: Edges, ms: number, bezier: [number, number, number, number]): void;
  setTarget(to: Edges): void;
  destroy(): void;
}

/** the built add-on, or null (not built, not windows, or it failed to load) */
export function loadSnapPreviewAddon(appRoot: string): SnapPreviewAddon | null {
  if (process.platform !== "win32") return null;
  const candidates = [path.join(appRoot, "native", "snap-preview", "build", "Release", "snap_preview.node")].map((p) =>
    // packaged: native files are unpacked next to the asar
    p.includes(`app.asar${path.sep}`) ? p.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`) : p,
  );
  const require = createRequire(import.meta.url);
  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) continue;
      const addon = require(file) as SnapPreviewAddon;
      if (typeof addon?.init === "function") return addon;
    } catch (err) {
      console.warn("[snap-preview] native add-on failed to load:", err);
    }
  }
  return null;
}

type Bezier = [number, number, number, number];
const GROW_EASE: Bezier = [0.33, 1, 0.68, 1]; // ease-out
const COLLAPSE_EASE: Bezier = [0.65, 0, 0.35, 1]; // ease-in-out

export interface NativeSnapOptions {
  insetDip: number; // gap between the box and the work area edges
  tuckInsetDip: number; // start / end inside the window, behind the app body
  radiusDip: number;
  growMs: number;
  collapseMs: number;
  tint: number; // 0xAARRGGBB over the blur
  tintNoBlur: number; // when no live blur is available (windows 10)
}

export class NativeSnapPreview {
  private visible = false;
  private areaDip: Rectangle | null = null;
  private areaPx: Rectangle | null = null;
  private scale = 1;
  private hideTimer: ReturnType<typeof setTimeout> | null = null;
  // the running animation, mirrored here so a turnaround starts exactly where it is
  private anim: { from: Edges; to: Edges; start: number; ms: number; ease: (t: number) => number } | null = null;

  private constructor(
    private readonly addon: SnapPreviewAddon,
    private readonly getMain: () => BrowserWindow | null,
    private readonly opts: NativeSnapOptions,
    private readonly blur: boolean,
  ) {}

  static create(addon: SnapPreviewAddon, getMain: () => BrowserWindow | null, opts: NativeSnapOptions) {
    try {
      if (!addon.init()) return null;
      return new NativeSnapPreview(addon, getMain, opts, addon.hasBackdrop());
    } catch (err) {
      console.warn("[snap-preview] native init failed:", err);
      return null;
    }
  }

  // dip screen rect -> physical px relative to the preview window
  private localEdges(rectDip: Rectangle): Edges | null {
    if (!this.areaPx) return null;
    const win = this.getMain();
    const px = screen.dipToScreenRect(win && !win.isDestroyed() ? win : null, rectDip);
    return toEdges({ x: px.x - this.areaPx.x, y: px.y - this.areaPx.y, width: px.width, height: px.height });
  }

  private tuckedEdges(): Edges | null {
    const win = this.getMain();
    if (!win || win.isDestroyed()) return null;
    const b = win.getBounds();
    const i = Math.min(this.opts.tuckInsetDip, Math.floor(b.width / 4), Math.floor(b.height / 4));
    return this.localEdges({ x: b.x + i, y: b.y + i, width: b.width - i * 2, height: b.height - i * 2 });
  }

  private fullEdges(): Edges | null {
    if (!this.areaDip) return null;
    const a = this.areaDip;
    const i = this.opts.insetDip;
    return this.localEdges({ x: a.x + i, y: a.y + i, width: a.width - i * 2, height: a.height - i * 2 });
  }

  private current(): Edges | null {
    const anim = this.anim;
    if (!anim) return null;
    const t = Math.min(1, (performance.now() - anim.start) / anim.ms);
    return lerpEdges(anim.from, anim.to, anim.ease(t));
  }

  private run(from: Edges, to: Edges, ms: number, bezier: Bezier) {
    this.addon.animate(from, to, ms, bezier);
    this.anim = { from, to, start: performance.now(), ms, ease: cubicBezier(...bezier) };
  }

  private clearHide() {
    if (this.hideTimer) clearTimeout(this.hideTimer);
    this.hideTimer = null;
  }

  private place(display: Display) {
    const area = display.workArea;
    const same =
      this.areaDip &&
      this.areaDip.x === area.x &&
      this.areaDip.y === area.y &&
      this.areaDip.width === area.width &&
      this.areaDip.height === area.height;
    if (same) return;
    if (this.visible) this.hideNow(); // only ever resized while hidden
    this.areaDip = area;
    this.scale = display.scaleFactor || 1;
    this.areaPx = screen.dipToScreenRect(null, area);
    this.addon.setArea(this.areaPx.x, this.areaPx.y, this.areaPx.width, this.areaPx.height);
    this.addon.setStyle(this.blur ? this.opts.tint : this.opts.tintNoBlur, this.opts.radiusDip * this.scale);
  }

  /** prime once in the background: the compositor sets up its resources now */
  prime(display: Display) {
    this.place(display);
    const empty: Edges = [0, 0, 0, 0];
    this.addon.animate(empty, empty, 0, GROW_EASE);
    this.addon.show(null);
    setTimeout(() => {
      if (!this.visible) this.addon.hide();
    }, 200);
  }

  /** cursor hit the top edge: grow out of the window */
  arm(display: Display) {
    this.clearHide();
    this.place(display);
    const to = this.fullEdges();
    if (!to) return;
    if (this.visible) {
      // mid-collapse: turn around from where the box is right now
      const from = this.current() ?? this.tuckedEdges() ?? to;
      this.run(from, to, this.opts.growMs, GROW_EASE);
      return;
    }
    const from = this.tuckedEdges();
    if (!from) return;
    // the clip is set (behind the app) before the window shows, so no frame flashes
    this.run(from, to, this.opts.growMs, GROW_EASE);
    const win = this.getMain();
    this.addon.show(win && !win.isDestroyed() ? win.getNativeWindowHandle() : null);
    this.visible = true;
  }

  /** cursor left the edge: collapse back into the window (follow() keeps it on it) */
  collapse() {
    if (!this.visible) return;
    this.clearHide();
    const from = this.current() ?? this.fullEdges();
    const to = this.tuckedEdges();
    if (!from || !to) {
      this.hideNow();
      return;
    }
    this.run(from, to, this.opts.collapseMs, COLLAPSE_EASE);
    this.hideTimer = setTimeout(() => this.hideNow(), this.opts.collapseMs + 30);
  }

  /** while collapsing: aim at the window's live position */
  follow() {
    if (!this.visible || !this.hideTimer || !this.anim) return;
    const to = this.tuckedEdges();
    if (!to) return;
    this.anim.to = to;
    this.addon.setTarget(to);
  }

  /** dropped: the app maximized; keep the blur under it a beat, then go */
  dropped() {
    if (!this.visible) return;
    this.clearHide();
    this.hideTimer = setTimeout(() => this.hideNow(), 120);
  }

  hideNow() {
    this.clearHide();
    this.anim = null;
    if (this.visible) this.addon.hide();
    this.visible = false;
  }

  destroy() {
    this.hideNow();
    try {
      this.addon.destroy();
    } catch {
      // already gone
    }
  }
}
