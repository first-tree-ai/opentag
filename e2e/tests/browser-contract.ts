import { AxeBuilder } from "@axe-core/playwright";
import type { Locator, Page } from "@playwright/test";
import { expect } from "./fixtures.js";

export async function expectAccessible(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page }).analyze();
  const violations = results.violations.map(
    (violation) => `${violation.id}: ${violation.nodes.map((node) => node.target.join(", ")).join(" | ")}`,
  );
  expect(violations, "axe accessibility violations").toEqual([]);
}

export async function expectNoPageOverflow(page: Page): Promise<void> {
  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(dimensions.scrollWidth, "page-level horizontal overflow").toBeLessThanOrEqual(dimensions.clientWidth);
}

export async function expectWithinViewport(locator: Locator): Promise<void> {
  await expect(locator).toBeVisible();
  const [box, viewport] = await Promise.all([locator.boundingBox(), locator.page().viewportSize()]);
  expect(box, "element layout box").not.toBeNull();
  expect(viewport, "browser viewport").not.toBeNull();
  if (!box || !viewport) throw new Error("Expected the element and viewport to have layout dimensions");

  expect(box.x, "element left edge").toBeGreaterThanOrEqual(0);
  expect(box.y, "element top edge").toBeGreaterThanOrEqual(0);
  expect(box.x + box.width, "element right edge").toBeLessThanOrEqual(viewport.width);
  expect(box.y + box.height, "element bottom edge").toBeLessThanOrEqual(viewport.height);
}
