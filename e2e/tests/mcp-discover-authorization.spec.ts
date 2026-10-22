import type { Locator, Page } from "@playwright/test";
import { expectAccessible, expectNoPageOverflow } from "./browser-contract.js";
import { expect, smokeTest as test } from "./fixtures.js";
import { createAgent, mcpFixture } from "./mcp-browser-fixture.js";

async function chooseDiscoverCategory(page: Page, dialog: Locator, category: string) {
  const categorySelect = dialog.getByRole("combobox", { name: "Categories", exact: true });
  if (await categorySelect.isVisible()) {
    await categorySelect.click();
    await page.getByRole("option", { name: category, exact: true }).click();
  } else {
    const directChoice = dialog
      .getByRole("button", { name: category, exact: true })
      .and(dialog.locator("[aria-pressed]"));
    if (await directChoice.isVisible()) {
      await directChoice.click();
    } else {
      await dialog.locator('[data-ui="overflow-filter"] button[aria-haspopup="menu"]').click();
      await page.getByRole("menuitemradio", { name: category, exact: true }).click();
      await expect(page.getByRole("menu")).toHaveCount(0);
    }
  }
}

async function openDiscover(page: Page, agentId: string, category = "Data & Analytics") {
  await page.goto(`/agents/${agentId}/mcp`);
  await page.getByRole("button", { name: "Discover", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Discover", exact: true });
  await expect(dialog.getByLabel("Search connectors")).toBeVisible();
  await expect(dialog.locator('[data-ui="dialog-heading"]')).toBeFocused();
  await chooseDiscoverCategory(page, dialog, category);
  return { dialog, card: dialog.getByRole("listitem").filter({ has: page.getByText("Airtable", { exact: true }) }) };
}

async function consentFixture(page: Page) {
  await page.context().route("**/mcp-consent-fixture?*", async (route) => {
    const target = new URL(route.request().url()).searchParams.get("return");
    if (!target) throw new Error("Missing consent return");
    await route.fulfill({
      contentType: "text/html",
      body: `<html lang="en"><title>Airtable authorization fixture</title><a href="${target}">Finish authorization</a></html>`,
    });
  });
}

async function expectHeight(card: Locator, height: number) {
  await expect.poll(async () => (await card.boundingBox())?.height).toBe(height);
}

for (const width of [1440, 736]) {
  test(`Discover authorization stays in its card and preserves geometry at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    const agentId = await createAgent(page, "Discover authorization");
    const fixture = await mcpFixture(page);
    fixture.allowOAuth();
    fixture.holdProbe();
    await consentFixture(page);
    const { dialog, card } = await openDiscover(page, agentId);
    const originalDescription = await card.locator(".mcp-catalog-card-description").innerText();
    const height = (await card.boundingBox())?.height;
    if (!height) throw new Error("Missing card geometry");
    const opened: string[] = [];
    await page.exposeFunction("recordAuthorizationOpen", (features: string | undefined) => opened.push(features ?? ""));
    await page.evaluate(() => {
      const original = window.open;
      window.open = (...args) => {
        void (
          window as unknown as { recordAuthorizationOpen: (features?: string) => Promise<void> }
        ).recordAuthorizationOpen(args[2]);
        return original.apply(window, args);
      };
    });
    const tabPromise = page.waitForEvent("popup");
    await card.getByRole("button", { name: "Add: Airtable", exact: true }).click();
    const tab = await tabPromise;
    await expect(tab.getByRole("link", { name: "Finish authorization" })).toBeVisible();
    await expect(card.getByRole("status")).toHaveText("Authorizing…");
    await expect(card.getByRole("button", { name: "Cancel: Airtable", exact: true })).toBeEnabled();
    await expect(dialog).toBeVisible();
    await expectHeight(card, height);
    expect(opened).toEqual([""]);
    await expectAccessible(page);
    await page.screenshot({ path: test.info().outputPath(`discover-waiting-${width}.png`) });
    fixture.completeOAuth(agentId);
    await tab.getByRole("link", { name: "Finish authorization" }).click();
    await expect(card.getByRole("status")).toHaveText("Loading tools…");
    await expect(card.getByRole("button", { name: /Cancel/ })).toHaveCount(0);
    await expectHeight(card, height);
    fixture.releaseProbe();
    await expect(card.getByRole("img", { name: "Added", exact: true })).toBeVisible();
    await expect(card.locator(".mcp-catalog-card-description")).toHaveText(originalDescription);
    await expectHeight(card, height);
    await expect(dialog.locator('button[aria-pressed="true"], button[data-selected="true"]')).toHaveText(
      "Data & Analytics",
    );
    await expectNoPageOverflow(page);
    await dialog.getByRole("button", { name: "Close Discover", exact: true }).click();
    await page.getByRole("button", { name: "Airtable", exact: true }).click();
    const details = page.getByRole("dialog", { name: "Airtable", exact: true });
    await expect(details.getByRole("region", { name: "Connector address" })).toContainText("https://");
    await expect(details.getByRole("textbox", { name: "Connector address" })).toHaveCount(0);
    await expect(details.getByRole("button", { name: "Tools", exact: true })).toHaveCount(0);
    await expect(details.getByRole("button", { name: "Advanced settings", exact: true })).toHaveCount(0);
    const writeCount = fixture.writes.length;
    await details.getByRole("combobox", { name: "Authentication", exact: true }).click();
    await page.getByRole("option", { name: "API key or token", exact: true }).click();
    await expect(details.getByLabel("API key or token")).toBeVisible();
    await details.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(fixture.writes).toHaveLength(writeCount);
    await expectAccessible(page);
    await page.screenshot({ path: test.info().outputPath(`preset-details-${width}.png`) });
  });
}

test("Discover cancel restores the original card and removes only its provisional binding", async ({ page }) => {
  const agentId = await createAgent(page, "Discover cancel");
  const fixture = await mcpFixture(page);
  await consentFixture(page);
  const { card, dialog } = await openDiscover(page, agentId);
  await dialog.getByLabel("Search connectors").fill("Airtable");
  const tabPromise = page.waitForEvent("popup");
  await card.getByRole("button", { name: "Add: Airtable", exact: true }).click();
  const tab = await tabPromise;
  await expect(card.getByRole("status")).toHaveText("Authorizing…");
  await card.getByRole("button", { name: "Cancel: Airtable", exact: true }).click();
  await expect(card.getByRole("button", { name: "Add: Airtable", exact: true })).toBeEnabled();
  await expect(card.getByRole("alert")).toHaveCount(0);
  await expect(dialog.getByLabel("Search connectors")).toHaveValue("Airtable");
  expect(fixture.mounts.get(agentId)).toHaveLength(0);
  await tab.close();
});

test("mobile keeps a long connector card's height stable while preparing authorization", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 900 });
  const agentId = await createAgent(page, "Discover mobile");
  const fixture = await mcpFixture(page);
  fixture.holdOAuth();
  const { dialog } = await openDiscover(page, agentId, "Communication");
  const card = dialog.getByRole("listitem").filter({ has: page.getByText("Google Calendar", { exact: true }) });
  await card.scrollIntoViewIfNeeded();
  const height = (await card.boundingBox())?.height;
  if (!height) throw new Error("Missing mobile card geometry");
  await card.getByRole("button", { name: "Add: Google Calendar", exact: true }).click();
  await expect(card.getByRole("button", { name: "Cancel: Google Calendar", exact: true })).toBeEnabled();
  await expectHeight(card, height);
  await expect(dialog.getByLabel("Search connectors")).toBeDisabled();
  await expect(dialog.getByRole("button", { name: "Add: Gmail", exact: true })).toBeDisabled();
  await expectNoPageOverflow(page);
  await card.scrollIntoViewIfNeeded();
  await page.screenshot({ path: test.info().outputPath("discover-mobile-320-preparing.png") });
  await card.getByRole("button", { name: "Cancel: Google Calendar", exact: true }).click();
  fixture.releaseOAuth();
  await expect(card.getByRole("button", { name: "Add: Google Calendar", exact: true })).toBeEnabled();
  await expectHeight(card, height);
});

test("Discover failure offers Authorize in the original action area and reuses the definition", async ({ page }) => {
  const agentId = await createAgent(page, "Discover retry");
  const fixture = await mcpFixture(page);
  fixture.failOAuth();
  const { card, dialog } = await openDiscover(page, agentId);
  const height = (await card.boundingBox())?.height;
  if (!height) throw new Error("Missing card geometry");
  await card.getByRole("button", { name: "Add: Airtable", exact: true }).click();
  await expect(card.getByRole("alert")).toHaveText("Authorization failed");
  await expect(card.getByRole("button", { name: "Authorize: Airtable", exact: true })).toBeEnabled();
  await expect(dialog).not.toContainText("Private upstream detail");
  await expectHeight(card, height);
  fixture.allowOAuth();
  await consentFixture(page);
  const tabPromise = page.waitForEvent("popup");
  await card.getByRole("button", { name: "Authorize: Airtable", exact: true }).click();
  const tab = await tabPromise;
  await expect(card.getByRole("status")).toHaveText("Authorizing…");
  expect(fixture.servers).toHaveLength(1);
  await card.getByRole("button", { name: "Cancel: Airtable", exact: true }).click();
  await expect(card.getByRole("button", { name: "Add: Airtable", exact: true })).toBeEnabled();
  await tab.close();
});

test("blocked authorization opens a normal tab from its card and preserves Discover", async ({ page }) => {
  const agentId = await createAgent(page, "Discover blocked");
  const fixture = await mcpFixture(page);
  fixture.allowOAuth();
  await consentFixture(page);
  const { card, dialog } = await openDiscover(page, agentId);
  await page.evaluate(() => {
    const original = window.open;
    let first = true;
    window.open = (...args) => {
      if (first) {
        first = false;
        return null;
      }
      return original.apply(window, args);
    };
  });
  await card.getByRole("button", { name: "Add: Airtable", exact: true }).click();
  await expect(card.getByRole("status")).toHaveText("Authorization page did not open");
  const tabPromise = page.waitForEvent("popup");
  await card.getByRole("button", { name: "Open window", exact: true }).click();
  const tab = await tabPromise;
  await expect(tab.getByRole("link", { name: "Finish authorization" })).toBeVisible();
  await expect(dialog).toBeVisible();
  await expect(card.getByRole("status")).toHaveText("Authorizing…");
  fixture.completeOAuth(agentId);
  await tab.getByRole("link", { name: "Finish authorization" }).click();
  await expect(card.getByRole("img", { name: "Added", exact: true })).toBeVisible();
});

for (const finishFirst of ["cancel", "success"] as const) {
  test(`Discover isolates concurrent authorization and filtering (${finishFirst})`, async ({ page }) => {
    const agentId = await createAgent(page, "Parallel Discover");
    const fixture = await mcpFixture(page);
    fixture.allowOAuth();
    fixture.holdProbe();
    await consentFixture(page);
    const { dialog, card: airtable } = await openDiscover(page, agentId);
    const search = dialog.getByLabel("Search connectors");
    const firstPopup = page.waitForEvent("popup");
    await airtable.getByRole("button", { name: "Add: Airtable", exact: true }).click();
    const first = await firstPopup;
    await expect(airtable.getByRole("status")).toHaveText("Authorizing…");
    await search.fill("Google Calendar");
    const calendar = dialog.getByRole("listitem").filter({ has: page.getByText("Google Calendar", { exact: true }) });
    const secondPopup = page.waitForEvent("popup");
    await calendar.getByRole("button", { name: "Add: Google Calendar", exact: true }).click();
    const second = await secondPopup;
    await expect(calendar.getByRole("status")).toHaveText("Authorizing…");
    const calendarId = fixture.servers.find((server) => server.name === "google-calendar")?.id;
    if (!calendarId) throw new Error("Missing calendar definition");
    fixture.completeOAuth(agentId, calendarId);
    await second.getByRole("link", { name: "Finish authorization" }).click();
    await expect(calendar.getByRole("status")).toHaveText("Loading tools…");
    await search.fill("Airtable");
    await expect(airtable.getByRole("status")).toHaveText("Authorizing…");
    if (finishFirst === "cancel") {
      await airtable.getByRole("button", { name: "Cancel: Airtable", exact: true }).click();
      await expect(airtable.getByRole("button", { name: "Add: Airtable", exact: true })).toBeEnabled();
      expect(fixture.mounts.get(agentId)?.map((entry) => entry.mcpServerId)).toEqual([calendarId]);
    } else {
      const airtableId = fixture.servers.find((server) => server.id !== calendarId)?.id;
      if (!airtableId) throw new Error("Missing Airtable definition");
      fixture.completeOAuth(agentId, airtableId);
      await first.getByRole("link", { name: "Finish authorization" }).click();
      await expect(airtable.getByRole("status")).toHaveText("Loading tools…");
    }
    fixture.releaseProbe();
    await search.fill("Google Calendar");
    await expect(calendar.getByRole("img", { name: "Added", exact: true })).toBeVisible();
    await chooseDiscoverCategory(page, dialog, "Data & Analytics");
    if (finishFirst === "success")
      await expect(airtable.getByRole("img", { name: "Added", exact: true })).toBeVisible();
    else await expect(airtable.getByRole("button", { name: "Add: Airtable", exact: true })).toBeEnabled();
    await expectAccessible(page);
    await expectNoPageOverflow(page);
  });
}
