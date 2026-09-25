import { expect, test } from "@playwright/test";
import path from "node:path";
import { FIXTURES, openSample, uploadFile, waitForTextLayer } from "./helpers";

test.describe("reader", () => {
  test("navigates pages by buttons and direct entry", async ({ page }) => {
    await openSample(page);
    const pageInput = page.getByLabel("Page number");
    await expect(pageInput).toHaveValue("1");
    await expect(page.getByRole("button", { name: "Previous page" })).toBeDisabled();
    await page.getByRole("button", { name: "Next page" }).click();
    await expect(pageInput).toHaveValue("2");
    await pageInput.fill("3");
    await pageInput.press("Enter");
    await expect(pageInput).toHaveValue("3");
    await expect(page.getByRole("button", { name: "Next page" })).toBeDisabled();
    await pageInput.fill("99");
    await pageInput.press("Enter");
    await expect(pageInput).toHaveValue("3");
    await page.getByRole("button", { name: "Previous page" }).click();
    await expect(pageInput).toHaveValue("2");
  });

  test("zooms in and out and fits the width", async ({ page }) => {
    await openSample(page);
    const zoomLabel = page.locator(".zoom-value");
    await expect(zoomLabel).toHaveText("125%");
    const width = async () => (await page.locator('.page[data-page-index="0"]').boundingBox())!.width;
    const before = await width();
    await page.getByRole("button", { name: "Zoom in" }).click();
    await expect(zoomLabel).toHaveText("150%");
    expect(await width()).toBeGreaterThan(before * 1.15);
    await page.getByRole("button", { name: "Zoom out" }).click();
    await page.getByRole("button", { name: "Zoom out" }).click();
    await expect(zoomLabel).toHaveText("110%");
    await page.getByRole("button", { name: /Fit width/ }).click();
    await expect(page.getByRole("button", { name: /Fit width/ })).toHaveAttribute("aria-pressed", "true");
    const scroller = await page.locator(".doc-scroll").boundingBox();
    expect(await width()).toBeGreaterThan(scroller!.width - 60);
    // Text layer stays aligned with the rendered page after zooming.
    await waitForTextLayer(page, 0);
    const layer = await page.locator('.page[data-page-index="0"] .textLayer').boundingBox();
    expect(Math.abs(layer!.width - (await width()))).toBeLessThan(2);
  });

  test("opens a scanned PDF for reading and explains that translation needs text", async ({ page }) => {
    await uploadFile(page, path.join(FIXTURES, "scanned.pdf"));
    await expect(page.locator(".page[data-rendered=true]").first()).toBeVisible();
    await expect(page.getByText(/This PDF looks scanned/)).toBeVisible();
    await expect(page.locator(".page-notice").first()).toHaveText(/No selectable text on this page/);
  });

  test("marks individual pages without a text layer", async ({ page }) => {
    await uploadFile(page, path.join(FIXTURES, "mixed-scanned.pdf"));
    await waitForTextLayer(page, 0);
    await page.getByRole("button", { name: "Next page" }).click();
    await expect(page.locator('.page[data-page-index="1"] .page-notice')).toBeVisible();
    await expect(page.locator('.page[data-page-index="0"] .page-notice')).toHaveCount(0);
    await expect(page.getByText(/This PDF looks scanned/)).toHaveCount(0);
  });

  test("keeps memory bounded on long papers", async ({ page }) => {
    await uploadFile(page, path.join(FIXTURES, "long-sample.pdf"));
    await waitForTextLayer(page, 0);
    await expect(page.locator(".page-total")).toHaveText("/ 42");
    for (let step = 0; step < 12; step++) {
      await page.locator(".doc-scroll").evaluate((el) => (el.scrollTop += el.clientHeight * 2.5));
      await page.waitForTimeout(120);
    }
    await page.waitForTimeout(600);
    const canvases = await page.locator("canvas.page-canvas").count();
    const layers = await page.locator(".textLayer").count();
    expect(canvases).toBeLessThanOrEqual(8);
    expect(layers).toBeLessThanOrEqual(12);
    // The pages now in view are rendered.
    const current = Number(await page.getByLabel("Page number").inputValue()) - 1;
    await expect(page.locator(`.page[data-page-index="${current}"]`)).toHaveAttribute("data-rendered", "true");
  });

  test("the back button returns to import with a Continue reading entry", async ({ page }) => {
    await openSample(page);
    await page.getByRole("button", { name: "Next page" }).click();
    await page.waitForTimeout(900);
    await page.getByRole("button", { name: "Open another paper" }).click();
    const entry = page.getByRole("region", { name: "Continue reading" });
    await expect(entry).toContainText("Attention in Neural Machine Translation: A Short Tutorial");
    await expect(entry).toContainText("Page 2 of 3");
    await entry.getByRole("button", { name: "Continue" }).click();
    await expect(page.getByLabel("Page number")).toHaveValue("2");
  });

  test("clearing saved data removes the continue entry", async ({ page }) => {
    await openSample(page);
    await page.waitForTimeout(500);
    await page.getByRole("button", { name: "Open another paper" }).click();
    await expect(page.getByRole("region", { name: "Continue reading" })).toBeVisible();
    await page.getByRole("button", { name: "Clear saved data" }).click();
    await page.getByRole("button", { name: "Remove", exact: true }).click();
    await expect(page.getByText("Saved data removed.")).toBeVisible();
    await expect(page.getByRole("region", { name: "Continue reading" })).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole("region", { name: "Continue reading" })).toHaveCount(0);
  });

  test("keyboard: the document can be focused and scrolled", async ({ page }) => {
    await openSample(page);
    await page.locator(".doc-scroll").focus();
    await page.keyboard.press("PageDown");
    await page.waitForTimeout(300);
    expect(await page.locator(".doc-scroll").evaluate((el) => el.scrollTop)).toBeGreaterThan(200);
  });
});
