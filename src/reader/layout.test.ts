import { describe, expect, it } from "vitest";
import { anchorAt, autoZoom, computeLayout, currentPageIndex, fitWidthZoom, pageAt, pointFor, stepZoom, visibleRange, PDF_TO_CSS } from "./layout";

const letter = { width: 612, height: 792 };
const sizes = [letter, letter, { width: 792, height: 612 }, letter];

describe("reader layout", () => {
  it("stacks pages vertically and centres them", () => {
    const layout = computeLayout(sizes, 1, 1200);
    expect(layout.pages[0]).toEqual({ top: 20, left: Math.floor((1200 - 816) / 2), width: 816, height: 1056 });
    expect(layout.pages[1]!.top).toBe(20 + 1056 + 16);
    expect(layout.pages[2]!.width).toBe(1056);
    expect(layout.height).toBe(layout.pages[3]!.top + layout.pages[3]!.height + 40);
  });

  it("widens the content when zoomed past the container", () => {
    const layout = computeLayout(sizes, 2, 800);
    expect(layout.width).toBe(Math.floor(792 * PDF_TO_CSS * 2) + 40);
  });

  it("computes fit-width and a capped automatic zoom", () => {
    expect(fitWidthZoom([letter], 856)).toBeCloseTo((856 - 40) / 816);
    expect(autoZoom([letter], 3000)).toBe(1.25);
    expect(autoZoom([letter], 500)).toBeCloseTo((500 - 40) / 816);
  });

  it("finds pages by offset and the visible range", () => {
    const layout = computeLayout(sizes, 1, 1200);
    expect(pageAt(layout, 0)).toBe(0);
    expect(pageAt(layout, layout.pages[2]!.top + 5)).toBe(2);
    expect(visibleRange(layout, layout.pages[1]!.top - 100, layout.pages[1]!.top + 1200)).toEqual([0, 2]);
    expect(currentPageIndex(layout, layout.pages[1]!.top - 50, 900)).toBe(1);
  });

  it("keeps the same page point under the view centre across zoom levels", () => {
    const before = computeLayout(sizes, 1, 1200);
    const anchor = anchorAt(before, 600, before.pages[1]!.top + 300);
    const after = computeLayout(sizes, 1.5, 1200);
    const point = pointFor(after, anchor);
    expect(pageAt(after, point.y)).toBe(1);
    expect((point.y - after.pages[1]!.top) / after.pages[1]!.height).toBeCloseTo(300 / before.pages[1]!.height, 3);
  });

  it("steps through zoom presets", () => {
    expect(stepZoom(1, 1)).toBe(1.1);
    expect(stepZoom(1, -1)).toBe(0.9);
    expect(stepZoom(1.13, 1)).toBe(1.25);
    expect(stepZoom(4, 1)).toBe(4);
    expect(stepZoom(0.5, -1)).toBe(0.5);
  });
});
