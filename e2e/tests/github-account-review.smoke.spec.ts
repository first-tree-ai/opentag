import { baseURL } from "../playwright.config.js";
import { expectAccessible, expectNoPageOverflow } from "./browser-contract.js";
import { expect, smokeTest as test } from "./fixtures.js";
import { createAgent } from "./mcp-browser-fixture.js";

for (const locale of ["en", "zh"] as const) {
  test(`Account retires independent GitHub authorization in ${locale}`, async ({ page }) => {
    const requests: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/integrations/github")) requests.push(request.url());
    });
    await page.addInitScript((value) => localStorage.setItem("PARAGLIDE_LOCALE", value), locale);
    await page.goto("/account", { waitUntil: "networkidle" });
    await expect(page.getByRole("heading", { level: 1, name: locale === "en" ? "Account" : "账户" })).toBeVisible();
    await expect(page.locator('[data-ui="account-github"]')).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Authorize GitHub|GitHub 账户授权/ })).toHaveCount(0);
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      await expectNoPageOverflow(page);
      if (width === 320 || width === 1440)
        await page.screenshot({ path: test.info().outputPath(`account-${locale}-${width}.png`), fullPage: true });
    }
    await expectAccessible(page);
    expect(requests).toEqual([]);
    for (const suffix of ["", "/authorization", "/oauth/callback?code=unused&state=unused"]) {
      const response = await page.request.get(`${baseURL}/api/v2/integrations/github${suffix}`);
      expect(response.status()).toBe(410);
    }
  });
}

test("Memory remains reachable without GitHub authorization", async ({ page }) => {
  const agentId = await createAgent(page, "Memory without GitHub");
  await page.goto(`/agents/${agentId}/context-tree`);
  await expect(page.getByRole("heading", { level: 1, name: "Memory" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Memory", exact: true })).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("button", { name: "Connect an existing tree", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "create a new one", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /Authorize GitHub/ })).toHaveCount(0);
  await expectAccessible(page);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expectNoPageOverflow(page);
  await page.screenshot({ path: test.info().outputPath("memory-without-github.png"), fullPage: true });
});
