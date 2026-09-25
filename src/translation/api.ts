import type {
  ProviderId,
  TranslateRequest,
  TranslateStreamEvent,
  TranslationErrorBody,
  TranslationErrorCode,
} from "../../shared/contracts";

export class TranslationFailure extends Error {
  readonly code: TranslationErrorCode;
  readonly retryable: boolean;
  readonly retryAfterSeconds?: number;

  constructor(body: TranslationErrorBody) {
    super(body.message);
    this.name = "TranslationFailure";
    this.code = body.code;
    this.retryable = body.retryable;
    this.retryAfterSeconds = body.retryAfterSeconds;
  }
}

export interface TranslationResult {
  translation: string;
  provider: ProviderId;
  model: string;
  configVersion: string;
}

export interface StreamHandlers {
  onStart?(event: Extract<TranslateStreamEvent, { type: "start" }>): void;
  onDelta?(text: string): void;
}

export type TranslateFn = (request: TranslateRequest, signal: AbortSignal, handlers: StreamHandlers) => Promise<TranslationResult>;

/** POST /api/translate and read the NDJSON event stream. */
export const streamTranslation: TranslateFn = async (request, signal, handlers) => {
  let response: Response;
  try {
    response = await fetch("/api/translate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
      signal,
    });
  } catch (error) {
    throw abortOrNetwork(error, signal);
  }

  if (!response.ok || !response.body) {
    let body: Partial<TranslationErrorBody> | undefined;
    try {
      body = ((await response.json()) as { error?: TranslationErrorBody }).error;
    } catch {
      body = undefined;
    }
    throw new TranslationFailure({
      code: body?.code ?? (response.status === 429 ? "rate_limited" : "provider_error"),
      message: body?.message ?? `The translation service answered with an error (HTTP ${response.status}).`,
      retryable: body?.retryable ?? response.status >= 500,
      retryAfterSeconds: body?.retryAfterSeconds ?? (Number(response.headers.get("retry-after")) || undefined),
    });
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buffered += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffered.indexOf("\n")) >= 0) {
        const line = buffered.slice(0, newline).trim();
        buffered = buffered.slice(newline + 1);
        if (!line) continue;
        const event = JSON.parse(line) as TranslateStreamEvent;
        if (event.type === "start") handlers.onStart?.(event);
        else if (event.type === "delta") handlers.onDelta?.(event.text);
        else if (event.type === "done") {
          return { translation: event.translation, provider: event.provider, model: event.model, configVersion: event.configVersion };
        } else if (event.type === "error") {
          throw new TranslationFailure(event);
        }
      }
    }
  } catch (error) {
    if (error instanceof TranslationFailure) throw error;
    throw abortOrNetwork(error, signal);
  } finally {
    reader.releaseLock();
  }
  // The stream closed without a result: treat as an interrupted connection.
  throw new TranslationFailure({
    code: "network",
    message: "The connection closed before the translation finished. Please try again.",
    retryable: true,
  });
};

function abortOrNetwork(error: unknown, signal: AbortSignal): TranslationFailure {
  if (signal.aborted || (error as { name?: string })?.name === "AbortError") {
    return new TranslationFailure({ code: "aborted", message: "The translation was cancelled.", retryable: false });
  }
  return new TranslationFailure({
    code: "network",
    message: "Couldn't reach the Passage server. Check your connection and try again.",
    retryable: true,
  });
}
