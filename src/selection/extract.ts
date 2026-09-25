/**
 * Rebuilds readable text from selected text-layer items.
 *
 * - Keeps meaningful paragraph breaks and joins wrapped lines.
 * - Undoes line-break hyphenation only when it is clearly a line break.
 * - Expands ligature glyphs; leaves all other characters as they are.
 * - Drops page furniture (running heads, page numbers, side stamps) and text
 *   from the other column when the selection itself stays in one column.
 * - Records, for every output character, the raw offset it came from.
 */

import { columnEdges, sameVisualLine, type ModelItem, type ModelLine, type PageModel } from "./pageModel";

export interface Piece {
  /** Item index (aligned with the text layer's textDivs). */
  index: number;
  /** Selected character range within the item string. */
  start: number;
  end: number;
}

export interface ExtractResult {
  text: string;
  /** Raw offset (into PageModel.rawText) per output character, -1 for inserted separators. */
  sourceMap: number[];
  /** Pieces that contributed to `text` (the highlight is drawn from these). */
  kept: Piece[];
  excluded: { furniture: number; otherColumn: number; rotated: number };
  /** Share of characters that look like extraction failures. */
  unreliable: "none" | "some" | "severe";
}

const LIGATURES: Record<string, string> = {
  "ﬀ": "ff",
  "ﬁ": "fi",
  "ﬂ": "fl",
  "ﬃ": "ffi",
  "ﬄ": "ffl",
  "ﬅ": "st",
  "ﬆ": "st",
};

const HYPHENS = new Set(["-", "‐"]);
const SOFT_HYPHEN = "­";
const ZERO_WIDTH = /[​-‍⁠﻿]/;
const SPACE_LIKE = /[\s  -   　]/;

/** Prefixes that usually form real compounds ("self-attention"), so their hyphen stays. */
const COMPOUND_PREFIXES = new Set([
  "self", "non", "well", "high", "low", "long", "short", "large", "small", "multi", "cross", "state", "end",
  "real", "open", "fine", "one", "two", "three", "four", "first", "second", "third", "zero", "few", "many",
  "half", "full", "semi", "sub", "super", "inter", "intra", "over", "under", "top", "left", "right", "time",
  "data", "task", "domain", "model", "word", "sentence", "token", "character", "context", "language", "human",
  "machine", "rule", "graph", "image", "text", "deep", "meta", "anti", "auto", "quasi", "pseudo", "ultra",
  "mid", "post", "cost", "rate", "point", "head", "layer", "back", "feed", "sequence", "encoder", "decoder",
  "fixed", "variable", "closed", "trade", "look", "follow", "state-of", "state-of-the", "out", "in", "on", "off",
]);

export function isCjk(ch: string): boolean {
  return /[぀-ヿㇰ-ㇿ㐀-䶿一-鿿豈-﫿　-〿＀-￯]/.test(ch);
}

interface LineText {
  chars: string[];
  map: number[];
  firstItem: ModelItem;
  lastItem: ModelItem;
}

export function extractSelection(model: PageModel, pieces: Piece[], vocabulary?: Set<string>): ExtractResult {
  const excluded = { furniture: 0, otherColumn: 0, rotated: 0 };
  const kept = filterPieces(model, normalizePieces(model, pieces), excluded);
  const lines = buildLines(model, kept);

  const chars: string[] = [];
  const map: number[] = [];
  lines.forEach((line, i) => {
    if (i > 0) {
      const previous = lines[i - 1]!;
      const kind = lineBreakKind(model, previous.lastItem, line.firstItem, previous.chars, line.chars);
      if (kind === "paragraph") {
        dropTrailingSoftHyphen(chars, map);
        chars.push("\n", "\n");
        map.push(-1, -1);
      } else {
        joinWrappedLine(chars, map, line.chars, model, vocabulary);
      }
    }
    chars.push(...line.chars);
    map.push(...line.map);
  });
  dropTrailingSoftHyphen(chars, map);

  let start = 0;
  let end = chars.length;
  while (start < end && /\s/.test(chars[start]!)) start++;
  while (end > start && /\s/.test(chars[end - 1]!)) end--;
  const text = chars.slice(start, end).join("");
  return { text, sourceMap: map.slice(start, end), kept, excluded, unreliable: assessReliability(text) };
}

function normalizePieces(model: PageModel, pieces: Piece[]): Piece[] {
  const byIndex = new Map<number, Piece>();
  for (const piece of pieces) {
    const item = model.items[piece.index];
    if (!item) continue;
    const start = Math.max(0, Math.min(piece.start, item.str.length));
    const end = Math.max(start, Math.min(piece.end, item.str.length));
    if (end <= start) continue;
    const existing = byIndex.get(piece.index);
    if (existing) {
      existing.start = Math.min(existing.start, start);
      existing.end = Math.max(existing.end, end);
    } else {
      byIndex.set(piece.index, { index: piece.index, start, end });
    }
  }
  return [...byIndex.values()].sort((a, b) => a.index - b.index);
}

function lineOf(model: PageModel, item: ModelItem): ModelLine | undefined {
  return item.line >= 0 ? model.lines[item.line] : undefined;
}

function filterPieces(model: PageModel, pieces: Piece[], excluded: ExtractResult["excluded"]): Piece[] {
  const itemOf = (p: Piece) => model.items[p.index]!;
  const isRotated = (p: Piece) => itemOf(p).rotated;
  const isFurniture = (p: Piece) => lineOf(model, itemOf(p))?.furniture ?? false;

  let result = pieces;
  // Side stamps and rotated labels only survive when nothing else was selected.
  if (result.some((p) => !isRotated(p) && !itemOf(p).empty)) {
    const before = result.length;
    result = result.filter((p) => !isRotated(p));
    excluded.rotated = before - result.length;
  }
  // Running heads and page numbers only survive when nothing else was selected.
  if (result.some((p) => !isFurniture(p) && !itemOf(p).empty)) {
    const before = result.length;
    result = result.filter((p) => !isFurniture(p));
    excluded.furniture = before - result.length;
  }
  // Within one column, text from the other column is stream-order leakage.
  if (model.columns.twoColumn) {
    const sides = result
      .map((p) => lineOf(model, itemOf(p))?.side)
      .filter((side): side is ModelLine["side"] => side !== undefined);
    const first = sides[0];
    const last = sides[sides.length - 1];
    if (first && first === last && (first === "left" || first === "right")) {
      const other = first === "left" ? "right" : "left";
      const before = result.length;
      result = result.filter((p) => lineOf(model, itemOf(p))?.side !== other);
      excluded.otherColumn = before - result.length;
    }
  }
  return result;
}

/** Groups pieces into visual lines and builds each line's text with its source map. */
function buildLines(model: PageModel, pieces: Piece[]): LineText[] {
  const lines: LineText[] = [];
  let current: LineText | null = null;
  let lastText: ModelItem | null = null;
  let pendingSpace = false;
  let forceBreak = false;

  for (const piece of pieces) {
    const item = model.items[piece.index]!;
    if (item.empty) {
      // Whitespace items separate words; their end-of-line flag ends the line.
      if (current) pendingSpace = true;
      if (item.hasEOL) forceBreak = true;
      continue;
    }
    const startsLine = !current || forceBreak || (lastText !== null && !sameVisualLine(lastText, item));
    if (startsLine) {
      current = { chars: [], map: [], firstItem: item, lastItem: item };
      lines.push(current);
      pendingSpace = false;
      forceBreak = false;
    } else if (lastText && (pendingSpace || gapNeedsSpace(lastText, item))) {
      appendSpace(current!);
    }
    pendingSpace = false;
    appendPiece(current!, item, piece.start, piece.end);
    current!.lastItem = item;
    lastText = item;
    if (item.hasEOL && piece.end >= item.str.length) forceBreak = true;
  }
  for (const line of lines) {
    while (line.chars.length && line.chars[line.chars.length - 1] === " ") {
      line.chars.pop();
      line.map.pop();
    }
  }
  return lines.filter((line) => line.chars.length > 0);
}

function gapNeedsSpace(p: ModelItem, c: ModelItem): boolean {
  const gap = c.dir === "rtl" ? p.x0 - c.x1 : c.x0 - p.x1;
  return gap > 0.12 * Math.max(p.size, c.size);
}

function appendSpace(line: LineText) {
  const last = line.chars[line.chars.length - 1];
  if (line.chars.length === 0 || last === " ") return;
  line.chars.push(" ");
  line.map.push(-1);
}

function appendPiece(line: LineText, item: ModelItem, start: number, end: number) {
  for (let i = start; i < end; i++) {
    const ch = item.str[i]!;
    const raw = item.rawStart + i;
    if (ZERO_WIDTH.test(ch)) continue;
    if (SPACE_LIKE.test(ch)) {
      appendSpace(line);
      continue;
    }
    if (ch === SOFT_HYPHEN && i < item.str.length - 1) continue;
    const expanded = LIGATURES[ch];
    if (expanded) {
      for (const part of expanded) {
        line.chars.push(part);
        line.map.push(raw);
      }
    } else {
      line.chars.push(ch);
      line.map.push(raw);
    }
  }
}

type BreakKind = "paragraph" | "wrap";

/**
 * Decides whether the break between two consecutive selected lines is a
 * paragraph boundary or an incidental line wrap. Uses the full page lines so
 * partial first/last lines are judged by their real extent.
 */
export function lineBreakKind(
  model: PageModel,
  lastItem: ModelItem,
  nextItem: ModelItem,
  prevChars: string[],
  nextChars: string[],
): BreakKind {
  const L = lineOf(model, lastItem);
  const M = lineOf(model, nextItem);
  if (!L || !M) return "wrap";
  const size = Math.max(L.size, M.size);

  // Heading/body boundary: clear font size change.
  if (Math.abs(L.size - M.size) > 0.18 * size) return "paragraph";

  if (L.side === M.side && M.baseline > L.baseline) {
    const delta = M.baseline - L.baseline;
    const spacing = model.lineSpacing || 1.25 * model.bodySize;
    if (delta > 1.45 * spacing && delta > 1.2 * size) return "paragraph";
  }

  // First-line indent (or the outdent of a hanging-indent entry) starts a paragraph.
  const edgesM = columnEdges(model, M.index);
  const relIndent = M.x0 - edgesM.dominantLeft;
  if (relIndent > 0.6 * M.size && relIndent < 8 * M.size) return "paragraph";
  if (relIndent < -0.6 * M.size) return "paragraph";

  // In justified text, a line that stops well short of the column edge ends a
  // paragraph unless the next line clearly continues the sentence.
  const edgesL = columnEdges(model, L.index);
  if (edgesL.justified && L.x1 < edgesL.right - 1.5 * L.size) {
    const first = nextChars.find((ch) => ch !== " ") ?? "";
    if (/\p{Ll}/u.test(first)) return "wrap";
    if (/[.!?:;。！？：]["'”’)\]]*$/u.test(prevChars.join("").trimEnd())) return "paragraph";
    if (/[\p{Lo}\p{Lm}]/u.test(first)) return "wrap";
    return "paragraph";
  }
  return "wrap";
}

function dropTrailingSoftHyphen(chars: string[], map: number[]) {
  if (chars[chars.length - 1] === SOFT_HYPHEN) {
    chars.pop();
    map.pop();
  }
}

function leadingWord(chars: string[]): string {
  let word = "";
  for (const ch of chars) {
    if (!/\p{L}/u.test(ch)) break;
    word += ch;
  }
  return word;
}

function trailingWord(chars: string[], skipLast: number): string {
  let word = "";
  for (let i = chars.length - 1 - skipLast; i >= 0; i--) {
    const ch = chars[i]!;
    if (!/\p{L}/u.test(ch)) break;
    word = ch + word;
  }
  return word;
}

/** Joins a wrapped line onto the text so far: space, nothing (CJK), or dehyphenation. */
function joinWrappedLine(chars: string[], map: number[], next: string[], model: PageModel, vocabulary?: Set<string>) {
  const last = chars[chars.length - 1] ?? "";
  const first = next[0] ?? "";

  if (last === SOFT_HYPHEN) {
    chars.pop();
    map.pop();
    return;
  }
  if (HYPHENS.has(last) && /[\p{L}\p{N}]/u.test(chars[chars.length - 2] ?? "") && /[\p{L}\p{N}]/u.test(first)) {
    if (/\p{Ll}/u.test(first)) {
      const prefix = trailingWord(chars, 1).toLowerCase();
      const suffix = leadingWord(next).toLowerCase();
      if (shouldDropHyphen(prefix, suffix, model, vocabulary)) {
        chars.pop();
        map.pop();
      }
    }
    return;
  }
  // Breaks after a dash or between CJK characters need no space.
  if (last === "\u2013" || last === "\u2014" || (isCjk(last) && isCjk(first))) return;
  chars.push(" ");
  map.push(-1);
}

/**
 * Line-break hyphen removal, most specific evidence first:
 * the hyphenated form seen elsewhere keeps the hyphen; the joined word seen
 * elsewhere drops it; known compound prefixes keep it; otherwise the break is
 * treated as typesetter hyphenation (as PDF.js search does).
 */
export function shouldDropHyphen(prefix: string, suffix: string, model: Pick<PageModel, "words" | "hyphenated">, vocabulary?: Set<string>): boolean {
  if (!prefix || !suffix) return false;
  const knows = (word: string) => model.words.has(word) || (vocabulary?.has(word) ?? false);
  if (model.hyphenated.has(`${prefix}-${suffix}`)) return false;
  if (knows(prefix + suffix)) return true;
  if (COMPOUND_PREFIXES.has(prefix)) return false;
  return true;
}

/** Replacement characters, private-use glyphs, and control codes signal a broken text layer. */
export function assessReliability(text: string): ExtractResult["unreliable"] {
  let letters = 0;
  let suspicious = 0;
  for (const ch of text) {
    if (/\s/.test(ch)) continue;
    letters++;
    const code = ch.codePointAt(0)!;
    if (
      code === 0xfffd ||
      (code >= 0xe000 && code <= 0xf8ff) ||
      code >= 0xf0000 ||
      (code < 0x20 && ch !== "\n" && ch !== "\t") ||
      (code >= 0x7f && code < 0xa0)
    ) {
      suspicious++;
    }
  }
  if (letters === 0) return "none";
  const ratio = suspicious / letters;
  if (ratio > 0.2) return "severe";
  if (ratio > 0.02) return "some";
  return "none";
}
