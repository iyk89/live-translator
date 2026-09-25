// Dumps pdf.js text content (the same data the text layer uses) for fixture
// pages so selection extraction can be unit-tested without a browser.
//   node scripts/dump-text-content.mjs fixtures/pdfs/sample-paper.pdf 0 1 > out.json
import fs from "node:fs";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

const [file, ...pageArgs] = process.argv.slice(2);
const data = new Uint8Array(fs.readFileSync(file));
const doc = await pdfjs.getDocument({ data, verbosity: 0, useWorkerFetch: false, isEvalSupported: false }).promise;
const pages = pageArgs.length ? pageArgs.map(Number) : [...Array(doc.numPages).keys()];
const out = [];
for (const index of pages) {
  const page = await doc.getPage(index + 1);
  const viewport = page.getViewport({ scale: 1 });
  const content = await page.getTextContent({ includeMarkedContent: true, disableNormalization: true });
  out.push({
    pageIndex: index,
    box: viewport.rawDims,
    rotation: viewport.rotation,
    content: {
      items: content.items.map((item) =>
        "str" in item
          ? { str: item.str, dir: item.dir, transform: item.transform.map((n) => Math.round(n * 1000) / 1000), width: Math.round(item.width * 1000) / 1000, height: Math.round(item.height * 1000) / 1000, fontName: item.fontName, hasEOL: item.hasEOL }
          : { type: item.type },
      ),
      styles: content.styles,
    },
  });
}
process.stdout.write(JSON.stringify(out));
