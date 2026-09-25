import { expect, test } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { FIXTURES, SAMPLE, uploadFile, waitForTextLayer } from "./helpers";

test.describe("import screen", () => {
  test("offers upload, link, sample, and states the limits", async ({ page }) => {
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Read papers across languages" })).toBeVisible();
    await expect(page.getByText("Open a paper and translate the passages you select.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Upload PDF" })).toBeVisible();
    await expect(page.getByLabel("Paste paper link")).toBeVisible();
    await expect(page.getByRole("button", { name: "Open paper" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Try a sample paper" })).toBeVisible();
    await expect(page.getByText("Text-based PDFs up to 25 MB and 200 pages")).toBeVisible();
    await expect(page.getByText(/only the selected text and a little surrounding context are sent/)).toBeVisible();
  });

  test("opens a PDF chosen with the file picker", async ({ page }) => {
    await uploadFile(page, SAMPLE);
    await waitForTextLayer(page, 0);
    await expect(page.locator(".toolbar-title")).toHaveText("Attention in Neural Machine Translation: A Short Tutorial");
    await expect(page.locator(".page-total")).toHaveText("/ 3");
  });

  test("opens a PDF dropped onto the page", async ({ page }) => {
    await page.goto("/");
    const bytes = fs.readFileSync(path.join(FIXTURES, "sample-paper-de.pdf")).toString("base64");
    const dataTransfer = await page.evaluateHandle(async (b64) => {
      const binary = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      const transfer = new DataTransfer();
      transfer.items.add(new File([binary], "aufmerksamkeit.pdf", { type: "application/pdf" }));
      return transfer;
    }, bytes);
    await page.locator(".dropzone").dispatchEvent("dragenter", { dataTransfer });
    await expect(page.locator(".dropzone")).toHaveClass(/is-dragging/);
    await page.locator(".dropzone").dispatchEvent("drop", { dataTransfer });
    await waitForTextLayer(page, 0);
    await expect(page.locator(".toolbar-title")).toContainText("Aufmerksamkeit");
  });

  const invalid: Array<[string, RegExp]> = [
    ["not-a-pdf.pdf", /isn't a PDF/],
    ["corrupt.pdf", /damaged|couldn't be opened/],
    ["encrypted.pdf", /password-protected/],
    ["too-many-pages.pdf", /201 pages\. 200 pages is the most/],
  ];
  for (const [file, message] of invalid) {
    test(`explains why ${file} can't be opened`, async ({ page }) => {
      await uploadFile(page, path.join(FIXTURES, file));
      await expect(page.getByRole("alert")).toHaveText(message);
      await expect(page).toHaveURL(/\/(#\/)?$/);
    });
  }

  test("rejects files over the size limit before reading them", async ({ page }) => {
    await page.goto("/");
    const big = Buffer.alloc(26 * 1024 * 1024, 0x20);
    big.write("%PDF-1.7\n", 0);
    await page.locator('input[type="file"]').setInputFiles({ name: "huge.pdf", mimeType: "application/pdf", buffer: big });
    await expect(page.getByRole("alert")).toHaveText(/26 MB\. PDFs up to 25 MB are supported/);
  });

  test("opens a paper from a link (server response mocked in this test)", async ({ page }) => {
    // The sandbox cannot reach arxiv.org; the server's fetcher is covered by unit tests.
    await page.route("**/api/import", async (route) => {
      expect(JSON.parse(route.request().postData() ?? "{}")).toEqual({ url: "https://arxiv.org/abs/2301.00001v2" });
      await route.fulfill({
        status: 200,
        contentType: "application/pdf",
        headers: {
          "x-passage-file-name": encodeURIComponent("arXiv 2301.00001v2.pdf"),
          "x-passage-final-url": encodeURIComponent("https://arxiv.org/pdf/2301.00001v2"),
        },
        body: fs.readFileSync(SAMPLE),
      });
    });
    await page.goto("/");
    await page.getByLabel("Paste paper link").fill("https://arxiv.org/abs/2301.00001v2");
    await page.getByRole("button", { name: "Open paper" }).click();
    await waitForTextLayer(page, 0);
    await expect(page.locator(".toolbar-title")).toContainText("Attention in Neural Machine Translation");
  });

  test("keeps the link after a failed import so it can be edited", async ({ page }) => {
    await page.goto("/");
    const input = page.getByLabel("Paste paper link");
    // Real server-side validation: private addresses are refused.
    await input.fill("http://192.168.1.10/paper.pdf");
    await page.getByRole("button", { name: "Open paper" }).click();
    await expect(page.getByRole("alert")).toHaveText(/private or local network address/);
    await expect(input).toHaveValue("http://192.168.1.10/paper.pdf");

    await page.route("**/api/import", (route) =>
      route.fulfill({
        status: 422,
        contentType: "application/json",
        body: JSON.stringify({ error: { code: "not_pdf", message: "This link doesn't lead to an accessible PDF. Upload the file or paste a direct PDF link." } }),
      }),
    );
    await input.fill("https://example.org/landing-page");
    await page.getByRole("button", { name: "Open paper" }).click();
    await expect(page.getByRole("alert")).toHaveText("This link doesn't lead to an accessible PDF. Upload the file or paste a direct PDF link.");
    await expect(input).toHaveValue("https://example.org/landing-page");
  });

  test("shows truthful progress while fetching a link", async ({ page }) => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    await page.route("**/api/import", async (route) => {
      await held;
      await route.fulfill({ status: 200, contentType: "application/pdf", body: fs.readFileSync(SAMPLE) });
    });
    await page.goto("/");
    await page.getByLabel("Paste paper link").fill("https://example.org/paper.pdf");
    await page.getByRole("button", { name: "Open paper" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Fetching paper…" })).toBeVisible();
    release();
    await waitForTextLayer(page, 0);
  });
});
