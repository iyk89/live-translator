import { describe, expect, it } from "vitest";
import type { ConfigResponse, TranslateStreamEvent } from "../shared/contracts";
import { createApp } from "./app";
import { readConfig } from "./env";
import { BusyError, RateLimiter, Semaphore } from "./limits";
import { silentLogger } from "./logger";

const valid = {
  requestId: "req-12345678",
  targetLang: "ko",
  sourceLang: "en",
  text: "Attention removed the bottleneck.",
  context: { before: "Before.", after: "After.", title: "Paper", section: null },
};

function app(env: Record<string, string> = {}) {
  return createApp({ config: readConfig({ PASSAGE_TRANSLATION_PROVIDER: "mock", PASSAGE_MOCK_DELAY_MS: "0", ...env }), logger: silentLogger });
}

function post(target: ReturnType<typeof app>, body: unknown, headers: Record<string, string> = {}) {
  return target.request("/api/translate", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

async function events(response: Response): Promise<TranslateStreamEvent[]> {
  const text = await response.text();
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as TranslateStreamEvent);
}

describe("POST /api/translate", () => {
  it("streams start, deltas, and a final result tied to the request id", async () => {
    const response = await post(app(), valid);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/x-ndjson");
    const stream = await events(response);
    expect(stream[0]).toMatchObject({ type: "start", requestId: "req-12345678", provider: "mock" });
    expect(stream.filter((e) => e.type === "delta").length).toBeGreaterThan(1);
    expect(stream.at(-1)).toEqual({
      type: "done",
      requestId: "req-12345678",
      translation: "[mock ko] Attention removed the bottleneck.",
      provider: "mock",
      model: "mock-translator",
      configVersion: "p1:mock",
    });
  });

  it.each<[unknown, string]>([
    [{ ...valid, text: "" }, "empty text"],
    [{ ...valid, text: "   " }, "blank text"],
    [{ ...valid, targetLang: "xx" }, "unknown language"],
    [{ ...valid, requestId: "bad id!" }, "bad request id"],
    [{ ...valid, context: { ...valid.context, before: "x".repeat(5000) } }, "oversized context"],
    [{ ...valid, extra: true }, "unexpected field"],
    ["not json", "invalid JSON"],
  ])("rejects %s (%s)", async (body) => {
    const response = await post(app(), body);
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("invalid_request");
  });

  it("enforces the configured selection limit on the server", async () => {
    const response = await post(app({ PASSAGE_MAX_SELECTION_CHARS: "100" }), { ...valid, text: "a".repeat(101) });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: { message: string } }).error.message).toMatch(/longer than 100 characters/);
  });

  it("rejects bodies that are too large to be a selection", async () => {
    const response = await post(app(), { ...valid, text: "a".repeat(70_000) });
    expect(response.status).toBe(413);
  });

  it("throttles bursts per client", async () => {
    const target = app({ PASSAGE_TRANSLATE_RATE_PER_MIN: "2" });
    expect((await post(target, valid)).status).toBe(200);
    expect((await post(target, valid)).status).toBe(200);
    const limited = await post(target, valid);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("reports provider failures as error events", async () => {
    const stream = await events(await post(app(), valid, { "x-passage-mock-fail": "busy" }));
    expect(stream.at(-1)).toMatchObject({ type: "error", code: "busy", retryable: true, requestId: "req-12345678" });
    expect(stream.some((e) => e.type === "done")).toBe(false);
  });

  it("is honest about missing credentials", async () => {
    const target = createApp({ config: readConfig({ PASSAGE_TRANSLATION_PROVIDER: "anthropic" }), logger: silentLogger });
    const config = (await (await target.request("/api/config")).json()) as ConfigResponse;
    expect(config.translation).toMatchObject({ available: false, reason: "not_configured" });
    const response = await post(target, valid);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: { code: "not_configured", message: expect.stringContaining("ANTHROPIC_API_KEY") } });
  });
});

describe("GET /api/config", () => {
  it("reports limits and the translation mode without secrets", async () => {
    const target = createApp({
      config: readConfig({ PASSAGE_TRANSLATION_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-ant-secret-value" }),
      logger: silentLogger,
    });
    const response = await target.request("/api/config");
    const raw = await response.text();
    expect(raw).not.toContain("sk-ant-secret-value");
    const config = JSON.parse(raw) as ConfigResponse;
    expect(config.limits).toEqual({ maxFileBytes: 25 * 1024 * 1024, maxPages: 200, maxSelectionChars: 6000 });
    expect(config.translation).toMatchObject({ available: true, provider: "anthropic", model: "claude-opus-5", location: "cloud", mock: false });
  });

  it("reports an unreachable local model server", async () => {
    const target = createApp({
      config: readConfig({ PASSAGE_TRANSLATION_PROVIDER: "ollama", OLLAMA_BASE_URL: "http://127.0.0.1:9" }),
      logger: silentLogger,
    });
    const config = (await (await target.request("/api/config")).json()) as ConfigResponse;
    expect(config.translation).toMatchObject({ available: false, reason: "unreachable", location: "local" });
  });
});

describe("request guards", () => {
  it("rate limiter recovers after the window", () => {
    let now = 0;
    const limiter = new RateLimiter(2, 1000, () => now);
    expect(limiter.take("a").ok).toBe(true);
    expect(limiter.take("a").ok).toBe(true);
    expect(limiter.take("a")).toMatchObject({ ok: false, retryAfterSeconds: 1 });
    expect(limiter.take("b").ok).toBe(true);
    now = 1001;
    expect(limiter.take("a").ok).toBe(true);
  });

  it("semaphore bounds concurrency and queue length", async () => {
    const semaphore = new Semaphore(1, 1);
    const release = await semaphore.acquire();
    const queued = semaphore.acquire();
    await expect(semaphore.acquire()).rejects.toBeInstanceOf(BusyError);
    release();
    const second = await queued;
    second();
    expect(semaphore.queued).toBe(0);
  });
});
