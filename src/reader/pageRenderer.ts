import type { PDFDocumentProxy, PDFPageProxy, RenderTask } from "pdfjs-dist";
import type { TextContent } from "pdfjs-dist/types/src/display/api";
import { pdfjs } from "../lib/pdf";
import { buildPageModel, type PageModel, type TextContentLike } from "../selection/pageModel";
import { PDF_TO_CSS } from "./layout";
import { registerTextLayer, unregisterTextLayer } from "./selectionAssist";

export interface PageHosts {
  page: HTMLElement;
  canvasHost: HTMLElement;
  textHost: HTMLElement;
}

export interface RendererEvents {
  /** A page's text is known: whether it has a selectable text layer. */
  onTextInfo(pageIndex: number, hasText: boolean): void;
  /** A page's text layer is in the DOM (selection is possible). */
  onTextLayerReady(pageIndex: number): void;
  /** A page's text layer was released (it will be rebuilt when needed). */
  onTextLayerReleased(pageIndex: number): void;
  /** A page could not be rendered. */
  onPageError(pageIndex: number, message: string): void;
}

interface Slot {
  index: number;
  hosts: PageHosts | null;
  canvas: HTMLCanvasElement | null;
  canvasZoom: number;
  renderTask: RenderTask | null;
  textLayer: InstanceType<typeof pdfjs.TextLayer> | null;
  textDiv: HTMLDivElement | null;
  textZoom: number;
  failed: boolean;
}

/** Keeps canvases for at most this many pages; others are released. */
const MAX_CANVAS_PAGES = 8;
/** Keeps parsed text (for selection and context) for this many pages. */
const MAX_TEXT_PAGES = 40;
/** Largest canvas area in device pixels (Safari's limit is 16.7M). */
const MAX_CANVAS_PIXELS = 16_000_000;

/**
 * Renders PDF pages into React-owned host elements: a canvas for the picture
 * and a pdf.js text layer for selection. Only pages near the viewport are
 * rendered; distant pages release their canvases and text layers.
 */
export class PageRenderer {
  readonly #doc: PDFDocumentProxy;
  readonly #events: RendererEvents;
  readonly #slots = new Map<number, Slot>();
  readonly #pages = new Map<number, Promise<PDFPageProxy>>();
  readonly #rotations = new Map<number, number>();
  readonly #text = new Map<number, Promise<{ content: TextContent; model: PageModel }>>();
  readonly #textReady = new Map<number, { content: TextContent; model: PageModel }>();
  readonly #textUse: number[] = [];
  /** Words from every page read so far, for hyphenation decisions. */
  readonly vocabulary = new Set<string>();
  #zoom = 1;
  #wanted: number[] = [];
  #pinned = new Set<number>();
  #running = false;
  #destroyed = false;

  constructor(doc: PDFDocumentProxy, events: RendererEvents) {
    this.#doc = doc;
    this.#events = events;
  }

  get zoom(): number {
    return this.#zoom;
  }

  attach(pageIndex: number, hosts: PageHosts): void {
    const slot = this.#slot(pageIndex);
    slot.hosts = hosts;
    this.#schedule();
  }

  detach(pageIndex: number): void {
    const slot = this.#slots.get(pageIndex);
    if (!slot) return;
    this.#releaseCanvas(slot);
    this.#releaseText(slot);
    slot.hosts = null;
  }

  /** New zoom: text layers rescale through CSS; canvases re-render in priority order. */
  setZoom(zoom: number): void {
    if (zoom === this.#zoom) return;
    this.#zoom = zoom;
    for (const slot of this.#slots.values()) {
      if (slot.renderTask) {
        slot.renderTask.cancel();
        slot.renderTask = null;
      }
    }
    this.#schedule();
  }

  /**
   * `wanted`: pages to render, most important first (visible, then nearby).
   * `keep`: pages whose rendering may stay; everything else is released.
   */
  update(wanted: number[], keep: Set<number>): void {
    this.#wanted = wanted.slice(0, MAX_CANVAS_PAGES);
    const wantedSet = new Set(this.#wanted);
    for (const slot of this.#slots.values()) {
      if (!keep.has(slot.index) && !wantedSet.has(slot.index) && !this.#pinned.has(slot.index)) {
        this.#releaseCanvas(slot);
        this.#releaseText(slot);
      }
    }
    // Hard cap on live canvases: drop pictures of pages that are not wanted first.
    let live = [...this.#slots.values()].filter((slot) => slot.canvas).length;
    for (const slot of this.#slots.values()) {
      if (live <= MAX_CANVAS_PAGES) break;
      if (slot.canvas && !wantedSet.has(slot.index) && !this.#pinned.has(slot.index)) {
        this.#releaseCanvas(slot);
        live--;
      }
    }
    this.#schedule();
  }

  /** Pages holding the current selection or passage are never released. */
  setPinned(pages: number[]): void {
    this.#pinned = new Set(pages);
  }

  textLayerOf(pageIndex: number): { div: HTMLDivElement; textDivs: HTMLElement[] } | null {
    const slot = this.#slots.get(pageIndex);
    if (!slot?.textDiv || !slot.textLayer) return null;
    return { div: slot.textDiv, textDivs: slot.textLayer.textDivs };
  }

  /** Text layer elements currently in the DOM, by page. */
  textLayers(): Map<number, HTMLElement> {
    const result = new Map<number, HTMLElement>();
    for (const slot of this.#slots.values()) if (slot.textDiv?.isConnected) result.set(slot.index, slot.textDiv);
    return result;
  }

  modelOf(pageIndex: number): PageModel | null {
    return this.#textReady.get(pageIndex)?.model ?? null;
  }

  /** Loads (or returns cached) text for a page, e.g. a neighbour needed for context. */
  async loadModel(pageIndex: number): Promise<PageModel | null> {
    if (pageIndex < 0 || pageIndex >= this.#doc.numPages) return null;
    try {
      return (await this.#loadText(pageIndex)).model;
    } catch {
      return null;
    }
  }

  destroy(): void {
    this.#destroyed = true;
    for (const slot of this.#slots.values()) {
      this.#releaseCanvas(slot);
      this.#releaseText(slot);
    }
    this.#slots.clear();
  }

  #slot(index: number): Slot {
    let slot = this.#slots.get(index);
    if (!slot) {
      slot = { index, hosts: null, canvas: null, canvasZoom: 0, renderTask: null, textLayer: null, textDiv: null, textZoom: 0, failed: false };
      this.#slots.set(index, slot);
    }
    return slot;
  }

  #page(index: number): Promise<PDFPageProxy> {
    let promise = this.#pages.get(index);
    if (!promise) {
      promise = this.#doc.getPage(index + 1).then((page) => {
        this.#rotations.set(index, page.rotate);
        return page;
      });
      this.#pages.set(index, promise);
    }
    return promise;
  }

  /** Page rotation in degrees (from the PDF), 0 until the page is loaded. */
  rotationOf(pageIndex: number): number {
    return this.#rotations.get(pageIndex) ?? 0;
  }

  #loadText(index: number): Promise<{ content: TextContent; model: PageModel }> {
    let promise = this.#text.get(index);
    if (!promise) {
      promise = (async () => {
        const page = await this.#page(index);
        const content = await page.getTextContent({ includeMarkedContent: true, disableNormalization: true });
        const viewport = page.getViewport({ scale: 1 });
        const model = buildPageModel(index, content as unknown as TextContentLike, viewport.rawDims as { pageX: number; pageY: number; pageWidth: number; pageHeight: number });
        for (const word of model.words) this.vocabulary.add(word);
        const entry = { content, model };
        this.#textReady.set(index, entry);
        this.#touchText(index);
        const hasText = model.items.some((item) => !item.empty);
        this.#events.onTextInfo(index, hasText);
        return entry;
      })();
      promise.catch(() => this.#text.delete(index));
      this.#text.set(index, promise);
    }
    return promise;
  }

  #touchText(index: number) {
    const at = this.#textUse.indexOf(index);
    if (at >= 0) this.#textUse.splice(at, 1);
    this.#textUse.push(index);
    while (this.#textUse.length > MAX_TEXT_PAGES) {
      const evict = this.#textUse.shift()!;
      if (this.#slots.get(evict)?.textDiv || this.#pinned.has(evict)) {
        this.#textUse.push(evict);
        break;
      }
      this.#text.delete(evict);
      this.#textReady.delete(evict);
    }
  }

  #schedule() {
    if (this.#running || this.#destroyed) return;
    this.#running = true;
    queueMicrotask(() => void this.#loop());
  }

  async #loop() {
    try {
      for (;;) {
        if (this.#destroyed) return;
        const next = this.#nextJob();
        if (!next) return;
        try {
          await next.job();
        } catch {
          // Never let one page stop the queue.
          this.#fail(next.slot, "This page couldn't be displayed.");
        }
      }
    } finally {
      this.#running = false;
    }
  }

  /** Visible pages first: picture, then text; then prefetch nearby pages. */
  #nextJob(): { slot: Slot; job: () => Promise<void> } | null {
    for (const index of this.#wanted) {
      const slot = this.#slots.get(index);
      if (!slot?.hosts || slot.failed) continue;
      if (slot.canvasZoom !== this.#zoom) return { slot, job: () => this.#renderCanvas(slot) };
      if (!slot.textDiv) return { slot, job: () => this.#renderText(slot) };
      if (slot.textZoom !== this.#zoom) return { slot, job: () => this.#rescaleText(slot) };
    }
    return null;
  }

  async #renderCanvas(slot: Slot): Promise<void> {
    const zoom = this.#zoom;
    let page: PDFPageProxy;
    try {
      page = await this.#page(slot.index);
    } catch {
      this.#fail(slot, "This page couldn't be read.");
      return;
    }
    if (!slot.hosts || zoom !== this.#zoom) return;
    const viewport = page.getViewport({ scale: zoom * PDF_TO_CSS });
    const ratio = window.devicePixelRatio || 1;
    const area = viewport.width * viewport.height * ratio * ratio;
    const outputScale = area > MAX_CANVAS_PIXELS ? ratio * Math.sqrt(MAX_CANVAS_PIXELS / area) : ratio;

    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.floor(viewport.width * outputScale));
    canvas.height = Math.max(1, Math.floor(viewport.height * outputScale));
    canvas.className = "page-canvas";
    canvas.setAttribute("aria-hidden", "true");
    const task = page.render({
      canvas,
      viewport,
      transform: outputScale !== 1 ? [outputScale, 0, 0, outputScale, 0, 0] : undefined,
    });
    slot.renderTask = task;
    try {
      await task.promise;
    } catch (error) {
      slot.renderTask = null;
      canvas.width = canvas.height = 0;
      if ((error as { name?: string })?.name === "RenderingCancelledException") return;
      this.#fail(slot, "This page couldn't be displayed.");
      return;
    }
    slot.renderTask = null;
    if (!slot.hosts || zoom !== this.#zoom || this.#destroyed) {
      canvas.width = canvas.height = 0;
      return;
    }
    // Swap in the new picture only when it is complete (no blank flash while zooming).
    const old = slot.canvas;
    slot.hosts.canvasHost.append(canvas);
    if (old) {
      old.remove();
      old.width = old.height = 0;
    }
    slot.canvas = canvas;
    slot.canvasZoom = zoom;
    slot.hosts.page.dataset.rendered = "true";
  }

  async #renderText(slot: Slot): Promise<void> {
    const zoom = this.#zoom;
    let entry: { content: TextContent; model: PageModel };
    let page: PDFPageProxy;
    try {
      [entry, page] = await Promise.all([this.#loadText(slot.index), this.#page(slot.index)]);
    } catch {
      this.#fail(slot, "This page's text couldn't be read.");
      return;
    }
    if (!slot.hosts || slot.textDiv) return;
    this.#touchText(slot.index);
    const div = document.createElement("div");
    div.className = "textLayer";
    const textLayer = new pdfjs.TextLayer({
      textContentSource: entry.content,
      container: div,
      viewport: page.getViewport({ scale: zoom * PDF_TO_CSS }),
    });
    try {
      await textLayer.render();
    } catch {
      return;
    }
    if (!slot.hosts || this.#destroyed) return;
    const end = document.createElement("div");
    end.className = "endOfContent";
    div.append(end);
    slot.hosts.textHost.replaceChildren(div);
    registerTextLayer(div, end);
    slot.textLayer = textLayer;
    slot.textDiv = div;
    slot.textZoom = zoom;
    this.#events.onTextLayerReady(slot.index);
  }

  async #rescaleText(slot: Slot): Promise<void> {
    const page = await this.#page(slot.index);
    if (!slot.textLayer || !slot.textDiv) return;
    const zoom = this.#zoom;
    slot.textLayer.update({ viewport: page.getViewport({ scale: zoom * PDF_TO_CSS }) });
    slot.textZoom = zoom;
  }

  #releaseCanvas(slot: Slot) {
    slot.renderTask?.cancel();
    slot.renderTask = null;
    if (slot.canvas) {
      slot.canvas.remove();
      slot.canvas.width = slot.canvas.height = 0;
      slot.canvas = null;
    }
    slot.canvasZoom = 0;
    if (slot.hosts) delete slot.hosts.page.dataset.rendered;
  }

  #releaseText(slot: Slot) {
    if (slot.textDiv) {
      unregisterTextLayer(slot.textDiv);
      slot.textDiv.remove();
      if (!this.#destroyed) this.#events.onTextLayerReleased(slot.index);
    }
    slot.textLayer?.cancel();
    slot.textLayer = null;
    slot.textDiv = null;
    slot.textZoom = 0;
  }

  #fail(slot: Slot, message: string) {
    slot.failed = true;
    this.#events.onPageError(slot.index, message);
  }
}
