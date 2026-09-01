import { expect, test } from "./fixtures.js";

test("browser negotiation renders the supported locale without persisting an implicit preference", async ({
  browser,
}) => {
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
    await expect(page.getByRole("heading", { name: "欢迎回来", exact: true })).toBeVisible();
    await expect(page.getByText("登录后继续使用 OpenTag。", { exact: true })).toBeVisible();
    // Document metadata remains on the base locale until the ongoing visible-copy migration is complete.
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
