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
