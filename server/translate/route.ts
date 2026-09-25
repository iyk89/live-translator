import type { Context } from "hono";
import type { TranslateStreamEvent, TranslationErrorBody, TranslationErrorCode } from "../../shared/contracts";
import { BusyError, RateLimiter, Semaphore } from "../limits";
import type { Logger } from "../logger";
import { MockProvider, type MockControls } from "./mock";
import { ProviderError, type TranslationProvider } from "./provider";
import { translateRequestSchema } from "./schema";

export interface TranslateRouteDeps {
  provider: TranslationProvider | null;
  /** Why translation is unavailable when provider is null. */
  unavailableMessage: string;
  maxSelectionChars: number;
  timeoutMs: number;
  rateLimiter: RateLimiter;
  semaphore: Semaphore;
  clientKey: (c: Context) => string;
  logger: Logger;
}

const STATUS_BY_CODE: Partial<Record<TranslationErrorCode, number>> = {
  invalid_request: 400,
  not_configured: 503,
  rate_limited: 429,
  busy: 503,
};

function errorResponse(c: Context, body: TranslationErrorBody) {
  const status = STATUS_BY_CODE[body.code] ?? 502;
  if (body.retryAfterSeconds) c.header("retry-after", String(body.retryAfterSeconds));
  return c.json({ error: body }, status as 400);
}

export function createTranslateHandler(deps: TranslateRouteDeps) {
  const schema = translateRequestSchema(deps.maxSelectionChars);

  return async (c: Context) => {
    const started = Date.now();
    const limited = deps.rateLimiter.take(deps.clientKey(c));
    if (!limited.ok) {
      return errorResponse(c, {
        code: "rate_limited",
        message: "Too many translations in a short time. Try again in a few seconds.",
        retryable: true,
        retryAfterSeconds: limited.retryAfterSeconds,
      });
    }

    let payload: unknown;
    try {
      payload = await c.req.json();
    } catch {
      return errorResponse(c, { code: "invalid_request", message: "The request could not be read.", retryable: false });
    }
    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      const tooLong = parsed.error.issues.some((issue) => issue.path[0] === "text" && issue.code === "too_big");
      return errorResponse(c, {
        code: "invalid_request",
        message: tooLong
          ? `This selection is longer than ${deps.maxSelectionChars.toLocaleString("en-US")} characters. Select a smaller passage.`
          : "This selection can't be translated. Try selecting the text again.",
        retryable: false,
      });
    }
    const request = parsed.data;

    const provider = deps.provider;
    if (!provider) {
      return errorResponse(c, { code: "not_configured", message: deps.unavailableMessage, retryable: false });
    }

    const clientSignal = c.req.raw.signal;
    let release: () => void;
    try {
      release = await deps.semaphore.acquire(clientSignal);
    } catch (error) {
      if (error instanceof BusyError) {
        return errorResponse(c, {
          code: "busy",
          message: "The translation service is busy. Please try again in a moment.",
          retryable: true,
          retryAfterSeconds: 3,
        });
      }
      return c.body(null, 499 as 400);
    }

    const mockControls = provider instanceof MockProvider ? readMockControls(c) : undefined;
    const encoder = new TextEncoder();
    const upstream = new AbortController();
    const onClientAbort = () => upstream.abort();
    clientSignal.addEventListener("abort", onClientAbort, { once: true });
    const timer = setTimeout(() => upstream.abort(new Error("timeout")), deps.timeoutMs);

    const stream = new ReadableStream<Uint8Array>({
      start: async (controller) => {
        const send = (event: TranslateStreamEvent) => {
          try {
            controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
          } catch {
            // The client has gone away; the abort handler stops the upstream call.
          }
        };
        send({
          type: "start",
          requestId: request.requestId,
          provider: provider.id,
          model: provider.model,
          configVersion: provider.configVersion,
        });

        let outcome = "ok";
        try {
          const input = {
            text: request.text,
            targetLang: request.targetLang,
            sourceLang: request.sourceLang ?? null,
            context: request.context,
          };
          const handlers = { onDelta: (text: string) => send({ type: "delta", text }) };
          const result =
            provider instanceof MockProvider
              ? await provider.translate(input, handlers, upstream.signal, mockControls)
              : await provider.translate(input, handlers, upstream.signal);
          send({
            type: "done",
            requestId: request.requestId,
            translation: result.translation,
            provider: provider.id,
            model: provider.model,
            configVersion: provider.configVersion,
          });
        } catch (error) {
          const timedOut = upstream.signal.aborted && !clientSignal.aborted;
          const failure =
            timedOut && !(error instanceof ProviderError && error.code !== "aborted")
              ? new ProviderError("timeout", "The translation took too long. Please try again.", { retryable: true })
              : error instanceof ProviderError
                ? error
                : new ProviderError("provider_error", "The translation failed. Please try again.", { retryable: true });
          outcome = `${failure.code}${failure.logDetail ? ` (${failure.logDetail})` : ""}`;
          send({
            type: "error",
            requestId: request.requestId,
            code: failure.code,
            message: failure.message,
            retryable: failure.retryable,
            retryAfterSeconds: failure.retryAfterSeconds,
          });
        } finally {
          clearTimeout(timer);
          clientSignal.removeEventListener("abort", onClientAbort);
          release();
          // Log sizes and outcomes only, never the selected text or translation.
          deps.logger.info(
            `translate id=${request.requestId} provider=${provider.id} chars=${request.text.length} target=${request.targetLang} outcome=${outcome} ms=${Date.now() - started}`,
          );
          try {
            controller.close();
          } catch {
            // Already closed by a disconnect.
          }
        }
      },
      cancel: () => upstream.abort(),
    });

    return c.body(stream, 200, {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    });
  };
}

/** Test-only knobs honoured exclusively by the mock provider. */
function readMockControls(c: Context): MockControls {
  const delay = Number(c.req.header("x-passage-mock-delay-ms"));
  const fail = c.req.header("x-passage-mock-fail") as TranslationErrorCode | undefined;
  return {
    delayMs: Number.isFinite(delay) && delay >= 0 ? Math.min(delay, 60_000) : undefined,
    fail: fail || undefined,
  };
}
