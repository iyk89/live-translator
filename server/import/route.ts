import type { Context } from "hono";
import { IMPORT_HEADERS, type ImportErrorBody } from "../../shared/contracts";
import type { RateLimiter } from "../limits";
import type { Logger } from "../logger";
import { ImportError, importPdfFromLink, type ImportOptions } from "./importer";

export interface ImportRouteDeps {
  options: ImportOptions;
  rateLimiter: RateLimiter;
  clientKey: (c: Context) => string;
  logger: Logger;
}

export function createImportHandler(deps: ImportRouteDeps) {
  return async (c: Context) => {
    const started = Date.now();
    const limited = deps.rateLimiter.take(deps.clientKey(c));
    if (!limited.ok) {
      c.header("retry-after", String(limited.retryAfterSeconds));
      return c.json({ error: { code: "rate_limited", message: "Too many imports in a short time. Try again in a minute." } satisfies ImportErrorBody }, 429);
    }

    let url = "";
    try {
      const body = (await c.req.json()) as { url?: unknown };
      url = typeof body.url === "string" ? body.url : "";
    } catch {
      url = "";
    }

    try {
      const result = await importPdfFromLink(url, deps.options);
      deps.logger.info(`import host=${safeHost(result.finalUrl)} bytes=${result.bytes.length} outcome=ok ms=${Date.now() - started}`);
      return new Response(new Uint8Array(result.bytes), {
        status: 200,
        headers: {
          "content-type": "application/pdf",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
          [IMPORT_HEADERS.finalUrl]: encodeURIComponent(result.finalUrl),
          [IMPORT_HEADERS.fileName]: encodeURIComponent(result.fileName),
          [IMPORT_HEADERS.source]: result.source,
        },
      });
    } catch (error) {
      const failure =
        error instanceof ImportError ? error : new ImportError("network", "Couldn't download the PDF. Check the link and try again.", 502);
      deps.logger.info(`import host=${safeHost(url)} outcome=${failure.code}${failure.upstreamStatus ? `:${failure.upstreamStatus}` : ""} ms=${Date.now() - started}`);
      const body: ImportErrorBody = { code: failure.code, message: failure.message };
      if (failure.upstreamStatus) body.status = failure.upstreamStatus;
      return c.json({ error: body }, failure.httpStatus as 400);
    }
  };
}

/** Hostname only: full URLs can carry tokens. */
function safeHost(raw: string): string {
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw.trim()) ? raw.trim() : `https://${raw.trim()}`).hostname || "-";
  } catch {
    return "-";
  }
}
