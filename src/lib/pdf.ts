// The "legacy" build carries polyfills, so the reader also works in browsers
// that lack the newest JavaScript features used by the modern build.
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PDFDocumentProxy } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?url";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

const assetBase = `${import.meta.env.BASE_URL}pdfjs/`;

export { pdfjs };
export type { PDFDocumentProxy };

export class DocumentError extends Error {
  readonly code: "not_pdf" | "encrypted" | "unreadable" | "too_large" | "too_many_pages" | "empty";
  constructor(code: DocumentError["code"], message: string) {
    super(message);
    this.name = "DocumentError";
    this.code = code;
  }
}

/** Checks the real file contents: the PDF header must appear in the first 1024 bytes. */
export function looksLikePdf(bytes: Uint8Array): boolean {
  const window = bytes.subarray(0, 1024);
  for (let i = 0; i + 4 < window.length; i++) {
    if (window[i] === 0x25 && window[i + 1] === 0x50 && window[i + 2] === 0x44 && window[i + 3] === 0x46 && window[i + 4] === 0x2d) {
      return true;
    }
  }
  return false;
}

export interface OpenedPdf {
  doc: PDFDocumentProxy;
  loadingTask: ReturnType<typeof pdfjs.getDocument>;
}

/**
 * Opens PDF bytes with pdf.js. A copy of the bytes is handed to the worker so
 * the caller's buffer stays usable for fingerprinting and saving.
 */
export async function openPdf(bytes: Uint8Array, limits: { maxPages: number }): Promise<OpenedPdf> {
  if (bytes.byteLength === 0) throw new DocumentError("empty", "This file is empty.");
  if (!looksLikePdf(bytes)) {
    throw new DocumentError("not_pdf", "This file isn't a PDF. Choose a PDF file (it should start with a %PDF header).");
  }
  const loadingTask = pdfjs.getDocument({
    data: bytes.slice(),
    cMapUrl: `${assetBase}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${assetBase}standard_fonts/`,
    wasmUrl: `${assetBase}wasm/`,
    iccUrl: `${assetBase}iccs/`,
    enableXfa: false,
    verbosity: 0,
  });
  // Password prompts are not supported: fail fast with a clear message.
  loadingTask.onPassword = () => {
    void loadingTask.destroy();
  };
  let doc: PDFDocumentProxy;
  try {
    doc = await loadingTask.promise;
  } catch (error) {
    throw mapPdfError(error);
  }
  if (doc.numPages > limits.maxPages) {
    const pages = doc.numPages;
    await loadingTask.destroy();
    throw new DocumentError(
      "too_many_pages",
      `This PDF has ${pages.toLocaleString("en-US")} pages. ${limits.maxPages} pages is the most Passage can open.`,
    );
  }
  return { doc, loadingTask };
}

function mapPdfError(error: unknown): DocumentError {
  if (error instanceof DocumentError) return error;
  const name = (error as { name?: string })?.name ?? "";
  if (name === "PasswordException" || /password/i.test(String((error as Error)?.message))) {
    return new DocumentError("encrypted", "This PDF is password-protected. Remove the password in another app, then open it again.");
  }
  if (name === "InvalidPDFException") {
    return new DocumentError("unreadable", "This PDF is damaged or incomplete and can't be opened.");
  }
  // A destroyed loading task (from the password handler) also lands here.
  if (/destroyed|Worker was terminated/i.test(String((error as Error)?.message))) {
    return new DocumentError("encrypted", "This PDF is password-protected. Remove the password in another app, then open it again.");
  }
  return new DocumentError("unreadable", "This PDF couldn't be opened. It may be damaged or use features Passage doesn't support.");
}

/** Title from metadata when it looks real, else the largest text near the top of page 1. */
export async function guessTitle(doc: PDFDocumentProxy, fallback: string): Promise<string> {
  try {
    const meta = await doc.getMetadata();
    const info = meta.info as { Title?: unknown };
    const title = typeof info?.Title === "string" ? info.Title.trim() : "";
    if (isUsefulTitle(title)) return title;
  } catch {
    // Metadata is optional.
  }
  try {
    const page = await doc.getPage(1);
    const viewport = page.getViewport({ scale: 1 });
    const content = await page.getTextContent();
    // Group horizontal text in the upper part of page 1 into lines by baseline.
    const lines = new Map<number, { size: number; text: string }>();
    for (const item of content.items) {
      if (!("str" in item) || !item.str.trim()) continue;
      const [a = 1, b = 0, c = 0, d = 1, , f = 0] = item.transform;
      if (Math.abs(b) > 0.01 * Math.abs(a)) continue;
      if (f < viewport.height * 0.45) continue;
      const size = Math.hypot(c, d);
      const key = Math.round(f);
      const line = lines.get(key) ?? { size: 0, text: "" };
      line.size = Math.max(line.size, size);
      line.text += item.str;
      lines.set(key, line);
    }
    const largest = Math.max(0, ...[...lines.values()].map((line) => line.size));
    const top = [...lines.entries()]
      .filter(([, line]) => line.size >= largest - 0.5)
      .sort((x, y) => y[0] - x[0])
      .map(([, line]) => line.text.trim())
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (top.length >= 8 && top.length <= 240) return top;
  } catch {
    // Fall through to the file name.
  }
  return fallback;
}

function isUsefulTitle(title: string): boolean {
  if (title.length < 4 || title.length > 300) return false;
  if (/^(untitled|microsoft word|document\d*|main|paper)\b/i.test(title)) return false;
  if (/\.(pdf|docx?|tex|dvi)$/i.test(title)) return false;
  return /\p{L}{3,}/u.test(title);
}

export function titleFromFileName(name: string): string {
  return name.replace(/\.pdf$/i, "").replace(/[_]+/g, " ").trim() || "Untitled paper";
}
