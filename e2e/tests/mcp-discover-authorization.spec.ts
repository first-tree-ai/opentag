import type { Locator, Page } from "@playwright/test";
import { expectAccessible, expectNoPageOverflow } from "./browser-contract.js";
import { expect, smokeTest as test } from "./fixtures.js";
import { createAgent, mcpFixture } from "./mcp-browser-fixture.js";

async function openDiscover(page: Page, agentId: string, category = "Data & Analytics") {
  await page.goto(`/agents/${agentId}/mcp`);
  await page.getByRole("button", { name: "Discover", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Discover", exact: true });
  await expect(dialog.getByLabel("Search connectors")).toBeVisible();
  await expect(dialog.locator('[data-ui="dialog-heading"]')).toBeFocused();
  const categorySelect = dialog.getByRole("combobox", { name: "Categories", exact: true });
  if (await categorySelect.isVisible()) {
    await categorySelect.click();
    await page.getByRole("option", { name: category, exact: true }).click();
  } else {
    await dialog.getByRole("button", { name: category, exact: true }).click();
  }
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
    await expect(card.getByRole("status")).toHaveText("Waiting for authorization…");
    await expect(card.getByRole("button", { name: "Cancel: Airtable", exact: true })).toBeEnabled();
    await expect(dialog).toBeVisible();
    await expectHeight(card, height);
    expect(opened).toEqual([""]);
    await expectAccessible(page);
    await page.screenshot({ path: test.info().outputPath(`discover-waiting-${width}.png`) });
    fixture.completeOAuth(agentId);
    await tab.getByRole("link", { name: "Finish authorization" }).click();
    await expect(card.getByRole("status")).toHaveText("Checking connection…");
    await expect(card.getByRole("button", { name: /Cancel/ })).toHaveCount(0);
    await expectHeight(card, height);
    fixture.releaseProbe();
    await expect(card).toContainText("Connected");
    await expect(card.locator(".mcp-catalog-card-description")).toHaveText(originalDescription);
    await expectHeight(card, height);
    await expect(dialog.getByRole("button", { name: "Data & Analytics", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expectNoPageOverflow(page);
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
  await expect(card.getByRole("status")).toHaveText("Waiting for authorization…");
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

test("Discover failure offers Reconnect in the original action area and reuses the definition", async ({ page }) => {
  const agentId = await createAgent(page, "Discover retry");
  const fixture = await mcpFixture(page);
  fixture.failOAuth();
  const { card, dialog } = await openDiscover(page, agentId);
  const height = (await card.boundingBox())?.height;
  if (!height) throw new Error("Missing card geometry");
  await card.getByRole("button", { name: "Add: Airtable", exact: true }).click();
  await expect(card.getByRole("alert")).toHaveText("Connection failed");
  await expect(card.getByRole("button", { name: "Reconnect: Airtable", exact: true })).toBeEnabled();
  await expect(dialog).not.toContainText("Private upstream detail");
  await expectHeight(card, height);
  fixture.allowOAuth();
  await consentFixture(page);
  const tabPromise = page.waitForEvent("popup");
  await card.getByRole("button", { name: "Reconnect: Airtable", exact: true }).click();
  const tab = await tabPromise;
  await expect(card.getByRole("status")).toHaveText("Waiting for authorization…");
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
  await card.getByRole("button", { name: "Open authorization page", exact: true }).click();
  const tab = await tabPromise;
  await expect(tab.getByRole("link", { name: "Finish authorization" })).toBeVisible();
  await expect(dialog).toBeVisible();
  await expect(card.getByRole("status")).toHaveText("Waiting for authorization…");
  fixture.completeOAuth(agentId);
  await tab.getByRole("link", { name: "Finish authorization" }).click();
  await expect(card).toContainText("Connected");
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
    await expect(airtable.getByRole("status")).toHaveText("Waiting for authorization…");
    await search.fill("Google Calendar");
    const calendar = dialog.getByRole("listitem").filter({ has: page.getByText("Google Calendar", { exact: true }) });
    const secondPopup = page.waitForEvent("popup");
    await calendar.getByRole("button", { name: "Add: Google Calendar", exact: true }).click();
    const second = await secondPopup;
    await expect(calendar.getByRole("status")).toHaveText("Waiting for authorization…");
    const calendarId = fixture.servers.find((server) => server.name === "google-calendar")?.id;
    if (!calendarId) throw new Error("Missing calendar definition");
    fixture.completeOAuth(agentId, calendarId);
    await second.getByRole("link", { name: "Finish authorization" }).click();
    await expect(calendar.getByRole("status")).toHaveText("Checking connection…");
    await search.fill("Airtable");
    await expect(airtable.getByRole("status")).toHaveText("Waiting for authorization…");
    if (finishFirst === "cancel") {
      await airtable.getByRole("button", { name: "Cancel: Airtable", exact: true }).click();
      await expect(airtable.getByRole("button", { name: "Add: Airtable", exact: true })).toBeEnabled();
      expect(fixture.mounts.get(agentId)?.map((entry) => entry.mcpServerId)).toEqual([calendarId]);
    } else {
      const airtableId = fixture.servers.find((server) => server.id !== calendarId)?.id;
      if (!airtableId) throw new Error("Missing Airtable definition");
      fixture.completeOAuth(agentId, airtableId);
      await first.getByRole("link", { name: "Finish authorization" }).click();
      await expect(airtable.getByRole("status")).toHaveText("Checking connection…");
    }
    fixture.releaseProbe();
    await search.fill("Google Calendar");
    await expect(calendar).toContainText("Connected");
    await dialog.getByRole("button", { name: "Data & Analytics", exact: true }).click();
    if (finishFirst === "success") await expect(airtable).toContainText("Connected");
    else await expect(airtable.getByRole("button", { name: "Add: Airtable", exact: true })).toBeEnabled();
    await expectAccessible(page);
    await expectNoPageOverflow(page);
  });
}
