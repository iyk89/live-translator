import type { ExtractResult } from "./extract";
import type { NormRect } from "./geometry";
import type { PageModel } from "./pageModel";

/** Where a translated passage came from, precise enough to find it again. */
export interface SourceAnchor {
  fingerprint: string;
  pageIndex: number;
  /** Offsets into the page's raw text stream (PageModel.rawText). */
  rawStart: number;
  rawEnd: number;
  /** Text-item references: first item/char and last item/char (exclusive). */
  start: { item: number; offset: number };
  end: { item: number; offset: number };
  /** Short raw text on either side, to disambiguate repeated phrases. */
  prefix: string;
  suffix: string;
  /** Highlight rectangles relative to the displayed page (0..1). */
  rects: NormRect[];
  rotation: number;
}

export interface SelectionSnapshot {
  id: string;
  anchor: SourceAnchor;
  /** Exactly the text shown to the reader and sent for translation. */
  text: string;
  context: { before: string; after: string; title: string | null; section: string | null };
  sourceLang: string | null;
  excluded: ExtractResult["excluded"];
  unreliable: ExtractResult["unreliable"];
}

const AFFIX = 32;

export function buildAnchor(
  model: PageModel,
  extraction: ExtractResult,
  fingerprint: string,
  rects: NormRect[],
  rotation: number,
): SourceAnchor {
  const mapped = extraction.sourceMap.filter((raw) => raw >= 0);
  const rawStart = mapped.length ? Math.min(...mapped) : 0;
  const rawEnd = mapped.length ? Math.max(...mapped) + 1 : 0;
  const first = extraction.kept[0];
  const last = extraction.kept[extraction.kept.length - 1];
  return {
    fingerprint,
    pageIndex: model.pageIndex,
    rawStart,
    rawEnd,
    start: { item: first?.index ?? 0, offset: first?.start ?? 0 },
    end: { item: last?.index ?? 0, offset: last?.end ?? 0 },
    prefix: model.rawText.slice(Math.max(0, rawStart - AFFIX), rawStart),
    suffix: model.rawText.slice(rawEnd, rawEnd + AFFIX),
    rects,
    rotation,
  };
}

/** Recursively freezes a snapshot so later UI changes cannot alter what was translated. */
export function freeze<T>(value: T): Readonly<T> {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const key of Object.keys(value)) freeze((value as Record<string, unknown>)[key]);
  }
  return value;
}
