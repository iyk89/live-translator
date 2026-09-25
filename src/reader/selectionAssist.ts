/**
 * Keeps drag-selection in pdf.js text layers from jumping over whitespace.
 *
 * Adapted from PDF.js TextLayerBuilder (web/text_layer_builder.js, v6.3).
 * Copyright 2012 Mozilla Foundation. Licensed under the Apache License,
 * Version 2.0: http://www.apache.org/licenses/LICENSE-2.0
 *
 * While selecting, an invisible `.endOfContent` block covers the empty space
 * of the page; in older Chromium it is also moved next to the selection edge
 * so hovering empty space extends the selection to at most one text run.
 */

const layers = new Map<HTMLElement, HTMLElement>();
let controller: AbortController | null = null;

export function registerTextLayer(textLayer: HTMLElement, endOfContent: HTMLElement): void {
  textLayer.addEventListener("mousedown", () => textLayer.classList.add("selecting"));
  layers.set(textLayer, endOfContent);
  enableGlobalListeners();
}

export function unregisterTextLayer(textLayer: HTMLElement): void {
  layers.delete(textLayer);
  if (layers.size === 0) {
    controller?.abort();
    controller = null;
  }
}

function reset(end: HTMLElement, textLayer: HTMLElement) {
  textLayer.append(end);
  end.style.width = "";
  end.style.height = "";
  end.style.userSelect = "";
  textLayer.classList.remove("selecting");
}

function enableGlobalListeners() {
  if (controller) return;
  controller = new AbortController();
  const { signal } = controller;
  let isPointerDown = false;
  let modernEngine: boolean | undefined;
  let prevRange: Range | null = null;

  document.addEventListener("pointerdown", () => (isPointerDown = true), { signal });
  document.addEventListener(
    "pointerup",
    () => {
      isPointerDown = false;
      layers.forEach(reset);
    },
    { signal },
  );
  window.addEventListener(
    "blur",
    () => {
      isPointerDown = false;
      layers.forEach(reset);
    },
    { signal },
  );
  document.addEventListener(
    "keyup",
    () => {
      if (!isPointerDown) layers.forEach(reset);
    },
    { signal },
  );

  document.addEventListener(
    "selectionchange",
    () => {
      const selection = document.getSelection();
      if (!selection || selection.rangeCount === 0) {
        layers.forEach(reset);
        return;
      }
      const active = new Set<HTMLElement>();
      for (let i = 0; i < selection.rangeCount; i++) {
        const range = selection.getRangeAt(i);
        for (const layer of layers.keys()) {
          if (!active.has(layer) && range.intersectsNode(layer)) active.add(layer);
        }
      }
      for (const [layer, end] of layers) {
        if (active.has(layer)) layer.classList.add("selecting");
        else reset(end, layer);
      }

      if (modernEngine === undefined) {
        const first = layers.keys().next().value;
        const firefox = first ? getComputedStyle(first).getPropertyValue("-moz-user-select") === "none" : false;
        const chromium = /\bChrome\/(\d+)\b/.exec(navigator.userAgent)?.[1];
        modernEngine = firefox || (!!chromium && Number.parseInt(chromium, 10) >= 148);
      }
      if (modernEngine) return;

      const range = selection.getRangeAt(0);
      const modifyStart =
        prevRange &&
        (range.compareBoundaryPoints(Range.END_TO_END, prevRange) === 0 ||
          range.compareBoundaryPoints(Range.START_TO_END, prevRange) === 0);
      let anchor: Node | null = modifyStart ? range.startContainer : range.endContainer;
      if (anchor?.nodeType === Node.TEXT_NODE) anchor = anchor.parentNode;
      if (!modifyStart && range.endOffset === 0 && anchor) {
        do {
          while (anchor && !anchor.previousSibling) anchor = anchor.parentNode;
          anchor = anchor?.previousSibling ?? null;
        } while (anchor && !anchor.childNodes.length);
      }
      const element = anchor as HTMLElement | null;
      const parentLayer = element?.parentElement?.closest<HTMLElement>(".textLayer");
      const end = parentLayer ? layers.get(parentLayer) : undefined;
      if (end && parentLayer && element?.parentElement) {
        end.style.width = parentLayer.style.width;
        end.style.height = parentLayer.style.height;
        end.style.userSelect = "text";
        element.parentElement.insertBefore(end, modifyStart ? element : element.nextSibling);
      }
      prevRange = range.cloneRange();
    },
    { signal },
  );
}
