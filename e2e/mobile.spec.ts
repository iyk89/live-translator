import { expect, test } from "@playwright/test";
import { charPoint, chooseTargetLanguage, openSample, translatedText } from "./helpers";

test.describe("narrow screens", () => {
  test("keeps essential controls reachable and shows the translation in a bottom sheet", async ({ page }) => {
    await openSample(page);
    await expect(page.getByRole("button", { name: "Open another paper" })).toBeVisible();
    await expect(page.getByLabel("Page number")).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Translate to" })).toBeVisible();
    await chooseTargetLanguage(page, "Spanish");

    // Select a word programmatically (touch selection is driven by the OS).
    const point = await charPoint(page, 0, "bottleneck", "start");
    await page.evaluate(({ x, y }) => {
      const hit = document.caretRangeFromPoint(x + 3, y);
      if (!hit) throw new Error("no caret");
      const node = hit.startContainer as Text;
      const at = node.data.indexOf("bottleneck");
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + "bottleneck".length);
      const selection = document.getSelection()!;
      selection.removeAllRanges();
      selection.addRange(range);
    }, point);
    await page.locator(".translate-action").tap();
    expect(await translatedText(page)).toBe("[mock es] bottleneck");

    const sheet = page.locator(".card.is-sheet");
    await expect(sheet).toBeVisible();
    const sheetBox = await sheet.boundingBox();
    const viewport = page.viewportSize()!;
    expect(Math.round(sheetBox!.y + sheetBox!.height)).toBeGreaterThanOrEqual(viewport.height - 2);
    expect(sheetBox!.width).toBeGreaterThanOrEqual(viewport.width - 2);
    // The passage stays visible above the sheet.
    const highlight = await page.locator(".passage-rect").first().boundingBox();
    expect(highlight!.y + highlight!.height).toBeLessThanOrEqual(sheetBox!.y);
    if (process.env.PASSAGE_SCREENSHOTS) await page.screenshot({ path: "docs/screenshots/mobile-sheet.png" });
    await page.getByRole("button", { name: "Close translation" }).tap();
    await expect(sheet).toHaveCount(0);
  });
});
