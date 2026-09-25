import type { TranslateRequest, TranslationErrorBody } from "../../shared/contracts";
import { targetForSource, type TargetLanguageCode } from "../../shared/languages";
import { randomId } from "../lib/hash";
import type { SelectionSnapshot } from "../selection/snapshot";
import { TranslationFailure, type TranslateFn, type TranslationResult } from "./api";
import { cacheKey, type CachedTranslation, type TranslationCache } from "./cache";

/** What the translation card shows. One card at a time; a new request replaces it. */
export type CardState =
  | { status: "need-language"; snapshot: SelectionSnapshot }
  | { status: "same-language"; snapshot: SelectionSnapshot; targetLang: TargetLanguageCode; detected: string }
  | { status: "loading"; snapshot: SelectionSnapshot; targetLang: TargetLanguageCode; requestId: string; partial: string }
  | {
      status: "done";
      snapshot: SelectionSnapshot;
      targetLang: TargetLanguageCode;
      requestId: string;
      translation: string;
      provider: string;
      model: string;
      cached: boolean;
    }
  | {
      status: "error";
      snapshot: SelectionSnapshot;
      targetLang: TargetLanguageCode;
      requestId: string;
      error: TranslationErrorBody;
    };

export interface ControllerState {
  card: CardState | null;
}

export interface ControllerDeps {
  translate: TranslateFn;
  cache: TranslationCache;
  /** Current server translation configuration version (part of the cache key). */
  configVersion: () => string;
  /** Called when the server reports a different configuration version. */
  onConfigVersion?: (version: string) => void;
}

interface InFlight {
  promise: Promise<TranslationResult>;
  abort: AbortController;
  requestIds: Set<string>;
}

export class TranslationController {
  #state: ControllerState = { card: null };
  #target: TargetLanguageCode | null;
  readonly #listeners = new Set<() => void>();
  readonly #inFlight = new Map<string, InFlight>();
  readonly #deps: ControllerDeps;

  constructor(deps: ControllerDeps, initialTarget: TargetLanguageCode | null) {
    this.#deps = deps;
    this.#target = initialTarget;
  }

  /* React integration (useSyncExternalStore). */
  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };
  getState = (): ControllerState => this.#state;

  get target(): TargetLanguageCode | null {
    return this.#target;
  }

  /** Starts translating a frozen selection snapshot in the chosen target language. */
  open(snapshot: SelectionSnapshot): void {
    if (!this.#target) {
      this.#cancelActive();
      this.#set({ card: { status: "need-language", snapshot } });
      return;
    }
    void this.#run(snapshot, this.#target, { force: false });
  }

  /** Changes the target language; an open card is re-translated into it. */
  setTarget(target: TargetLanguageCode): void {
    this.#target = target;
    const card = this.#state.card;
    if (card) void this.#run(card.snapshot, target, { force: false });
  }

  /** From the same-language notice: translate regardless of detection. */
  translateAnyway(): void {
    const card = this.#state.card;
    if (card?.status === "same-language") void this.#run(card.snapshot, card.targetLang, { force: true });
  }

  retry(): void {
    const card = this.#state.card;
    if (card?.status === "error") void this.#run(card.snapshot, card.targetLang, { force: true });
  }

  /** Closes the card and cancels its request. */
  close(): void {
    this.#cancelActive();
    this.#set({ card: null });
  }

  /** Document closed or replaced: cancel everything. */
  reset(): void {
    for (const flight of this.#inFlight.values()) flight.abort.abort();
    this.#inFlight.clear();
    this.#set({ card: null });
  }

  async #run(snapshot: SelectionSnapshot, targetLang: TargetLanguageCode, options: { force: boolean }): Promise<void> {
    const requestId = randomId();
    const detected = snapshot.sourceLang;
    if (!options.force && detected && targetForSource(detected) === targetLang) {
      this.#cancelActive();
      this.#set({ card: { status: "same-language", snapshot, targetLang, detected } });
      return;
    }

    const version = this.#deps.configVersion();
    const key = this.#key(snapshot, targetLang, version);
    this.#cancelActive(key);
    this.#set({ card: { status: "loading", snapshot, targetLang, requestId, partial: "" } });

    const cached = options.force ? null : await this.#deps.cache.get(key);
    if (!this.#isActive(requestId)) return;
    if (cached) {
      this.#showResult(requestId, snapshot, targetLang, cached, true);
      return;
    }

    let flight = this.#inFlight.get(key);
    if (flight) {
      // Same passage and language already on its way (e.g. a double click).
      flight.requestIds.add(requestId);
    } else {
      const abort = new AbortController();
      const request: TranslateRequest = {
        requestId,
        targetLang,
        sourceLang: snapshot.sourceLang,
        text: snapshot.text,
        context: {
          before: snapshot.context.before,
          after: snapshot.context.after,
          title: snapshot.context.title,
          section: snapshot.context.section,
        },
      };
      const promise = this.#deps.translate(request, abort.signal, {
        onDelta: (text) => this.#appendPartial(key, text),
      });
      flight = { promise, abort, requestIds: new Set([requestId]) };
      this.#inFlight.set(key, flight);
    }

    try {
      const result = await flight.promise;
      const value: CachedTranslation = {
        translation: result.translation,
        targetLang,
        sourceLang: snapshot.sourceLang,
        provider: result.provider,
        model: result.model,
        configVersion: result.configVersion,
        createdAt: Date.now(),
      };
      // Only complete results are cached. A late result is still correct for its own key.
      const meta = { fingerprint: snapshot.anchor.fingerprint, sourceText: snapshot.text, anchor: snapshot.anchor };
      this.#deps.cache.set(key, value, meta);
      if (result.configVersion !== version) {
        this.#deps.cache.set(this.#key(snapshot, targetLang, result.configVersion), value, meta);
        this.#deps.onConfigVersion?.(result.configVersion);
      }
      this.#showResult(requestId, snapshot, targetLang, value, false);
    } catch (error) {
      if (!this.#isActive(requestId)) return;
      const failure =
        error instanceof TranslationFailure
          ? error
          : new TranslationFailure({ code: "provider_error", message: "The translation failed. Please try again.", retryable: true });
      if (failure.code === "aborted") return;
      this.#set({
        card: {
          status: "error",
          snapshot,
          targetLang,
          requestId,
          error: {
            code: failure.code,
            message: failure.message,
            retryable: failure.retryable,
            retryAfterSeconds: failure.retryAfterSeconds,
          },
        },
      });
    } finally {
      if (this.#inFlight.get(key) === flight) this.#inFlight.delete(key);
    }
  }

  #key(snapshot: SelectionSnapshot, targetLang: TargetLanguageCode, configVersion: string): string {
    return cacheKey({
      fingerprint: snapshot.anchor.fingerprint,
      text: snapshot.text,
      context: snapshot.context,
      sourceLang: snapshot.sourceLang,
      targetLang,
      configVersion,
    });
  }

  #showResult(requestId: string, snapshot: SelectionSnapshot, targetLang: TargetLanguageCode, value: CachedTranslation, cached: boolean) {
    // A delayed response for an older request must never replace the current card.
    if (!this.#isActive(requestId)) return;
    this.#set({
      card: {
        status: "done",
        snapshot,
        targetLang,
        requestId,
        translation: value.translation,
        provider: value.provider,
        model: value.model,
        cached,
      },
    });
  }

  #appendPartial(key: string, text: string) {
    const card = this.#state.card;
    const flight = this.#inFlight.get(key);
    if (card?.status !== "loading" || !flight?.requestIds.has(card.requestId)) return;
    this.#set({ card: { ...card, partial: card.partial + text } });
  }

  #isActive(requestId: string): boolean {
    const card = this.#state.card;
    return !!card && "requestId" in card && card.requestId === requestId;
  }

  /** Aborts the active card's request unless it is the one about to be reused. */
  #cancelActive(keepKey?: string) {
    const card = this.#state.card;
    if (!card || !("requestId" in card)) return;
    for (const [key, flight] of this.#inFlight) {
      if (key === keepKey || !flight.requestIds.has(card.requestId)) continue;
      flight.requestIds.delete(card.requestId);
      if (flight.requestIds.size === 0) {
        flight.abort.abort();
        this.#inFlight.delete(key);
      }
    }
  }

  #set(state: ControllerState) {
    this.#state = state;
    for (const listener of this.#listeners) listener();
  }
}
