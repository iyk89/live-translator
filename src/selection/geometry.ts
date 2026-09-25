/**
 * Selection rectangles are stored relative to the displayed page box (0..1),
 * so they stay aligned at any zoom level and survive re-rendering.
 */

export interface NormRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function normalizeRect(rect: { left: number; top: number; width: number; height: number }, page: Box): NormRect | null {
  if (page.width <= 0 || page.height <= 0 || rect.width <= 0 || rect.height <= 0) return null;
  const x0 = clamp01((rect.left - page.left) / page.width);
  const y0 = clamp01((rect.top - page.top) / page.height);
  const x1 = clamp01((rect.left + rect.width - page.left) / page.width);
  const y1 = clamp01((rect.top + rect.height - page.top) / page.height);
  if (x1 - x0 <= 0 || y1 - y0 <= 0) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** Converts a page-relative rect into pixels within a page placed at `page`. */
export function toPixels(rect: NormRect, page: Box): Box {
  return {
    left: page.left + rect.x * page.width,
    top: page.top + rect.y * page.height,
    width: rect.w * page.width,
    height: rect.h * page.height,
  };
}

/**
 * Merges per-glyph-run rectangles into one rectangle per line segment:
 * rects on the same line that touch or nearly touch are joined; a large gap
 * (for example between columns) keeps them separate.
 */
export function mergeLineRects(rects: NormRect[], gapTolerance = 0.012): NormRect[] {
  // Group into lines by vertical overlap, then merge neighbours along each line.
  const lines: Array<{ band: NormRect; rects: NormRect[] }> = [];
  const sorted = rects.filter((r) => r.w > 0 && r.h > 0).sort((a, b) => a.y + a.h / 2 - (b.y + b.h / 2));
  for (const rect of sorted) {
    const line = lines.find((l) => sameLine(l.band, rect));
    if (line) {
      line.rects.push(rect);
      line.band = union(line.band, rect);
    } else {
      lines.push({ band: { ...rect }, rects: [rect] });
    }
  }
  const merged: NormRect[] = [];
  for (const line of lines) {
    const row: NormRect[] = [];
    for (const rect of [...line.rects].sort((a, b) => a.x - b.x)) {
      const last = row[row.length - 1];
      if (last && rect.x <= last.x + last.w + gapTolerance) row[row.length - 1] = union(last, rect);
      else row.push({ ...rect });
    }
    merged.push(...row);
  }
  return merged.sort((a, b) => a.y - b.y || a.x - b.x);
}

function union(a: NormRect, b: NormRect): NormRect {
  const x0 = Math.min(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  return { x: x0, y: y0, w: Math.max(a.x + a.w, b.x + b.w) - x0, h: Math.max(a.y + a.h, b.y + b.h) - y0 };
}

function sameLine(a: NormRect, b: NormRect): boolean {
  const overlap = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return overlap > 0.5 * Math.min(a.h, b.h);
}

export function boundingRect(rects: NormRect[]): NormRect | null {
  if (rects.length === 0) return null;
  let x0 = 1;
  let y0 = 1;
  let x1 = 0;
  let y1 = 0;
  for (const r of rects) {
    x0 = Math.min(x0, r.x);
    y0 = Math.min(y0, r.y);
    x1 = Math.max(x1, r.x + r.w);
    y1 = Math.max(y1, r.y + r.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}
