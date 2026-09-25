/**
 * Builds the bounded context sent with a selection: nearby text before and
 * after it (same reading order as the selection), and the nearest section
 * heading. Page furniture and rotated labels are left out.
 */

import { CONTEXT_LIMITS } from "../../shared/config";
import { extractSelection, type Piece } from "./extract";
import type { ModelLine, PageModel } from "./pageModel";

export interface SelectionContext {
  before: string;
  after: string;
  section: string | null;
}

export interface Neighbours {
  previous?: PageModel | null;
  next?: PageModel | null;
}

export function buildContext(model: PageModel, kept: Piece[], neighbours: Neighbours = {}): SelectionContext {
  if (kept.length === 0) return { before: "", after: "", section: null };
  const first = kept[0]!;
  const last = kept[kept.length - 1]!;

  let before = textOfRange(model, 0, first.index, first.start);
  if (before.length < CONTEXT_LIMITS.beforeChars / 2 && neighbours.previous) {
    const tail = textOfRange(neighbours.previous, 0, neighbours.previous.items.length, 0);
    before = joinContext(tail, before);
  }
  let after = textAfter(model, last);
  if (after.length < CONTEXT_LIMITS.afterChars / 2 && neighbours.next) {
    const head = textOfRange(neighbours.next, 0, neighbours.next.items.length, 0);
    after = joinContext(after, head);
  }

  return {
    before: trimStartToWord(before, CONTEXT_LIMITS.beforeChars),
    after: trimEndToWord(after, CONTEXT_LIMITS.afterChars),
    section: findSection(model, first.index) ?? (neighbours.previous ? findSection(neighbours.previous, neighbours.previous.items.length) : null),
  };
}

/** Text of items [from, to) plus the first `partialEnd` characters of item `to`. */
function textOfRange(model: PageModel, from: number, to: number, partialEnd: number): string {
  const pieces: Piece[] = [];
  for (let i = from; i < to && i < model.items.length; i++) {
    pieces.push({ index: i, start: 0, end: model.items[i]!.str.length });
  }
  if (partialEnd > 0 && model.items[to]) pieces.push({ index: to, start: 0, end: partialEnd });
  return withoutFurniture(model, pieces);
}

function textAfter(model: PageModel, last: Piece): string {
  const pieces: Piece[] = [];
  const lastItem = model.items[last.index];
  if (lastItem && last.end < lastItem.str.length) pieces.push({ index: last.index, start: last.end, end: lastItem.str.length });
  for (let i = last.index + 1; i < model.items.length; i++) {
    pieces.push({ index: i, start: 0, end: model.items[i]!.str.length });
  }
  return withoutFurniture(model, pieces);
}

function withoutFurniture(model: PageModel, pieces: Piece[]): string {
  const body = pieces.filter((piece) => {
    const item = model.items[piece.index]!;
    if (item.rotated) return false;
    const line = item.line >= 0 ? model.lines[item.line] : undefined;
    return !line?.furniture;
  });
  return extractSelection(model, body).text;
}

function joinContext(a: string, b: string): string {
  if (!a) return b;
  if (!b) return a;
  return `${a}\n\n${b}`;
}

function trimStartToWord(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(text.length - max);
  const space = cut.search(/\s/);
  return space > 0 && space < 40 ? cut.slice(space + 1) : cut;
}

function trimEndToWord(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const space = cut.lastIndexOf(" ");
  return space > max - 40 ? cut.slice(0, space) : cut;
}

const NUMBERED_HEADING = /^(?:\d+(?:\.\d+){0,3}\.?|[IVXLC]+\.|[A-Z]\.|§\s*\d+)\s+\p{Lu}/u;

/** Nearest heading-like line at or before item `beforeItem`, searching backwards. */
export function findSection(model: PageModel, beforeItem: number): string | null {
  const firstItem = model.items[Math.min(beforeItem, model.items.length - 1)];
  let startLine = firstItem && firstItem.line >= 0 ? firstItem.line : model.lines.length - 1;
  if (beforeItem >= model.items.length) startLine = model.lines.length - 1;
  for (let i = startLine; i >= 0; i--) {
    const line = model.lines[i]!;
    if (line.furniture) continue;
    const text = lineText(model, line);
    if (isHeading(model, line, text)) return text.slice(0, CONTEXT_LIMITS.sectionChars);
  }
  return null;
}

function lineText(model: PageModel, line: ModelLine): string {
  return extractSelection(
    model,
    line.items.map((index) => ({ index, start: 0, end: model.items[index]!.str.length })),
  ).text;
}

function isHeading(model: PageModel, line: ModelLine, text: string): boolean {
  if (text.length < 2 || text.length > 90) return false;
  if (/[.,;:]$/.test(text)) return false;
  if (NUMBERED_HEADING.test(text)) return true;
  // Larger than body text but smaller than a title block.
  const ratio = line.size / model.bodySize;
  return ratio > 1.12 && ratio < 1.6 && /^\p{Lu}/u.test(text) && !/^\d+$/.test(text);
}
