import { expectAccessible } from "./browser-contract.js";
import { expect, smokeTest as test } from "./fixtures.js";

test.describe.configure({ mode: "parallel" });

test.describe("anonymous access", () => {
  test.use({ storageState: { cookies: [], origins: [] } });

  test("protected routes redirect to an accessible sign-in form", async ({ page }) => {
    await page.goto("/agents", { waitUntil: "networkidle" });
    await expect(page).toHaveURL(/\/login\?next=%2Fagents$/);
    await expect(page.getByRole("heading", { name: "Welcome back", exact: true })).toBeVisible();
    await expect(page.getByLabel("Email", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Password", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Sign in", exact: true })).toBeEnabled();

    const email = page.getByLabel("Email", { exact: true });
    const password = page.getByLabel("Password", { exact: true });
    await email.focus();
    await expect(email).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(password).toBeFocused();
    await expectAccessible(page);
  });
});

test("the authenticated Agents entrypoint exposes an accessible keyboard action", async ({ page }) => {
  await page.goto("/agents", { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { name: "Agents", exact: true })).toBeVisible();
  const newAgent = page.getByRole("link", { name: "New Agent", exact: true });
  await expect(newAgent).toBeVisible();
  await newAgent.focus();
  await expect(newAgent).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/agents\/setup\?action=create$/);
  await expect(page.getByRole("heading", { name: "Where should your agent run?", exact: true })).toBeVisible();
  await expectAccessible(page);
});

test("the Agent creation route exposes named keyboard controls", async ({ page }) => {
  await page.goto("/agents/setup?action=create", { waitUntil: "networkidle" });
  const localComputer = page.getByRole("button", { name: /Local computer/ });
  await localComputer.focus();
  await expect(localComputer).toBeFocused();
  await page.keyboard.press("Enter");
  const continueAction = page.getByRole("button", { name: "Continue", exact: true });
  await expect(continueAction).toBeEnabled();
  await continueAction.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("heading", { name: "Create your agent", exact: true })).toBeVisible();
  await expect(page.getByLabel("Agent name", { exact: true })).toBeVisible();
  await expectAccessible(page);
});

test("the Account menu has named keyboard destinations", async ({ page }) => {
  await page.goto("/agents", { waitUntil: "networkidle" });
  const trigger = page.getByRole("button", { name: "Account menu", exact: true });
  await trigger.focus();
  await expect(trigger).toBeFocused();
  await trigger.click();
  const account = page.getByRole("menuitem", { name: "Account", exact: true });
  await expect(page.getByRole("menuitem", { name: "Computers", exact: true })).toBeVisible();
  await expect(account).toBeVisible();
  await account.focus();
  await expect(account).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/account\/?$/);
  await expect(page.getByRole("heading", { name: "Account", exact: true })).toBeVisible();
  await expectAccessible(page);
});
