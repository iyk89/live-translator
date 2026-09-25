import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import type { ConfigResponse } from "../../shared/contracts";
import type { TargetLanguageCode } from "../../shared/languages";
import type { OpenedDocument } from "../document/openDocument";
import { isTypingTarget } from "../lib/clipboard";
import { randomId } from "../lib/hash";
import { pagesTouchedByRange, piecesFromRange, rectsForPieces } from "../selection/capture";
import { buildContext } from "../selection/context";
import { extractSelection, type ExtractResult } from "../selection/extract";
import { boundingRect, toPixels, type NormRect } from "../selection/geometry";
import { buildAnchor, freeze, type SelectionSnapshot } from "../selection/snapshot";
import { loadTranslation, saveTranslation, savePosition, type ReadingPosition } from "../storage/db";
import { streamTranslation } from "../translation/api";
import { TranslationCache } from "../translation/cache";
import { TranslationController } from "../translation/controller";
import { detectLanguage, detectSelectionLanguage, type Detection } from "../translation/detect";
import { placeCard, type PlacementResult } from "../translation/placement";
import { TranslationCard } from "../translation/TranslationCard";
import {
  anchorAt,
  autoZoom,
  computeLayout,
  currentPageIndex,
  fitWidthZoom,
  PDF_TO_CSS,
  pointFor,
  stepZoom,
  visibleRange,
  type Layout,
  type PageSize,
  type ScrollAnchor,
} from "./layout";
import { PageRenderer } from "./pageRenderer";
import { Toolbar } from "./Toolbar";

export interface ReaderProps {
  opened: OpenedDocument;
  initialPosition: ReadingPosition | null;
  config: ConfigResponse | null;
  maxSelectionChars: number;
  targetLang: TargetLanguageCode | null;
  onTargetLang(code: TargetLanguageCode): void;
  onBack(): void;
  storageNotice: string | null;
}

type ZoomState = { mode: "auto" | "fit-width" } | { mode: "custom"; value: number };

type SelectionUi =
  | { kind: "none" }
  | { kind: "ready"; pageIndex: number; extraction: ExtractResult; rects: NormRect[] }
  | { kind: "cross-page" | "too-long" | "unreadable"; at: { x: number; y: number }; length?: number };

const SHEET_BREAKPOINT = 640;
const CARD_WIDTH = 420;

export function Reader(props: ReaderProps) {
  const { opened, config } = props;
  const { doc, meta } = opened;
  const scrollRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const pageEls = useRef(new Map<number, HTMLElement>());

  const [viewportSize, setViewportSize] = useState({ width: 0, height: 0 });
  const [sizes, setSizes] = useState<PageSize[] | null>(null);
  const [sizesFinal, setSizesFinal] = useState(false);
  const [zoomState, setZoomState] = useState<ZoomState>(() => {
    const saved = props.initialPosition?.zoom;
    if (saved?.mode === "custom") return { mode: "custom", value: saved.scale };
    return { mode: saved?.mode ?? "auto" } as ZoomState;
  });
  const [currentPage, setCurrentPage] = useState(props.initialPosition?.pageIndex ?? 0);
  const [noTextPages, setNoTextPages] = useState<Set<number>>(() => new Set());
  const [textKnownPages, setTextKnownPages] = useState<Set<number>>(() => new Set());
  const [textLayerPages, setTextLayerPages] = useState<Set<number>>(() => new Set());
  const [pageErrors, setPageErrors] = useState<Map<number, string>>(() => new Map());
  const [selection, setSelection] = useState<SelectionUi>({ kind: "none" });
  const [bannerDismissed, setBannerDismissed] = useState<Record<string, boolean>>({});
  const [announcement, setAnnouncement] = useState("");
  const docLang = useRef<Detection | null>(null);

  /* ---------------------------------------------------------------- Renderer */

  // Created in an effect (not during render) so it is torn down and rebuilt cleanly.
  const [renderer, setRenderer] = useState<PageRenderer | null>(null);
  useEffect(() => {
    const instance = new PageRenderer(doc, {
      onTextInfo: (pageIndex, hasText) => {
        setTextKnownPages((prev) => new Set(prev).add(pageIndex));
        if (!hasText) setNoTextPages((prev) => new Set(prev).add(pageIndex));
      },
      onTextLayerReady: (pageIndex) => setTextLayerPages((prev) => new Set(prev).add(pageIndex)),
      onTextLayerReleased: (pageIndex) =>
        setTextLayerPages((prev) => {
          if (!prev.has(pageIndex)) return prev;
          const next = new Set(prev);
          next.delete(pageIndex);
          return next;
        }),
      onPageError: (pageIndex, message) => setPageErrors((prev) => new Map(prev).set(pageIndex, message)),
    });
    setRenderer(instance);
    return () => {
      instance.destroy();
      setTextLayerPages(new Set());
    };
  }, [doc]);

  /* ------------------------------------------------------------ Translation */

  const configVersion = useRef(config?.translation.configVersion ?? "unknown");
  useEffect(() => {
    if (config) configVersion.current = config.translation.configVersion;
  }, [config]);

  const controller = useMemo(
    () =>
      new TranslationController(
        {
          translate: streamTranslation,
          cache: new TranslationCache({ load: loadTranslation, save: saveTranslation }),
          configVersion: () => configVersion.current,
          onConfigVersion: (version) => (configVersion.current = version),
        },
        props.targetLang,
      ),
    // The controller lives as long as the document; target changes go through setTarget.
    [doc],
  );
  useEffect(() => () => controller.reset(), [controller]);
  const { card } = useSyncExternalStore(controller.subscribe, controller.getState);

  useEffect(() => {
    if (props.targetLang && props.targetLang !== controller.target) controller.setTarget(props.targetLang);
  }, [props.targetLang, controller]);

  useEffect(() => {
    if (card?.status === "loading") setAnnouncement("Translating…");
    else if (card?.status === "done") setAnnouncement("Translation ready.");
    else if (card?.status === "error") setAnnouncement(`Translation failed. ${card.error.message}`);
  }, [card?.status, card]);

  /* ------------------------------------------------------------------ Sizes */

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const first = (await doc.getPage(1)).getViewport({ scale: 1 });
      if (cancelled) return;
      setSizes(Array.from({ length: doc.numPages }, () => ({ width: first.width, height: first.height })));
      const all: PageSize[] = [];
      for (let start = 1; start <= doc.numPages; start += 24) {
        const batch = await Promise.all(
          Array.from({ length: Math.min(24, doc.numPages - start + 1) }, (_, k) =>
            doc.getPage(start + k).then((page) => page.getViewport({ scale: 1 })),
          ),
        );
        if (cancelled) return;
        all.push(...batch.map((viewport) => ({ width: viewport.width, height: viewport.height })));
      }
      setSizes((previous) =>
        previous && previous.every((size, i) => size.width === all[i]?.width && size.height === all[i]?.height) ? previous : all,
      );
      setSizesFinal(true);
    })().catch(() => {
      if (!cancelled) setSizesFinal(true);
    });
    return () => {
      cancelled = true;
    };
  }, [doc]);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setViewportSize({ width: el.clientWidth, height: el.clientHeight }));
    observer.observe(el);
    setViewportSize({ width: el.clientWidth, height: el.clientHeight });
    return () => observer.disconnect();
  }, []);

  const sheet = viewportSize.width > 0 && viewportSize.width < SHEET_BREAKPOINT;

  const zoom = useMemo(() => {
    if (!sizes || viewportSize.width === 0) return 1;
    if (zoomState.mode === "custom") return zoomState.value;
    if (zoomState.mode === "fit-width") return fitWidthZoom(sizes, viewportSize.width);
    return autoZoom(sizes, viewportSize.width);
  }, [sizes, viewportSize.width, zoomState]);

  const layout = useMemo<Layout | null>(() => {
    if (!sizes || viewportSize.width === 0) return null;
    const base = computeLayout(sizes, zoom, viewportSize.width);
    // On narrow screens keep room below the last page so the sheet never hides it.
    return sheet ? { ...base, height: base.height + Math.round(viewportSize.height * 0.55) } : base;
  }, [sizes, zoom, viewportSize.width, viewportSize.height, sheet]);

  useEffect(() => renderer?.setZoom(zoom), [renderer, zoom]);

  /* ----------------------------------------------- Scroll position & paging */

  const viewAnchor = useRef<ScrollAnchor | null>(null);
  const lastPosition = useRef<{ pageIndex: number; pageOffset: number } | null>(null);
  const restored = useRef(false);
  const lastLayout = useRef<Layout | null>(null);

  const updateVisibility = useCallback(() => {
    const el = scrollRef.current;
    if (!el || !layout || !renderer) return;
    const top = el.scrollTop;
    const bottom = top + el.clientHeight;
    const [first, last] = visibleRange(layout, top, bottom);
    const centre = (top + bottom) / 2;
    const visible: number[] = [];
    for (let i = first; i <= last; i++) visible.push(i);
    visible.sort((a, b) => {
      const pa = layout.pages[a]!;
      const pb = layout.pages[b]!;
      return Math.abs(pa.top + pa.height / 2 - centre) - Math.abs(pb.top + pb.height / 2 - centre);
    });
    const wanted = [...visible];
    for (const extra of [last + 1, first - 1, last + 2, first - 2]) if (extra >= 0 && extra < layout.pages.length) wanted.push(extra);
    const keep = new Set<number>();
    for (let i = Math.max(0, first - 3); i <= Math.min(layout.pages.length - 1, last + 3); i++) keep.add(i);
    renderer.update(wanted, keep);
    const current = currentPageIndex(layout, top, el.clientHeight);
    setCurrentPage(current);
    if (restored.current) {
      viewAnchor.current = anchorAt(layout, el.scrollLeft + el.clientWidth / 2, top + el.clientHeight / 2);
      // Remember the position against the page shown in the toolbar.
      const page = layout.pages[current]!;
      lastPosition.current = { pageIndex: current, pageOffset: Math.min(1, Math.max(-0.5, (top - page.top) / page.height)) };
    }
  }, [layout, renderer]);

  // Keep the reading position stable when the layout changes (zoom, resize, real page sizes).
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || !layout) return;
    const previous = lastLayout.current;
    lastLayout.current = layout;
    if (!restored.current) {
      const saved = props.initialPosition;
      if (!saved || saved.pageIndex === 0 || sizesFinal) {
        if (saved && layout.pages[saved.pageIndex]) {
          const page = layout.pages[saved.pageIndex]!;
          el.scrollTop = page.top + saved.pageOffset * page.height;
        }
        restored.current = true;
        viewAnchor.current = anchorAt(layout, el.scrollLeft + el.clientWidth / 2, el.scrollTop + el.clientHeight / 2);
      }
    } else if (previous && previous !== layout && viewAnchor.current) {
      const point = pointFor(layout, viewAnchor.current);
      el.scrollTop = Math.max(0, point.y - el.clientHeight / 2);
      el.scrollLeft = Math.max(0, point.x - el.clientWidth / 2);
    }
    updateVisibility();
  }, [layout, sizesFinal, props.initialPosition, updateVisibility]);

  const positionTimer = useRef<number | undefined>(undefined);
  // Writes the last known position; safe to call during unmount (no DOM reads).
  const persistPosition = useCallback(() => {
    const last = lastPosition.current;
    if (!last || !restored.current) return;
    const position: ReadingPosition = {
      fingerprint: meta.fingerprint,
      pageIndex: last.pageIndex,
      pageOffset: last.pageOffset,
      zoom: { mode: zoomState.mode, scale: zoomState.mode === "custom" ? zoomState.value : zoom },
      updatedAt: Date.now(),
    };
    void savePosition(position);
  }, [meta.fingerprint, zoomState, zoom]);

  useEffect(() => {
    const flush = () => persistPosition();
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onVisibility);
      flush();
    };
  }, [persistPosition]);

  // Persist zoom changes too.
  useEffect(() => {
    window.clearTimeout(positionTimer.current);
    positionTimer.current = window.setTimeout(persistPosition, 600);
  }, [zoomState, persistPosition]);

  const scrollFrame = useRef(0);
  const onScroll = useCallback(() => {
    if (scrollFrame.current) return;
    scrollFrame.current = requestAnimationFrame(() => {
      scrollFrame.current = 0;
      updateVisibility();
      window.clearTimeout(positionTimer.current);
      positionTimer.current = window.setTimeout(persistPosition, 700);
    });
  }, [updateVisibility, persistPosition]);

  const goToPage = useCallback(
    (pageIndex: number) => {
      const el = scrollRef.current;
      if (!el || !layout) return;
      const clamped = Math.min(layout.pages.length - 1, Math.max(0, pageIndex));
      el.scrollTop = Math.max(0, layout.pages[clamped]!.top - 12);
      setCurrentPage(clamped);
    },
    [layout],
  );

  const zoomBy = useCallback(
    (direction: 1 | -1) => setZoomState({ mode: "custom", value: stepZoom(zoom, direction) }),
    [zoom],
  );

  // Ctrl/Cmd + wheel (and trackpad pinch) zooms the document instead of the page.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let last = 0;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const now = performance.now();
      if (now - last < 120) return;
      last = now;
      zoomBy(event.deltaY < 0 ? 1 : -1);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomBy]);

  /* ---------------------------------------------------------------- Selection */

  const contentPoint = useCallback((clientX: number, clientY: number) => {
    const el = scrollRef.current!;
    const box = el.getBoundingClientRect();
    return { x: clientX - box.left + el.scrollLeft, y: clientY - box.top + el.scrollTop };
  }, []);

  const pointerDown = useRef(false);
  const evaluateSelection = useCallback(() => {
    if (!renderer) return;
    const native = document.getSelection();
    if (!native || native.rangeCount === 0 || native.isCollapsed) {
      setSelection((prev) => (prev.kind === "none" ? prev : { kind: "none" }));
      renderer.setPinned(card ? [card.snapshot.anchor.pageIndex] : []);
      return;
    }
    const layers = renderer.textLayers();
    const pages = new Set<number>();
    for (let i = 0; i < native.rangeCount; i++) {
      for (const page of pagesTouchedByRange(native.getRangeAt(i), layers)) pages.add(page);
    }
    if (pages.size === 0) {
      setSelection({ kind: "none" });
      return;
    }
    const range = native.getRangeAt(native.rangeCount - 1);
    const end = range.getBoundingClientRect();
    const endPoint = contentPoint(end.right, end.bottom);
    if (pages.size > 1) {
      setSelection({ kind: "cross-page", at: endPoint });
      return;
    }
    const pageIndex = [...pages][0]!;
    renderer.setPinned([pageIndex, ...(card ? [card.snapshot.anchor.pageIndex] : [])]);
    const textLayer = renderer.textLayerOf(pageIndex);
    const model = renderer.modelOf(pageIndex);
    const pageEl = pageEls.current.get(pageIndex);
    if (!textLayer || !model || !pageEl) {
      setSelection({ kind: "none" });
      return;
    }
    const pieces = piecesFromRange(native.getRangeAt(0), textLayer.textDivs);
    const extraction = extractSelection(model, pieces, renderer.vocabulary);
    if (!extraction.text.trim()) {
      setSelection({ kind: "none" });
      return;
    }
    if (extraction.text.length > props.maxSelectionChars) {
      setSelection({ kind: "too-long", at: endPoint, length: extraction.text.length });
      return;
    }
    if (extraction.unreliable === "severe") {
      setSelection({ kind: "unreadable", at: endPoint });
      return;
    }
    const rects = rectsForPieces(extraction.kept, textLayer.textDivs, pageEl);
    if (rects.length === 0) {
      setSelection({ kind: "none" });
      return;
    }
    setSelection({ kind: "ready", pageIndex, extraction, rects });
  }, [renderer, contentPoint, props.maxSelectionChars, card]);

  useEffect(() => {
    let timer: number | undefined;
    const onSelectionChange = () => {
      window.clearTimeout(timer);
      if (pointerDown.current) {
        setSelection((prev) => (prev.kind === "none" ? prev : { kind: "none" }));
        return;
      }
      timer = window.setTimeout(evaluateSelection, 220);
    };
    const onPointerDown = (event: PointerEvent) => {
      // Touch selection handles don't reliably report pointerup; for touch and
      // pen, the debounced selectionchange shows the action instead.
      if (event.pointerType !== "mouse") return;
      if ((event.target as Element | null)?.closest?.(".translate-action, .card")) return;
      pointerDown.current = true;
    };
    const onPointerUp = () => {
      if (!pointerDown.current) return;
      pointerDown.current = false;
      window.clearTimeout(timer);
      timer = window.setTimeout(evaluateSelection, 10);
    };
    document.addEventListener("selectionchange", onSelectionChange);
    document.addEventListener("pointerdown", onPointerDown, true);
    document.addEventListener("pointerup", onPointerUp, true);
    document.addEventListener("pointercancel", onPointerUp, true);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("selectionchange", onSelectionChange);
      document.removeEventListener("pointerdown", onPointerDown, true);
      document.removeEventListener("pointerup", onPointerUp, true);
      document.removeEventListener("pointercancel", onPointerUp, true);
    };
  }, [evaluateSelection]);

  // Document language from the first pages' text, used for short selections.
  useEffect(() => {
    if (docLang.current || !renderer) return;
    const sample = [0, 1, 2]
      .map((index) => renderer.modelOf(index)?.rawText ?? "")
      .join(" ")
      .slice(0, 6000);
    if (sample.length > 200) docLang.current = detectLanguage(sample);
  }, [textKnownPages, renderer]);

  const translateSelection = useCallback(() => {
    if (selection.kind !== "ready" || !renderer) return;
    const { pageIndex, extraction, rects } = selection;
    const model = renderer.modelOf(pageIndex);
    if (!model) return;
    const context = buildContext(model, extraction.kept, {
      previous: renderer.modelOf(pageIndex - 1),
      next: renderer.modelOf(pageIndex + 1),
    });
    const rotation = renderer.rotationOf(pageIndex);
    const snapshot: SelectionSnapshot = freeze({
      id: randomId(),
      anchor: buildAnchor(model, extraction, meta.fingerprint, rects, rotation),
      text: extraction.text,
      context: { ...context, title: meta.title },
      sourceLang: detectSelectionLanguage(extraction.text, docLang.current)?.lang ?? null,
      excluded: extraction.excluded,
      unreliable: extraction.unreliable,
    });
    document.getSelection()?.removeAllRanges();
    setSelection({ kind: "none" });
    renderer.setPinned([pageIndex]);
    controller.open(snapshot);
    requestAnimationFrame(() => cardRef.current?.focus({ preventScroll: true }));
  }, [selection, renderer, meta.fingerprint, meta.title, controller]);

  const closeCard = useCallback(() => {
    controller.close();
    renderer?.setPinned([]);
    scrollRef.current?.focus({ preventScroll: true });
  }, [controller, renderer]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return;
      if (event.key === "Escape" && card) {
        event.preventDefault();
        closeCard();
        return;
      }
      if ((event.key === "t" || event.key === "T") && !event.ctrlKey && !event.metaKey && !event.altKey) {
        if (isTypingTarget(event.target) || selection.kind !== "ready") return;
        event.preventDefault();
        translateSelection();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [card, closeCard, selection.kind, translateSelection]);

  /* ------------------------------------------------------------ Card layout */

  const [naturalHeight, setNaturalHeight] = useState(180);
  const [placement, setPlacement] = useState<PlacementResult | null>(null);
  const placementRef = useRef<PlacementResult | null>(null);
  const placedFor = useRef<string | null>(null);
  const activeAnchor = card?.snapshot.anchor ?? null;

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!card || !activeAnchor || !layout || !el || sheet) {
      placementRef.current = null;
      setPlacement(null);
      return;
    }
    const page = layout.pages[activeAnchor.pageIndex];
    const bounds = boundingRect(activeAnchor.rects);
    if (!page || !bounds) return;
    const anchorBox = toPixels(bounds, page);
    const lastRect = activeAnchor.rects[activeAnchor.rects.length - 1];
    // A new passage chooses its side afresh; the same passage keeps its side.
    if (placedFor.current !== card.snapshot.id) placementRef.current = null;
    placedFor.current = card.snapshot.id;
    const next = placeCard({
      anchor: anchorBox,
      lastLine: lastRect ? toPixels(lastRect, page) : undefined,
      viewport: { left: el.scrollLeft, top: el.scrollTop, width: el.clientWidth, height: el.clientHeight },
      card: { width: Math.min(CARD_WIDTH, el.clientWidth - 24), height: naturalHeight },
      content: { width: layout.width, height: layout.height },
      previous: placementRef.current?.placement,
    });
    placementRef.current = next;
    setPlacement(next);
    // Recompute when the passage, card size, or layout changes — not on scroll.
  }, [card?.snapshot.id, naturalHeight, layout, sheet]);

  // Bottom sheet: if the passage is hidden behind the sheet, scroll just enough to reveal it.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    const sheetEl = cardRef.current;
    if (!sheet || !card || !activeAnchor || !layout || !el || !sheetEl) return;
    const page = layout.pages[activeAnchor.pageIndex];
    const bounds = boundingRect(activeAnchor.rects);
    if (!page || !bounds) return;
    const box = toPixels(bounds, page);
    const sheetTop = sheetEl.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
    const overlap = box.top + Math.min(box.height, 120) + 12 - sheetTop;
    if (overlap > 0) el.scrollTop += Math.min(overlap, Math.max(0, box.top - el.scrollTop - 8));
    // When a passage opens and once more when its (taller) translation arrives.
  }, [card?.snapshot.id, card?.status === "done", sheet]);

  useEffect(() => {
    if (!card) placementRef.current = null;
  }, [card]);

  /* ------------------------------------------------------------- Rendering */

  const pinPage = useCallback(
    (pageIndex: number, element: HTMLElement | null, hosts: { canvasHost: HTMLElement; textHost: HTMLElement } | null) => {
      if (!renderer) return;
      if (element && hosts) {
        pageEls.current.set(pageIndex, element);
        renderer.attach(pageIndex, { page: element, ...hosts });
      } else {
        pageEls.current.delete(pageIndex);
        renderer.detach(pageIndex);
      }
    },
    [renderer],
  );

  const actionPosition = useMemo(() => {
    if (!layout) return null;
    if (selection.kind === "ready") {
      const page = layout.pages[selection.pageIndex];
      const last = selection.rects[selection.rects.length - 1];
      if (!page || !last) return null;
      const box = toPixels(last, page);
      return { x: box.left + box.width, y: box.top + box.height };
    }
    if (selection.kind === "none") return null;
    return selection.at;
  }, [layout, selection]);

  const firstPagesScanned =
    doc.numPages > 0 && [0, 1, 2].filter((i) => i < doc.numPages).every((i) => noTextPages.has(i));
  const currentHasTextLayer = textLayerPages.has(currentPage) || noTextPages.has(currentPage);
  const mockProvider = config?.translation.available ? config.translation.mock : false;

  const cardStyle: CSSProperties | undefined =
    !sheet && placement
      ? { left: placement.left, top: placement.top, width: Math.min(CARD_WIDTH, viewportSize.width - 24), maxHeight: placement.maxHeight }
      : undefined;

  return (
    <div className="reader">
      <Toolbar
        title={meta.title}
        pageIndex={currentPage}
        pageCount={doc.numPages}
        zoom={zoom}
        fitWidth={zoomState.mode === "fit-width"}
        targetLang={props.targetLang}
        onBack={props.onBack}
        onGoToPage={goToPage}
        onZoomStep={zoomBy}
        onFitWidth={() => setZoomState((state) => (state.mode === "fit-width" ? { mode: "custom", value: zoom } : { mode: "fit-width" }))}
        onTargetLang={props.onTargetLang}
      />
      <div className="reader-viewport">
        <div
          ref={scrollRef}
          className="doc-scroll"
          onScroll={onScroll}
          tabIndex={0}
          role="document"
          aria-label={`${meta.title}, page ${currentPage + 1} of ${doc.numPages}`}
        >
          {layout && (
            <div className="doc-content" style={{ width: layout.width, height: layout.height }}>
              {layout.pages.map((box, index) => (
                <PageSlot
                  key={index}
                  index={index}
                  box={box}
                  zoom={zoom}
                  onMount={pinPage}
                  noText={noTextPages.has(index)}
                  error={pageErrors.get(index) ?? null}
                  highlight={activeAnchor && activeAnchor.pageIndex === index ? activeAnchor.rects : null}
                />
              ))}

              {actionPosition && selection.kind !== "none" && (
                <TranslateAction selection={selection} at={actionPosition} contentWidth={layout.width} onTranslate={translateSelection} max={props.maxSelectionChars} />
              )}

              {card && !sheet && (
                <TranslationCard
                  ref={cardRef}
                  card={card}
                  sheet={false}
                  style={cardStyle ?? { visibility: "hidden" }}
                  mockProvider={mockProvider}
                  onClose={closeCard}
                  onRetry={() => controller.retry()}
                  onTranslateAnyway={() => controller.translateAnyway()}
                  onChooseLanguage={props.onTargetLang}
                  onNaturalHeight={setNaturalHeight}
                />
              )}
            </div>
          )}
        </div>

        {card && sheet && (
          <TranslationCard
            ref={cardRef}
            card={card}
            sheet
            mockProvider={mockProvider}
            onClose={closeCard}
            onRetry={() => controller.retry()}
            onTranslateAnyway={() => controller.translateAnyway()}
            onChooseLanguage={props.onTargetLang}
            onNaturalHeight={setNaturalHeight}
          />
        )}

        {firstPagesScanned && !bannerDismissed.scanned && (
          <div className="reader-banner" role="status">
            <span>
              This PDF looks scanned: its pages have no selectable text. You can read it, but translation needs selectable text (scanned pages
              aren't supported yet).
            </span>
            <button type="button" className="icon-btn" aria-label="Dismiss" onClick={() => setBannerDismissed((d) => ({ ...d, scanned: true }))}>
              ×
            </button>
          </div>
        )}
        {props.storageNotice && !bannerDismissed.storage && !firstPagesScanned && (
          <div className="reader-banner" role="status">
            <span>{props.storageNotice}</span>
            <button type="button" className="icon-btn" aria-label="Dismiss" onClick={() => setBannerDismissed((d) => ({ ...d, storage: true }))}>
              ×
            </button>
          </div>
        )}
        {layout && !currentHasTextLayer && (
          <div className="reader-status" role="status">
            <span className="spinner" aria-hidden="true" />
            Preparing text selection…
          </div>
        )}
        <div className="visually-hidden" aria-live="polite">
          {announcement}
        </div>
      </div>
    </div>
  );
}

/* --------------------------------------------------------------------------- */

interface PageSlotProps {
  index: number;
  box: { top: number; left: number; width: number; height: number };
  zoom: number;
  noText: boolean;
  error: string | null;
  highlight: readonly NormRect[] | null;
  onMount(index: number, element: HTMLElement | null, hosts: { canvasHost: HTMLElement; textHost: HTMLElement } | null): void;
}

const PageSlot = memo(function PageSlot({ index, box, zoom, noText, error, highlight, onMount }: PageSlotProps) {
  const pageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const textRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    onMount(index, pageRef.current, canvasRef.current && textRef.current ? { canvasHost: canvasRef.current, textHost: textRef.current } : null);
    return () => onMount(index, null, null);
  }, [index, onMount]);

  const style = {
    top: box.top,
    left: box.left,
    width: box.width,
    height: box.height,
    "--scale-factor": zoom * PDF_TO_CSS,
    "--total-scale-factor": zoom * PDF_TO_CSS,
  } as CSSProperties;

  return (
    <div ref={pageRef} className="page" style={style} data-page-index={index} aria-label={`Page ${index + 1}`} role="region">
      <div className="page-placeholder" aria-hidden="true">
        {error ?? `Page ${index + 1}`}
      </div>
      <div ref={canvasRef} className="page-canvas-host" />
      <div className="page-highlight-host">
        {highlight?.map((rect, i) => (
          <div
            key={i}
            className="passage-rect"
            style={{
              left: `${rect.x * 100}%`,
              top: `${rect.y * 100}%`,
              width: `${rect.w * 100}%`,
              height: `${rect.h * 100}%`,
            }}
          />
        ))}
      </div>
      <div ref={textRef} className="page-text-host" />
      {noText && <div className="page-notice">No selectable text on this page. Translation needs selectable text.</div>}
    </div>
  );
});

/* --------------------------------------------------------------------------- */

function TranslateAction(props: {
  selection: SelectionUi;
  at: { x: number; y: number };
  contentWidth: number;
  max: number;
  onTranslate(): void;
}) {
  const { selection, at } = props;
  const width = selection.kind === "ready" ? 130 : 300;
  const left = Math.max(8, Math.min(at.x - width / 2, props.contentWidth - width - 8));
  const style: CSSProperties = { left, top: at.y + 8 };

  if (selection.kind === "ready") {
    return (
      <button
        type="button"
        className="translate-action"
        style={style}
        // Keep the text selection: the button must not take it away on press.
        onPointerDown={(event) => event.preventDefault()}
        onMouseDown={(event) => event.preventDefault()}
        onClick={props.onTranslate}
        title="Translate selection (T)"
      >
        Translate <kbd aria-hidden="true">T</kbd>
      </button>
    );
  }
  const message =
    selection.kind === "cross-page"
      ? "Select text on one page at a time to translate it."
      : selection.kind === "too-long"
        ? `This selection is ${(selection.length ?? 0).toLocaleString("en-US")} characters. Select a smaller passage (up to ${props.max.toLocaleString("en-US")}).`
        : "This part of the PDF has no readable text layer. Try selecting a smaller passage.";
  return (
    <div className="translate-action is-info" style={style} role="status">
      {message}
    </div>
  );
}
