import http from "node:http";
import https from "node:https";
import type { ImportErrorCode } from "../../shared/contracts";
import { arxivFileName, arxivPdfUrl, parseBareArxivReference, resolveArxivUrl, type ArxivId } from "./arxiv";
import { bareHostname, BlockedDestinationError, createPinnedLookup, isIpLiteral, isPublicAddress } from "./network-policy";

export interface ImportOptions {
  maxBytes: number;
  /** Total time budget for the whole import, including redirects. */
  timeoutMs: number;
  maxRedirects: number;
  userAgent: string;
  /** Address policy. Tests may widen it; production uses isPublicAddress. */
  allowAddress?: (address: string) => boolean;
  /** DNS resolver override for tests. */
  resolver?: Parameters<typeof createPinnedLookup>[1];
  /** Ports that may be contacted. */
  allowedPorts?: number[];
}

export interface ImportedPdf {
  bytes: Buffer;
  finalUrl: string;
  fileName: string;
  source: "arxiv" | "url";
}

export class ImportError extends Error {
  readonly code: ImportErrorCode;
  readonly httpStatus: number;
  readonly upstreamStatus?: number;

  constructor(code: ImportErrorCode, message: string, httpStatus: number, upstreamStatus?: number) {
    super(message);
    this.name = "ImportError";
    this.code = code;
    this.httpStatus = httpStatus;
    this.upstreamStatus = upstreamStatus;
  }
}

export const NOT_A_PDF_MESSAGE = "This link doesn't lead to an accessible PDF. Upload the file or paste a direct PDF link.";

/** Parses what the reader pasted into a URL, applying arXiv shortcuts. */
export function normalizeInput(raw: string): { url: URL; arxiv: ArxivId | null } {
  const input = raw.trim();
  if (!input || input.length > 2048) {
    throw new ImportError("invalid_url", "Paste a link to a PDF or an arXiv paper.", 400);
  }
  const bare = parseBareArxivReference(input);
  if (bare) return { url: arxivPdfUrl(bare), arxiv: bare };

  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(input) ? input : `https://${input}`);
  } catch {
    throw new ImportError("invalid_url", "That doesn't look like a web link. Paste a link that starts with https://", 400);
  }
  // Ports are checked per request (with the configured allow list).
  assertAllowedShape(url, null);
  const arxiv = resolveArxivUrl(url);
  if (arxiv) return { url: arxiv.pdfUrl, arxiv: arxiv.arxiv };
  return { url, arxiv: null };
}

function assertAllowedShape(url: URL, allowedPorts: number[] | null = [80, 443]): void {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ImportError("unsupported_scheme", "Only http and https links are supported.", 400);
  }
  if (url.username || url.password) {
    throw new ImportError("credentials_in_url", "Links that contain a username or password aren't supported.", 400);
  }
  if (!url.hostname) {
    throw new ImportError("invalid_url", "That doesn't look like a web link. Paste a link that starts with https://", 400);
  }
  if (allowedPorts && url.port && !allowedPorts.includes(Number(url.port))) {
    throw new ImportError("blocked_destination", "Links to non-standard ports aren't supported.", 400);
  }
}

export async function importPdfFromLink(raw: string, options: ImportOptions): Promise<ImportedPdf> {
  const { url: startUrl, arxiv } = normalizeInput(raw);
  const allowAddress = options.allowAddress ?? isPublicAddress;
  const lookup = createPinnedLookup(allowAddress, options.resolver);
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), options.timeoutMs);

  try {
    let current = startUrl;
    for (let hop = 0; ; hop++) {
      assertAllowedShape(current, options.allowedPorts);
      const host = bareHostname(current.hostname);
      if (isIpLiteral(host) && !allowAddress(host)) {
        throw new ImportError("blocked_destination", "This link points to a private or local network address, which isn't allowed.", 400);
      }

      const response = await request(current, lookup, options, deadline.signal);
      const status = response.statusCode ?? 0;

      if (status >= 300 && status < 400 && response.headers.location) {
        response.resume();
        if (hop >= options.maxRedirects) {
          throw new ImportError("too_many_redirects", "The link redirected too many times.", 502);
        }
        try {
          current = new URL(response.headers.location, current);
        } catch {
          throw new ImportError("network", "The link redirected to an invalid address.", 502);
        }
        continue;
      }

      if (status !== 200) {
        response.resume();
        if (status === 401 || status === 403) {
          throw new ImportError("not_pdf", `${NOT_A_PDF_MESSAGE} (The site requires access permission.)`, 422, status);
        }
        if (status === 404 || status === 410) {
          throw new ImportError("http_error", "The website couldn't find that file (HTTP " + status + ").", 502, status);
        }
        throw new ImportError("http_error", `The website returned an error (HTTP ${status}).`, 502, status);
      }

      const length = Number(response.headers["content-length"]);
      if (Number.isFinite(length) && length > options.maxBytes) {
        response.destroy();
        throw tooLarge(options.maxBytes);
      }

      const bytes = await readPdfBody(response, options.maxBytes, deadline.signal);
      return {
        bytes,
        finalUrl: current.toString(),
        fileName: arxiv ? arxivFileName(arxiv) : fileNameFrom(response.headers["content-disposition"], current),
        source: arxiv ? "arxiv" : "url",
      };
    }
  } catch (error) {
    if (error instanceof ImportError) throw error;
    if (deadline.signal.aborted) {
      throw new ImportError("timeout", "The website took too long to respond.", 504);
    }
    if (error instanceof BlockedDestinationError || (error as { code?: string })?.code === "EBLOCKEDDESTINATION") {
      throw new ImportError("blocked_destination", "This link points to a private or local network address, which isn't allowed.", 400);
    }
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "ENODATA") {
      throw new ImportError("dns_failure", "Couldn't find that website. Check the link and try again.", 502);
    }
    throw new ImportError("network", "Couldn't download the PDF. Check the link and try again.", 502);
  } finally {
    clearTimeout(timer);
  }
}

function request(url: URL, lookup: ReturnType<typeof createPinnedLookup>, options: ImportOptions, signal: AbortSignal): Promise<http.IncomingMessage> {
  const client = url.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = client.request(
      url,
      {
        method: "GET",
        // A fresh agent per request: no pooled sockets that skipped validation.
        agent: false,
        lookup: lookup as unknown as typeof import("node:dns").lookup,
        signal,
        headers: {
          "user-agent": options.userAgent,
          accept: "application/pdf,application/octet-stream;q=0.9,*/*;q=0.5",
          "accept-encoding": "identity",
        },
      },
      resolve,
    );
    req.on("error", reject);
    req.end();
  });
}

async function readPdfBody(response: http.IncomingMessage, maxBytes: number, signal: AbortSignal): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  let checkedSignature = false;
  try {
    for await (const chunk of response) {
      if (signal.aborted) throw new ImportError("timeout", "The website took too long to respond.", 504);
      const buffer = chunk as Buffer;
      total += buffer.length;
      if (total > maxBytes) throw tooLarge(maxBytes);
      chunks.push(buffer);
      if (!checkedSignature && total >= 1024) {
        checkedSignature = true;
        if (!hasPdfSignature(Buffer.concat(chunks))) throw new ImportError("not_pdf", NOT_A_PDF_MESSAGE, 422);
      }
    }
  } catch (error) {
    response.destroy();
    throw error;
  }
  const bytes = Buffer.concat(chunks);
  if (!hasPdfSignature(bytes)) throw new ImportError("not_pdf", NOT_A_PDF_MESSAGE, 422);
  return bytes;
}

/** The PDF header may appear anywhere in the first 1024 bytes. */
export function hasPdfSignature(bytes: Uint8Array): boolean {
  const window = Buffer.from(bytes.subarray(0, 1024)).toString("latin1");
  return window.includes("%PDF-");
}

function tooLarge(maxBytes: number): ImportError {
  const mb = Math.round(maxBytes / (1024 * 1024));
  return new ImportError("too_large", `This PDF is larger than ${mb} MB.`, 413);
}

function fileNameFrom(disposition: string | undefined, url: URL): string {
  const star = disposition && /filename\*\s*=\s*(?:UTF-8'')?([^;]+)/i.exec(disposition);
  const plain = disposition && /filename\s*=\s*"?([^";]+)"?/i.exec(disposition);
  let name = "";
  try {
    name = star?.[1] ? decodeURIComponent(star[1].trim().replace(/^"|"$/g, "")) : plain?.[1]?.trim() ?? "";
  } catch {
    name = plain?.[1]?.trim() ?? "";
  }
  if (!name) {
    const last = url.pathname.split("/").filter(Boolean).pop() ?? "";
    try {
      name = decodeURIComponent(last);
    } catch {
      name = last;
    }
  }
  name = name.replace(/[\u0000-\u001f\u007f/\\]/g, "").slice(0, 180);
  if (!name) name = url.hostname;
  return /\.pdf$/i.test(name) ? name : `${name}.pdf`;
}
