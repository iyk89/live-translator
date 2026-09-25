import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { importPdfFromLink, NOT_A_PDF_MESSAGE, type ImportOptions } from "./importer";

/*
 * A local HTTP server stands in for remote hosts. The resolver maps the test
 * hostnames to 127.0.0.1 and the address policy allows only that address, so
 * the real fetch, redirect, size, and content checks run end to end.
 */

const pdf = fs.readFileSync(path.resolve("public/samples/sample-paper.pdf"));
let server: http.Server;
let port = 0;
let lastHeaders: http.IncomingHttpHeaders = {};

beforeAll(async () => {
  server = http.createServer((req, res) => {
    lastHeaders = req.headers;
    const url = new URL(req.url ?? "/", "http://localhost");
    switch (url.pathname) {
      case "/paper.pdf":
        res.writeHead(200, { "content-type": "application/pdf", "content-length": pdf.length });
        res.end(pdf);
        break;
      case "/download": // No .pdf suffix, generic content type, filename in the header.
        res.writeHead(200, { "content-type": "application/octet-stream", "content-disposition": 'attachment; filename="My Paper.pdf"' });
        res.end(pdf);
        break;
      case "/redirect-1":
        res.writeHead(302, { location: "/redirect-2" });
        res.end();
        break;
      case "/redirect-2":
        res.writeHead(301, { location: `http://papers.test:${port}/paper.pdf` });
        res.end();
        break;
      case "/loop":
        res.writeHead(302, { location: "/loop" });
        res.end();
        break;
      case "/to-private":
        res.writeHead(302, { location: "http://10.0.0.1/secret.pdf" });
        res.end();
        break;
      case "/to-metadata-name":
        res.writeHead(302, { location: `http://metadata.test:${port}/latest` });
        res.end();
        break;
      case "/html":
        res.writeHead(200, { "content-type": "text/html" });
        res.end(`<!doctype html><html><body>${"<p>Landing page</p>".repeat(200)}</body></html>`);
        break;
      case "/big-declared":
        res.writeHead(200, { "content-type": "application/pdf", "content-length": 50 * 1024 * 1024 });
        res.end(pdf.subarray(0, 100));
        break;
      case "/big-streamed": {
        res.writeHead(200, { "content-type": "application/pdf" });
        res.write(pdf);
        const chunk = Buffer.alloc(64 * 1024, 0x20);
        let sent = 0;
        const pump = () => {
          while (sent < 4 * 1024 * 1024) {
            sent += chunk.length;
            if (!res.write(chunk)) return void res.once("drain", pump);
          }
          res.end();
        };
        pump();
        break;
      }
      case "/slow":
        setTimeout(() => {
          res.writeHead(200, { "content-type": "application/pdf" });
          res.end(pdf);
        }, 3_000);
        break;
      case "/forbidden":
        res.writeHead(403);
        res.end("no");
        break;
      default:
        res.writeHead(404);
        res.end("missing");
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

function options(overrides: Partial<ImportOptions> = {}): ImportOptions {
  return {
    maxBytes: 2 * 1024 * 1024,
    timeoutMs: 1_500,
    maxRedirects: 5,
    userAgent: "Passage-test",
    allowedPorts: [port],
    allowAddress: (address) => address === "127.0.0.1",
    resolver: (hostname, _opts, callback) => {
      if (hostname === "papers.test") return callback(null, [{ address: "127.0.0.1", family: 4 }]);
      if (hostname === "metadata.test") return callback(null, [{ address: "169.254.169.254", family: 4 }]);
      const error = Object.assign(new Error("not found"), { code: "ENOTFOUND" });
      callback(error, []);
    },
    ...overrides,
  };
}

const at = (pathname: string) => `http://papers.test:${port}${pathname}`;

describe("link import", () => {
  it("downloads a PDF and reports its name", async () => {
    const result = await importPdfFromLink(at("/paper.pdf"), options());
    expect(result.bytes.equals(pdf)).toBe(true);
    expect(result.fileName).toBe("paper.pdf");
    expect(result.source).toBe("url");
  });

  it("accepts URLs without a .pdf suffix by checking the bytes", async () => {
    const result = await importPdfFromLink(at("/download"), options());
    expect(result.fileName).toBe("My Paper.pdf");
    expect(result.bytes.length).toBe(pdf.length);
  });

  it("follows ordinary redirects and reports the final URL", async () => {
    const result = await importPdfFromLink(at("/redirect-1"), options());
    expect(result.finalUrl).toBe(at("/paper.pdf"));
  });

  it("stops after the redirect limit", async () => {
    await expect(importPdfFromLink(at("/loop"), options())).rejects.toMatchObject({ code: "too_many_redirects" });
  });

  it("re-checks every redirect target against the address policy", async () => {
    await expect(importPdfFromLink(at("/to-private"), options())).rejects.toMatchObject({ code: "blocked_destination" });
    await expect(importPdfFromLink(at("/to-metadata-name"), options())).rejects.toMatchObject({ code: "blocked_destination" });
  });

  it("rejects pages that are not PDFs with the standard message", async () => {
    await expect(importPdfFromLink(at("/html"), options())).rejects.toMatchObject({ code: "not_pdf", message: NOT_A_PDF_MESSAGE });
  });

  it("enforces the size limit from headers and while streaming", async () => {
    await expect(importPdfFromLink(at("/big-declared"), options())).rejects.toMatchObject({ code: "too_large" });
    await expect(importPdfFromLink(at("/big-streamed"), options())).rejects.toMatchObject({ code: "too_large" });
  });

  it("times out slow servers", async () => {
    await expect(importPdfFromLink(at("/slow"), options({ timeoutMs: 400 }))).rejects.toMatchObject({ code: "timeout" });
  });

  it("explains inaccessible and missing files", async () => {
    await expect(importPdfFromLink(at("/forbidden"), options())).rejects.toMatchObject({ code: "not_pdf", upstreamStatus: 403 });
    await expect(importPdfFromLink(at("/nothing-here"), options())).rejects.toMatchObject({ code: "http_error", upstreamStatus: 404 });
  });

  it("reports unknown hosts", async () => {
    await expect(importPdfFromLink(`http://nowhere.test:${port}/x.pdf`, options())).rejects.toMatchObject({ code: "dns_failure" });
  });

  it("sends no cookies or credentials upstream", async () => {
    await importPdfFromLink(at("/paper.pdf"), options());
    expect(lastHeaders.cookie).toBeUndefined();
    expect(lastHeaders.authorization).toBeUndefined();
    expect(lastHeaders["user-agent"]).toBe("Passage-test");
  });

  it.each([
    ["ftp://example.org/paper.pdf", "unsupported_scheme"],
    ["file:///etc/passwd", "unsupported_scheme"],
    ["javascript:alert(1)", "unsupported_scheme"],
    ["https://user:secret@example.org/paper.pdf", "credentials_in_url"],
    ["http://localhost/paper.pdf", "blocked_destination"],
    ["http://127.0.0.1/paper.pdf", "blocked_destination"],
    ["http://[::1]/paper.pdf", "blocked_destination"],
    ["http://2130706433/paper.pdf", "blocked_destination"],
    ["http://169.254.169.254/latest/meta-data/", "blocked_destination"],
    ["https://example.org:8443/paper.pdf", "blocked_destination"],
    ["", "invalid_url"],
    ["http://", "invalid_url"],
  ])("refuses %s (%s) with the production policy", async (input, code) => {
    await expect(
      importPdfFromLink(input, { maxBytes: 1024, timeoutMs: 1000, maxRedirects: 2, userAgent: "t" }),
    ).rejects.toMatchObject({ code });
  });
});
