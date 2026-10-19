import type { Page } from "@playwright/test";
import { expectAccessible, expectNoPageOverflow } from "./browser-contract.js";
import { expect, smokeTest as test } from "./fixtures.js";
import { binding, chooseAuthentication, createAgent, mcpFixture, server } from "./mcp-browser-fixture.js";

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

test("custom OAuth retries a failed tool probe without replacing the completed authorization", async ({ page }) => {
  const agentId = await createAgent(page, "OAuth recovery review");
  const fixture = await mcpFixture(page);
  fixture.allowOAuth();
  fixture.failProbe(true);
  await consentFixture(page);
  await page.goto(`/agents/${agentId}/mcp`);
  await page.getByRole("button", { name: "Add custom", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add custom connector", exact: true });
  await dialog.getByLabel("Connector address").fill("https://docs.example.com/mcp");
  const opened: Page[] = [];
  page.on("popup", (popup) => opened.push(popup));
  const popup = page.waitForEvent("popup");
  await dialog.getByRole("button", { name: "Connect", exact: true }).click();
  const consent = await popup;
  await expect(consent.getByRole("link", { name: "Finish authorization" })).toBeVisible();
  fixture.completeOAuth(agentId);
  await consent.getByRole("link", { name: "Finish authorization" }).click();
  await expect(dialog.getByRole("alert")).toHaveText("Couldn't load tools");
  const oauthPath = `/api/v1/agents/${agentId}/mcp-servers/${fixture.servers[0]?.id}/authorization/oauth`;
  expect(fixture.writes.filter((write) => write.path === oauthPath)).toHaveLength(1);
  fixture.failProbe(false);
  await dialog.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(fixture.writes.filter((write) => write.path === oauthPath)).toHaveLength(1);
  expect(opened).toHaveLength(1);
  expect(fixture.mounts.get(agentId)?.[0]?.authorization?.hasCredential).toBe(true);
  await expectAccessible(page);
});

test("a failed key-to-OAuth switch remains a preset and reopens with the submitted method", async ({ page }) => {
  const agentId = await createAgent(page, "Preset method recovery");
  const definition = {
    ...server("exa", "bearer"),
    url: "https://mcp.exa.ai/mcp",
    authHeader: "x-api-key",
    authScheme: "",
  };
  const fixture = await mcpFixture(page, [definition]);
  const installed = binding(definition);
  fixture.mounts.set(agentId, [installed]);
  fixture.completeOAuth(agentId);
  if (!installed.authorization) throw new Error("Missing test authorization");
  Object.assign(installed.authorization, { kind: "bearer", probeState: "succeeded", toolsCount: 1 });
  fixture.failOAuth();
  await page.goto(`/agents/${agentId}/mcp`);
  await page.getByRole("button", { name: "Exa", exact: true }).click();
  const details = page.getByRole("dialog", { name: "Exa", exact: true });
  await chooseAuthentication(page, "Account sign-in");
  await details.getByRole("button", { name: "Authorize", exact: true }).click();
  await expect(details.getByRole("alert")).toHaveText("Authorization failed");
  await expect(details.getByRole("button", { name: "Advanced settings", exact: true })).toHaveCount(0);
  await expect(details.getByRole("radio")).toHaveCount(0);
  await expect(details.getByRole("textbox", { name: "Connector address" })).toHaveCount(0);
  await details.getByRole("button", { name: "Close Exa", exact: true }).click();
  await page.getByRole("button", { name: "Exa", exact: true }).click();
  await expect(details.getByText("Account sign-in", { exact: true })).toBeVisible();
  await expect(details.getByRole("combobox", { name: "Authentication", exact: true })).toHaveText("Account sign-in");
  expect(fixture.mounts.get(agentId)?.[0]?.authorization?.hasCredential).toBe(false);
  await expectAccessible(page);
});

for (const width of [1440, 320]) {
  test(`saving a key keeps its layout and freezes submitted inputs at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const agentId = await createAgent(page, "Credential submission review");
    const definition = { ...server("firecrawl", "bearer"), url: "https://mcp.firecrawl.dev/v2/mcp" };
    const fixture = await mcpFixture(page, [definition]);
    const installed = binding(definition);
    fixture.mounts.set(agentId, [installed]);
    fixture.completeOAuth(agentId);
    if (!installed.authorization) throw new Error("Missing test authorization");
    Object.assign(installed.authorization, { kind: "bearer", probeState: "succeeded", toolsCount: 1 });
    await page.goto(`/agents/${agentId}/mcp`);
    await page.getByRole("button", { name: "Firecrawl", exact: true }).click();
    const details = page.getByRole("dialog", { name: "Firecrawl", exact: true });
    const tracked = [
      details.getByRole("heading"),
      details.getByRole("combobox"),
      details.getByRole("region", { name: "Connector address" }),
    ];
    const anchors = await Promise.all(tracked.map((item) => item.boundingBox()));
    await details.getByRole("button", { name: "Update", exact: true }).click();
    const key = details.getByLabel("API key or token");
    await key.fill("replacement-review-key");
    expect(await Promise.all(tracked.map((item) => item.boundingBox()))).toEqual(anchors);
    fixture.holdAuthorization();
    try {
      await details.getByRole("button", { name: "Save", exact: true }).click();
      await expect(key).toBeDisabled();
      await expect(details.getByRole("button", { name: "Show key", exact: true })).toBeDisabled();
      await expect(details.getByRole("button", { name: "Cancel", exact: true })).toBeDisabled();
      expect(await Promise.all(tracked.map((item) => item.boundingBox()))).toEqual(anchors);
      await expectNoPageOverflow(page);
      await page.screenshot({ path: test.info().outputPath(`mcp-key-saving-${width}.png`) });
    } finally {
      fixture.releaseAuthorization();
    }
    await expect(details.getByRole("button", { name: "Update", exact: true })).toBeVisible();
    expect(await Promise.all(tracked.map((item) => item.boundingBox()))).toEqual(anchors);
    await expectAccessible(page);
    expect(fixture.writes.filter((write) => write.body.bearerKey === "replacement-review-key")).toHaveLength(1);
  });
}

test("an existing OAuth endpoint keeps preset Details and can save an alternate key method", async ({ page }) => {
  const agentId = await createAgent(page, "Existing preset compatibility");
  const definition = { ...server("exa", "oauth"), url: "https://mcp.exa.ai/mcp" };
  const fixture = await mcpFixture(page, [definition]);
  fixture.mounts.set(agentId, [binding(definition)]);
  fixture.completeOAuth(agentId);
  await page.goto(`/agents/${agentId}/mcp`);
  await page.getByRole("button", { name: "Exa", exact: true }).click();
  const details = page.getByRole("dialog", { name: "Exa", exact: true });
  await expect(details.getByRole("region", { name: "Connector address" })).toContainText(definition.url);
  await expect(details.getByRole("textbox", { name: "Connector address" })).toHaveCount(0);
  await expect(details.getByRole("button", { name: "Advanced settings", exact: true })).toHaveCount(0);
  await chooseAuthentication(page, "API key or token");
  await details.getByLabel("API key or token").fill("alternate-review-key");
  await details.getByRole("button", { name: "Save", exact: true }).click();
  await expect(details.getByRole("button", { name: "Update", exact: true })).toBeVisible();
  const installed = fixture.mounts.get(agentId)?.[0];
  expect(installed?.authorization?.kind).toBe("bearer");
  expect(installed?.effective.authHeader).toBe("x-api-key");
  expect(installed?.effective.authScheme).toBe("");
  await details.getByRole("button", { name: "Close Exa", exact: true }).click();
  await page.getByRole("button", { name: "Exa", exact: true }).click();
  await expect(details.getByRole("combobox", { name: "Authentication", exact: true })).toHaveText("API key or token");
  await expect(details.getByRole("combobox", { name: "Authentication", exact: true })).toHaveText("API key or token");
  await expectAccessible(page);
});

for (const width of [1440, 320]) {
  test(`preset failure stays with its action and deletion has one cancel entry at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 720 });
    const agentId = await createAgent(page, "MCP feedback review");
    const definition = { ...server("firecrawl", "oauth"), url: "https://mcp.firecrawl.dev/v2/mcp-oauth" };
    const fixture = await mcpFixture(page, [definition]);
    fixture.mounts.set(agentId, [binding(definition)]);
    fixture.failOAuth();
    await page.goto(`/agents/${agentId}/mcp`);
    await page.getByRole("button", { name: "Firecrawl", exact: true }).click();
    const details = page.getByRole("dialog", { name: "Firecrawl", exact: true });
    await details.getByRole("button", { name: "Authorize", exact: true }).click();
    const feedback = details.getByRole("alert");
    await expect(feedback).toHaveText("Authorization failed");
    const actionRow = details.locator(".mcp-preset-auth-row");
    await expect(actionRow.getByRole("button", { name: "Authorize", exact: true })).toBeVisible();
    await expect(details.locator(".mcp-preset-feedback").getByRole("alert")).toHaveText("Authorization failed");
    const buttonBox = await actionRow.getByRole("button").boundingBox();
    const errorBox = await feedback.boundingBox();
    if (!buttonBox || !errorBox) throw new Error("Missing feedback geometry");
    expect(errorBox.y).toBeGreaterThanOrEqual(buttonBox.y + buttonBox.height);
    await expect(details.getByRole("combobox", { name: "Authentication", exact: true })).toBeVisible();
    await expectAccessible(page);
    await expectNoPageOverflow(page);
    await page.screenshot({ path: test.info().outputPath(`mcp-auth-failure-${width}.png`) });
    await details.getByRole("button", { name: "Close Firecrawl", exact: true }).click();
    await page.getByRole("button", { name: "More actions for Firecrawl", exact: true }).click();
    await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
    const confirmation = page.getByRole("alertdialog", { name: "Delete Firecrawl?", exact: true });
    await expect(confirmation.getByRole("button")).toHaveCount(2);
    await expect(confirmation.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
    await expectAccessible(page);
    const writes = fixture.writes.length;
    await page.keyboard.press("Escape");
    await expect(confirmation).toBeHidden();
    expect(fixture.writes).toHaveLength(writes);
    await page.getByRole("button", { name: "More actions for Firecrawl", exact: true }).click();
    await page.getByRole("menuitem", { name: "Delete", exact: true }).click();
    await confirmation.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(confirmation).toBeHidden();
    await expect.poll(() => fixture.servers.length).toBe(0);
    await expect(page.getByRole("heading", { name: "No connectors yet" })).toBeVisible();
  });
}

for (const width of [1440, 768, 390, 320]) {
  test(`preset recovery stays beside its reason and keeps stable anchors at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 844 });
    const agentId = await createAgent(page, "Preset recovery layout");
    const definition = { ...server("firecrawl", "oauth"), url: "https://mcp.firecrawl.dev/v2/mcp-oauth" };
    const fixture = await mcpFixture(page, [definition]);
    const installed = binding(definition);
    fixture.mounts.set(agentId, [installed]);
    fixture.completeOAuth(agentId);
    if (!installed.authorization) throw new Error("Missing test authorization");
    Object.assign(installed.authorization, { probeState: "failed", probeError: "MCP_UPSTREAM_ERROR: fixture failure" });
    await page.goto(`/agents/${agentId}/mcp`);
    await page.getByRole("button", { name: "Firecrawl", exact: true }).click();
    const details = page.getByRole("dialog", { name: "Firecrawl", exact: true });
    const feedback = details.locator(".mcp-preset-feedback");
    const address = details.getByRole("region", { name: "Connector address" });
    const primary = details.locator(".mcp-preset-account-action");
    await expect(feedback.getByRole("alert")).toHaveText("Couldn't load tools");
    const anchors = await Promise.all(
      [details.getByRole("heading"), address, primary].map((item) => item.boundingBox()),
    );
    fixture.holdProbe();
    try {
      await feedback.getByRole("button", { name: "Retry", exact: true }).click();
      await expect(feedback.getByRole("status")).toHaveText("Loading tools…");
      expect(
        await Promise.all([details.getByRole("heading"), address, primary].map((item) => item.boundingBox())),
      ).toEqual(anchors);
    } finally {
      fixture.releaseProbe();
    }
    await expect(feedback.getByText("Loading tools…", { exact: true })).toHaveCount(0);
    await page.evaluate(() => {
      window.open = () => null;
    });
    // Mobile sign-in redirects. Resize a desktop popup attempt to check this state at narrow widths.
    if (width <= 640) await page.setViewportSize({ width: 768, height: 844 });
    await primary.click();
    const open = feedback.getByRole("button", { name: "Open window", exact: true });
    await expect(open).toBeVisible();
    if (width <= 640) await page.setViewportSize({ width, height: 844 });
    await expect(feedback.getByRole("status")).toHaveText("Authorization window blocked");
    const reasonBox = await feedback.getByRole("status").boundingBox();
    const actionBox = await open.boundingBox();
    if (!reasonBox || !actionBox) throw new Error("Missing recovery geometry");
    if (actionBox.y < reasonBox.y + reasonBox.height) {
      expect(actionBox.x - reasonBox.x - reasonBox.width).toBeCloseTo(12, 0);
    } else {
      expect(actionBox.x).toBeCloseTo(reasonBox.x, 0);
    }
    expect(await details.getByRole("heading").boundingBox()).toEqual(anchors[0]);
    expect(await address.boundingBox()).toEqual(anchors[1]);
    await expect(primary).toHaveText("Cancel");
    await expectAccessible(page);
    await expectNoPageOverflow(page);
    await page.screenshot({ path: test.info().outputPath(`mcp-inline-recovery-${width}.png`) });
    await details.getByRole("button", { name: "Close Firecrawl", exact: true }).click();
    await page.getByRole("button", { name: "Firecrawl", exact: true }).click();
    await expect(open).toBeVisible();
    await primary.click();
    await expect(open).toBeHidden();
  });
}
