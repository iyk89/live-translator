import { describe, expect, it } from "vitest";
import { detectLanguage, detectSelectionLanguage } from "./detect";

describe("language detection", () => {
  it("recognizes common paper languages from a sentence", () => {
    expect(detectLanguage("Attention mechanisms removed this bottleneck by letting the decoder consult every source position.")?.lang).toBe("en");
    expect(detectLanguage("Die Gewichte sind nicht negativ und summieren sich zu eins, daher lassen sie sich als Zuordnung lesen.")?.lang).toBe("de");
    expect(detectLanguage("Les poids ne sont pas négatifs et leur somme est égale à un, ce qui permet de les lire comme un alignement.")?.lang).toBe("fr");
    expect(detectLanguage("Los pesos no son negativos y suman uno, por lo que se pueden leer como una alineación.")?.lang).toBe("es");
    expect(detectLanguage("신경망 기계 번역은 하나의 학습 가능한 네트워크로 문장을 옮긴다.")?.lang).toBe("ko");
    expect(detectLanguage("ニューラル機械翻訳は、一つの学習可能なネットワークによって文を変換する。")?.lang).toBe("ja");
    expect(detectLanguage("神经机器翻译使用单个可训练的网络将一种语言的句子映射到另一种语言。")?.lang).toBe("zh");
  });

  it("stays undecided on text without a clear signal", () => {
    expect(detectLanguage("x = (x1, …, xn)")).toBeNull();
    expect(detectLanguage("BLEU")).toBeNull();
    expect(detectLanguage("")).toBeNull();
  });

  it("falls back to the document language for a single word", () => {
    const docLang = detectLanguage(
      "Neural machine translation maps a sentence in one language to a sentence in another with a single trainable network. The encoder reads the source.",
    );
    expect(docLang?.lang).toBe("en");
    expect(detectSelectionLanguage("bottleneck", docLang)?.lang).toBe("en");
    expect(detectSelectionLanguage("Aufmerksamkeit ist nicht das, was die Wörter bedeuten.", docLang)?.lang).toBe("de");
  });
});
