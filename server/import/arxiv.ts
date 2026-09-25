/**
 * arXiv link handling. Accepts abstract, PDF, and HTML pages, versioned or
 * not, new-style (2301.00001) and old-style (hep-th/9901001) identifiers, and
 * bare identifiers such as "arXiv:2301.00001v2".
 */

const ARXIV_HOSTS = new Set(["arxiv.org", "www.arxiv.org", "export.arxiv.org", "browse.arxiv.org"]);

const NEW_STYLE = /^(\d{4}\.\d{4,5})(v\d+)?$/;
const OLD_STYLE = /^([a-z][a-z-]*(?:\.[a-z]{2})?\/\d{7})(v\d+)?$/i;

export interface ArxivId {
  id: string;
  version: string | null;
}

export function parseArxivId(value: string): ArxivId | null {
  const cleaned = value.trim().replace(/\.pdf$/i, "");
  const match = NEW_STYLE.exec(cleaned) ?? OLD_STYLE.exec(cleaned);
  if (!match || !match[1]) return null;
  return { id: match[1], version: match[2] ?? null };
}

/** "arXiv:2301.00001", "arxiv 2301.00001v2", or a bare new-style identifier. */
export function parseBareArxivReference(input: string): ArxivId | null {
  const trimmed = input.trim();
  const prefixed = /^arxiv\s*:?\s*(.+)$/i.exec(trimmed);
  if (prefixed?.[1]) return parseArxivId(prefixed[1]);
  return NEW_STYLE.test(trimmed) ? parseArxivId(trimmed) : null;
}

export function isArxivHost(hostname: string): boolean {
  return ARXIV_HOSTS.has(hostname.toLowerCase());
}

/** Returns the PDF URL for a supported arXiv page, or null for other URLs. */
export function resolveArxivUrl(url: URL): { pdfUrl: URL; arxiv: ArxivId } | null {
  if (!isArxivHost(url.hostname)) return null;
  const match = /^\/(abs|pdf|html|format)\/(.+?)\/?$/.exec(decodeURIComponent(url.pathname));
  if (!match || !match[2]) return null;
  const arxiv = parseArxivId(match[2]);
  if (!arxiv) return null;
  return { pdfUrl: arxivPdfUrl(arxiv), arxiv };
}

export function arxivPdfUrl(arxiv: ArxivId): URL {
  return new URL(`https://arxiv.org/pdf/${arxiv.id}${arxiv.version ?? ""}`);
}

export function arxivFileName(arxiv: ArxivId): string {
  return `arXiv ${arxiv.id}${arxiv.version ?? ""}.pdf`.replace(/\//g, "_");
}
