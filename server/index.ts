import { serve } from "@hono/node-server";
import fs from "node:fs";
import { createApp } from "./app";
import { readConfig } from "./env";
import { consoleLogger } from "./logger";

// Load .env from the working directory when present (Node >= 21.7).
if (fs.existsSync(".env")) process.loadEnvFile(".env");

const config = readConfig();
// The production build serves the client from dist/client unless told otherwise.
if (!config.staticDir && import.meta.url.includes("/dist/server/") && fs.existsSync("dist/client/index.html")) {
  config.staticDir = "dist/client";
}
const app = createApp({ config, logger: consoleLogger });

const server = serve({ fetch: app.fetch, port: config.port, hostname: config.host }, (info) => {
  const mode =
    config.provider === "mock"
      ? "MOCK translations (test mode)"
      : config.provider === "ollama"
        ? `local model ${config.model} via ${config.ollamaBaseUrl}`
        : config.anthropicApiKey
          ? `Claude (${config.model})`
          : "translation NOT configured (set ANTHROPIC_API_KEY)";
  consoleLogger.info(`server listening on http://${info.address}:${info.port} — ${mode}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2_000).unref();
  });
}
