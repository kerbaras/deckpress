import { writeFile } from "node:fs/promises";
import { expect, test } from "@playwright/test";

test("imports a real deck, compares sources, uploads art, and exports a duplex PDF", async ({
  page,
  request,
}, info) => {
  const name = `Print workflow ${Date.now()}`;
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/");
  await page.getByRole("button", { name: "New deck", exact: true }).click();
  await page.getByLabel("Deck name", { exact: true }).fill(name);
  await page
    .getByRole("combobox", { name: "Format", exact: true })
    .selectOption("Casual");
  const createdResponse = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/decks") &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Create deck", exact: true }).click();
  const created: { id: string } = await (await createdResponse).json();
  try {
    await page
      .getByLabel("Decklist", { exact: true })
      .fill("4 Lightning Bolt (M10) 146\n1 Delver of Secrets (ISD) 51");
    await page.getByRole("button", { name: "Resolve on Scryfall" }).click();
    await page.getByRole("button", { name: "Add 5 cards to deck" }).click();
    await expect(
      page.getByRole("button", { name: "Imported and saved" }),
    ).toBeDisabled();
    await page.getByRole("button", { name: "Art studio", exact: true }).click();
    const original = page.getByAltText("Original: Lightning Bolt", {
      exact: true,
    });
    await expect
      .poll(() =>
        original.evaluate((image: HTMLImageElement) => image.naturalWidth),
      )
      .toBeGreaterThan(0);
    const originalSrc = await original.getAttribute("src");
    await page.getByLabel("Official only", { exact: true }).check();
    await page
      .getByRole("searchbox", { name: "Search set, artist, creator or tag" })
      .fill("Mystical Archive");
    await page
      .getByRole("button", {
        name: /Select.*Mystical Archive.*Anato Finnstark/,
      })
      .first()
      .click();
    await expect(original).toHaveAttribute("src", originalSrc ?? "");
    await expect(
      page.getByAltText("Selected: Lightning Bolt", { exact: true }),
    ).not.toHaveAttribute("src", originalSrc ?? "");
    await page.getByRole("button", { name: "Apply", exact: true }).click();
    await expect(
      page.getByRole("button", { name: "Save changes" }),
    ).toBeDisabled();
    await expect
      .poll(() =>
        page
          .getByAltText("Selected: Lightning Bolt", { exact: true })
          .evaluate((image: HTMLImageElement) => image.naturalWidth),
      )
      .toBeGreaterThan(0);
    await info.attach("Art comparison", {
      body: await page.screenshot({
        fullPage: true,
        path: info.outputPath("art-comparison.png"),
      }),
      contentType: "image/png",
    });
    await page
      .getByRole("searchbox", { name: "Search set, artist, creator or tag" })
      .fill("");
    await page
      .getByRole("button", { name: "MPC Autofill", exact: true })
      .click();
    await expect(page.locator(".art-option").first()).toBeVisible();
    await expect(page.locator(".art-option .badge").first()).toHaveText(
      "Community",
    );
    const originalBytes = await (await request.get(originalSrc ?? "")).body();
    await page.getByRole("button", { name: "Upload art" }).click();
    await page.getByLabel("Image · PNG, JPEG or WebP").setInputFiles({
      name: "test-upload.png",
      mimeType: "image/png",
      buffer: originalBytes,
    });
    await page.getByLabel("Artist / credit").fill("Workflow test upload");
    await page.getByRole("button", { name: "Upload & preview" }).click();
    await expect(page.locator(".selected-monitor")).toContainText(
      "Workflow test upload",
    );
    await page.getByRole("button", { name: "Reset to original" }).click();
    await page.getByRole("button", { name: "Next card", exact: true }).click();
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await expect(
      page.getByAltText("Original: Insectile Aberration", { exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Print setup", exact: true })
      .click();
    await page
      .getByLabel("Print preset", { exact: true })
      .selectOption("proof");
    await page
      .getByRole("combobox", { name: "Paper size", exact: true })
      .selectOption("letter");
    await page
      .getByRole("combobox", { name: "Back pages", exact: true })
      .selectOption("long-edge");
    await page
      .getByRole("combobox", { name: "Fill", exact: true })
      .selectOption("mirror");
    await expect(
      page.getByRole("img", {
        name: /Print preview, US Letter, 3 columns by 3 rows/,
      }),
    ).toBeVisible();
    await expect(
      page.locator(".proof-sheet text", { hasText: "Image failed to load" }),
    ).toHaveCount(0);
    const previewUrls = await page
      .locator(".proof-sheet image")
      .evaluateAll((images) =>
        images.map((image) => image.getAttribute("href")),
      );
    await Promise.all(
      previewUrls.map(async (url) =>
        expect((await request.get(url ?? "")).ok()).toBe(true),
      ),
    );
    await expect(page.locator(".proof-canvas")).toHaveAttribute(
      "aria-busy",
      "false",
    );
    await expect(
      page.locator('.proof-sheet image[data-loaded="true"]'),
    ).toHaveCount(5);
    const ratio = await page.locator(".proof-sheet").evaluate((sheet) => {
      const rect = sheet.getBoundingClientRect();
      return rect.width / rect.height;
    });
    expect(ratio).toBeCloseTo(215.9 / 279.4, 2);
    await info.attach("Print preview", {
      body: await page.screenshot({
        fullPage: true,
        path: info.outputPath("print-preview.png"),
      }),
      contentType: "image/png",
    });
    await page
      .getByRole("button", { name: "Generate PDF", exact: true })
      .first()
      .click();
    const job = page
      .locator(".job", {
        has: page.getByRole("heading", { name, exact: true }),
      })
      .first();
    await expect(job).toContainText("completed", { timeout: 90_000 });
    const href = await job
      .getByRole("link", { name: "Download PDF" })
      .getAttribute("href");
    const pdf = await request.get(href ?? "");
    expect(pdf.headers()["content-type"]).toBe("application/pdf");
    const bytes = await pdf.body();
    expect(bytes.subarray(0, 5).toString()).toBe("%PDF-");
    expect(bytes.length).toBeGreaterThan(10_000);
    await expect(job).toContainText("2 PDF pages");
    await writeFile(info.outputPath("duplex-proof.pdf"), bytes);
    await info.attach("Duplex proof", {
      body: bytes,
      contentType: "application/pdf",
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/#/decks/${created.id}`);
    await page.getByRole("button", { name: "Art studio", exact: true }).click();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await info.attach("Mobile art studio", {
      body: await page.screenshot({
        fullPage: false,
        path: info.outputPath("mobile-art-studio.png"),
      }),
      contentType: "image/png",
    });
    expect(errors).toEqual([]);
  } finally {
    await request.delete(`/api/decks/${created.id}`, {
      headers: { "Content-Type": "application/json" },
    });
  }
});
