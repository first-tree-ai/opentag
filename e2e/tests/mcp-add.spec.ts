import type { Locator, Page } from "@playwright/test";
import { expectAccessible, expectNoPageOverflow, expectWithinViewport } from "./browser-contract.js";
import { expect, smokeTest as test } from "./fixtures.js";
import { createAgent, mcpFixture, server } from "./mcp-browser-fixture.js";

async function openAdd(page: Page, agentId: string, locale = "en") {
  await page.goto(`/agents/${agentId}/mcp`);
  await page
    .getByRole("button", { name: locale === "zh" ? "自定义" : "Add custom", exact: true })
    .first()
    .click();
  const dialog = page.getByRole("dialog", {
    name: locale === "zh" ? "添加自定义连接器" : "Add custom connector",
    exact: true,
  });
  await expect(dialog).toBeVisible();
  return dialog;
}
async function geometry(dialog: Locator) {
  return Promise.all([
    dialog.boundingBox(),
    dialog.locator("header").boundingBox(),
    dialog.getByLabel("Connector URL", { exact: true }).boundingBox(),
    dialog.locator("footer").boundingBox(),
  ]);
}

/** Visibility alone passes for partially clipped elements; check every clipping ancestor as well. */
async function expectUnclipped(locator: Locator) {
  await expect(locator).toBeVisible();
  const clipped = await locator.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const problems: string[] = [];
    for (let parent = element.parentElement; parent; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      const bounds = parent.getBoundingClientRect();
      if (
        /auto|scroll|hidden|clip/.test(style.overflowY) &&
        (box.top < bounds.top - 1 || box.bottom > bounds.bottom + 1)
      )
        problems.push(`${parent.className}: vertical clipping`);
      if (
        /auto|scroll|hidden|clip/.test(style.overflowX) &&
        (box.left < bounds.left - 1 || box.right > bounds.right + 1)
      )
        problems.push(`${parent.className}: horizontal clipping`);
    }
    return problems;
  });
  expect(clipped, "the whole element must be visible").toEqual([]);
}

test("Add custom accepts only a URL and retries tools without another create or bind", async ({ page }) => {
  const agentId = await createAgent(page, "MCP first Agent");
  const fixture = await mcpFixture(page);
  fixture.failProbe(true);
  const dialog = await openAdd(page, agentId);
  await expect(dialog.getByRole("textbox")).toHaveCount(1);
  const url = dialog.getByLabel("Connector URL", { exact: true });
  await url.fill("claude mcp add docs https://docs.example.com/mcp");
  await dialog.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(dialog).toContainText("Enter a complete connector URL.");
  expect(fixture.writes).toHaveLength(0);
  await url.fill("https://docs.example.com/mcp");
  const initial = await geometry(dialog);
  fixture.holdProbe();
  await dialog.getByRole("button", { name: "Connect", exact: true }).click();
  const loading = dialog.getByRole("button", { name: "Loading tools…", exact: true });
  await expect(loading).toBeVisible();
  await expect(loading).toBeDisabled();
  expect(
    await loading.evaluate((element) => {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        if (walker.currentNode.textContent?.trim() !== "Loading tools…") continue;
        const range = document.createRange();
        range.selectNodeContents(walker.currentNode);
        return range.getClientRects().length;
      }
      throw new Error("Missing loading label");
    }),
  ).toBe(1);
  expect(await geometry(dialog)).toEqual(initial);
  await page.screenshot({ path: test.info().outputPath("mcp-loading.png") });
  fixture.releaseProbe();
  await expect(dialog).toContainText("Couldn’t load tools. Try again.");
  expect(await geometry(dialog)).toEqual(initial);
  fixture.failProbe(false);
  await dialog.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(fixture.servers).toHaveLength(1);
  expect(fixture.mounts.get(agentId)).toHaveLength(1);
  expect(fixture.writes.filter((write) => write.path === "/api/v1/mcp-servers")).toHaveLength(1);
  expect(fixture.writes.filter((write) => write.path === `/api/v1/agents/${agentId}/mcp-servers`)).toHaveLength(1);
  await expect(page.locator('[data-ui="mcp-server-list"]')).toContainText("Connected");
  await expectAccessible(page);
  await page.screenshot({ path: test.info().outputPath("mcp-added.png") });
});

test("different Agents create independent definitions and show the same catalog title", async ({ page }) => {
  const first = await createAgent(page, "First MCP Agent");
  const second = await createAgent(page, "Second MCP Agent");
  const fixture = await mcpFixture(page);
  for (const id of [first, second]) {
    const dialog = await openAdd(page, id);
    await expect(dialog).not.toContainText("Choose a configured connector");
    await dialog.getByLabel("Connector URL", { exact: true }).fill("https://mcp.exa.ai/mcp");
    await dialog.getByRole("button", { name: "Connect", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(
      page.locator('[data-ui="mcp-server-row"]').getByRole("button", { name: "Exa", exact: true }),
    ).toBeVisible();
  }
  expect(fixture.servers.map((value) => value.name)).toEqual(["exa", "exa-2"]);
  expect(fixture.mounts.get(first)?.[0]?.mcpServerId).not.toBe(fixture.mounts.get(second)?.[0]?.mcpServerId);
  const dialog = await openAdd(page, second);
  await dialog.getByLabel("Connector URL", { exact: true }).fill("https://mcp.exa.ai/mcp");
  await dialog.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(fixture.servers).toHaveLength(2);
  expect(fixture.mounts.get(second)).toHaveLength(1);
});

for (const { width, height } of [
  { width: 1440, height: 720 },
  { width: 320, height: 720 },
  { width: 320, height: 480 },
  { width: 390, height: 844 },
  { width: 768, height: 900 },
]) {
  test(`URL-only Add is stable and accessible without loading Account configurations at ${width}x${height}`, async ({
    page,
  }) => {
    const agentId = await createAgent(page, "MCP layout review");
    const fixture = await mcpFixture(
      page,
      Array.from({ length: 8 }, (_, i) => server(`service-${i}`)),
    );
    fixture.holdPool();
    await page.setViewportSize({ width, height });
    const dialog = await openAdd(page, agentId);
    const initial = await geometry(dialog);
    expect(initial[0]?.height).toBeLessThanOrEqual(280);
    await expect(dialog.getByRole("textbox")).toHaveCount(1);
    await expect(dialog).not.toContainText("Choose a configured connector");
    await dialog.getByLabel("Connector URL", { exact: true }).fill("example.com");
    await dialog.getByRole("button", { name: "Connect", exact: true }).click();
    await expect(dialog.getByRole("alert")).toHaveText("Enter a complete connector URL.");
    expect(await geometry(dialog)).toEqual(initial);
    await expectUnclipped(dialog.getByRole("alert"));
    await expectWithinViewport(dialog);
    await expectNoPageOverflow(page);
    await expectAccessible(page);
    await page.screenshot({ path: test.info().outputPath(`mcp-url-only-${width}-${height}.png`) });
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("button", { name: "Add custom", exact: true })).toBeFocused();
    await page.getByRole("button", { name: "Add custom", exact: true }).click();
    expect(await geometry(dialog)).toEqual(initial);
    expect(fixture.writes).toHaveLength(0);
    fixture.releasePool();
  });
}

test("OAuth cancellation retries only this journey's definition", async ({ page }) => {
  const agentId = await createAgent(page, "MCP browser sign-in");
  const fixture = await mcpFixture(page);
  await page.context().route("**/mcp-consent-fixture?*", async (route) => {
    const target = new URL(route.request().url()).searchParams.get("return");
    if (!target) throw new Error("Missing consent return URL");
    await route.fulfill({
      contentType: "text/html",
      body: `<html lang="en"><title>Fixture sign-in</title><a href="${target}">Cancel sign-in</a></html>`,
    });
  });
  const dialog = await openAdd(page, agentId);
  await dialog.getByLabel("Connector URL", { exact: true }).fill("https://mcp.linear.app/mcp");
  const cancellation = page.waitForEvent("popup");
  await dialog.getByRole("button", { name: "Connect", exact: true }).click();
  await (await cancellation).getByRole("link", { name: "Cancel sign-in" }).click();
  await expect(dialog).toContainText("Sign-in was cancelled. You can try again.");
  await expect.poll(() => fixture.mounts.get(agentId)).toHaveLength(0);
  const retry = page.waitForEvent("popup");
  await dialog.getByRole("button", { name: "Connect", exact: true }).click();
  const retried = await retry;
  await expect(retried.getByRole("link", { name: "Cancel sign-in" })).toBeVisible();
  expect(fixture.servers).toHaveLength(1);
  expect(fixture.mounts.get(agentId)).toHaveLength(1);
  expect(fixture.writes.filter((write) => write.path === "/api/v1/mcp-servers")).toHaveLength(1);
  await retried.close();
});

for (const width of [1440, 320]) {
  test(`sign-in errors remain beside the URL and retry this installation at ${width}px`, async ({ page }) => {
    const agentId = await createAgent(page, "MCP sign-in feedback");
    const fixture = await mcpFixture(page);
    fixture.failOAuth();
    await page.setViewportSize({ width, height: 720 });
    const dialog = await openAdd(page, agentId);
    await dialog.getByLabel("Connector URL", { exact: true }).fill("https://mcp.figma.com/mcp");
    const initial = await geometry(dialog);
    await dialog.getByRole("button", { name: "Connect", exact: true }).click();
    const error = dialog.getByRole("alert");
    await expect(error).toHaveText("Couldn’t start sign-in. Try again.");
    await expect(dialog).not.toContainText("Private upstream detail");
    expect(await geometry(dialog)).toEqual(initial);
    await expectUnclipped(error);
    await expectAccessible(page);
    await page.screenshot({ path: test.info().outputPath(`mcp-sign-in-error-${width}.png`) });
    await dialog.getByRole("button", { name: "Connect", exact: true }).click();
    await expect(error).toBeVisible();
    expect(fixture.servers).toHaveLength(1);
    await dialog.getByLabel("Connector URL", { exact: true }).fill("https://changed.example.com/mcp");
    await expect(error).toHaveCount(0);
    expect(await geometry(dialog)).toEqual(initial);
  });
}

test("Chinese Add custom contains only the URL and no configuration picker", async ({ page }) => {
  const agentId = await createAgent(page, "MCP Chinese layout");
  const fixture = await mcpFixture(page, [server("existing")]);
  await page.addInitScript(() => localStorage.setItem("PARAGLIDE_LOCALE", "zh"));
  await page.setViewportSize({ width: 320, height: 720 });
  const dialog = await openAdd(page, agentId, "zh");
  await expect(dialog.getByRole("textbox")).toHaveCount(1);
  await expect(dialog).not.toContainText("选择已配置的连接器");
  await expectWithinViewport(dialog);
  await expectAccessible(page);
  await page.screenshot({ path: test.info().outputPath("mcp-url-only-zh-320.png") });
  expect(fixture.writes).toHaveLength(0);
});
