import type { TargetLanguageCode } from "../../shared/languages";
import { hash64 } from "../lib/hash";
import type { StorageResult, StoredTranslation } from "../storage/db";

export interface CachedTranslation {
  translation: string;
  targetLang: TargetLanguageCode;
  sourceLang: string | null;
  provider: string;
  model: string;
  configVersion: string;
  createdAt: number;
}

export interface CacheKeyParts {
  fingerprint: string;
  text: string;
  context: { before: string; after: string; title: string | null; section: string | null };
  sourceLang: string | null;
  targetLang: TargetLanguageCode;
  configVersion: string;
}

/**
 * Cache identity: document, exact selected text, the context that was sent,
 * source and target language, and the server's translation configuration.
 * Changing any of them (e.g. the target language) yields a different key.
 */
export function cacheKey(parts: CacheKeyParts): string {
  const contextId = hash64(JSON.stringify([parts.context.before, parts.context.after, parts.context.title ?? "", parts.context.section ?? ""]));
  const identity = JSON.stringify([parts.fingerprint, parts.text, contextId, parts.sourceLang ?? "auto", parts.targetLang, parts.configVersion]);
  return `t1:${parts.targetLang}:${hash64(identity)}:${hash64(identity.split("").reverse().join(""))}`;
}

export interface CachePersistence {
  load(key: string): Promise<StoredTranslation | null>;
  save(entry: StoredTranslation): Promise<StorageResult>;
}

/** Completed translations only; memory first, IndexedDB behind it (best effort). */
export class TranslationCache {
  readonly #memory = new Map<string, CachedTranslation>();
  readonly #persistence: CachePersistence | null;
  onPersistFailure: ((result: StorageResult) => void) | null = null;

  constructor(persistence: CachePersistence | null) {
    this.#persistence = persistence;
  }

  async get(key: string): Promise<CachedTranslation | null> {
    const hit = this.#memory.get(key);
    if (hit) return hit;
    if (!this.#persistence) return null;
    const stored = await this.#persistence.load(key).catch(() => null);
    if (!stored) return null;
    const value: CachedTranslation = {
      translation: stored.translation,
      targetLang: stored.targetLang,
      sourceLang: stored.sourceLang,
      provider: stored.provider,
      model: stored.model,
      configVersion: stored.configVersion,
      createdAt: stored.createdAt,
    };
    this.#memory.set(key, value);
    return value;
  }

  set(key: string, value: CachedTranslation, meta: { fingerprint: string; sourceText: string; anchor: unknown }): void {
    this.#memory.set(key, value);
    if (!this.#persistence) return;
    void this.#persistence
      .save({ key, fingerprint: meta.fingerprint, sourceText: meta.sourceText, anchor: meta.anchor, ...value })
      .then((result) => {
        if (!result.ok) this.onPersistFailure?.(result);
      });
  }

  clearMemory(): void {
    this.#memory.clear();
  }
}
