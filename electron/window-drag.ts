// Manual window move (windows/macos; linux uses css app-region).
//
// Electron's setPosition() on Windows converts DIP -> physical pixels and back
// on every call. With display scaling (125%, 150%, ...) or when crossing
// monitors with different DPI, that rounding nudges the window SIZE by a pixel
// now and then, so a long drag slowly grows the window. Moving with
// setBounds() and the size captured at drag start pins the size exactly.

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** bounds for the current cursor: start position + cursor travel, start size kept */
export function computeDragBounds(start: Rect, startCursor: Point, cursor: Point): Rect {
  return {
    x: Math.round(start.x + (cursor.x - startCursor.x)),
    y: Math.round(start.y + (cursor.y - startCursor.y)),
    width: start.width,
    height: start.height,
  };
}

// drag-to-top snap (windows). the custom drag never reaches the os, so aero snap
// is emulated: cursor on the top edge of a display -> show the preview, drop -> maximize

/** px band at the top of the display that arms the maximize snap */
export const TOP_SNAP_THRESHOLD = 2;

/** true when the cursor sits on the top edge of the display it is on */
export function isInTopSnapZone(cursor: Point, displayBounds: Rect, threshold = TOP_SNAP_THRESHOLD): boolean {
  return (
    cursor.x >= displayBounds.x &&
    cursor.x < displayBounds.x + displayBounds.width &&
    cursor.y <= displayBounds.y + threshold
  );
}

/**
 * where a maximized window lands when the user drags it out: restored size, placed
 * so the cursor keeps the same relative x across the title bar and the same
 * distance from the top (clamped into the restored height), like windows does
 */
export function restoreUnderCursor(maximized: Rect, restoredSize: { width: number; height: number }, cursor: Point): Rect {
  const ratio = maximized.width > 0 ? (cursor.x - maximized.x) / maximized.width : 0.5;
  const clampedRatio = Math.min(1, Math.max(0, ratio));
  const offsetY = Math.min(Math.max(0, cursor.y - maximized.y), Math.max(0, restoredSize.height - 1));
  return {
    x: Math.round(cursor.x - restoredSize.width * clampedRatio),
    y: Math.round(cursor.y - offsetY),
    width: restoredSize.width,
    height: restoredSize.height,
  };
}
