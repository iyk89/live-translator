import { buildPageModel, type PageBox, type PageModel, type TextContentLike } from "./pageModel";
import type { Piece } from "./extract";

export interface FixturePage {
  pageIndex: number;
  box: PageBox;
  rotation: number;
  content: TextContentLike;
}

export function modelFromFixture(page: FixturePage): PageModel {
  return buildPageModel(page.pageIndex, page.content, page.box);
}

/** Finds `needle` in the page's items (searching from item `fromItem`). */
export function locate(model: PageModel, needle: string, fromItem = 0): { index: number; offset: number } {
  for (let i = fromItem; i < model.items.length; i++) {
    const offset = model.items[i]!.str.indexOf(needle);
    if (offset >= 0) return { index: i, offset };
  }
  throw new Error(`"${needle}" not found on page ${model.pageIndex + 1}`);
}

/**
 * Pieces for a selection that starts at the first character of `startText`
 * and ends after the last character of `endText`, like a mouse drag would.
 */
export function selectRange(model: PageModel, startText: string, endText: string): Piece[] {
  const start = locate(model, startText);
  const end = locate(model, endText, start.index);
  const endOffset = end.offset + endText.length;
  const pieces: Piece[] = [];
  for (let i = start.index; i <= end.index; i++) {
    const item = model.items[i]!;
    pieces.push({
      index: i,
      start: i === start.index ? start.offset : 0,
      end: i === end.index ? endOffset : item.str.length,
    });
  }
  return pieces;
}
