/**
 * Small, dependency-free language detector. It only has to answer "is this
 * passage already in the target language?" and label the source, so it is
 * deliberately conservative: when unsure it returns null.
 */

export interface Detection {
  lang: string;
  /** 0..1 */
  confidence: number;
}

const STOPWORDS: Record<string, string[]> = {
  en: ["the", "of", "and", "to", "in", "is", "that", "for", "it", "as", "with", "was", "on", "are", "by", "this", "be", "from", "or", "an", "which", "at", "not", "we", "can", "these", "their", "has", "have", "our", "its", "were", "been", "but", "also", "such", "than", "into", "more", "between", "each", "when", "where", "how", "does"],
  de: ["der", "die", "das", "und", "ist", "nicht", "ein", "eine", "zu", "den", "mit", "von", "für", "auf", "im", "dem", "des", "sich", "es", "auch", "als", "wird", "werden", "bei", "oder", "aus", "wie", "zur", "zum", "sind", "kann", "durch", "nach", "über", "einer", "eines", "einem", "wir", "diese", "dass"],
  fr: ["le", "la", "les", "de", "des", "du", "et", "est", "en", "un", "une", "que", "qui", "dans", "pour", "pas", "sur", "au", "aux", "par", "avec", "ce", "cette", "sont", "il", "elle", "ne", "se", "plus", "ou", "nous", "leur", "ces", "être", "été"],
  es: ["el", "la", "los", "las", "de", "del", "y", "en", "que", "es", "un", "una", "por", "con", "para", "se", "no", "al", "lo", "como", "más", "su", "sus", "son", "este", "esta", "pero", "entre", "sobre", "también", "fue", "ha"],
  it: ["il", "lo", "la", "gli", "le", "di", "del", "della", "e", "è", "che", "un", "una", "per", "con", "non", "sono", "nel", "nella", "si", "da", "dei", "al", "questo", "come"],
  pt: ["o", "a", "os", "as", "de", "do", "da", "dos", "das", "e", "é", "que", "um", "uma", "para", "com", "não", "em", "no", "na", "por", "se", "são", "mais", "foi", "também"],
  nl: ["de", "het", "een", "en", "van", "is", "dat", "niet", "op", "te", "zijn", "met", "voor", "die", "er", "aan", "ook", "als", "bij", "wordt", "worden", "deze"],
};

const STOPWORD_SETS = Object.fromEntries(Object.entries(STOPWORDS).map(([lang, words]) => [lang, new Set(words)])) as Record<string, Set<string>>;

const CHAR_HINTS: Array<[RegExp, string, number]> = [
  [/[ßäöü]/i, "de", 2],
  [/[ñ¿¡]/i, "es", 3],
  [/[çœèêëàâîôûù]/i, "fr", 1],
  [/[ãõ]/i, "pt", 3],
  [/[ąęłśźżń]/i, "pl", 4],
  [/[ğşı]/i, "tr", 4],
  [/[ơưđ]/i, "vi", 4],
];

export function detectLanguage(text: string): Detection | null {
  const sample = text.slice(0, 4000);
  const counts = { hangul: 0, kana: 0, han: 0, latin: 0, cyrillic: 0, greek: 0, arabic: 0, hebrew: 0, devanagari: 0, thai: 0 };
  for (const ch of sample) {
    const c = ch.codePointAt(0)!;
    if ((c >= 0xac00 && c <= 0xd7af) || (c >= 0x1100 && c <= 0x11ff) || (c >= 0x3130 && c <= 0x318f)) counts.hangul++;
    else if ((c >= 0x3040 && c <= 0x30ff) || (c >= 0x31f0 && c <= 0x31ff)) counts.kana++;
    else if ((c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3400 && c <= 0x4dbf) || (c >= 0xf900 && c <= 0xfaff)) counts.han++;
    else if (/[a-z]/i.test(ch) || (c >= 0xc0 && c <= 0x24f && /\p{L}/u.test(ch))) counts.latin++;
    else if (c >= 0x400 && c <= 0x4ff) counts.cyrillic++;
    else if (c >= 0x370 && c <= 0x3ff) counts.greek++;
    else if (c >= 0x600 && c <= 0x6ff) counts.arabic++;
    else if (c >= 0x590 && c <= 0x5ff) counts.hebrew++;
    else if (c >= 0x900 && c <= 0x97f) counts.devanagari++;
    else if (c >= 0xe00 && c <= 0xe7f) counts.thai++;
  }
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  if (total < 2) return null;
  const share = (n: number) => n / total;
  const strength = (n: number, full: number) => Math.min(1, n / full);

  if (share(counts.hangul) > 0.3) return { lang: "ko", confidence: strength(counts.hangul, 8) };
  if (counts.kana > 0 && share(counts.kana + counts.han) > 0.4) return { lang: "ja", confidence: strength(counts.kana + counts.han, 10) };
  if (share(counts.han) > 0.5) return { lang: "zh", confidence: strength(counts.han, 12) * 0.9 };
  if (share(counts.cyrillic) > 0.5) return { lang: /[іїєґ]/i.test(sample) ? "uk" : "ru", confidence: strength(counts.cyrillic, 20) };
  if (share(counts.greek) > 0.5) return { lang: "el", confidence: strength(counts.greek, 15) };
  if (share(counts.arabic) > 0.5) return { lang: "ar", confidence: strength(counts.arabic, 15) };
  if (share(counts.hebrew) > 0.5) return { lang: "he", confidence: strength(counts.hebrew, 15) };
  if (share(counts.devanagari) > 0.5) return { lang: "hi", confidence: strength(counts.devanagari, 15) };
  if (share(counts.thai) > 0.5) return { lang: "th", confidence: strength(counts.thai, 15) };
  if (share(counts.latin) > 0.5) return detectLatin(sample);
  return null;
}

function detectLatin(text: string): Detection | null {
  const words = (text.toLowerCase().match(/\p{L}+/gu) ?? []).filter((w) => w.length <= 20);
  if (words.length === 0) return null;
  const scores: Record<string, number> = {};
  for (const lang of Object.keys(STOPWORD_SETS)) scores[lang] = 0;
  for (const word of words) {
    for (const [lang, set] of Object.entries(STOPWORD_SETS)) if (set.has(word)) scores[lang]! += 1;
  }
  for (const [pattern, lang, weight] of CHAR_HINTS) {
    const matches = text.match(new RegExp(pattern.source, "gi"))?.length ?? 0;
    if (matches) scores[lang] = (scores[lang] ?? 0) + Math.min(6, matches) * weight;
  }
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [bestLang, best] = ranked[0]!;
  const second = ranked[1]?.[1] ?? 0;
  if (best < 2 || best < second * 1.5) return null;
  // Confidence grows with evidence and with the margin over the runner-up.
  const confidence = Math.min(1, (best / Math.max(4, words.length * 0.25)) * (1 - second / (best + second + 1)));
  return { lang: bestLang, confidence: Math.max(0.3, Math.min(1, confidence)) };
}

/**
 * Source language for a selection: the selection's own signal when strong,
 * otherwise the document's language (short selections such as one word).
 */
export function detectSelectionLanguage(text: string, documentLang: Detection | null): Detection | null {
  const own = detectLanguage(text);
  if (own && own.confidence >= 0.6) return own;
  if (documentLang && documentLang.confidence >= 0.6) {
    // A single word or short phrase in the same script as the document: use the document's language.
    if (!own || own.lang === documentLang.lang || sameScriptFamily(own.lang, documentLang.lang)) return documentLang;
  }
  return own && own.confidence >= 0.45 ? own : null;
}

function sameScriptFamily(a: string, b: string): boolean {
  const latin = new Set(["en", "de", "fr", "es", "it", "pt", "nl", "pl", "tr", "vi"]);
  return latin.has(a) && latin.has(b);
}
