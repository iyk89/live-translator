import type { ProviderId, TranslationErrorCode } from "../../shared/contracts";
import type { PromptInput } from "./prompt";

export interface ProviderStreamHandlers {
  /** Called with each piece of translated text as it arrives. */
  onDelta(text: string): void;
}

export interface ProviderResult {
  translation: string;
}

/**
 * A translation backend. Implementations must honour `signal` (abort the
 * upstream request) and throw ProviderError for failures the reader should see.
 */
export interface TranslationProvider {
  readonly id: ProviderId;
  readonly model: string;
  /** Where the text is processed; drives the privacy copy in the interface. */
  readonly location: "cloud" | "local";
  /** Identifies settings that change output. Part of the client cache key. */
  readonly configVersion: string;
  /** Mock providers are for automated tests only and are labeled in the UI. */
  readonly mock: boolean;
  translate(input: PromptInput, handlers: ProviderStreamHandlers, signal: AbortSignal): Promise<ProviderResult>;
  /** Optional readiness probe (used for the local model server). */
  checkAvailable?(signal: AbortSignal): Promise<{ ok: true } | { ok: false; message: string }>;
}

export class ProviderError extends Error {
  readonly code: TranslationErrorCode;
  readonly retryable: boolean;
  readonly retryAfterSeconds?: number;
  /** Safe, non-content detail for server logs (status codes, error types). */
  readonly logDetail?: string;

  constructor(
    code: TranslationErrorCode,
    message: string,
    options: { retryable?: boolean; retryAfterSeconds?: number; logDetail?: string } = {},
  ) {
    super(message);
    this.name = "ProviderError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.logDetail = options.logDetail;
  }
}

/** Removes leftover wrapping that some models add despite the instructions. */
export function cleanTranslation(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/g, "")
    .replace(/^\s*<translation>\s*/i, "")
    .replace(/\s*<\/translation>\s*$/i, "")
    .trim();
}
