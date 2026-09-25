# Test and sample documents

All documents here were written for Passage and are released under the
[Creative Commons Attribution 4.0](https://creativecommons.org/licenses/by/4.0/) license.
They summarize published work and report no new results.

| File | Purpose |
| --- | --- |
| `pdfs/sample-paper.pdf` (also `public/samples/`) | Two-column English research-style paper: “Try a sample paper”, most tests. |
| `pdfs/sample-paper-de.pdf` | German paper for non-English reading and language detection. |
| `pdfs/cjk-sample.pdf` | Korean and Japanese paragraphs. |
| `pdfs/scanned.pdf`, `pdfs/mixed-scanned.pdf` | Image-only pages (no text layer). |
| `pdfs/encrypted.pdf` | Password-protected (password `passage-test`). |
| `pdfs/long-sample.pdf` | 42 pages, for memory and virtualization checks. |
| `pdfs/too-many-pages.pdf` | 201 pages, over the default limit. |
| `pdfs/not-a-pdf.pdf`, `pdfs/corrupt.pdf` | Invalid inputs. |

Regenerate with `pip install typst pymupdf` then `npm run fixtures`.
Sources are in `src/` (Typst). `../src/selection/__fixtures__/*.json` hold the
pdf.js text content of these PDFs for unit tests
(`node scripts/dump-text-content.mjs <pdf> > file.json`).
