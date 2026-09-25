/**
 * Geometry model of one PDF page's text, built from pdf.js text content.
 *
 * Items keep the same indices as the text layer's `textDivs`, so a DOM
 * selection can be mapped back to exact item/character positions. All
 * geometry is in PDF points in unrotated page space with a top-left origin.
 */

export interface TextItemLike {
  str: string;
  dir: string;
  transform: number[];
  width: number;
  height: number;
  fontName: string;
  hasEOL: boolean;
}

export interface TextStyleLike {
  ascent: number;
  descent: number;
  vertical: boolean;
  fontFamily: string;
}

export interface TextContentLike {
  items: Array<TextItemLike | { type: string }>;
  styles: Record<string, TextStyleLike>;
}

export interface PageBox {
  pageX: number;
  pageY: number;
  pageWidth: number;
  pageHeight: number;
}

export interface ModelItem {
  index: number;
  str: string;
  hasEOL: boolean;
  fontName: string;
  dir: string;
  x0: number;
  x1: number;
  top: number;
  bottom: number;
  baseline: number;
  size: number;
  /** Not horizontal (e.g. arXiv side stamps, rotated table headers). */
  rotated: boolean;
  empty: boolean;
  /** Offset of `str` in PageModel.rawText. */
  rawStart: number;
  /** Index into PageModel.lines, or -1 for empty/rotated items. */
  line: number;
}

export type ColumnSide = "left" | "right" | "span" | "single";

export interface ModelLine {
  index: number;
  items: number[];
  x0: number;
  x1: number;
  top: number;
  bottom: number;
  baseline: number;
  size: number;
  side: ColumnSide;
  furniture: boolean;
}

export interface Columns {
  twoColumn: boolean;
  /** Gutter centre in points (only meaningful when twoColumn). */
  split: number;
}

export interface PageModel {
  pageIndex: number;
  width: number;
  height: number;
  items: ModelItem[];
  /** Item strings in order, "\n" after items that end a line. Anchor offsets refer to this. */
  rawText: string;
  lines: ModelLine[];
  columns: Columns;
  /** Median body font size (points). */
  bodySize: number;
  /** Median baseline distance between consecutive body lines (points), or 0 if unknown. */
  lineSpacing: number;
  /** Lower-case words seen on the page, for hyphenation decisions. */
  words: Set<string>;
  /** Lower-case hyphenated compounds seen inside lines ("state-of-the-art"). */
  hyphenated: Set<string>;
}

/** Page header/footer bands as a fraction of page height. */
export const FURNITURE_BAND = 0.06;

export function isTextItem(item: TextItemLike | { type: string }): item is TextItemLike {
  return typeof (item as TextItemLike).str === "string";
}

export function buildPageModel(pageIndex: number, content: TextContentLike, box: PageBox): PageModel {
  const { pageX, pageY, pageWidth: W, pageHeight: H } = box;
  const items: ModelItem[] = [];
  let raw = "";

  for (const entry of content.items) {
    if (!isTextItem(entry)) continue;
    const style = content.styles[entry.fontName];
    const [a = 1, b = 0, c = 0, d = 1, e = 0, f = 0] = entry.transform;
    let angle = Math.atan2(-b, a);
    if (style?.vertical) angle += Math.PI / 2;
    const rotated = Math.abs(angle) > 0.02;
    const fontHeight = Math.hypot(c, d) || entry.height || 1;
    const ascent = style?.ascent ? style.ascent : style?.descent ? 1 + style.descent : 0.8;
    const descent = style?.descent ? Math.abs(style.descent) : Math.max(0.15, 1 - ascent);
    const x = e - pageX;
    const baseline = pageY + H - f;
    const width = style?.vertical ? entry.height : entry.width;

    items.push({
      index: items.length,
      str: entry.str,
      hasEOL: entry.hasEOL,
      fontName: entry.fontName,
      dir: entry.dir,
      x0: x,
      x1: x + Math.max(0, width),
      top: baseline - ascent * fontHeight,
      bottom: baseline + descent * fontHeight,
      baseline,
      size: fontHeight,
      rotated,
      empty: entry.str.trim() === "",
      rawStart: raw.length,
      line: -1,
    });
    raw += entry.str;
    if (entry.hasEOL) raw += "\n";
  }

  const lines = groupLines(items, H);
  const bodySize = medianSize(lines, items);
  const columns = detectColumns(lines, W, bodySize);
  for (const line of lines) {
    line.side = columnSide(line, columns, bodySize);
  }
  const lineSpacing = medianLineSpacing(lines, bodySize);
  const { words, hyphenated } = collectVocabulary(raw);

  return {
    pageIndex,
    width: W,
    height: H,
    items,
    rawText: raw,
    lines,
    columns,
    bodySize,
    lineSpacing,
    words,
    hyphenated,
  };
}

/** True when `c` continues the same visual line as `p`. */
export function sameVisualLine(p: ModelItem, c: ModelItem): boolean {
  const overlap = Math.min(p.bottom, c.bottom) - Math.max(p.top, c.top);
  const minHeight = Math.min(p.bottom - p.top, c.bottom - c.top);
  if (minHeight <= 0 || overlap < 0.35 * minHeight) return false;
  const tolerance = 0.6 * Math.max(p.size, c.size);
  return c.dir === "rtl" ? c.x1 <= p.x0 + tolerance : c.x0 >= p.x1 - tolerance;
}

function groupLines(items: ModelItem[], pageHeight: number): ModelLine[] {
  const lines: ModelLine[] = [];
  let current: ModelLine | null = null;
  let previous: ModelItem | null = null;

  for (const item of items) {
    if (item.empty || item.rotated) {
      if (item.hasEOL && current) {
        current = null;
        previous = null;
      }
      continue;
    }
    const startNew = !current || !previous || previous.hasEOL || !sameVisualLine(previous, item);
    if (startNew) {
      current = {
        index: lines.length,
        items: [],
        x0: item.x0,
        x1: item.x1,
        top: item.top,
        bottom: item.bottom,
        baseline: item.baseline,
        size: item.size,
        side: "single",
        furniture: false,
      };
      lines.push(current);
    }
    const line = current!;
    line.items.push(item.index);
    item.line = line.index;
    line.x0 = Math.min(line.x0, item.x0);
    line.x1 = Math.max(line.x1, item.x1);
    line.top = Math.min(line.top, item.top);
    line.bottom = Math.max(line.bottom, item.bottom);
    previous = item;
    if (item.hasEOL) {
      current = null;
      previous = null;
    }
  }

  for (const line of lines) {
    // Dominant size/baseline: the item with the most characters.
    let best: ModelItem | null = null;
    for (const index of line.items) {
      const item = items[index]!;
      if (!best || item.str.length > best.str.length) best = item;
    }
    if (best) {
      line.size = best.size;
      line.baseline = best.baseline;
    }
    const centre = (line.top + line.bottom) / 2;
    line.furniture = centre < FURNITURE_BAND * pageHeight || centre > (1 - FURNITURE_BAND) * pageHeight;
  }
  return lines;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((x, y) => x - y);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function medianSize(lines: ModelLine[], items: ModelItem[]): number {
  // Weight by characters so long body lines dominate headings and labels.
  const sizes: number[] = [];
  for (const line of lines) {
    if (line.furniture) continue;
    const chars = line.items.reduce((sum, i) => sum + items[i]!.str.length, 0);
    const weight = Math.min(20, Math.ceil(chars / 10));
    for (let k = 0; k < weight; k++) sizes.push(line.size);
  }
  return median(sizes) || 10;
}

/**
 * Finds a vertical split near the middle of the page with body lines on both
 * sides and few lines crossing it. Lines spanning the split (titles,
 * abstracts, wide figures) are tolerated.
 */
export function detectColumns(lines: ModelLine[], pageWidth: number, bodySize: number): Columns {
  const body = lines.filter((l) => !l.furniture && Math.abs(l.size - bodySize) < 0.25 * bodySize && l.x1 - l.x0 > 4 * bodySize);
  const single = { twoColumn: false, split: pageWidth / 2 };
  if (body.length < 6) return single;
  let best: { left: number; right: number; split: number } | null = null;
  const steps = 160;
  for (let step = Math.floor(steps * 0.3); step <= Math.ceil(steps * 0.7); step++) {
    const x = (step / steps) * pageWidth;
    let left = 0;
    let right = 0;
    let maxLeft = 0;
    let minRight = pageWidth;
    for (const line of body) {
      if (line.x1 <= x) {
        left++;
        maxLeft = Math.max(maxLeft, line.x1);
      } else if (line.x0 >= x) {
        right++;
        minRight = Math.min(minRight, line.x0);
      }
    }
    if (left < 3 || right < 3) continue;
    if (!best || left + right > best.left + best.right) best = { left, right, split: (maxLeft + minRight) / 2 };
  }
  if (!best || (best.left + best.right) / body.length < 0.6) return single;
  return { twoColumn: true, split: best.split };
}

function columnSide(line: ModelLine, columns: Columns, bodySize: number): ColumnSide {
  if (!columns.twoColumn) return "single";
  const tolerance = 0.5 * bodySize;
  if (line.x1 <= columns.split + tolerance) return "left";
  if (line.x0 >= columns.split - tolerance) return "right";
  return "span";
}

function medianLineSpacing(lines: ModelLine[], bodySize: number): number {
  const deltas: number[] = [];
  for (let i = 1; i < lines.length; i++) {
    const a = lines[i - 1]!;
    const b = lines[i]!;
    if (a.furniture || b.furniture || a.side !== b.side) continue;
    if (Math.abs(a.size - bodySize) > 0.2 * bodySize || Math.abs(b.size - bodySize) > 0.2 * bodySize) continue;
    const delta = b.baseline - a.baseline;
    if (delta > 0.8 * bodySize && delta < 3 * bodySize) deltas.push(delta);
  }
  return median(deltas);
}

const WORD = /\p{L}+(?:[-‐]\p{L}+)*/gu;

function collectVocabulary(raw: string): { words: Set<string>; hyphenated: Set<string> } {
  const words = new Set<string>();
  const hyphenated = new Set<string>();
  for (const line of raw.split("\n")) {
    const tokens = line.match(WORD) ?? [];
    tokens.forEach((token, position) => {
      const lower = token.toLowerCase();
      // A token that ends the line may be a hyphenation fragment; skip the last one.
      const endsLine = position === tokens.length - 1 && /[-‐­]\s*$/.test(line);
      if (endsLine) return;
      if (lower.includes("-") || lower.includes("‐")) {
        hyphenated.add(lower.replace(/‐/g, "-"));
        for (const part of lower.split(/[-‐]/)) if (part.length >= 3) words.add(part);
      } else if (lower.length >= 3) {
        words.add(lower);
      }
    });
  }
  return { words, hyphenated };
}

/** Line bounds used for indentation checks, from nearby lines in the same column. */
export function columnEdges(
  model: PageModel,
  lineIndex: number,
): { left: number; right: number; dominantLeft: number; justified: boolean } {
  const line = model.lines[lineIndex];
  if (!line) return { left: 0, right: model.width, dominantLeft: 0, justified: false };
  const neighbours = model.lines.filter(
    (l) =>
      !l.furniture &&
      l.side === line.side &&
      Math.abs(l.index - lineIndex) <= 12 &&
      Math.abs(l.size - line.size) < 0.12 * line.size,
  );
  if (neighbours.length === 0) return { left: line.x0, right: line.x1, dominantLeft: line.x0, justified: false };
  const lefts = neighbours.map((l) => l.x0).sort((a, b) => a - b);
  const rights = neighbours.map((l) => l.x1).sort((a, b) => a - b);
  const left = lefts[Math.floor(lefts.length * 0.1)]!;
  const right = rights[Math.min(rights.length - 1, Math.floor(rights.length * 0.9))]!;
  // Justified text: most lines end at the right edge, so a short line is meaningful.
  const flush = neighbours.filter((l) => l.x1 >= right - 0.6 * line.size).length;
  const justified = neighbours.length >= 4 && flush / neighbours.length >= 0.55;
  return { left, right, dominantLeft: modeWithin(lefts, 0.5 * model.bodySize), justified };
}

/** Most common value, grouping values within `tolerance`. */
function modeWithin(sorted: number[], tolerance: number): number {
  let best = sorted[0] ?? 0;
  let bestCount = 0;
  for (let i = 0; i < sorted.length; i++) {
    let count = 0;
    for (let j = i; j < sorted.length && sorted[j]! - sorted[i]! <= tolerance; j++) count++;
    if (count > bestCount) {
      bestCount = count;
      best = sorted[i]!;
    }
  }
  return best;
}
