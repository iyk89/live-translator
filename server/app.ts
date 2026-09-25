import { getConnInfo } from "@hono/node-server/conninfo";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import fs from "node:fs";
import path from "node:path";
import { APP_NAME } from "../shared/brand";
import type { ConfigResponse } from "../shared/contracts";
import type { ServerConfig } from "./env";
import { createImportHandler } from "./import/route";
import type { ImportOptions } from "./import/importer";
import { RateLimiter, Semaphore } from "./limits";
import { consoleLogger, type Logger } from "./logger";
import { AnthropicProvider } from "./translate/anthropic";
import { MockProvider } from "./translate/mock";
import { OllamaProvider } from "./translate/ollama";
import { PROMPT_VERSION } from "./translate/prompt";
import type { TranslationProvider } from "./translate/provider";
import { createTranslateHandler } from "./translate/route";

export interface AppDeps {
  config: ServerConfig;
  logger?: Logger;
  /** Overrides for tests. */
  provider?: TranslationProvider | null;
  importOptions?: Partial<ImportOptions>;
}

export function createProvider(config: ServerConfig): { provider: TranslationProvider | null; unavailableMessage: string } {
  if (config.provider === "mock") {
    return { provider: new MockProvider(config.mockDelayMs), unavailableMessage: "" };
  }
  if (config.provider === "ollama") {
    return {
      provider: new OllamaProvider({
        baseUrl: config.ollamaBaseUrl,
        model: config.model,
        timeoutMs: config.translateTimeoutMs,
        numCtx: config.ollamaNumCtx,
      }),
      unavailableMessage: "",
    };
  }
  if (!config.anthropicApiKey) {
    return {
      provider: null,
      unavailableMessage: "Translation is unavailable: this server has no translation API key yet. Add ANTHROPIC_API_KEY to the server's .env file and restart it.",
    };
  }
  return {
    provider: new AnthropicProvider({
      apiKey: config.anthropicApiKey,
      baseURL: config.anthropicBaseUrl ?? undefined,
      model: config.model,
      effort: config.effort,
      refusalFallback: config.refusalFallback,
      timeoutMs: config.translateTimeoutMs,
      maxRetries: 2,
    }),
    unavailableMessage: "",
  };
}

export function createApp(deps: AppDeps) {
  const { config } = deps;
  const logger = deps.logger ?? consoleLogger;
  const created = deps.provider !== undefined ? { provider: deps.provider, unavailableMessage: "Translation is unavailable." } : createProvider(config);
  const provider = created.provider;

  const clientKey = (c: Context): string => {
    if (config.trustProxy) {
      const forwarded = c.req.header("x-forwarded-for")?.split(",")[0]?.trim();
      if (forwarded) return forwarded;
    }
    try {
      return getConnInfo(c).remote.address ?? "unknown";
    } catch {
      return "unknown";
    }
  };

  const app = new Hono();

  app.use("*", async (c, next) => {
    await next();
    c.header("x-content-type-options", "nosniff");
    c.header("referrer-policy", "no-referrer");
    c.header("x-frame-options", "DENY");
  });

  let probe: { at: number; result: { ok: true } | { ok: false; message: string } } | null = null;
  app.get("/api/config", async (c) => {
    const limits = {
      maxFileBytes: config.maxFileBytes,
      maxPages: config.maxPages,
      maxSelectionChars: config.maxSelectionChars,
    };
    let translation: ConfigResponse["translation"];
    if (!provider) {
      translation = {
        available: false,
        provider: null,
        location: "cloud",
        reason: "not_configured",
        message: created.unavailableMessage,
        configVersion: `${PROMPT_VERSION}:none`,
      };
    } else {
      if (provider.checkAvailable && (!probe || Date.now() - probe.at > 15_000)) {
        probe = { at: Date.now(), result: await provider.checkAvailable(AbortSignal.timeout(2_000)) };
      }
      const probeResult = provider.checkAvailable ? probe?.result : { ok: true as const };
      translation =
        probeResult && !probeResult.ok
          ? {
              available: false,
              provider: provider.id,
              location: provider.location,
              reason: "unreachable",
              message: probeResult.message,
              configVersion: provider.configVersion,
            }
          : {
              available: true,
              provider: provider.id,
              model: provider.model,
              location: provider.location,
              configVersion: provider.configVersion,
              mock: provider.mock,
            };
    }
    const body: ConfigResponse = { appName: APP_NAME, translation, limits };
    c.header("cache-control", "no-store");
    return c.json(body);
  });

  app.get("/api/health", (c) => c.json({ ok: true }));

  app.post(
    "/api/translate",
    bodyLimit({
      maxSize: 64 * 1024,
      onError: (c) =>
        c.json({ error: { code: "invalid_request", message: "This selection is too large to send.", retryable: false } }, 413),
    }),
    createTranslateHandler({
      provider,
      unavailableMessage: created.unavailableMessage,
      maxSelectionChars: config.maxSelectionChars,
      timeoutMs: config.translateTimeoutMs,
      rateLimiter: new RateLimiter(config.translateRatePerMinute, 60_000),
      semaphore: new Semaphore(config.translateConcurrency, config.translateConcurrency * 4),
      clientKey,
      logger,
    }),
  );

  app.post(
    "/api/import",
    bodyLimit({
      maxSize: 8 * 1024,
      onError: (c) => c.json({ error: { code: "invalid_url", message: "That link is too long." } }, 413),
    }),
    createImportHandler({
      options: {
        maxBytes: config.maxFileBytes,
        timeoutMs: config.importTimeoutMs,
        maxRedirects: 5,
        userAgent: `${APP_NAME}/0.1 (paper import; +https://github.com/iyk89/live-translator)`,
        ...deps.importOptions,
      },
      rateLimiter: new RateLimiter(config.importRatePerMinute, 60_000),
      clientKey,
      logger,
    }),
  );

  app.all("/api/*", (c) => c.json({ error: { code: "not_found", message: "Not found." } }, 404));

  if (config.staticDir) {
    const root = path.resolve(config.staticDir);
    const indexHtml = fs.readFileSync(path.join(root, "index.html"), "utf8");
    // Page routes get the app shell with a strict content security policy.
    app.get("*", async (c, next) => {
      if (c.req.path !== "/" && path.extname(c.req.path)) return next();
      c.header("content-security-policy", CONTENT_SECURITY_POLICY);
      c.header("cache-control", "no-cache");
      return c.html(indexHtml);
    });
    app.use("/assets/*", async (c, next) => {
      await next();
      if (c.res.status === 200) c.header("cache-control", "public, max-age=31536000, immutable");
    });
    app.use("*", serveStatic({ root: path.relative(process.cwd(), root) || "." }));
  }

  return app;
}

export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
].join("; ");
