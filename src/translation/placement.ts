/**
 * Places the translation card next to its passage, in document (scroll
 * content) coordinates so it scrolls together with the text.
 *
 * Preference: below the passage, then above, then beside it in the margin,
 * then whichever of below/above has more room (with internal scrolling), and
 * only as a last resort over the passage. The card never extends past the
 * visible area it was opened in.
 */

import type { Box } from "../selection/geometry";

export type Placement = "below" | "above" | "right" | "left" | "overlay";

export interface PlacementInput {
  /** Passage bounding box (content coordinates). */
  anchor: Box;
  /** Last line of the passage (content coordinates), used to align the card. */
  lastLine?: Box;
  /** Visible part of the scroll content. */
  viewport: Box;
  /** Natural card size before height limiting. */
  card: { width: number; height: number };
  /** Total scrollable content size. */
  content: { width: number; height: number };
  /** Keep the previous side when it still fits, to avoid jumping. */
  previous?: Placement;
}

export interface PlacementResult {
  left: number;
  top: number;
  maxHeight: number;
  placement: Placement;
}

const GAP = 10;
const EDGE = 12;
const MIN_HEIGHT = 150;

export function placeCard(input: PlacementInput): PlacementResult {
  const { anchor, viewport, card, content } = input;
  const width = Math.min(card.width, viewport.width - 2 * EDGE);
  const visibleTop = viewport.top + EDGE;
  const visibleBottom = viewport.top + viewport.height - EDGE;
  const visibleLeft = viewport.left + EDGE;
  const visibleRight = viewport.left + viewport.width - EDGE;

  const spaceBelow = visibleBottom - (anchor.top + anchor.height + GAP);
  const spaceAbove = anchor.top - GAP - visibleTop;
  const spaceRight = visibleRight - (anchor.left + anchor.width + GAP);
  const spaceLeft = anchor.left - GAP - visibleLeft;
  const fullHeight = visibleBottom - visibleTop;
  const needed = Math.min(card.height, fullHeight);

  const alignX = (input.lastLine ?? anchor).left;
  const clampX = (x: number) => Math.max(visibleLeft, Math.min(x, visibleRight - width));
  const clampContent = (result: PlacementResult): PlacementResult => ({
    ...result,
    left: Math.max(0, Math.min(result.left, content.width - width)),
    top: Math.max(0, Math.min(result.top, content.height - Math.min(result.maxHeight, card.height))),
  });

  const below = (): PlacementResult => ({
    placement: "below",
    left: clampX(alignX),
    top: anchor.top + anchor.height + GAP,
    maxHeight: Math.max(MIN_HEIGHT, spaceBelow),
  });
  const above = (): PlacementResult => {
    const maxHeight = Math.max(MIN_HEIGHT, spaceAbove);
    const height = Math.min(card.height, maxHeight);
    return { placement: "above", left: clampX(alignX), top: anchor.top - GAP - height, maxHeight };
  };
  const side = (placement: "right" | "left"): PlacementResult => {
    const top = Math.max(visibleTop, Math.min(anchor.top, visibleBottom - needed));
    const left = placement === "right" ? anchor.left + anchor.width + GAP : anchor.left - GAP - width;
    return { placement, left, top, maxHeight: visibleBottom - top };
  };

  const fits: Record<Placement, boolean> = {
    below: spaceBelow >= needed,
    above: spaceAbove >= needed,
    right: spaceRight >= width,
    left: spaceLeft >= width,
    overlay: true,
  };
  const build: Record<Exclude<Placement, "overlay">, () => PlacementResult> = {
    below,
    above,
    right: () => side("right"),
    left: () => side("left"),
  };

  if (input.previous && input.previous !== "overlay" && fits[input.previous]) {
    return clampContent(build[input.previous]());
  }
  for (const placement of ["below", "above", "right", "left"] as const) {
    if (fits[placement]) return clampContent(build[placement]());
  }
  // Nothing fits fully: use the larger vertical space if it is usable.
  if (Math.max(spaceBelow, spaceAbove) >= MIN_HEIGHT) {
    return clampContent(spaceBelow >= spaceAbove ? below() : above());
  }
  // Last resort: cover the lower part of the view, leaving the top of the passage visible.
  const height = Math.min(card.height, Math.max(MIN_HEIGHT, fullHeight * 0.5));
  return clampContent({
    placement: "overlay",
    left: clampX(alignX),
    top: visibleBottom - height,
    maxHeight: height,
  });
}
