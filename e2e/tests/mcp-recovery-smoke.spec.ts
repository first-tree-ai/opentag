import type { Page } from "@playwright/test";
import { expectAccessible, expectNoPageOverflow } from "./browser-contract.js";
import { expect, smokeTest as test } from "./fixtures.js";
import { binding, createAgent, mcpFixture, server } from "./mcp-browser-fixture.js";

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
  await details.getByRole("button", { name: "Use account sign-in", exact: true }).click();
  await details.getByRole("button", { name: "Authorize", exact: true }).click();
  await expect(details.getByRole("alert")).toHaveText("Authorization failed");
  await expect(details.getByRole("button", { name: "Advanced settings", exact: true })).toHaveCount(0);
  await expect(details.getByRole("radio")).toHaveCount(0);
  await expect(details.getByLabel("Connector address")).toHaveAttribute("readonly", "");
  await details.getByRole("button", { name: "Close Exa", exact: true }).click();
  await page.getByRole("button", { name: "Exa", exact: true }).click();
  await expect(details.getByText("Account sign-in", { exact: true })).toBeVisible();
  await expect(details.getByRole("button", { name: "Use API key or token", exact: true })).toBeVisible();
  expect(fixture.mounts.get(agentId)?.[0]?.authorization?.hasCredential).toBe(false);
  await expectAccessible(page);
});

test("saving a key freezes the submitted inputs until the credential write completes", async ({ page }) => {
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
  await details.getByRole("button", { name: "Update", exact: true }).click();
  const key = details.getByLabel("API key or token");
  await key.fill("replacement-review-key");
  fixture.holdAuthorization();
  try {
    await details.getByRole("button", { name: "Save", exact: true }).click();
    await expect(key).toBeDisabled();
    await expect(details.getByRole("button", { name: "Show key", exact: true })).toBeDisabled();
    await expect(details.getByRole("button", { name: "Cancel", exact: true })).toBeDisabled();
  } finally {
    fixture.releaseAuthorization();
  }
  await expect(details.getByRole("button", { name: "Update", exact: true })).toBeVisible();
  expect(fixture.writes.filter((write) => write.body.bearerKey === "replacement-review-key")).toHaveLength(1);
});

test("an existing OAuth endpoint keeps preset Details and can save an alternate key method", async ({ page }) => {
  const agentId = await createAgent(page, "Existing preset compatibility");
  const definition = { ...server("exa", "oauth"), url: "https://mcp.exa.ai/mcp" };
  const fixture = await mcpFixture(page, [definition]);
  fixture.mounts.set(agentId, [binding(definition)]);
  fixture.completeOAuth(agentId);
  await page.goto(`/agents/${agentId}/mcp`);
  await page.getByRole("button", { name: "Exa", exact: true }).click();
  const details = page.getByRole("dialog", { name: "Exa", exact: true });
  await expect(details.getByLabel("Connector address")).toHaveValue(definition.url);
  await expect(details.getByLabel("Connector address")).toHaveAttribute("readonly", "");
  await expect(details.getByRole("button", { name: "Advanced settings", exact: true })).toHaveCount(0);
  await details.getByRole("button", { name: "Use API key or token", exact: true }).click();
  await details.getByLabel("API key or token").fill("alternate-review-key");
  await details.getByRole("button", { name: "Save", exact: true }).click();
  await expect(details.getByRole("button", { name: "Update", exact: true })).toBeVisible();
  const installed = fixture.mounts.get(agentId)?.[0];
  expect(installed?.authorization?.kind).toBe("bearer");
  expect(installed?.effective.authHeader).toBe("x-api-key");
  expect(installed?.effective.authScheme).toBe("");
  await details.getByRole("button", { name: "Close Exa", exact: true }).click();
  await page.getByRole("button", { name: "Exa", exact: true }).click();
  await expect(details.getByText("API key or token", { exact: true })).toBeVisible();
  await expect(details.getByRole("button", { name: "Use account sign-in", exact: true })).toBeVisible();
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
    const actionRow = details.locator(".mcp-auth-action-row");
    await expect(actionRow.getByRole("button", { name: "Authorize", exact: true })).toBeVisible();
    await expect(actionRow.getByRole("alert")).toHaveText("Authorization failed");
    const buttonBox = await actionRow.getByRole("button").boundingBox();
    const errorBox = await feedback.boundingBox();
    if (!buttonBox || !errorBox) throw new Error("Missing feedback geometry");
    if (width === 320) expect(errorBox.y).toBeGreaterThanOrEqual(buttonBox.y + buttonBox.height);
    else expect(Math.abs(buttonBox.y + buttonBox.height / 2 - errorBox.y - errorBox.height / 2)).toBeLessThan(2);
    await expect(details.getByRole("button", { name: "Use API key or token" })).toBeVisible();
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
