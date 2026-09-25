import { describe, expect, it } from "vitest";
import sampleEn from "./__fixtures__/sample-paper.json";
import sampleDe from "./__fixtures__/sample-paper-de.json";
import cjk from "./__fixtures__/cjk-sample.json";
import { extractSelection, shouldDropHyphen, assessReliability, type Piece } from "./extract";
import { buildPageModel, type PageModel } from "./pageModel";
import { modelFromFixture, selectRange, locate, type FixturePage } from "./testUtils";

const en = (sampleEn as FixturePage[]).map(modelFromFixture);
const de = (sampleDe as FixturePage[]).map(modelFromFixture);
const cjkPage = modelFromFixture((cjk as FixturePage[])[0]!);
const page1 = en[0]!;
const page2 = en[1]!;
const page3 = en[2]!;

function textOf(model: PageModel, start: string, end: string) {
  return extractSelection(model, selectRange(model, start, end)).text;
}

describe("page model", () => {
  it("detects the two-column layout and body metrics", () => {
    expect(page1.columns.twoColumn).toBe(true);
    expect(page1.columns.split).toBeGreaterThan(290);
    expect(page1.columns.split).toBeLessThan(320);
    expect(page1.bodySize).toBeCloseTo(10, 0);
    expect(page1.lineSpacing).toBeGreaterThan(11);
    expect(page1.lineSpacing).toBeLessThan(12.5);
  });

  it("marks running heads, page numbers, and the rotated side stamp", () => {
    const stamp = page1.items[locate(page1, "Passage sample document ·").index]!;
    expect(stamp.rotated).toBe(true);
    const pageNumber = page2.items[page2.items.length - 1]!;
    expect(pageNumber.str).toBe("2");
    expect(page2.lines[pageNumber.line]!.furniture).toBe(true);
    const head = page2.items[locate(page2, "Attention in Neural Machine Translation: A Short Tutorial").index]!;
    expect(page2.lines[head.line]!.furniture).toBe(true);
  });

  it("builds raw text with line ends for anchors", () => {
    expect(page1.rawText).toContain("The encoder–decoder architecture [7, 2] was the first");
    expect(page1.rawText.split("\n").length).toBeGreaterThan(50);
  });
});

describe("selection extraction on a two-column paper", () => {
  it("extracts a single word exactly", () => {
    const { index, offset } = locate(page1, "bottleneck");
    const result = extractSelection(page1, [{ index, start: offset, end: offset + "bottleneck".length }]);
    expect(result.text).toBe("bottleneck");
  });

  it("joins a sentence wrapped across lines with single spaces", () => {
    expect(textOf(page1, "The encoder–decoder architecture", "end to end.")).toBe(
      "The encoder–decoder architecture [7, 2] was the first neural design to translate whole sentences end to end.",
    );
  });

  it("rebuilds a paragraph and removes line-break hyphenation", () => {
    expect(textOf(page1, "The encoder–decoder architecture", "amount of information.")).toBe(
      "The encoder–decoder architecture [7, 2] was the first neural design to translate whole sentences end to end. " +
        "An encoder reads the source sentence and a decoder generates the translation one token at a time. " +
        "In its original form the encoder summarized the entire sentence in a single vector. " +
        "This worked surprisingly well for short sentences, but quality dropped as sentences grew longer, " +
        "because a fixed-length vector cannot hold an arbitrary amount of information.",
    );
  });

  it("keeps real compounds hyphenated and separates indented paragraphs", () => {
    const text = textOf(page1, "Attention [1] addressed", "Section 6 lists practical considerations.");
    const paragraphs = text.split("\n\n");
    expect(paragraphs).toHaveLength(2);
    expect(paragraphs[0]).toBe(
      "Attention [1] addressed this limitation. Instead of one summary vector, the decoder receives a different weighted " +
        "combination of encoder states at every step. The weights are computed from the current decoder state, so the model " +
        "can focus on different source words as the translation proceeds. Later work showed that attention alone, without " +
        "any recurrence, is sufficient for state-of-the-art translation [8].",
    );
    expect(paragraphs[1]).toBe(
      "The rest of this tutorial is organized as follows. Section 2 introduces the encoder–decoder model. Section 3 defines " +
        "attention and its common scoring functions. Section 4 describes self-attention and the Transformer. Section 5 covers " +
        "evaluation, and Section 6 lists practical considerations.",
    );
  });

  it("separates a heading from the following paragraph", () => {
    const text = textOf(page1, "Encoder–Decoder Models", "its translation.");
    expect(text.startsWith("Encoder–Decoder Models\n\nLet ")).toBe(true);
    expect(text).not.toContain("\n\n\n");
  });

  it("continues a sentence from the bottom of the left column to the top of the right column", () => {
    const text = textOf(page2, "Automatic", "metric is BLEU [6],");
    expect(text).toBe(
      "Automatic metrics compare system output with one or more reference translations. The most widely reported metric is BLEU [6],",
    );
  });

  it("does not mix running heads or page numbers into a selection that spans them", () => {
    // Drag from the last lines of page 2's right column over the page number.
    const start = locate(page2, "masking, and consistent evaluation");
    const pieces: Piece[] = [];
    for (let i = start.index; i < page2.items.length; i++) {
      pieces.push({ index: i, start: i === start.index ? start.offset : 0, end: page2.items[i]!.str.length });
    }
    const result = extractSelection(page2, pieces);
    expect(result.excluded.furniture).toBeGreaterThan(0);
    expect(result.text.endsWith("2")).toBe(false);
  });

  it("drops text from the other column when the selection starts and ends in one column", () => {
    const pieces = selectRange(page1, "The encoder–decoder architecture", "end to end.");
    const intruder = locate(page1, "The decoder maintains its own state");
    const result = extractSelection(page1, [...pieces, { index: intruder.index, start: 0, end: 10 }].sort((a, b) => a.index - b.index));
    // The intruder sorts after the selection end, so it is the last piece: the
    // selection now spans both columns and is kept as the reader dragged it.
    expect(result.excluded.otherColumn).toBe(0);

    // A genuine leak: a right-column item placed between two left-column items in the stream.
    const model = withLeak();
    const leaked = extractSelection(model.model, model.pieces);
    expect(leaked.excluded.otherColumn).toBe(1);
    expect(leaked.text).not.toContain("LEAK");
  });

  it("keeps the rotated side stamp out of body selections", () => {
    const pieces = [...selectRange(page1, "Neural machine translation maps", "single trainable")];
    const stamp = locate(page1, "Passage sample document ·");
    const result = extractSelection(page1, [{ index: stamp.index, start: 0, end: 10 }, ...pieces]);
    expect(result.excluded.rotated).toBe(1);
    expect(result.text.startsWith("Neural machine translation maps")).toBe(true);
  });

  it("returns only the stamp when only the stamp is selected", () => {
    const stamp = locate(page1, "Passage sample document ·");
    const result = extractSelection(page1, [{ index: stamp.index, start: 0, end: 23 }]);
    expect(result.text).toBe("Passage sample document");
  });

  it("maps every copied character back to its raw offset", () => {
    const result = extractSelection(page1, selectRange(page1, "This worked surprisingly", "fixed-length"));
    expect(result.text).toBe("This worked surprisingly well for short sentences, but quality dropped as sentences grew longer, because a fixed-length");
    result.sourceMap.forEach((raw, i) => {
      if (raw >= 0) expect(page1.rawText[raw]).toBe(result.text[i]);
    });
    // Inserted separators are marked, and the removed hyphen is not in the output.
    expect(result.sourceMap.filter((raw) => raw < 0).length).toBeGreaterThan(0);
  });

  it("joins hanging-indent reference entries line by line", () => {
    const text = textOf(page3, "[5] M.-T. Luong", ", 2015.");
    expect(text).toBe("[5] M.-T. Luong, H. Pham, and C. D. Manning. Effective approaches to attention-based neural machine translation. In EMNLP, 2015.");
  });

  it("separates consecutive reference entries", () => {
    const text = textOf(page3, "[5] M.-T. Luong", ", 2002.");
    expect(text.split("\n\n")).toHaveLength(2);
  });
});

describe("other languages", () => {
  it("rebuilds German text and removes German hyphenation", () => {
    const page = de[0]!;
    const text = extractSelection(page, selectRange(page, "Beim Übersetzen muss", "bezeichnet.")).text;
    expect(text).toBe(
      "Beim Übersetzen muss für jedes Wort der Ausgabe entschieden werden, welche Teile des Quellsatzes relevant sind. " +
        "Statistische Systeme trafen diese Entscheidung ausdrücklich über Wortzuordnungen. Neuronale Systeme lernen sie " +
        "dagegen aus Daten, und die Komponente, die diese weiche Zuordnung vornimmt, wird als Aufmerksamkeit bezeichnet.",
    );
  });

  it("joins wrapped Japanese lines without spaces and Korean lines with spaces", () => {
    const ko = extractSelection(cjkPage, selectRange(cjkPage, "신경망 기계 번역은", "병목을 없앴다.")).text;
    expect(ko).toBe(
      "신경망 기계 번역은 하나의 학습 가능한 네트워크로 한 언어의 문장을 다른 언어의 문장으로 옮긴다. " +
        "초기의 인코더-디코더 시스템은 원문 전체를 고정 길이의 벡터 하나로 압축했기 때문에 긴 문장을 번역하기 어려웠다. " +
        "어텐션 메커니즘은 디코더가 매 단계마다 원문의 모든 위치를 참고할 수 있게 하여 이 병목을 없앴다.",
    );
    const ja = extractSelection(cjkPage, selectRange(cjkPage, "ニューラル機械翻訳は", "この問題を解消した。")).text;
    expect(ja).toBe(
      "ニューラル機械翻訳は、一つの学習可能なネットワークによって、ある言語の文を別の言語の文に変換する。" +
        "初期のエンコーダ・デコーダ方式では、原文全体を固定長のベクトル一つに圧縮していたため、長い文の翻訳が難しかった。" +
        "注意機構は、デコーダが各ステップで原文のすべての位置を参照できるようにすることで、この問題を解消した。",
    );
  });
});

describe("character handling", () => {
  it("expands ligature glyphs and keeps the mapping", () => {
    const model = syntheticModel([{ str: "The ﬁrst eﬃcient ﬂow", x: 50, y: 700 }]);
    const result = extractSelection(model, [{ index: 1, start: 0, end: model.items[1]!.str.length }]);
    expect(result.text).toBe("The first efficient flow");
    expect(result.sourceMap[4]).toBe(result.sourceMap[5]);
  });

  it("removes soft hyphens at line ends and keeps hyphens before capitals", () => {
    const model = syntheticModel([
      { str: "a statis­", x: 50, y: 700 },
      { str: "tical model uses COVID-", x: 50, y: 688 },
      { str: "19 data and Encoder-", x: 50, y: 676 },
      { str: "Decoder blocks", x: 50, y: 664 },
    ]);
    const pieces = model.items.map((item) => ({ index: item.index, start: 0, end: item.str.length }));
    expect(extractSelection(model, pieces).text).toBe("a statistical model uses COVID-19 data and Encoder-Decoder blocks");
  });

  it("decides line-break hyphens from evidence", () => {
    const vocab = { words: new Set(["translation", "self"]), hyphenated: new Set(["state-of"]) };
    expect(shouldDropHyphen("trans", "lation", vocab)).toBe(true);
    expect(shouldDropHyphen("state", "of", vocab)).toBe(false);
    expect(shouldDropHyphen("self", "attention", vocab)).toBe(false);
    expect(shouldDropHyphen("recur", "rence", vocab)).toBe(true);
  });

  it("flags text layers made of unmapped glyphs", () => {
    expect(assessReliability("A normal sentence.")).toBe("none");
    expect(assessReliability(" abc")).toBe("severe");
    expect(assessReliability("Mostly fine text with one � glitch in a long sentence here")).toBe("some");
  });
});

/* ------------------------------------------------------------------------- */

function syntheticModel(lines: Array<{ str: string; x: number; y: number; size?: number }>): PageModel {
  const items = lines.flatMap((line) => [
    { str: "", dir: "ltr", transform: [line.size ?? 10, 0, 0, line.size ?? 10, line.x, line.y], width: 0, height: 0, fontName: "f1", hasEOL: true },
    {
      str: line.str,
      dir: "ltr",
      transform: [line.size ?? 10, 0, 0, line.size ?? 10, line.x, line.y],
      width: line.str.length * 5,
      height: line.size ?? 10,
      fontName: "f1",
      hasEOL: false,
    },
  ]);
  return buildPageModel(0, { items, styles: { f1: { ascent: 0.8, descent: -0.2, vertical: false, fontFamily: "serif" } } }, {
    pageX: 0,
    pageY: 0,
    pageWidth: 612,
    pageHeight: 792,
  });
}

function withLeak(): { model: PageModel; pieces: Piece[] } {
  // Rebuild page 1 with a right-column item injected into the left column's stream.
  const page = (sampleEn as FixturePage[])[0]!;
  const items = [...page.content.items];
  const anchor = items.findIndex((it) => "str" in it && it.str.startsWith("neural design to translate"));
  items.splice(anchor, 0, {
    str: "LEAK",
    dir: "ltr",
    transform: [10, 0, 0, 10, 400, 300],
    width: 30,
    height: 10,
    fontName: (items[anchor] as { fontName: string }).fontName,
    hasEOL: false,
  });
  const leakModel = buildPageModel(0, { items, styles: page.content.styles }, page.box);
  return { model: leakModel, pieces: selectRange(leakModel, "The encoder–decoder architecture", "end to end.") };
}
