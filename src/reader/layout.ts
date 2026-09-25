/** Page layout of the continuous-scroll reader (pure geometry, no DOM). */

/** CSS pixels per PDF point at 100% zoom (PDF units are 1/72 in, CSS px 1/96 in). */
export const PDF_TO_CSS = 96 / 72;

/** Zoom presets, as a fraction of the printed page size. */
export const ZOOM_STEPS = [0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4] as const;
export const MIN_ZOOM = ZOOM_STEPS[0];
export const MAX_ZOOM = ZOOM_STEPS[ZOOM_STEPS.length - 1]!;
/** "Auto" fits the page width but never enlarges beyond this. */
export const AUTO_MAX_ZOOM = 1.25;

export interface PageSize {
  /** PDF points, rotation applied. */
  width: number;
  height: number;
}

export interface PageBox {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface Layout {
  zoom: number;
  pages: PageBox[];
  width: number;
  height: number;
}

export interface LayoutOptions {
  gap: number;
  padTop: number;
  padBottom: number;
  padX: number;
}

export const DEFAULT_LAYOUT_OPTIONS: LayoutOptions = { gap: 16, padTop: 20, padBottom: 40, padX: 20 };

export function computeLayout(sizes: PageSize[], zoom: number, containerWidth: number, options: LayoutOptions = DEFAULT_LAYOUT_OPTIONS): Layout {
  const scale = zoom * PDF_TO_CSS;
  const boxes: PageBox[] = [];
  let maxWidth = 0;
  for (const size of sizes) {
    const width = Math.floor(size.width * scale);
    const height = Math.floor(size.height * scale);
    maxWidth = Math.max(maxWidth, width);
    boxes.push({ top: 0, left: 0, width, height });
  }
  const width = Math.max(containerWidth, maxWidth + 2 * options.padX);
  let top = options.padTop;
  for (const box of boxes) {
    box.top = top;
    box.left = Math.floor((width - box.width) / 2);
    top += box.height + options.gap;
  }
  const height = boxes.length ? top - options.gap + options.padBottom : options.padTop + options.padBottom;
  return { zoom, pages: boxes, width, height };
}

/** Zoom at which the widest page fills the container width. */
export function fitWidthZoom(sizes: PageSize[], containerWidth: number, options: LayoutOptions = DEFAULT_LAYOUT_OPTIONS): number {
  const widest = Math.max(1, ...sizes.map((s) => s.width));
  const zoom = (containerWidth - 2 * options.padX) / (widest * PDF_TO_CSS);
  return clampZoom(zoom);
}

export function autoZoom(sizes: PageSize[], containerWidth: number, options?: LayoutOptions): number {
  return Math.min(AUTO_MAX_ZOOM, fitWidthZoom(sizes, containerWidth, options));
}

export function clampZoom(zoom: number): number {
  return Math.min(MAX_ZOOM, Math.max(0.25, zoom));
}

export function stepZoom(current: number, direction: 1 | -1): number {
  if (direction > 0) return ZOOM_STEPS.find((step) => step > current + 0.001) ?? MAX_ZOOM;
  return [...ZOOM_STEPS].reverse().find((step) => step < current - 0.001) ?? MIN_ZOOM;
}

/** Index of the page at vertical offset `y` (the nearest page when in a gap). */
export function pageAt(layout: Layout, y: number): number {
  const pages = layout.pages;
  if (pages.length === 0) return 0;
  let lo = 0;
  let hi = pages.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (pages[mid]!.top <= y) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/** First and last page index intersecting [top, bottom]. */
export function visibleRange(layout: Layout, top: number, bottom: number): [number, number] {
  const first = pageAt(layout, top);
  let last = first;
  while (last + 1 < layout.pages.length && layout.pages[last + 1]!.top < bottom) last++;
  return [first, last];
}

export interface ScrollAnchor {
  pageIndex: number;
  /** Fractions within the page. */
  fx: number;
  fy: number;
}

/** The page point under (x, y) in content coordinates. */
export function anchorAt(layout: Layout, x: number, y: number): ScrollAnchor {
  const pageIndex = pageAt(layout, y);
  const page = layout.pages[pageIndex];
  if (!page) return { pageIndex: 0, fx: 0.5, fy: 0 };
  return {
    pageIndex,
    fx: Math.min(1, Math.max(0, (x - page.left) / page.width)),
    fy: Math.min(1, Math.max(0, (y - page.top) / page.height)),
  };
}

/** Content coordinates of a page anchor in another layout (after zoom or resize). */
export function pointFor(layout: Layout, anchor: ScrollAnchor): { x: number; y: number } {
  const page = layout.pages[Math.min(anchor.pageIndex, layout.pages.length - 1)];
  if (!page) return { x: 0, y: 0 };
  return { x: page.left + anchor.fx * page.width, y: page.top + anchor.fy * page.height };
}

/** The page that is "current": the one covering the upper third of the view. */
export function currentPageIndex(layout: Layout, scrollTop: number, viewportHeight: number): number {
  return pageAt(layout, scrollTop + Math.min(viewportHeight / 3, 200));
}
