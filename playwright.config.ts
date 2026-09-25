import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests run against the production build with the MOCK translation
 * provider. Mock output is prefixed "[mock <lang>]" and labelled in the UI, so
 * these checks verify the application flow, not real translation quality.
 */
const PORT = Number(process.env.E2E_PORT ?? 4180);
const chromiumPath = process.env.PW_CHROMIUM_PATH;

export default defineConfig({
  testDir: "e2e",
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    trace: "retain-on-failure",
    launchOptions: chromiumPath ? { executablePath: chromiumPath } : {},
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 900 } }, testIgnore: /mobile\.spec/ },
    { name: "mobile", use: { ...devices["Pixel 7"] }, testMatch: /mobile\.spec/ },
  ],
  webServer: {
    command: "node dist/server/index.js",
    url: `http://127.0.0.1:${PORT}/api/health`,
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      PORT: String(PORT),
      HOST: "127.0.0.1",
      PASSAGE_TRANSLATION_PROVIDER: "mock",
      PASSAGE_MOCK_DELAY_MS: "400",
      PASSAGE_MAX_SELECTION_CHARS: "2000",
      PASSAGE_TRANSLATE_RATE_PER_MIN: "1000",
    },
  },
});
