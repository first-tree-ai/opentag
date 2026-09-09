import { randomUUID } from "node:crypto";
import { InternalNavigationVisibilitySchema } from "@opentag/shared/browser";
import type { Page } from "@playwright/test";
import { baseURL } from "../playwright.config.js";
import { expectAccessible, expectNoPageOverflow, expectWithinViewport } from "./browser-contract.js";
import { expect, smokeTest as test } from "./fixtures.js";

const internalToolsTest = test.extend<{ restoreInternalNavigation: undefined }>({
  restoreInternalNavigation: [
    async ({ page }, use) => {
      const csrf = (await page.context().cookies()).find((cookie) => cookie.name === "opentag_csrf")?.value;
      if (!csrf) throw new Error("Missing authenticated CSRF cookie");
      const response = await page.request.get("/api/v1/internal/navigation-visibility");
      expect(response.ok(), await response.text()).toBeTruthy();
      const original = InternalNavigationVisibilitySchema.parse(await response.json());
      try {
        await use(undefined);
      } finally {
        // This state belongs to the shared Server, so restore it even when the UI test fails.
        const restored = await page.request.put("/api/v1/internal/navigation-visibility", {
          data: original,
          headers: { Origin: baseURL, "x-opentag-csrf": csrf },
        });
        expect(restored.ok(), await restored.text()).toBeTruthy();
        expect(await restored.json()).toEqual(original);
      }
    },
    { auto: true },
  ],
});

async function createAgent(page: Page, displayName: string): Promise<string> {
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === "opentag_csrf")?.value;
  if (!csrf) throw new Error("Missing authenticated CSRF cookie");
  const response = await page.request.post("/api/v1/agents", {
    data: { creationIntentId: randomUUID(), name: `nav-${randomUUID()}`, displayName, runtimeProvider: "codex" },
    headers: { Origin: baseURL, "x-opentag-csrf": csrf },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return ((await response.json()) as { id: string }).id;
}

test("dock account menu preserves all destinations, visible hover, and keyboard focus", async ({ page }) => {
  await page.goto("/agents", { waitUntil: "networkidle" });
  expect((await page.request.get("/api/v1/me/setup/reset")).status()).toBe(204);
  const trigger = page.getByRole("button", { name: "Account menu", exact: true });
  const tooltip = page.locator(".kumo-tooltip-popup").filter({ hasText: "Account menu" });
  await trigger.hover();
  await expect(tooltip).toBeVisible();
  await trigger.click();
  const menu = page.getByRole("menu");
  await expect(menu).toHaveAccessibleName("Account menu");
  await expect(page.getByRole("navigation", { name: "Account", exact: true })).toHaveCount(0);
  await expect(menu.getByRole("menuitem")).toHaveText(["Computers", "Account", "Internal tools", "Sign out"]);
  await expect(tooltip).toBeHidden();
  await expectWithinViewport(menu);
  await page.screenshot({ path: test.info().outputPath("workspace-account.png") });
  const account = menu.getByRole("menuitem", { name: "Account", exact: true });
  const idle = await account.evaluate((element) => getComputedStyle(element).backgroundColor);
  await account.hover();
  await expect.poll(() => account.evaluate((element) => getComputedStyle(element).backgroundColor)).not.toBe(idle);
  await page.keyboard.press("End");
  await expect(menu.getByRole("menuitem", { name: "Sign out" })).toBeFocused();
  await page.keyboard.press("Home");
  await expect(menu.getByRole("menuitem", { name: "Computers" })).toBeFocused();
  await expectAccessible(page);
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(trigger).toBeFocused();
  await trigger.click();
  const heading = await page.getByRole("heading", { name: "All Agents", exact: true }).boundingBox();
  if (!heading) throw new Error("Missing page heading bounds");
  // A modal menu's dismissing backdrop receives the outside pointer, not the element underneath.
  await page.mouse.click(heading.x + heading.width / 2, heading.y + heading.height / 2);
  await expect(menu).toBeHidden();
});

internalToolsTest(
  "Internal tools opens from Agent navigation and retains working previews and reset cancellation",
  async ({ page }) => {
    const agentId = await createAgent(page, "Navigation Review");
    await page.goto(`/agents/${agentId}/usage`, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: "Account menu" }).click();
    await page.getByRole("menuitem", { name: "Internal tools" }).click();
    await expect(page).toHaveURL(/\/internal$/);
    await expect(page.getByRole("heading", { name: "Internal tools", exact: true })).toBeVisible();
    const skills = page.getByRole("switch", { name: "Show Skills", exact: true });
    await expect(skills).not.toBeChecked();
    await skills.click();
    await expect(skills).toBeChecked();
    await expect(skills).toBeEnabled();
    const integrations = page.getByRole("switch", { name: "Show Integrations", exact: true });
    await integrations.click();
    await expect(integrations).toBeChecked();
    await expect(integrations).toBeEnabled();
    await page.goto(`/agents/${agentId}`, { waitUntil: "networkidle" });
    await expect(page.getByRole("link", { name: "Skills", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Integrations", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Account menu" }).click();
    await page.getByRole("menuitem", { name: "Internal tools" }).click();
    await skills.click();
    await expect(skills).not.toBeChecked();
    await expect(skills).toBeEnabled();
    await integrations.click();
    await expect(integrations).not.toBeChecked();
    await expect(integrations).toBeEnabled();
    await page.screenshot({ path: test.info().outputPath("internal-tools.png"), fullPage: true });
    let resetRequests = 0;
    page.on("request", (request) => {
      if (request.method() === "POST" && request.url().endsWith("/me/setup/reset")) resetRequests += 1;
    });
    for (const name of ["Re-board", "Reset and start onboarding"]) {
      const trigger = page.getByRole("button", { name, exact: true });
      await trigger.click();
      const dialog = page.getByRole("dialog");
      await expect(dialog).toBeVisible();
      await expectAccessible(page);
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(dialog).toBeHidden();
      await expect(trigger).toBeFocused();
    }
    expect(resetRequests).toBe(0);
    const me = await page.request.get("/api/v1/me");
    expect((await me.json()).setupCompletedAt).toEqual(expect.any(String));
    await page.getByRole("link", { name: /Agent Setup lab/ }).click();
    await expect(page).toHaveURL(/\/internal\/agent-setup$/);
    await expect(page.getByRole("button", { name: "Mock control" })).toBeVisible();
  },
);

test("long Agent names stay bounded in the switcher and preserve the current section", async ({ page }) => {
  const longName = "CustomerResearchAndProductStrategy".repeat(3);
  const firstId = await createAgent(page, longName);
  const secondId = await createAgent(page, "Switch destination");
  await page.setViewportSize({ width: 768, height: 540 });
  await page.goto(`/agents/${firstId}/usage`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: /Switch Agent/ }).click();
  const menu = page.getByRole("menu");
  await expectWithinViewport(menu);
  await expectNoPageOverflow(page);
  await expectAccessible(page);
  await page.screenshot({ path: test.info().outputPath("agent-switcher.png") });
  await menu.getByRole("menuitem", { name: "Switch destination", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/agents/${secondId}/usage$`));
  await expect(page.getByRole("link", { name: "Usage", exact: true })).toHaveAttribute("aria-current", "page");
});

for (const width of [320, 390]) {
  test.describe(`${width}px touch account menu`, () => {
    test.use({ hasTouch: true, viewport: { width, height: 720 } });

    test("keeps Internal tools reachable and returns to All Agents", async ({ page }) => {
      await page.goto("/agents", { waitUntil: "networkidle" });
      await page.getByRole("button", { name: "Account menu" }).tap();
      await expectWithinViewport(page.getByRole("menu"));
      const item = await page.getByRole("menuitem", { name: "Internal tools" }).boundingBox();
      expect(item?.height, "touch destination height").toBeGreaterThanOrEqual(44);
      await expectNoPageOverflow(page);
      await expectAccessible(page);
      await page.getByRole("menuitem", { name: "Sign out", exact: true }).click({ trial: true });
      await page.screenshot({ path: test.info().outputPath("mobile-account.png") });
      await page.getByRole("menuitem", { name: "Internal tools" }).tap();
      await expect(page.getByRole("heading", { name: "Internal tools", exact: true })).toBeVisible();
      await expectNoPageOverflow(page);
      await page.getByRole("link", { name: "All Agents", exact: true }).tap();
      await expect(page).toHaveURL(/\/agents$/);

      const agentId = await createAgent(page, "Mobile navigation");
      await page.goto(`/agents/${agentId}/usage`, { waitUntil: "networkidle" });
      await page.getByRole("button", { name: "Open Agent navigation", exact: true }).tap();
      const switcher = page.getByRole("button", { name: /Switch Agent/ });
      await switcher.tap();
      await expectWithinViewport(page.getByRole("menu"));
      await expectAccessible(page);
      await page.keyboard.press("Escape");
      await expect(switcher).toBeFocused();
      await page.getByRole("button", { name: "Account menu", exact: true }).tap();
      await expectWithinViewport(page.getByRole("menu"));
      await expectAccessible(page);
      await page.getByRole("menuitem", { name: "Internal tools", exact: true }).tap();
      await expect(page).toHaveURL(/\/internal$/);
    });
  });
}
