import { describe, expect, it, vi } from "vitest";
import type { TranslateRequest } from "../../shared/contracts";
import type { SelectionSnapshot } from "../selection/snapshot";
import { TranslationFailure, type StreamHandlers, type TranslationResult } from "./api";
import { cacheKey, TranslationCache } from "./cache";
import { TranslationController } from "./controller";

/**
 * Deterministic fake translation API: every call is recorded and resolved or
 * rejected manually, so tests control ordering and timing exactly.
 */
function fakeApi() {
  const calls: Array<{
    request: TranslateRequest;
    signal: AbortSignal;
    handlers: StreamHandlers;
    resolve: (translation?: string) => void;
    reject: (error: unknown) => void;
  }> = [];
  const translate = vi.fn((request: TranslateRequest, signal: AbortSignal, handlers: StreamHandlers) => {
    return new Promise<TranslationResult>((resolve, reject) => {
      calls.push({
        request,
        signal,
        handlers,
        resolve: (translation) =>
          resolve({ translation: translation ?? `[${request.targetLang}] ${request.text}`, provider: "mock", model: "mock", configVersion: "v1" }),
        reject,
      });
    });
  });
  return { translate, calls };
}

function snapshot(text: string, overrides: Partial<SelectionSnapshot> = {}): SelectionSnapshot {
  return {
    id: `snap-${text}`,
    text,
    sourceLang: "en",
    context: { before: "Before.", after: "After.", title: "A paper", section: null },
    excluded: { furniture: 0, otherColumn: 0, rotated: 0 },
    unreliable: "none",
    anchor: {
      fingerprint: "doc-1",
      pageIndex: 0,
      rawStart: 0,
      rawEnd: text.length,
      start: { item: 0, offset: 0 },
      end: { item: 0, offset: text.length },
      prefix: "",
      suffix: "",
      rects: [],
      rotation: 0,
    },
    ...overrides,
  };
}

function setup(target: "ko" | "ja" | "en" | null = "ko") {
  const api = fakeApi();
  const cache = new TranslationCache(null);
  const controller = new TranslationController({ translate: api.translate, cache, configVersion: () => "v1" }, target);
  return { api, cache, controller };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("translation controller", () => {
  it("shows a loading card immediately, streams partial text, then the result", async () => {
    const { api, controller } = setup();
    controller.open(snapshot("Attention removed the bottleneck."));
    expect(controller.getState().card?.status).toBe("loading");
    await tick();
    api.calls[0]!.handlers.onDelta?.("[ko] Att");
    expect(controller.getState().card).toMatchObject({ status: "loading", partial: "[ko] Att" });
    api.calls[0]!.resolve();
    await tick();
    expect(controller.getState().card).toMatchObject({ status: "done", translation: "[ko] Attention removed the bottleneck.", cached: false });
  });

  it("sends the frozen text, context, and target language", async () => {
    const { api, controller } = setup();
    controller.open(snapshot("One sentence."));
    await tick();
    expect(api.calls[0]!.request).toMatchObject({
      targetLang: "ko",
      sourceLang: "en",
      text: "One sentence.",
      context: { before: "Before.", after: "After.", title: "A paper", section: null },
    });
    expect(api.calls[0]!.request.requestId).toMatch(/[A-Za-z0-9-]{8,}/);
  });

  it("never lets a delayed old response replace a newer passage", async () => {
    const { api, controller } = setup();
    controller.open(snapshot("First passage."));
    await tick();
    controller.open(snapshot("Second passage."));
    await tick();
    expect(api.calls).toHaveLength(2);
    expect(api.calls[0]!.signal.aborted).toBe(true);
    // The second answer arrives first, then the (ignored-abort) first one.
    api.calls[1]!.resolve();
    await tick();
    api.calls[0]!.resolve("LATE ANSWER");
    await tick();
    expect(controller.getState().card).toMatchObject({ status: "done", translation: "[ko] Second passage." });
  });

  it("also ignores a late failure from an older request", async () => {
    const { api, controller } = setup();
    controller.open(snapshot("First passage."));
    await tick();
    controller.open(snapshot("Second passage."));
    await tick();
    api.calls[1]!.resolve();
    await tick();
    api.calls[0]!.reject(new TranslationFailure({ code: "busy", message: "late", retryable: true }));
    await tick();
    expect(controller.getState().card?.status).toBe("done");
  });

  it("does not send duplicate requests for repeated clicks", async () => {
    const { api, controller } = setup();
    const snap = snapshot("Same passage.");
    controller.open(snap);
    controller.open(snap);
    await tick();
    controller.open(snap);
    await tick();
    expect(api.translate).toHaveBeenCalledTimes(1);
    api.calls[0]!.resolve();
    await tick();
    expect(controller.getState().card?.status).toBe("done");
  });

  it("reuses the cached result after closing and reopening the same passage", async () => {
    const { api, controller } = setup();
    const snap = snapshot("Cached passage.");
    controller.open(snap);
    await tick();
    api.calls[0]!.resolve();
    await tick();
    controller.close();
    expect(controller.getState().card).toBeNull();
    controller.open(snap);
    await tick();
    expect(api.translate).toHaveBeenCalledTimes(1);
    expect(controller.getState().card).toMatchObject({ status: "done", cached: true, translation: "[ko] Cached passage." });
  });

  it("changing the target language re-translates and never shows the other language's cache", async () => {
    const { api, controller } = setup();
    const snap = snapshot("Language test.");
    controller.open(snap);
    await tick();
    api.calls[0]!.resolve();
    await tick();
    controller.setTarget("ja");
    expect(controller.getState().card).toMatchObject({ status: "loading", targetLang: "ja" });
    await tick();
    expect(api.calls[1]!.request.targetLang).toBe("ja");
    api.calls[1]!.resolve();
    await tick();
    expect(controller.getState().card).toMatchObject({ status: "done", targetLang: "ja", translation: "[ja] Language test." });
    controller.setTarget("ko");
    await tick();
    expect(api.translate).toHaveBeenCalledTimes(2);
    expect(controller.getState().card).toMatchObject({ status: "done", targetLang: "ko", translation: "[ko] Language test.", cached: true });
  });

  it("asks for a target language first when none is chosen", async () => {
    const { api, controller } = setup(null);
    controller.open(snapshot("Needs a language."));
    expect(controller.getState().card?.status).toBe("need-language");
    controller.setTarget("ko");
    await tick();
    expect(api.calls[0]!.request.targetLang).toBe("ko");
  });

  it("skips the request when the passage is already in the target language", async () => {
    const { api, controller } = setup("en");
    controller.open(snapshot("Already English."));
    await tick();
    expect(controller.getState().card).toMatchObject({ status: "same-language", detected: "en" });
    expect(api.translate).not.toHaveBeenCalled();
    controller.translateAnyway();
    await tick();
    expect(api.translate).toHaveBeenCalledTimes(1);
  });

  it("shows retryable errors, keeps the excerpt, and does not cache failures", async () => {
    const { api, cache, controller } = setup();
    const snap = snapshot("Fails first.");
    controller.open(snap);
    await tick();
    api.calls[0]!.reject(new TranslationFailure({ code: "rate_limited", message: "Too many", retryable: true, retryAfterSeconds: 5 }));
    await tick();
    expect(controller.getState().card).toMatchObject({ status: "error", error: { code: "rate_limited", retryable: true } });
    expect(controller.getState().card?.snapshot.text).toBe("Fails first.");
    const key = cacheKey({ fingerprint: "doc-1", text: "Fails first.", context: snap.context, sourceLang: "en", targetLang: "ko", configVersion: "v1" });
    expect(await cache.get(key)).toBeNull();
    controller.retry();
    await tick();
    api.calls[1]!.resolve();
    await tick();
    expect(controller.getState().card?.status).toBe("done");
  });

  it("cancels the request when the card is closed or the document changes", async () => {
    const { api, controller } = setup();
    controller.open(snapshot("Close me."));
    await tick();
    controller.close();
    expect(api.calls[0]!.signal.aborted).toBe(true);
    controller.open(snapshot("Reset me."));
    await tick();
    controller.reset();
    expect(api.calls[1]!.signal.aborted).toBe(true);
    api.calls[1]!.resolve();
    await tick();
    expect(controller.getState().card).toBeNull();
  });
});

describe("cache identity", () => {
  const base = {
    fingerprint: "doc",
    text: "A passage.",
    context: { before: "b", after: "a", title: "t", section: null },
    sourceLang: "en",
    targetLang: "ko" as const,
    configVersion: "v1",
  };

  it("changes with every input that affects the translation", () => {
    const key = cacheKey(base);
    expect(cacheKey({ ...base })).toBe(key);
    expect(cacheKey({ ...base, targetLang: "ja" })).not.toBe(key);
    expect(cacheKey({ ...base, text: "A passage!" })).not.toBe(key);
    expect(cacheKey({ ...base, fingerprint: "other" })).not.toBe(key);
    expect(cacheKey({ ...base, configVersion: "v2" })).not.toBe(key);
    expect(cacheKey({ ...base, sourceLang: "de" })).not.toBe(key);
    expect(cacheKey({ ...base, context: { ...base.context, before: "c" } })).not.toBe(key);
  });
});
