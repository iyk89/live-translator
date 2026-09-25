import { describe, expect, it } from "vitest";
import { boundingRect, mergeLineRects, normalizeRect, toPixels } from "./geometry";

describe("anchor rectangles", () => {
  const page = { left: 100, top: 50, width: 800, height: 1000 };

  it("normalizes viewport rects against the page box and back again at any zoom", () => {
    const norm = normalizeRect({ left: 300, top: 250, width: 200, height: 20 }, page)!;
    expectClose(norm, { x: 0.25, y: 0.2, w: 0.25, h: 0.02 });
    // Same page at 150% zoom, scrolled: the rect scales with it.
    const zoomed = { left: -40, top: -900, width: 1200, height: 1500 };
    expectClose(toPixels(norm, zoomed), { left: 260, top: -600, width: 300, height: 30 });
  });

  it("clips rects to the page and rejects empty ones", () => {
    expectClose(normalizeRect({ left: 50, top: 40, width: 100, height: 30 }, page)!, { x: 0, y: 0, w: 0.0625, h: 0.02 });
    expect(normalizeRect({ left: 1000, top: 40, width: 100, height: 30 }, page)).toBeNull();
    expect(normalizeRect({ left: 300, top: 250, width: 0, height: 20 }, page)).toBeNull();
  });

  it("merges touching rects on a line but keeps column gaps separate", () => {
    const merged = mergeLineRects([
      { x: 0.1, y: 0.1, w: 0.1, h: 0.02 },
      { x: 0.205, y: 0.101, w: 0.1, h: 0.019 },
      { x: 0.6, y: 0.1, w: 0.2, h: 0.02 },
      { x: 0.1, y: 0.13, w: 0.3, h: 0.02 },
    ]);
    expect(merged).toHaveLength(3);
    expect(merged[0]!.x).toBeCloseTo(0.1);
    expect(merged[0]!.w).toBeCloseTo(0.205);
    expect(merged[1]!.x).toBeCloseTo(0.6);
    expect(merged[2]!.y).toBeCloseTo(0.13);
  });

  it("computes the bounding box of a selection", () => {
    expect(
      boundingRect([
        { x: 0.2, y: 0.1, w: 0.3, h: 0.02 },
        { x: 0.1, y: 0.13, w: 0.35, h: 0.02 },
      ]),
    ).toEqual({ x: 0.1, y: 0.1, w: expect.closeTo(0.4), h: expect.closeTo(0.05) });
    expect(boundingRect([])).toBeNull();
  });
});

function expectClose(actual: object, expected: Record<string, number>) {
  for (const [key, value] of Object.entries(expected)) {
    expect((actual as Record<string, number>)[key]).toBeCloseTo(value, 6);
  }
}
