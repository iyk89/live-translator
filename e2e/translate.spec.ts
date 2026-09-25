import { expect, test, type Page } from "@playwright/test";
import {
  card,
  clickTranslate,
  charPoint,
  chooseTargetLanguage,
  dragSelect,
  highlightGeometry,
  openSample,
  scrollTextIntoView,
  trackTranslateRequests,
  translatedText,
  waitForTextLayer,
} from "./helpers";

/*
 * These tests run against the MOCK provider: translations read "[mock <lang>] <source>"
 * so the tests can check exactly which passage and language were translated.
 */

const PARAGRAPH =
  "The encoder–decoder architecture [7, 2] was the first neural design to translate whole sentences end to end. " +
  "An encoder reads the source sentence and a decoder generates the translation one token at a time. " +
  "In its original form the encoder summarized the entire sentence in a single vector. " +
  "This worked surprisingly well for short sentences, but quality dropped as sentences grew longer, " +
  "because a fixed-length vector cannot hold an arbitrary amount of information.";

async function start(page: Page, language = "Korean") {
  await openSample(page);
  await chooseTargetLanguage(page, language);
}

async function translateParagraph(page: Page) {
  await dragSelect(page, 0, "The encoder–decoder architecture", "amount of information.");
  await clickTranslate(page);
  return translatedText(page);
}

test.describe("selection translation", () => {
  test("translates a single word chosen by double-click", async ({ page }) => {
    await openSample(page);
    const word = await charPoint(page, 0, "bottleneck", "start");
    await page.mouse.dblclick(word.x + 12, word.y);
    await clickTranslate(page);
    // First use: the language is chosen inline in the card.
    await expect(card(page)).toHaveAttribute("data-status", "need-language");
    await card(page).getByRole("button", { name: /Korean/ }).click();
    expect(await translatedText(page)).toBe("[mock ko] bottleneck");
    await expect(page.locator(".card-source-text")).toHaveText("bottleneck");
    // The choice is remembered.
    await expect(page.getByRole("combobox", { name: "Translate to" })).toHaveValue("ko");
  });

  test("translates a sentence with the T shortcut and sends bounded context", async ({ page }) => {
    await start(page);
    const requests = trackTranslateRequests(page);
    await dragSelect(page, 0, "The encoder–decoder architecture", "end to end.");
    await expect(page.locator(".translate-action")).toBeVisible();
    await page.keyboard.press("t");
    const sentence = "The encoder–decoder architecture [7, 2] was the first neural design to translate whole sentences end to end.";
    expect(await translatedText(page)).toBe(`[mock ko] ${sentence}`);
    const body = JSON.parse(requests[0]!.postData()!);
    expect(body.text).toBe(sentence);
    expect(body.targetLang).toBe("ko");
    expect(body.sourceLang).toBe("en");
    expect(body.context.title).toBe("Attention in Neural Machine Translation: A Short Tutorial");
    expect(body.context.section).toBe("1 Introduction");
    expect(body.context.before).toMatch(/is called attention\.$/);
    expect(body.context.after.startsWith("An encoder reads")).toBe(true);
    expect(body.context.before.length).toBeLessThanOrEqual(1200);
  });

  test("captures a whole paragraph exactly as selected", async ({ page }) => {
    await start(page);
    const scrollBefore = await page.locator(".doc-scroll").evaluate((el) => el.scrollTop);
    expect(await translateParagraph(page)).toBe(`[mock ko] ${PARAGRAPH}`);
    // Opening the card keeps the reading position.
    expect(await page.locator(".doc-scroll").evaluate((el) => el.scrollTop)).toBe(scrollBefore);
    await page.getByRole("button", { name: "Show full selection" }).click();
    await expect(page.locator(".card-source-text")).toHaveText(PARAGRAPH);
    // The passage stays visible and highlighted; the card sits beside it.
    await expect(page.locator(".passage-rect").first()).toBeVisible();
    const box = await card(page).boundingBox();
    const geometry = await highlightGeometry(page);
    const passageTop = Math.min(...geometry.rects.map((r) => r.y));
    const passageBottom = Math.max(...geometry.rects.map((r) => r.y + r.h));
    const passageRight = Math.max(...geometry.rects.map((r) => r.x + r.w));
    const coversPassage = box!.x < passageRight && box!.y < passageBottom && box!.y + box!.height > passageTop && box!.x + box!.width > geometry.rects[0]!.x;
    expect(coversPassage).toBe(false);
  });

  test("does not steal T while typing", async ({ page }) => {
    await start(page);
    const requests = trackTranslateRequests(page);
    await dragSelect(page, 0, "The encoder–decoder architecture", "end to end.");
    await expect(page.locator(".translate-action")).toBeVisible();
    await page.getByLabel("Page number").focus();
    await page.keyboard.press("t");
    await page.waitForTimeout(400);
    expect(requests).toHaveLength(0);
    await expect(card(page)).toHaveCount(0);
  });

  test("selecting text alone sends nothing", async ({ page }) => {
    await start(page);
    const requests = trackTranslateRequests(page);
    await dragSelect(page, 0, "The encoder–decoder architecture", "amount of information.");
    await page.mouse.move(700, 300, { steps: 5 });
    await page.waitForTimeout(600);
    expect(requests).toHaveLength(0);
  });

  test("copies the displayed translation", async ({ page, context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await start(page);
    const shown = await translateParagraph(page);
    await page.getByRole("button", { name: "Copy translation" }).click();
    await expect(page.locator(".copy-toast")).toHaveText("Copied");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(shown);
  });

  test("Escape closes without moving the page, and reopening uses the saved result", async ({ page }) => {
    await start(page);
    const requests = trackTranslateRequests(page);
    await translateParagraph(page);
    const before = await page.locator(".doc-scroll").evaluate((el) => [el.scrollTop, el.scrollLeft]);
    await page.keyboard.press("Escape");
    await expect(card(page)).toHaveCount(0);
    await expect(page.locator(".passage-rect")).toHaveCount(0);
    expect(await page.locator(".doc-scroll").evaluate((el) => [el.scrollTop, el.scrollLeft])).toEqual(before);

    await dragSelect(page, 0, "The encoder–decoder architecture", "amount of information.");
    await clickTranslate(page);
    expect(await translatedText(page)).toBe(`[mock ko] ${PARAGRAPH}`);
    await expect(page.locator(".card-note")).toHaveText("Saved translation");
    expect(requests).toHaveLength(1);
  });

  test("changing the target language re-translates; switching back reuses the right cache", async ({ page }) => {
    await start(page);
    const requests = trackTranslateRequests(page);
    await translateParagraph(page);
    await chooseTargetLanguage(page, "Japanese");
    await expect(page.locator(".card-lang")).toHaveText("Japanese");
    expect(await translatedText(page)).toBe(`[mock ja] ${PARAGRAPH}`);
    await chooseTargetLanguage(page, "Korean");
    expect(await translatedText(page)).toBe(`[mock ko] ${PARAGRAPH}`);
    expect(requests.map((r) => JSON.parse(r.postData()!).targetLang)).toEqual(["ko", "ja"]);
  });

  test("the highlight stays on the passage through zoom, resize, and scroll", async ({ page }) => {
    await start(page);
    await translateParagraph(page);
    const check = async () => {
      const geometry = await highlightGeometry(page);
      const first = geometry.rects[0]!;
      const textStart = await charPoint(page, 0, "The encoder–decoder architecture", "start");
      // The first highlight line starts at the first selected character.
      expect(Math.abs(first.x - (textStart.x - 1))).toBeLessThan(3);
      expect(textStart.y).toBeGreaterThan(first.y);
      expect(textStart.y).toBeLessThan(first.y + first.h);
      return geometry;
    };
    const base = await check();
    await page.getByRole("button", { name: "Zoom in" }).click();
    await page.waitForTimeout(400);
    const zoomed = await check();
    expect(zoomed.page!.w / base.page!.w).toBeGreaterThan(1.1);
    // Relative position within the page is unchanged.
    const rel = (g: typeof base) => (g.rects[0]!.y - g.page!.y) / g.page!.h;
    expect(rel(zoomed)).toBeCloseTo(rel(base), 3);
    await page.setViewportSize({ width: 1100, height: 800 });
    await page.waitForTimeout(400);
    await check();
    await page.locator(".doc-scroll").evaluate((el) => (el.scrollTop += 120));
    await page.waitForTimeout(200);
    await check();
    await expect(card(page)).toBeVisible();
  });

  test("a delayed older request never replaces the newer translation", async ({ page }) => {
    await start(page);
    let first = true;
    await page.route("**/api/translate", async (route) => {
      const delay = first ? "2500" : "50";
      first = false;
      await route.continue({ headers: { ...route.request().headers(), "x-passage-mock-delay-ms": delay } });
    });
    await dragSelect(page, 0, "The encoder–decoder architecture", "end to end.");
    await clickTranslate(page);
    await expect(card(page)).toHaveAttribute("data-status", "loading");
    await scrollTextIntoView(page, 0, "Attention replaces the constant");
    await dragSelect(page, 0, "Attention replaces the constant", "weighted average:");
    await clickTranslate(page);
    const second = await translatedText(page);
    expect(second.startsWith("[mock ko] Attention replaces the constant context")).toBe(true);
    await page.waitForTimeout(3000);
    expect(await translatedText(page)).toBe(second);
  });

  test("shows a retryable error when the service fails, keeping the excerpt", async ({ page }) => {
    await start(page);
    let fail = true;
    await page.route("**/api/translate", async (route) => {
      const headers = { ...route.request().headers() };
      if (fail) headers["x-passage-mock-fail"] = "rate_limited";
      fail = false;
      await route.continue({ headers });
    });
    await dragSelect(page, 0, "The encoder–decoder architecture", "end to end.");
    await clickTranslate(page);
    await expect(card(page)).toHaveAttribute("data-status", "error");
    await expect(card(page).getByRole("alert")).toHaveText(/Mock failure: rate_limited/);
    await expect(page.locator(".card-source-text")).toContainText("The encoder–decoder architecture");
    await card(page).getByRole("button", { name: "Retry" }).click();
    expect((await translatedText(page)).startsWith("[mock ko] The encoder–decoder")).toBe(true);
  });

  test("reports missing credentials honestly (server response mocked in this test)", async ({ page }) => {
    await start(page);
    await page.route("**/api/translate", (route) =>
      route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({
          error: {
            code: "not_configured",
            message: "Translation is unavailable: this server has no translation API key yet. Add ANTHROPIC_API_KEY to the server's .env file and restart it.",
            retryable: false,
          },
        }),
      }),
    );
    await dragSelect(page, 0, "The encoder–decoder architecture", "end to end.");
    await clickTranslate(page);
    await expect(card(page).getByRole("alert")).toHaveText(/no translation API key yet/);
    await expect(card(page).getByRole("button", { name: "Retry" })).toHaveCount(0);
  });

  test("asks for a smaller passage when the selection is over the limit", async ({ page }) => {
    // The e2e server sets the limit to 2,000 characters.
    await start(page);
    const requests = trackTranslateRequests(page);
    // From the top of the left column into the right column: well over 2,000 characters.
    await dragSelect(page, 0, "Translating a sentence requires", "weighted average:");
    await expect(page.locator(".translate-action.is-info")).toHaveText(/Select a smaller passage \(up to 2,000\)/);
    await page.keyboard.press("t");
    await page.waitForTimeout(300);
    expect(requests).toHaveLength(0);
  });

  test("asks for one page at a time when a selection crosses pages", async ({ page }) => {
    await start(page);
    await page.locator(".doc-scroll").evaluate((el) => {
      const second = document.querySelector('.page[data-page-index="1"]') as HTMLElement;
      el.scrollTop = second.offsetTop - el.clientHeight / 2;
    });
    await waitForTextLayer(page, 1);
    await page.waitForTimeout(300);
    await dragSelect(page, 0, "matters in practice.", "saturates,", 1);
    await expect(page.locator(".translate-action.is-info")).toHaveText("Select text on one page at a time to translate it.");
  });

  test("does not spend a request when the passage is already in the target language", async ({ page }) => {
    await start(page, "English");
    const requests = trackTranslateRequests(page);
    await dragSelect(page, 0, "The encoder–decoder architecture", "end to end.");
    await clickTranslate(page);
    await expect(card(page)).toHaveAttribute("data-status", "same-language");
    await expect(card(page)).toContainText("already appears to be in English");
    expect(requests).toHaveLength(0);
    await card(page).getByRole("button", { name: "German" }).click();
    expect((await translatedText(page)).startsWith("[mock de]")).toBe(true);
  });

  test("the saved translation and reading position survive a refresh", async ({ page }) => {
    await start(page);
    const requests = trackTranslateRequests(page);
    await translateParagraph(page);
    await page.keyboard.press("Escape");
    await page.locator(".doc-scroll").evaluate((el) => (el.scrollTop = 1500));
    await page.waitForTimeout(1200);
    const before = await page.locator(".doc-scroll").evaluate((el) => el.scrollTop);
    await page.reload();
    await waitForTextLayer(page, 1);
    await expect(page.getByLabel("Page number")).toHaveValue("2");
    const after = await page.locator(".doc-scroll").evaluate((el) => el.scrollTop);
    expect(Math.abs(after - before)).toBeLessThan(40);
    await page.locator(".doc-scroll").evaluate((el) => (el.scrollTop = 0));
    await page.waitForTimeout(300);
    await dragSelect(page, 0, "The encoder–decoder architecture", "amount of information.");
    await clickTranslate(page);
    expect(await translatedText(page)).toBe(`[mock ko] ${PARAGRAPH}`);
    expect(requests).toHaveLength(1);
  });
});
