import { expect, type Page, type Request } from "@playwright/test";
import path from "node:path";

export const FIXTURES = path.resolve("fixtures/pdfs");
export const SAMPLE = path.resolve("public/samples/sample-paper.pdf");

export async function openSample(page: Page) {
  await page.goto("/");
  await page.getByRole("button", { name: "Try a sample paper" }).click();
  await waitForTextLayer(page, 0);
}

export async function uploadFile(page: Page, file: string) {
  await page.goto("/");
  await page.locator('input[type="file"]').setInputFiles(file);
}

export async function waitForTextLayer(page: Page, pageIndex: number) {
  await expect(page.locator(`.page[data-page-index="${pageIndex}"] .textLayer span`).first()).toBeAttached({ timeout: 15_000 });
}

/** Viewport point of one character of `text` inside page `pageIndex`'s text layer. */
export async function charPoint(page: Page, pageIndex: number, text: string, which: "start" | "end", occurrence = 0) {
  const point = await page.evaluate(
    ({ pageIndex, text, which, occurrence }) => {
      const spans = [...document.querySelectorAll(`.page[data-page-index="${pageIndex}"] .textLayer span`)];
      let seen = 0;
      for (const span of spans) {
        const node = span.firstChild;
        if (!node || node.nodeType !== Node.TEXT_NODE) continue;
        const data = (node as Text).data;
        const at = data.indexOf(text);
        if (at < 0) continue;
        if (seen++ < occurrence) continue;
        const range = document.createRange();
        const offset = which === "start" ? at : at + text.length - 1;
        range.setStart(node, offset);
        range.setEnd(node, offset + 1);
        const r = range.getBoundingClientRect();
        return { x: which === "start" ? r.left + 1 : r.right - 1, y: r.top + r.height / 2 };
      }
      return null;
    },
    { pageIndex, text, which, occurrence },
  );
  if (!point) throw new Error(`Text "${text}" not found on page ${pageIndex + 1}`);
  return point;
}

/** Scrolls so that `text` on the page is comfortably inside the viewport. */
export async function scrollTextIntoView(page: Page, pageIndex: number, text: string) {
  await page.evaluate(
    ({ pageIndex, text }) => {
      const spans = [...document.querySelectorAll(`.page[data-page-index="${pageIndex}"] .textLayer span`)];
      const span = spans.find((s) => s.textContent?.includes(text));
      const scroller = document.querySelector(".doc-scroll")!;
      if (!span) return;
      const box = span.getBoundingClientRect();
      const host = scroller.getBoundingClientRect();
      scroller.scrollTop += box.top - host.top - host.height * 0.3;
    },
    { pageIndex, text },
  );
  await page.waitForTimeout(250);
}

/** Drags a mouse selection from the start of `startText` to the end of `endText`. */
export async function dragSelect(page: Page, pageIndex: number, startText: string, endText: string, endPage = pageIndex) {
  const start = await charPoint(page, pageIndex, startText, "start");
  const end = await charPoint(page, endPage, endText, "end");
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move((start.x + end.x) / 2, (start.y + end.y) / 2, { steps: 6 });
  await page.mouse.move(end.x, end.y, { steps: 6 });
  await page.mouse.up();
}

export async function chooseTargetLanguage(page: Page, label: string) {
  await page.getByRole("combobox", { name: "Translate to" }).selectOption({ label });
}

export function card(page: Page) {
  return page.locator(".card");
}

export async function translatedText(page: Page) {
  await expect(card(page)).toHaveAttribute("data-status", "done");
  return (await page.locator(".card-translation").innerText()).trim();
}

export function trackTranslateRequests(page: Page) {
  const requests: Request[] = [];
  page.on("request", (request) => {
    if (request.url().endsWith("/api/translate") && request.method() === "POST") requests.push(request);
  });
  return requests;
}

/** Highlight rectangles and the page box, in viewport pixels. */
export async function highlightGeometry(page: Page) {
  return page.evaluate(() => {
    const rects = [...document.querySelectorAll(".passage-rect")].map((el) => el.getBoundingClientRect());
    const pageEl = document.querySelector(".passage-rect")?.closest(".page");
    const pageBox = pageEl?.getBoundingClientRect();
    return {
      rects: rects.map((r) => ({ x: r.left, y: r.top, w: r.width, h: r.height })),
      page: pageBox ? { x: pageBox.left, y: pageBox.top, w: pageBox.width, h: pageBox.height } : null,
    };
  });
}

/** Where the text of `text` currently is on screen (first line box). */
export async function textBox(page: Page, pageIndex: number, text: string) {
  const start = await charPoint(page, pageIndex, text, "start");
  return start;
}

/**
 * Clicks the floating Translate button where it is, like a person would.
 * (Locator.click() may scroll the element into view first, which would hide
 * whether the app itself keeps the reading position.)
 */
export async function clickTranslate(page: Page) {
  const action = page.locator(".translate-action:not(.is-info)");
  await expect(action).toBeVisible();
  await page.waitForTimeout(150);
  const box = (await action.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
}
