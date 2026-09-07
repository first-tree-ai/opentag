import { randomUUID } from "node:crypto";
import { expectAccessible, expectNoPageOverflow } from "./browser-contract.js";
import { expect, smokeTest as test } from "./fixtures.js";

test.describe.configure({ mode: "parallel" });
test.use({ storageState: { cookies: [], origins: [] } });

test("password sign-in preserves rejected input and establishes a real browser session", async ({ page }, testInfo) => {
  await page.goto("/login?next=%2Fagents%2Fsetup");
  const email = page.getByLabel("Email", { exact: true });
  const password = page.getByLabel("Password", { exact: true });
  await email.fill("password-e2e@opentag.local");
  await password.fill("definitely-wrong-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("The email address or password is incorrect");
  await expect(email).toHaveValue("password-e2e@opentag.local");
  await expect(password).toHaveValue("definitely-wrong-password");
  await expectAccessible(page);
  await testInfo.attach("login-credential-error-desktop", { body: await page.screenshot(), contentType: "image/png" });

  await password.fill("correct-password-e2e");
  await password.press("Enter");
  await expect(page).toHaveURL(/\/agents\/setup$/);
  await expect(page.getByRole("heading", { name: "Where should your agent run?", exact: true })).toBeVisible();
  const me = await page.request.get("/api/v1/me");
  expect(me.status()).toBe(200);
  await expect(me.json()).resolves.toMatchObject({ user: { email: "password-e2e@opentag.local" } });
});

test("registration creates an account through the form and opens setup", async ({ page }, testInfo) => {
  const email = `login-${randomUUID()}@opentag.local`;
  await page.goto("/login");
  await page.getByRole("button", { name: "Create one", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Create your account", exact: true })).toBeVisible();
  await page.getByLabel("Name", { exact: true }).fill("Login E2E");
  await page.getByLabel("Email", { exact: true }).fill(email);
  const password = page.getByLabel("Password", { exact: true });
  await expect(password).toHaveAttribute("autocomplete", "new-password");
  await expect(page.getByText("At least 12 characters.", { exact: true })).toBeVisible();
  await password.fill("new-account-password-e2e");
  await expectAccessible(page);
  await testInfo.attach("login-registration-desktop", { body: await page.screenshot(), contentType: "image/png" });
  await page.getByRole("button", { name: "Create account", exact: true }).click();
  await expect(page).toHaveURL(/\/agents\/setup$/);
  await expect(page.getByRole("heading", { name: "Where should your agent run?", exact: true })).toBeVisible();
  const me = await page.request.get("/api/v1/me");
  expect(me.status()).toBe(200);
  await expect(me.json()).resolves.toMatchObject({ user: { email, displayName: "Login E2E" } });
});

test("mobile visitors can switch language and reveal a password with the keyboard", async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/login");
  const language = page.getByRole("combobox", { name: "Language", exact: true });
  await language.focus();
  await language.press("Space");
  const chinese = page.getByRole("option", { name: "中文", exact: true });
  await expect(chinese).toBeVisible();
  await chinese.focus();
  await chinese.press("Enter");
  await expect(page.getByRole("heading", { name: "登录 OpenTag", exact: true })).toBeVisible();
  await expect(page.locator("main")).toHaveAttribute("lang", "zh");
  await expect(page.getByRole("combobox", { name: "语言", exact: true })).toContainText("中文");
  const password = page.getByLabel("密码", { exact: true });
  await password.fill("password-visibility-e2e");
  await page.getByRole("button", { name: "显示密码", exact: true }).press("Space");
  await expect(password).toHaveAttribute("type", "text");
  await expect(password).toHaveAttribute("autocapitalize", "none");
  await expect(password).toHaveAttribute("spellcheck", "false");
  await page.getByRole("button", { name: "隐藏密码", exact: true }).press("Space");
  await expect(password).toHaveAttribute("type", "password");
  await expect(password).toHaveValue("password-visibility-e2e");
  await expectNoPageOverflow(page);
  await expectAccessible(page);
  await testInfo.attach("login-chinese-mobile", { body: await page.screenshot(), contentType: "image/png" });
});

test("a failed provider request can retry against the real server", async ({ page }) => {
  await page.route(
    "**/api/v1/auth/providers",
    async (route) => {
      await route.fulfill({
        status: 503,
        json: { error: { code: "INTERNAL_ERROR", category: "internal", message: "Unavailable" } },
      });
    },
    { times: 1 },
  );
  await page.goto("/login");
  await expect(page.getByRole("alert")).toContainText("Unable to load sign-in methods");
  await expect(page.getByLabel("Email", { exact: true })).toHaveCount(0);
  await page.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(page.getByLabel("Email", { exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Continue with Developer sign-in", exact: true })).toBeVisible();
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expectAccessible(page);
});

test("Google-only sign-in uses a loaded brand mark and localized text on a narrow screen", async ({
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 320, height: 720 });
  await page.route("**/api/v1/auth/providers", (route) =>
    route.fulfill({
      json: {
        providers: [
          { id: "google", enabled: true, startUrl: "/api/v1/auth/google/start" },
          { id: "password", enabled: false, startUrl: null },
        ],
      },
    }),
  );
  await page.goto("/login?next=%2Fagents%2Fsetup");
  const google = page.getByRole("link", { name: "Sign in with Google", exact: true });
  await expect(google).toHaveText("Sign in with Google");
  await expect(google).toHaveAttribute("href", /\/api\/v1\/auth\/google\/start\?next=%2Fagents%2Fsetup$/);
  await expect(google.locator("img")).toHaveJSProperty("complete", true);
  expect(await google.locator("img").evaluate((image: HTMLImageElement) => image.naturalWidth)).toBeGreaterThan(0);
  await expect(google).toHaveCSS("height", "44px");
  await expect(page.getByLabel("Email", { exact: true })).toHaveCount(0);
  await page.getByRole("combobox", { name: "Language", exact: true }).click();
  await page.getByRole("option", { name: "中文", exact: true }).click();
  await expect(page.getByRole("link", { name: "使用 Google 登录", exact: true })).toHaveText("使用 Google 登录");
  await expectNoPageOverflow(page);
  await expectAccessible(page);
  await testInfo.attach("login-google-only-mobile", { body: await page.screenshot(), contentType: "image/png" });
});
