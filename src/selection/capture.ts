/**
 * DOM side of selection capture: maps a browser Range over a pdf.js text
 * layer to item/character pieces, and measures highlight rectangles.
 */

import type { Piece } from "./extract";
import { mergeLineRects, normalizeRect, type NormRect } from "./geometry";

/**
 * Character ranges of every text-layer span the range touches. Spans are the
 * layer's `textDivs`, whose indices equal the text-content item indices.
 */
export function piecesFromRange(range: Range, textDivs: readonly HTMLElement[]): Piece[] {
  const pieces: Piece[] = [];
  for (let index = 0; index < textDivs.length; index++) {
    const div = textDivs[index]!;
    if (!div.isConnected) continue;
    const node = div.firstChild;
    if (!node || node.nodeType !== Node.TEXT_NODE) continue;
    const text = node as Text;
    if (!range.intersectsNode(text)) continue;
    const length = text.length;
    let start = range.startContainer === text ? range.startOffset : 0;
    let end = range.endContainer === text ? range.endOffset : length;
    // Boundaries can also sit on the span element itself.
    if (range.startContainer === div) start = range.startOffset > 0 ? length : 0;
    if (range.endContainer === div) end = range.endOffset > 0 ? length : 0;
    if (end > start) pieces.push({ index, start, end });
  }
  return pieces;
}

/** Highlight rectangles for the kept pieces, relative to the page element. */
export function rectsForPieces(pieces: readonly Piece[], textDivs: readonly HTMLElement[], pageElement: HTMLElement): NormRect[] {
  const pageBox = pageElement.getBoundingClientRect();
  const measure = document.createRange();
  const rects: NormRect[] = [];
  for (const piece of pieces) {
    const node = textDivs[piece.index]?.firstChild;
    if (!node || node.nodeType !== Node.TEXT_NODE) continue;
    const text = node as Text;
    const start = Math.min(piece.start, text.length);
    const end = Math.min(piece.end, text.length);
    if (end <= start) continue;
    measure.setStart(text, start);
    measure.setEnd(text, end);
    for (const rect of measure.getClientRects()) {
      const normalized = normalizeRect(rect, pageBox);
      if (normalized) rects.push(normalized);
    }
  }
  measure.detach();
  return mergeLineRects(rects);
}

/** The page index of the text layer that contains `node`, if any. */
export function textLayerPageOf(node: Node | null): number | null {
  const element = node instanceof Element ? node : node?.parentElement;
  const layer = element?.closest<HTMLElement>(".textLayer");
  const page = layer?.closest<HTMLElement>("[data-page-index]");
  if (!page) return null;
  const index = Number(page.dataset.pageIndex);
  return Number.isInteger(index) ? index : null;
}

/** Page indices whose text layers the range touches. */
export function pagesTouchedByRange(range: Range, layers: ReadonlyMap<number, HTMLElement>): number[] {
  const pages: number[] = [];
  for (const [pageIndex, div] of layers) {
    if (range.intersectsNode(div)) pages.push(pageIndex);
  }
  return pages.sort((a, b) => a - b);
}
