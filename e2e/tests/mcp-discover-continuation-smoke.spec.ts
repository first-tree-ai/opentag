import type { Page } from "@playwright/test";
import { expectAccessible, expectNoPageOverflow } from "./browser-contract.js";
import { expect, smokeTest as test } from "./fixtures.js";
import { binding, createAgent, mcpFixture, server } from "./mcp-browser-fixture.js";

async function openFirecrawl(page: Page, agentId: string) {
  await page.goto(`/agents/${agentId}/mcp`);
  await page.getByRole("button", { name: "Discover", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Discover", exact: true });
  await dialog.getByLabel("Search connectors").fill("Firecrawl");
  const card = dialog.getByRole("listitem").filter({ has: page.getByText("Firecrawl", { exact: true }) });
  return { dialog, card };
}

async function consentFixture(page: Page) {
  await page.context().route("**/mcp-consent-fixture?*", async (route) => {
    const target = new URL(route.request().url()).searchParams.get("return");
    if (!target) throw new Error("Missing authorization return URL");
    await route.fulfill({
      contentType: "text/html",
      body: `<html lang="en"><title>Authorization fixture</title><a href="${target}">Finish authorization</a></html>`,
    });
  });
}

for (const outcome of ["success", "cancel"] as const) {
  test(`Discover can close during OAuth and the list can ${outcome} the same attempt`, async ({ page }) => {
    const agentId = await createAgent(page, "Discover continuation");
    const fixture = await mcpFixture(page);
    fixture.allowOAuth();
    fixture.holdProbe();
    await consentFixture(page);
    const { dialog, card } = await openFirecrawl(page, agentId);
    const popup = page.waitForEvent("popup");
    await card.getByRole("button", { name: "Add: Firecrawl", exact: true }).click();
    const consent = await popup;
    await expect(consent.getByRole("link", { name: "Finish authorization" })).toBeVisible();
    await expect(card.getByRole("status")).toHaveText("Authorizing…");
    const close = dialog.getByRole("button", { name: "Close Discover", exact: true });
    await expect(close).toBeEnabled();
    await close.click();
    await expect(dialog).toBeHidden();
    expect(consent.isClosed()).toBe(false);
    const row = page
      .locator('[data-ui="mcp-server-row"]')
      .filter({ has: page.getByRole("button", { name: "Firecrawl", exact: true }) });
    await expect(row.getByText("Authorizing…", { exact: true })).toBeVisible();
    await expect(row.getByRole("button", { name: "Cancel", exact: true })).toBeEnabled();
    await expect(row.getByRole("button", { name: /^(Authorize|Reauthorize)$/ })).toHaveCount(0);
    await expect(row.getByRole("switch")).toBeDisabled();
    await expect(row.getByRole("button", { name: "More actions for Firecrawl", exact: true })).toBeDisabled();
    if (outcome === "cancel") {
      await row.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(row).toBeHidden();
      await page.getByRole("button", { name: "Discover", exact: true }).click();
      await expect(card.getByRole("button", { name: "Add: Firecrawl", exact: true })).toBeEnabled();
      expect(fixture.mounts.get(agentId)).toHaveLength(0);
    } else {
      fixture.completeOAuth(agentId);
      await consent.getByRole("link", { name: "Finish authorization" }).click();
      await expect(row.getByText("Loading tools…", { exact: true })).toBeVisible();
      await expect(row.getByRole("button", { name: "Cancel", exact: true })).toHaveCount(0);
      fixture.releaseProbe();
      await expect(row.getByText("Loading tools…", { exact: true })).toHaveCount(0);
      await expect(row.getByRole("switch")).toBeEnabled();
      await expect(dialog).toBeHidden();
      expect(fixture.writes.filter((write) => write.path.endsWith("/authorization/oauth"))).toHaveLength(1);
    }
    await expectAccessible(page);
    await expectNoPageOverflow(page);
  });
}

for (const width of [1440, 320]) {
  test(`Discover close remains enabled during OAuth preparation and preserves failure at ${width}px`, async ({
    page,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const agentId = await createAgent(page, "Discover close during preparation");
    const fixture = await mcpFixture(page);
    fixture.holdOAuth();
    fixture.failOAuth();
    const { dialog, card } = await openFirecrawl(page, agentId);
    await card.getByRole("button", { name: "Add: Firecrawl", exact: true }).click();
    await expect(card.getByRole("status")).toHaveText("Authorizing…");
    const close = dialog.getByRole("button", { name: "Close Discover", exact: true });
    await expect(close).toBeEnabled();
    await close.click();
    await expect(dialog).toBeHidden();
    fixture.releaseOAuth();
    const row = page
      .locator('[data-ui="mcp-server-row"]')
      .filter({ has: page.getByRole("button", { name: "Firecrawl", exact: true }) });
    await expect(row.getByText("Authorization failed", { exact: true })).toBeVisible();
    await expect(row.getByRole("button", { name: "Authorize", exact: true })).toBeEnabled();
    await expect(row.getByRole("button", { name: "Cancel", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Discover", exact: true }).click();
    await expect(card.getByRole("alert")).toHaveText("Authorization failed");
    await expectNoPageOverflow(page);
  });
}

test("successful authorization from Details clears an earlier Discover failure", async ({ page }) => {
  const agentId = await createAgent(page, "Discover failure recovery in Details");
  const fixture = await mcpFixture(page);
  fixture.failOAuth();
  const { dialog, card } = await openFirecrawl(page, agentId);
  await card.getByRole("button", { name: "Add: Firecrawl", exact: true }).click();
  await expect(card.getByRole("alert")).toHaveText("Authorization failed");
  await dialog.getByRole("button", { name: "Close Discover", exact: true }).click();
  const row = page.locator('[data-ui="mcp-server-row"]');
  await expect(row.getByText("Authorization failed", { exact: true })).toBeVisible();
  await row.getByRole("button", { name: "Firecrawl", exact: true }).click();
  const details = page.getByRole("dialog", { name: "Firecrawl", exact: true });
  fixture.allowOAuth();
  await consentFixture(page);
  const popup = page.waitForEvent("popup");
  await details.getByRole("button", { name: "Authorize", exact: true }).click();
  const consent = await popup;
  await expect(consent.getByRole("link", { name: "Finish authorization" })).toBeVisible();
  fixture.completeOAuth(agentId);
  const authorization = fixture.mounts.get(agentId)?.[0]?.authorization;
  if (!authorization) throw new Error("Missing completed OAuth authorization");
  Object.assign(authorization, { probeState: "succeeded", toolsCount: 1 });
  await consent.getByRole("link", { name: "Finish authorization" }).click();
  await expect(details.getByRole("button", { name: "Reauthorize", exact: true })).toBeVisible();
  await details.getByRole("button", { name: "Close Firecrawl", exact: true }).click();
  await expect(row.getByText("Authorization failed", { exact: true })).toHaveCount(0);
  await expect(row.getByRole("button", { name: /^(Authorize|Reauthorize|Retry)$/ })).toHaveCount(0);
  await expect(row.getByRole("switch")).toBeEnabled();
});

for (const source of ["list", "discover"] as const) {
  test(`${source} retries an OAuth tool failure without opening another window`, async ({ page }) => {
    const agentId = await createAgent(page, "OAuth tool recovery");
    const definition = { ...server("firecrawl", "oauth"), url: "https://mcp.firecrawl.dev/v2/mcp-oauth" };
    const fixture = await mcpFixture(page, [definition]);
    fixture.mounts.set(agentId, [binding(definition)]);
    fixture.completeOAuth(agentId);
    const auth = fixture.mounts.get(agentId)?.[0]?.authorization;
    if (!auth) throw new Error("Missing OAuth authorization fixture");
    Object.assign(auth, { probeState: "failed", probeError: "Fixture unavailable" });
    fixture.holdProbe();
    const opened: Page[] = [];
    page.on("popup", (popup) => opened.push(popup));
    await page.goto(`/agents/${agentId}/mcp`);
    if (source === "discover") {
      await page.getByRole("button", { name: "Discover", exact: true }).click();
      await page.getByLabel("Search connectors").fill("Firecrawl");
    }
    const surface =
      source === "list"
        ? page.locator('[data-ui="mcp-server-list"]')
        : page.getByRole("dialog", { name: "Discover", exact: true });
    await page.getByRole("button", { name: source === "list" ? "Retry" : "Retry: Firecrawl", exact: true }).click();
    await expect(surface.getByText("Loading tools…", { exact: true })).toBeVisible();
    fixture.releaseProbe();
    await expect(surface.getByText("Loading tools…", { exact: true })).toHaveCount(0);
    expect(fixture.writes.filter((write) => write.path.endsWith("/authorization/oauth"))).toHaveLength(0);
    expect(opened).toHaveLength(0);
    expect(auth.hasCredential).toBe(true);
    await expectAccessible(page);
  });
}
