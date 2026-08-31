import { expect, test } from "./fixtures.js";

test("browser negotiation does not label untranslated copy or persist an implicit preference", async ({ browser }) => {
  const context = await browser.newContext({
    storageState: { cookies: [], origins: [] },
    viewport: { width: 1440, height: 900 },
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "languages", {
      configurable: true,
      get: () => ["zh-CN", "en-US"],
    });
    Object.defineProperty(navigator, "language", {
      configurable: true,
      get: () => "zh-CN",
    });

    const localeWrites: string[] = [];
    Object.defineProperty(window, "__opentagLocaleWrites", { configurable: true, value: localeWrites });
    const originalSetItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function setItem(key, value) {
      if (key === "PARAGLIDE_LOCALE") localeWrites.push(value);
      return originalSetItem.call(this, key, value);
    };
  });

  try {
    const page = await context.newPage();
    await page.goto("/login", { waitUntil: "networkidle" });
    await expect(page.getByRole("heading", { name: "Welcome back", exact: true })).toBeVisible();
    await expect(page.getByText("Sign in to continue to OpenTag.", { exact: true })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
    await expect(page.locator("html")).toHaveAttribute("dir", "ltr");

    const localeState = await page.evaluate(() => ({
      stored: localStorage.getItem("PARAGLIDE_LOCALE"),
      writes: (window as typeof window & { __opentagLocaleWrites?: string[] }).__opentagLocaleWrites ?? [],
    }));
    expect(localeState).toEqual({ stored: null, writes: [] });
  } finally {
    await context.close();
  }
});
