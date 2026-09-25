import Anthropic from "@anthropic-ai/sdk";
import { buildUserMessage, PROMPT_VERSION, SYSTEM_PROMPT, type PromptInput } from "./prompt";
import { cleanTranslation, ProviderError, type ProviderResult, type ProviderStreamHandlers, type TranslationProvider } from "./provider";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface AnthropicProviderOptions {
  apiKey: string;
  model: string;
  /** Omit for models that do not accept the effort setting (e.g. Haiku 4.5). */
  effort: Effort | null;
  /** Server-side refusal fallback ("default" routes by refusal category). */
  refusalFallback: boolean;
  timeoutMs: number;
  maxRetries: number;
  baseURL?: string;
}

const FALLBACK_BETA = "server-side-fallback-2026-07-01";

export class AnthropicProvider implements TranslationProvider {
  readonly id = "anthropic" as const;
  readonly location = "cloud" as const;
  readonly mock = false;
  readonly model: string;
  readonly configVersion: string;
  readonly #client: Anthropic;
  readonly #options: AnthropicProviderOptions;

  constructor(options: AnthropicProviderOptions) {
    this.#options = options;
    this.model = options.model;
    this.configVersion = `${PROMPT_VERSION}:anthropic:${options.model}:${options.effort ?? "default"}`;
    this.#client = new Anthropic({
      apiKey: options.apiKey,
      baseURL: options.baseURL,
      timeout: options.timeoutMs,
      maxRetries: options.maxRetries,
    });
  }

  async translate(input: PromptInput, handlers: ProviderStreamHandlers, signal: AbortSignal): Promise<ProviderResult> {
    const { model, effort, refusalFallback } = this.#options;
    const stream = this.#client.beta.messages.stream(
      {
        model,
        // Room for adaptive thinking plus a translation of the longest selection.
        max_tokens: 16000,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: buildUserMessage(input) }],
        ...(effort ? { output_config: { effort } } : {}),
        ...(refusalFallback ? { betas: [FALLBACK_BETA], fallbacks: "default" as const } : {}),
      },
      { signal },
    );

    stream.on("text", (delta) => {
      if (delta) handlers.onDelta(delta);
    });

    let message: Awaited<ReturnType<typeof stream.finalMessage>>;
    try {
      message = await stream.finalMessage();
    } catch (error) {
      throw mapAnthropicError(error, signal);
    }

    if (message.stop_reason === "refusal") {
      throw new ProviderError("refused", "The translation service declined this passage.", {
        logDetail: `refusal category=${message.stop_details?.category ?? "none"}`,
      });
    }
    if (message.stop_reason === "max_tokens" || message.stop_reason === "model_context_window_exceeded") {
      throw new ProviderError("cut_off", "The translation was cut off before it finished. Try a smaller selection.", {
        logDetail: `stop_reason=${message.stop_reason}`,
      });
    }

    // Text blocks form one continuous answer, including after a mid-stream fallback.
    const text = message.content
      .map((block) => (block.type === "text" ? block.text : ""))
      .join("");
    const translation = cleanTranslation(text);
    if (!translation) {
      throw new ProviderError("provider_error", "The translation service returned an empty response. Please try again.", {
        retryable: true,
        logDetail: `empty stop_reason=${message.stop_reason}`,
      });
    }
    return { translation };
  }
}

export function mapAnthropicError(error: unknown, signal: AbortSignal): ProviderError {
  if (error instanceof ProviderError) return error;
  if (signal.aborted || error instanceof Anthropic.APIUserAbortError) {
    return new ProviderError("aborted", "The translation was cancelled.");
  }
  // Most specific first; APIConnectionError is a subclass of APIError.
  if (error instanceof Anthropic.APIConnectionTimeoutError) {
    return new ProviderError("timeout", "The translation took too long. Please try again.", {
      retryable: true,
      logDetail: "connection timeout",
    });
  }
  if (error instanceof Anthropic.APIConnectionError) {
    return new ProviderError("provider_error", "Couldn't reach the translation service. Please try again.", {
      retryable: true,
      logDetail: "connection error",
    });
  }
  if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
    return new ProviderError(
      "not_configured",
      "Translation is unavailable: the server's translation API key was rejected.",
      { logDetail: `status=${error.status} type=${error.type}` },
    );
  }
  if (error instanceof Anthropic.RateLimitError) {
    const retryAfter = Number(error.headers?.get("retry-after"));
    return new ProviderError("rate_limited", "The translation service is receiving too many requests. Try again shortly.", {
      retryable: true,
      retryAfterSeconds: Number.isFinite(retryAfter) && retryAfter > 0 ? Math.ceil(retryAfter) : 10,
      logDetail: "status=429",
    });
  }
  if (error instanceof Anthropic.BadRequestError || error instanceof Anthropic.NotFoundError) {
    return new ProviderError("provider_error", "The translation service rejected the request. Check the server's model settings.", {
      logDetail: `status=${error.status} type=${error.type} message=${error.message.slice(0, 200)}`,
    });
  }
  if (error instanceof Anthropic.APIError) {
    const status = error.status ?? 0;
    const overloaded = status === 529 || error.type === "overloaded_error";
    return new ProviderError(
      "busy",
      overloaded ? "The translation service is busy right now. Please try again." : "The translation service had a problem. Please try again.",
      { retryable: true, logDetail: `status=${status} type=${error.type}` },
    );
  }
  return new ProviderError("provider_error", "The translation failed. Please try again.", {
    retryable: true,
    logDetail: error instanceof Error ? error.name : "unknown",
  });
}
