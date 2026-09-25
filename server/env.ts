import { DEFAULT_LIMITS } from "../shared/config";
import type { Effort } from "./translate/anthropic";

export type ProviderSetting = "anthropic" | "ollama" | "mock";

export interface ServerConfig {
  port: number;
  host: string;
  trustProxy: boolean;
  staticDir: string | null;
  provider: ProviderSetting;
  anthropicApiKey: string | null;
  anthropicBaseUrl: string | null;
  model: string;
  effort: Effort | null;
  refusalFallback: boolean;
  ollamaBaseUrl: string;
  mockDelayMs: number;
  translateTimeoutMs: number;
  translateRatePerMinute: number;
  translateConcurrency: number;
  importRatePerMinute: number;
  importTimeoutMs: number;
  maxFileBytes: number;
  maxPages: number;
  maxSelectionChars: number;
}

const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max"]);

function int(value: string | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, Math.round(parsed)));
}

function bool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const providerRaw = (env.PASSAGE_TRANSLATION_PROVIDER ?? "anthropic").trim().toLowerCase();
  const provider: ProviderSetting = providerRaw === "ollama" || providerRaw === "mock" ? providerRaw : "anthropic";

  const defaultModel = provider === "ollama" ? "qwen3:8b" : provider === "mock" ? "mock-translator" : "claude-opus-5";
  const effortRaw = (env.PASSAGE_TRANSLATION_EFFORT ?? "low").trim().toLowerCase();
  const effort = effortRaw === "" || effortRaw === "none" ? null : EFFORTS.has(effortRaw) ? (effortRaw as Effort) : "low";

  return {
    port: int(env.PORT, 8787, 1, 65535),
    host: env.HOST?.trim() || "127.0.0.1",
    trustProxy: bool(env.PASSAGE_TRUST_PROXY, false),
    staticDir: env.PASSAGE_STATIC_DIR?.trim() || null,
    provider,
    anthropicApiKey: env.ANTHROPIC_API_KEY?.trim() || null,
    anthropicBaseUrl: env.PASSAGE_ANTHROPIC_BASE_URL?.trim() || null,
    model: env.PASSAGE_TRANSLATION_MODEL?.trim() || defaultModel,
    effort,
    refusalFallback: bool(env.PASSAGE_REFUSAL_FALLBACK, true),
    ollamaBaseUrl: env.OLLAMA_BASE_URL?.trim() || "http://127.0.0.1:11434",
    mockDelayMs: int(env.PASSAGE_MOCK_DELAY_MS, 150, 0, 60_000),
    translateTimeoutMs: int(env.PASSAGE_TRANSLATE_TIMEOUT_MS, 90_000, 5_000, 600_000),
    translateRatePerMinute: int(env.PASSAGE_TRANSLATE_RATE_PER_MIN, 30, 1, 10_000),
    translateConcurrency: int(env.PASSAGE_TRANSLATE_CONCURRENCY, 4, 1, 64),
    importRatePerMinute: int(env.PASSAGE_IMPORT_RATE_PER_MIN, 10, 1, 10_000),
    importTimeoutMs: int(env.PASSAGE_IMPORT_TIMEOUT_MS, 25_000, 2_000, 120_000),
    maxFileBytes: int(env.PASSAGE_MAX_FILE_MB, DEFAULT_LIMITS.maxFileBytes / (1024 * 1024), 1, 200) * 1024 * 1024,
    maxPages: int(env.PASSAGE_MAX_PAGES, DEFAULT_LIMITS.maxPages, 1, 5000),
    maxSelectionChars: int(env.PASSAGE_MAX_SELECTION_CHARS, DEFAULT_LIMITS.maxSelectionChars, 100, 50_000),
  };
}
