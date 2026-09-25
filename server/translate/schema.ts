import { z } from "zod";
import { CONTEXT_LIMITS, DEFAULT_LIMITS } from "../../shared/config";
import { TARGET_LANGUAGE_CODES } from "../../shared/languages";

/** Server-side validation of POST /api/translate (see shared/contracts.ts). */
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
