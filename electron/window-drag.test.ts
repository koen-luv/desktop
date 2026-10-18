import { describe, expect, it } from "vitest";
import { computeDragBounds } from "./window-drag";

describe("computeDragBounds", () => {
  const start = { x: 100, y: 50, width: 1200, height: 780 };

  it("moves by the cursor travel", () => {
    expect(computeDragBounds(start, { x: 10, y: 10 }, { x: 35, y: -5 })).toEqual({
      x: 125,
      y: 35,
      width: 1200,
      height: 780,
    });
  });

  it("never changes the size, however long the drag", () => {
    let cursor = { x: 0, y: 0 };
    for (let i = 0; i < 5000; i++) {
      cursor = { x: cursor.x + ((i % 7) - 3) * 1.25, y: cursor.y + ((i % 5) - 2) * 1.5 };
      const b = computeDragBounds(start, { x: 0, y: 0 }, cursor);
      expect(b.width).toBe(1200);
      expect(b.height).toBe(780);
    }
  });

  it("rounds fractional positions to whole pixels", () => {
    const b = computeDragBounds(start, { x: 0, y: 0 }, { x: 0.6, y: 0.4 });
    expect([b.x, b.y]).toEqual([101, 50]);
  });
});
