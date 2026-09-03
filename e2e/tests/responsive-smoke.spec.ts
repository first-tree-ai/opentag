import { expectAccessible, expectNoPageOverflow, expectWithinViewport } from "./browser-contract.js";
import { expect, smokeTest as test } from "./fixtures.js";

test.describe.configure({ mode: "parallel" });

test.describe("320px minimum supported width", () => {
  test.use({ storageState: { cookies: [], origins: [] }, viewport: { width: 320, height: 720 } });

  test("keeps sign-in visible, keyboard ordered, and free of page overflow", async ({ page }) => {
    await page.goto("/agents", { waitUntil: "networkidle" });
    await expect(page).toHaveURL(/\/login\?next=%2Fagents$/);
    await expect(page.getByRole("heading", { name: "Welcome back", exact: true })).toBeVisible();
    await expectWithinViewport(page.locator('[data-ui="login-card"]'));
    await expectNoPageOverflow(page);

    const email = page.getByLabel("Email", { exact: true });
    const password = page.getByLabel("Password", { exact: true });
    await email.focus();
    await page.keyboard.press("Tab");
    await expect(password).toBeFocused();
    await expectAccessible(page);
  });
});

test.describe("390px primary mobile width", () => {
  test.use({ hasTouch: true, viewport: { width: 390, height: 844 } });

  test("keeps the primary action and touch creation route inside the viewport", async ({ page }) => {
    await page.goto("/agents", { waitUntil: "networkidle" });
    await expect(page.getByRole("heading", { name: "Agents", exact: true })).toBeVisible();
    const trigger = page.getByRole("link", { name: "New Agent", exact: true });
    await expectWithinViewport(trigger);
    await expectNoPageOverflow(page);

    await trigger.tap();
    await expect(page).toHaveURL(/\/agents\/setup\?action=create$/);
    const createSurface = page.locator('[data-ui="agent-create"]');
    await expect(page.getByRole("heading", { name: "Where should your agent run?", exact: true })).toBeVisible();
    await expectWithinViewport(createSurface);
    await expectNoPageOverflow(page);
    await expectAccessible(page);
  });
});

test.describe("768px layout transition width", () => {
  test.use({ viewport: { width: 768, height: 900 } });

  test("keeps Account settings readable in the wide row composition", async ({ page }) => {
    await page.goto("/account", { waitUntil: "networkidle" });
    await expect(page.getByRole("heading", { name: "Account", exact: true })).toBeVisible();
    await expectNoPageOverflow(page);

    const firstRow = page.locator('[data-ui="settings-row"]').first();
    const copy = firstRow.locator(":scope > div").nth(0);
    const control = firstRow.locator(":scope > div").nth(1);
    const [copyBox, controlBox] = await Promise.all([copy.boundingBox(), control.boundingBox()]);
    expect(copyBox, "settings copy layout box").not.toBeNull();
    expect(controlBox, "settings control layout box").not.toBeNull();
    if (!copyBox || !controlBox) throw new Error("Expected Account settings to have layout dimensions");
    expect(controlBox.x, "settings control column").toBeGreaterThan(copyBox.x + copyBox.width);

    const displayName = page.getByLabel("Display name", { exact: true });
    await displayName.focus();
    await expect(displayName).toBeFocused();
    await expectAccessible(page);
  });
});

test.describe("1440px desktop width", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("centers the bounded content frame and preserves the page hierarchy", async ({ page }) => {
    await page.goto("/agents", { waitUntil: "networkidle" });
    const heading = page.getByRole("heading", { name: "Agents", exact: true });
    const action = page.getByRole("link", { name: "New Agent", exact: true });
    await expect(heading).toBeVisible();
    await expect(action).toBeVisible();
    await expectNoPageOverflow(page);

    const frame = page.locator('[data-ui="content-page-frame"]');
    const frameBox = await frame.boundingBox();
    expect(frameBox, "desktop content frame layout box").not.toBeNull();
    if (!frameBox) throw new Error("Expected the desktop content frame to have layout dimensions");
    expect(frameBox.width, "desktop content frame width").toBeLessThanOrEqual(1024);
    expect(frameBox.x + frameBox.width / 2, "desktop content frame center").toBeCloseTo(720, 0);

    const [headingBox, actionBox] = await Promise.all([heading.boundingBox(), action.boundingBox()]);
    if (!headingBox || !actionBox) throw new Error("Expected the page header to have layout dimensions");
    const alignmentOffset = Math.abs(actionBox.y + actionBox.height / 2 - (headingBox.y + headingBox.height / 2));
    expect(alignmentOffset, "desktop page action alignment").toBeLessThanOrEqual(8);

    await action.click();
    await expect(page).toHaveURL(/\/agents\/setup\?action=create$/);
    await expect(page.getByRole("heading", { name: "Where should your agent run?", exact: true })).toBeVisible();
    await expectNoPageOverflow(page);
    await expectAccessible(page);
  });
});
