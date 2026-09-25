import type { TranslationErrorCode } from "../../shared/contracts";
import { PROMPT_VERSION, type PromptInput } from "./prompt";
import { ProviderError, type ProviderResult, type ProviderStreamHandlers, type TranslationProvider } from "./provider";

/**
 * Deterministic stand-in used ONLY by automated tests
 * (PASSAGE_TRANSLATION_PROVIDER=mock). Its output is prefixed with
 * "[mock <lang>]" and the interface shows a "Test mode" label, so it can never
 * pass for a real translation.
 */
export interface MockControls {
  delayMs?: number;
  fail?: TranslationErrorCode;
}

export class MockProvider implements TranslationProvider {
  readonly id = "mock" as const;
  // Behaves like a remote service so the interface shows the normal privacy copy.
  readonly location = "cloud" as const;
  readonly mock = true;
  readonly model = "mock-translator";
  readonly configVersion = `${PROMPT_VERSION}:mock`;
  readonly #defaultDelayMs: number;

  constructor(defaultDelayMs = 150) {
    this.#defaultDelayMs = defaultDelayMs;
  }

  async translate(
    input: PromptInput,
    handlers: ProviderStreamHandlers,
    signal: AbortSignal,
    controls: MockControls = {},
  ): Promise<ProviderResult> {
    const delayMs = controls.delayMs ?? this.#defaultDelayMs;
    const translation = `[mock ${input.targetLang}] ${input.text}`;
    const chunks = splitIntoChunks(translation, 4);
    for (const [index, chunk] of chunks.entries()) {
      await sleep(delayMs / chunks.length, signal);
      if (controls.fail && index === 1) {
        throw new ProviderError(controls.fail, `Mock failure: ${controls.fail}`, {
          retryable: controls.fail !== "refused",
          retryAfterSeconds: controls.fail === "rate_limited" ? 2 : undefined,
        });
      }
      handlers.onDelta(chunk);
    }
    return { translation };
  }
}

function splitIntoChunks(text: string, count: number): string[] {
  const size = Math.max(1, Math.ceil(text.length / count));
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
  return chunks;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new ProviderError("aborted", "The translation was cancelled."));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new ProviderError("aborted", "The translation was cancelled."));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
