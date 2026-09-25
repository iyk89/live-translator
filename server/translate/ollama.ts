import { buildUserMessage, PROMPT_VERSION, SYSTEM_PROMPT, type PromptInput } from "./prompt";
import { cleanTranslation, ProviderError, type ProviderResult, type ProviderStreamHandlers, type TranslationProvider } from "./provider";

export interface OllamaProviderOptions {
  /** Base URL of the local Ollama server, e.g. http://127.0.0.1:11434 */
  baseUrl: string;
  model: string;
  timeoutMs: number;
  /** Injected for tests. */
  fetchImpl?: typeof fetch;
}

interface OllamaChunk {
  message?: { content?: string; thinking?: string };
  done?: boolean;
  done_reason?: string;
  error?: string;
}

/**
 * Local translation through an Ollama server (https://ollama.com). Text never
 * leaves the machine that runs Ollama.
 */
export class OllamaProvider implements TranslationProvider {
  readonly id = "ollama" as const;
  readonly location = "local" as const;
  readonly mock = false;
  readonly model: string;
  readonly configVersion: string;
  readonly #options: OllamaProviderOptions;
  readonly #fetch: typeof fetch;

  constructor(options: OllamaProviderOptions) {
    this.#options = { ...options, baseUrl: options.baseUrl.replace(/\/+$/, "") };
    this.#fetch = options.fetchImpl ?? fetch;
    this.model = options.model;
    this.configVersion = `${PROMPT_VERSION}:ollama:${options.model}`;
  }

  async checkAvailable(signal: AbortSignal): Promise<{ ok: true } | { ok: false; message: string }> {
    try {
      const response = await this.#fetch(`${this.#options.baseUrl}/api/tags`, { signal });
      if (!response.ok) return { ok: false, message: `The local model server answered with HTTP ${response.status}.` };
      const body = (await response.json()) as { models?: Array<{ name?: string; model?: string }> };
      const names = (body.models ?? []).flatMap((m) => [m.name, m.model]).filter(Boolean) as string[];
      const wanted = this.model.includes(":") ? this.model : `${this.model}:latest`;
      if (!names.includes(this.model) && !names.includes(wanted)) {
        return { ok: false, message: `The local model "${this.model}" isn't installed. Run: ollama pull ${this.model}` };
      }
      return { ok: true };
    } catch {
      return { ok: false, message: `Couldn't reach the local model server at ${this.#options.baseUrl}. Is Ollama running?` };
    }
  }

  async translate(input: PromptInput, handlers: ProviderStreamHandlers, signal: AbortSignal): Promise<ProviderResult> {
    const timeout = AbortSignal.timeout(this.#options.timeoutMs);
    const combined = AbortSignal.any([signal, timeout]);
    let response: Response;
    try {
      response = await this.#fetch(`${this.#options.baseUrl}/api/chat`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          stream: true,
          // Thinking slows local models down and adds nothing to a translation.
          think: false,
          options: { temperature: 0.2 },
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: buildUserMessage(input) },
          ],
        }),
        signal: combined,
      });
    } catch (error) {
      throw this.#mapFetchError(error, signal, timeout);
    }

    if (!response.ok || !response.body) {
      const detail = await response.text().catch(() => "");
      if (response.status === 404) {
        throw new ProviderError("not_configured", `The local model "${this.model}" isn't installed. Run: ollama pull ${this.model}`, {
          logDetail: "ollama status=404",
        });
      }
      throw new ProviderError("provider_error", "The local model server returned an error. Please try again.", {
        retryable: true,
        logDetail: `ollama status=${response.status} ${detail.slice(0, 120)}`,
      });
    }

    let text = "";
    let doneReason: string | undefined;
    let finished = false;
    const decoder = new TextDecoder();
    let buffered = "";
    const reader = response.body.getReader();
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
          const chunk = JSON.parse(line) as OllamaChunk;
          if (chunk.error) {
            throw new ProviderError("provider_error", "The local model reported an error. Please try again.", {
              retryable: true,
              logDetail: `ollama stream error ${chunk.error.slice(0, 120)}`,
            });
          }
          const piece = chunk.message?.content ?? "";
          if (piece) {
            text += piece;
            handlers.onDelta(piece);
          }
          if (chunk.done) {
            finished = true;
            doneReason = chunk.done_reason;
          }
        }
      }
    } catch (error) {
      throw this.#mapFetchError(error, signal, timeout);
    } finally {
      reader.releaseLock();
    }

    if (!finished) {
      throw new ProviderError("provider_error", "The local model stopped before finishing. Please try again.", {
        retryable: true,
        logDetail: "ollama stream ended without done",
      });
    }
    if (doneReason === "length") {
      throw new ProviderError("cut_off", "The translation was cut off before it finished. Try a smaller selection.", {
        logDetail: "ollama done_reason=length",
      });
    }
    const translation = cleanTranslation(text);
    if (!translation) {
      throw new ProviderError("provider_error", "The local model returned an empty response. Please try again.", {
        retryable: true,
        logDetail: "ollama empty",
      });
    }
    return { translation };
  }

  #mapFetchError(error: unknown, signal: AbortSignal, timeout: AbortSignal): ProviderError {
    if (error instanceof ProviderError) return error;
    if (signal.aborted) return new ProviderError("aborted", "The translation was cancelled.");
    if (timeout.aborted) {
      return new ProviderError("timeout", "The local model took too long. Please try again.", {
        retryable: true,
        logDetail: "ollama timeout",
      });
    }
    if (error instanceof SyntaxError) {
      return new ProviderError("provider_error", "The local model server sent an unreadable response.", {
        retryable: true,
        logDetail: "ollama invalid json",
      });
    }
    return new ProviderError(
      "not_configured",
      `Couldn't reach the local model server at ${this.#options.baseUrl}. Start Ollama and try again.`,
      { retryable: true, logDetail: "ollama connection error" },
    );
  }
}
