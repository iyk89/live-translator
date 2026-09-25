import { expect, test } from "@playwright/test";
import { chooseTargetLanguage, clickTranslate, dragSelect, openSample, translatedText } from "./helpers";

/*
 * Regenerates the README screenshots (docs/screenshots). Skipped unless
 * PASSAGE_SCREENSHOTS=1. Translations come from the MOCK provider and the
 * card shows its "Test mode" label.
 */
test.skip(!process.env.PASSAGE_SCREENSHOTS, "set PASSAGE_SCREENSHOTS=1 to regenerate screenshots");

test("desktop screenshots", async ({ page, isMobile }) => {
  test.skip(isMobile);
  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Read papers across languages" })).toBeVisible();
  await page.screenshot({ path: "docs/screenshots/import.png" });

  await openSample(page);
  await chooseTargetLanguage(page, "Korean");
  await page.waitForTimeout(600);
  await page.screenshot({ path: "docs/screenshots/reader.png" });

  await dragSelect(page, 0, "The encoder–decoder architecture", "amount of information.");
  await page.waitForTimeout(300);
  await page.screenshot({ path: "docs/screenshots/selection.png" });
  await clickTranslate(page);
  await translatedText(page);
  await page.mouse.move(5, 300);
  await page.waitForTimeout(300);
  await page.screenshot({ path: "docs/screenshots/translation.png" });
});
