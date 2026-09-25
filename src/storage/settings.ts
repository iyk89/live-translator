import { isTargetLanguageCode, type TargetLanguageCode } from "../../shared/languages";

const TARGET_KEY = "passage.targetLanguage";

/** The remembered "Translate to" choice (a tiny preference, so localStorage is fine). */
export function loadTargetLanguage(): TargetLanguageCode | null {
  try {
    const value = localStorage.getItem(TARGET_KEY);
    return isTargetLanguageCode(value) ? value : null;
  } catch {
    return null;
  }
}

export function saveTargetLanguage(code: TargetLanguageCode | null): void {
  try {
    if (code) localStorage.setItem(TARGET_KEY, code);
    else localStorage.removeItem(TARGET_KEY);
  } catch {
    // Storage may be blocked; the choice still applies for this session.
  }
}
