import { z } from "zod";
import { CONTEXT_LIMITS, DEFAULT_LIMITS } from "./config";
import { TARGET_LANGUAGE_CODES, type TargetLanguageCode } from "./languages";

/* ------------------------------------------------------------------------- */
/* Translation                                                               */
/* ------------------------------------------------------------------------- */

/**
 * POST /api/translate request body. `text` is the exact selection shown to the
 * reader; `context` is bounded nearby text used only to resolve meaning.
 */
export function translateRequestSchema(maxSelectionChars: number = DEFAULT_LIMITS.maxSelectionChars) {
  return z
    .object({
      requestId: z.string().min(8).max(64).regex(/^[A-Za-z0-9-]+$/),
      targetLang: z.enum(TARGET_LANGUAGE_CODES),
      sourceLang: z
        .string()
        .max(12)
        .regex(/^[a-zA-Z-]+$/)
        .nullish(),
      text: z.string().min(1).max(maxSelectionChars),
      context: z
        .object({
          before: z.string().max(CONTEXT_LIMITS.beforeChars).default(""),
          after: z.string().max(CONTEXT_LIMITS.afterChars).default(""),
          title: z.string().max(CONTEXT_LIMITS.titleChars).nullish(),
          section: z.string().max(CONTEXT_LIMITS.sectionChars).nullish(),
        })
        .strict(),
    })
    .strict()
    .refine((value) => value.text.trim().length > 0, { message: "text must not be blank", path: ["text"] });
}

export type TranslateRequest = z.infer<ReturnType<typeof translateRequestSchema>>;

export type TranslationErrorCode =
  | "invalid_request"
  | "not_configured"
  | "rate_limited"
  | "busy"
  | "timeout"
  | "refused"
  | "cut_off"
  | "provider_error"
  | "network"
  | "aborted";

export interface TranslationErrorBody {
  code: TranslationErrorCode;
  message: string;
  retryable: boolean;
  retryAfterSeconds?: number;
}

/** One line of the application/x-ndjson response stream. */
export type TranslateStreamEvent =
  | {
      type: "start";
      requestId: string;
      provider: ProviderId;
      model: string;
      configVersion: string;
    }
  | { type: "delta"; text: string }
  | {
      type: "done";
      requestId: string;
      translation: string;
      provider: ProviderId;
      model: string;
      configVersion: string;
    }
  | ({ type: "error"; requestId: string } & TranslationErrorBody);

export type ProviderId = "anthropic" | "ollama" | "mock";

/* ------------------------------------------------------------------------- */
/* Config                                                                    */
/* ------------------------------------------------------------------------- */

export interface ConfigResponse {
  appName: string;
  translation:
    | {
        available: true;
        provider: ProviderId;
        model: string;
        /** "local" means the text never leaves the machine running the model. */
        location: "cloud" | "local";
        configVersion: string;
        /** True only in automated tests; the interface labels mock output. */
        mock: boolean;
      }
    | {
        available: false;
        provider: ProviderId | null;
        location: "cloud" | "local";
        reason: "not_configured" | "unreachable";
        message: string;
        configVersion: string;
      };
  limits: {
    maxFileBytes: number;
    maxPages: number;
    maxSelectionChars: number;
  };
}

/* ------------------------------------------------------------------------- */
/* Link import                                                               */
/* ------------------------------------------------------------------------- */

export type ImportErrorCode =
  | "invalid_url"
  | "unsupported_scheme"
  | "credentials_in_url"
  | "blocked_destination"
  | "dns_failure"
  | "not_pdf"
  | "http_error"
  | "too_many_redirects"
  | "too_large"
  | "timeout"
  | "rate_limited"
  | "network";

export interface ImportErrorBody {
  code: ImportErrorCode;
  message: string;
  status?: number;
}

/** Response headers set on a successful POST /api/import. */
export const IMPORT_HEADERS = {
  finalUrl: "x-passage-final-url",
  fileName: "x-passage-file-name",
  source: "x-passage-source",
} as const;

export type TranslateTarget = TargetLanguageCode;
