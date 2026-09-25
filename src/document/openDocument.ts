import { IMPORT_HEADERS, type ImportErrorBody } from "../../shared/contracts";
import { formatBytes, type Limits } from "../../shared/config";
import { sha256Hex } from "../lib/hash";
import type { PDFDocumentProxy } from "../lib/pdf";
import type { StoredDocumentMeta } from "../storage/db";

export type DocumentSource =
  | { kind: "file"; file: File }
  | { kind: "link"; url: string }
  | { kind: "sample" }
  | { kind: "saved"; meta: StoredDocumentMeta; bytes: Uint8Array };

/** Truthful loading stages shown to the reader. */
export type OpenStage = "reading" | "fetching" | "opening";

export interface OpenedDocument {
  doc: PDFDocumentProxy;
  bytes: Uint8Array;
  meta: StoredDocumentMeta;
  destroy(): Promise<void>;
}

export class OpenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OpenError";
  }
}

export const SAMPLE_URL = `${import.meta.env.BASE_URL}samples/sample-paper.pdf`;

export async function openDocument(
  source: DocumentSource,
  limits: Limits,
  onStage: (stage: OpenStage) => void,
  signal: AbortSignal,
): Promise<OpenedDocument> {
  let bytes: Uint8Array;
  let fileName: string;
  let origin: StoredDocumentMeta["source"];

  if (source.kind === "file") {
    onStage("reading");
    if (source.file.size > limits.maxFileBytes) {
      throw new OpenError(`This file is ${formatBytes(source.file.size)}. PDFs up to ${formatBytes(limits.maxFileBytes)} are supported.`);
    }
    bytes = new Uint8Array(await source.file.arrayBuffer());
    fileName = source.file.name;
    origin = { kind: "upload" };
  } else if (source.kind === "link") {
    onStage("fetching");
    const result = await fetchLink(source.url, signal);
    bytes = result.bytes;
    fileName = result.fileName;
    origin = { kind: "link", url: result.finalUrl };
  } else if (source.kind === "sample") {
    onStage("fetching");
    const response = await fetch(SAMPLE_URL, { signal });
    if (!response.ok) throw new OpenError("The sample paper couldn't be loaded. Please try again.");
    bytes = new Uint8Array(await response.arrayBuffer());
    fileName = "sample-paper.pdf";
    origin = { kind: "sample" };
  } else {
    bytes = source.bytes;
    fileName = source.meta.fileName;
    origin = source.meta.source;
  }

  if (bytes.byteLength > limits.maxFileBytes) {
    throw new OpenError(`This PDF is ${formatBytes(bytes.byteLength)}. PDFs up to ${formatBytes(limits.maxFileBytes)} are supported.`);
  }
  signal.throwIfAborted();
  onStage("opening");
  // pdf.js is large; it loads only when a paper is opened.
  const { DocumentError, guessTitle, openPdf, titleFromFileName } = await import("../lib/pdf");
  let opened;
  try {
    opened = await openPdf(bytes, limits);
  } catch (error) {
    if (error instanceof DocumentError) throw new OpenError(error.message);
    throw error;
  }
  const { doc, loadingTask } = opened;
  try {
    signal.throwIfAborted();
    const fingerprint = source.kind === "saved" ? source.meta.fingerprint : await sha256Hex(bytes);
    const title = source.kind === "saved" ? source.meta.title : await guessTitle(doc, titleFromFileName(fileName));
    return {
      doc,
      bytes,
      meta: {
        fingerprint,
        title,
        fileName,
        byteLength: bytes.byteLength,
        pageCount: doc.numPages,
        source: origin,
        openedAt: Date.now(),
      },
      destroy: () => loadingTask.destroy(),
    };
  } catch (error) {
    await loadingTask.destroy();
    throw error;
  }
}

async function fetchLink(url: string, signal: AbortSignal): Promise<{ bytes: Uint8Array; fileName: string; finalUrl: string }> {
  let response: Response;
  try {
    response = await fetch("/api/import", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url }),
      signal,
    });
  } catch (error) {
    if (signal.aborted) throw error;
    throw new OpenError("Couldn't reach the Passage server. Check your connection and try again.");
  }
  if (!response.ok) {
    let body: ImportErrorBody | undefined;
    try {
      body = ((await response.json()) as { error?: ImportErrorBody }).error;
    } catch {
      body = undefined;
    }
    throw new OpenError(body?.message ?? "This link doesn't lead to an accessible PDF. Upload the file or paste a direct PDF link.");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const decode = (value: string | null, fallback: string) => {
    try {
      return value ? decodeURIComponent(value) : fallback;
    } catch {
      return fallback;
    }
  };
  return {
    bytes,
    fileName: decode(response.headers.get(IMPORT_HEADERS.fileName), "paper.pdf"),
    finalUrl: decode(response.headers.get(IMPORT_HEADERS.finalUrl), url),
  };
}
