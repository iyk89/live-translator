/** Target languages offered in the "Translate to" selector. */
export const TARGET_LANGUAGES = [
  { code: "en", label: "English", nativeLabel: "English", promptName: "English" },
  { code: "ko", label: "Korean", nativeLabel: "한국어", promptName: "Korean" },
  { code: "ja", label: "Japanese", nativeLabel: "日本語", promptName: "Japanese" },
  { code: "zh-Hans", label: "Chinese (Simplified)", nativeLabel: "简体中文", promptName: "Simplified Chinese" },
  { code: "es", label: "Spanish", nativeLabel: "Español", promptName: "Spanish" },
  { code: "fr", label: "French", nativeLabel: "Français", promptName: "French" },
  { code: "de", label: "German", nativeLabel: "Deutsch", promptName: "German" },
] as const;

export type TargetLanguage = (typeof TARGET_LANGUAGES)[number];
export type TargetLanguageCode = TargetLanguage["code"];

export const TARGET_LANGUAGE_CODES = TARGET_LANGUAGES.map((l) => l.code) as [
  TargetLanguageCode,
  ...TargetLanguageCode[],
];

export function isTargetLanguageCode(value: unknown): value is TargetLanguageCode {
  return typeof value === "string" && TARGET_LANGUAGES.some((l) => l.code === value);
}

export function getTargetLanguage(code: TargetLanguageCode): TargetLanguage {
  const found = TARGET_LANGUAGES.find((l) => l.code === code);
  if (!found) throw new Error(`Unknown target language: ${code}`);
  return found;
}

/**
 * Display names for detected source languages (a superset of the targets).
 * Keys are the codes produced by the client-side detector.
 */
export const SOURCE_LANGUAGE_NAMES: Record<string, string> = {
  en: "English",
  ko: "Korean",
  ja: "Japanese",
  zh: "Chinese",
  es: "Spanish",
  fr: "French",
  de: "German",
  it: "Italian",
  pt: "Portuguese",
  nl: "Dutch",
  ru: "Russian",
  uk: "Ukrainian",
  pl: "Polish",
  tr: "Turkish",
  ar: "Arabic",
  he: "Hebrew",
  el: "Greek",
  hi: "Hindi",
  th: "Thai",
  vi: "Vietnamese",
};

/** Maps a detected source language to the target language it would match. */
export function targetForSource(sourceCode: string): TargetLanguageCode | null {
  if (sourceCode === "zh") return "zh-Hans";
  return isTargetLanguageCode(sourceCode) ? sourceCode : null;
}
