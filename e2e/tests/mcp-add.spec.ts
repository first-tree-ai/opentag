import type { Locator, Page } from "@playwright/test";
import { expectAccessible, expectNoPageOverflow, expectWithinViewport } from "./browser-contract.js";
import { expect, smokeTest as test } from "./fixtures.js";
import { binding, createAgent, mcpFixture, server } from "./mcp-browser-fixture.js";

async function openAdd(page: Page, agentId: string) {
  await page.goto(`/agents/${agentId}/mcp`);
  await page.getByRole("button", { name: "Add custom", exact: true }).first().click();
  const dialog = page.getByRole("dialog", { name: "Add custom connector", exact: true });
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

test("another Agent reuses the server and supplies its own API key", async ({ page }) => {
  const first = await createAgent(page, "First MCP Agent");
  const second = await createAgent(page, "Second MCP Agent");
  const shared = server("documents", "bearer");
  const fixture = await mcpFixture(page, [shared]);
  for (const [agentId, key] of [
    [first, "first-fixture-key"],
    [second, "second-fixture-key"],
  ]) {
    if (!agentId || !key) throw new Error("Missing Agent fixture");
    const dialog = await openAdd(page, agentId);
    await dialog.getByRole("button", { name: "documents", exact: true }).click();
    await expect(dialog.getByLabel("API key", { exact: true })).toHaveCount(0);
    await dialog.getByRole("button", { name: "Connect", exact: true }).click();
    const input = dialog.getByLabel("API key", { exact: true });
    await expect(input).toHaveValue("");
    await expect(input).toBeFocused();
    await input.fill(key);
    await dialog.getByRole("button", { name: "Connect", exact: true }).click();
    await expect(dialog).toBeHidden();
    expect(
      fixture.writes.find((write) => write.path === `/api/v1/agents/${agentId}/mcp-servers/${shared.id}/authorization`)
        ?.body,
    ).toEqual({ kind: "bearer", bearerKey: key });
  }
  expect(fixture.servers).toHaveLength(1);
  const dialog = await openAdd(page, second);
  await expect(dialog.locator(".mcp-add-tag")).toHaveCount(0);
  await expect(dialog).not.toContainText("Or choose a connector");
  expect((await dialog.boundingBox())?.height).toBeLessThanOrEqual(280);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
});

test("an empty server pool opens at the same compact size on first use and reopen", async ({ page }) => {
  const agentId = await createAgent(page, "MCP first use layout");
  const fixture = await mcpFixture(page);
  fixture.holdPool();
  await page.goto(`/agents/${agentId}/mcp`);
  const add = page.getByRole("button", { name: "Add custom", exact: true }).first();
  await expect(add).toBeDisabled();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  fixture.releasePool();
  await add.click();
  const dialog = page.getByRole("dialog", { name: "Add custom connector", exact: true });
  const initial = await geometry(dialog);
  expect(initial[0]?.height).toBeLessThanOrEqual(280);
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Add custom", exact: true }).first().click();
  const reopened = await geometry(dialog);
  expect(reopened).toEqual(initial);
  await expect(dialog).not.toContainText("Or choose a connector");
  await dialog.getByLabel("Connector URL", { exact: true }).fill("example.com");
  await dialog.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(dialog.getByRole("alert")).toHaveText("Enter a complete connector URL.");
  await expectUnclipped(dialog.getByRole("alert"));
  expect(await geometry(dialog)).toEqual(reopened);
  expect(fixture.writes).toHaveLength(0);
});

for (const { width, height } of [
  { width: 1440, height: 720 },
  { width: 320, height: 720 },
  { width: 320, height: 480 },
  { width: 390, height: 844 },
  { width: 768, height: 900 },
]) {
  test(`Add custom stays stable through loading, search, selection and authentication at ${width}x${height}`, async ({
    page,
  }) => {
    const agentId = await createAgent(page, "MCP layout review");
    const fixture = await mcpFixture(
      page,
      Array.from({ length: 8 }, (_, i) => server(`service-${i}`, "bearer")),
    );
    fixture.holdPool();
    await page.setViewportSize({ width, height });
    await page.goto(`/agents/${agentId}/mcp`);
    await expect(page.getByRole("button", { name: "Add custom", exact: true }).first()).toBeDisabled();
    fixture.releasePool();
    await page.getByRole("button", { name: "Add custom", exact: true }).first().click();
    const dialog = page.getByRole("dialog", { name: "Add custom connector", exact: true });
    const initial = await geometry(dialog);
    expect(
      await dialog.locator(".mcp-add-servers-heading > span").evaluate((heading) => {
        const text = document.createRange();
        text.selectNodeContents(heading);
        return text.getClientRects().length;
      }),
      "the existing-server hint should stay on one line",
    ).toBe(1);
    const shortcuts = dialog.locator(".mcp-add-tag:visible");
    await expect(shortcuts).toHaveCount(width <= 600 ? 2 : 4);
    for (const shortcut of await shortcuts.all()) await expectUnclipped(shortcut);
    expect(await geometry(dialog)).toEqual(initial);
    await page.screenshot({ path: test.info().outputPath(`mcp-shortcuts-${width}-${height}.png`) });
    await dialog.getByRole("button", { name: "View all (8)" }).click();
    const expanded = await geometry(dialog);
    expect(expanded.slice(1, 3)).toEqual(initial.slice(1, 3));
    expect(expanded[0]).toMatchObject({ x: initial[0]?.x, y: initial[0]?.y, width: initial[0]?.width });
    expect(expanded[0]?.height).toBeGreaterThanOrEqual(initial[0]?.height ?? 0);
    const rows = dialog.locator(".mcp-add-server-row");
    await expect(rows).toHaveCount(8);
    for (const row of await rows.all()) {
      expect(
        await row.evaluate((element) => {
          const bounds = element.getBoundingClientRect();
          const copy = element.querySelector(".mcp-add-server-copy")?.getBoundingClientRect();
          return copy && copy.top >= bounds.top && copy.bottom <= bounds.bottom;
        }),
        "wrapped names and addresses must fit inside their result row",
      ).toBe(true);
    }
    await rows.last().scrollIntoViewIfNeeded();
    await expectUnclipped(rows.last());
    await expectWithinViewport(dialog);
    await rows.first().scrollIntoViewIfNeeded();
    await expectUnclipped(rows.first());
    await page.screenshot({ path: test.info().outputPath(`mcp-all-${width}-${height}.png`) });
    await dialog.getByRole("textbox", { name: "Search connectors" }).fill("service-7");
    await dialog.getByRole("button", { name: /service-7.*https/ }).click();
    await expect(dialog.getByRole("button", { name: "service-7", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await expect.poll(() => geometry(dialog)).toEqual(initial);
    await dialog.getByRole("button", { name: "Connect", exact: true }).click();
    await expect(dialog.getByLabel("API key", { exact: true })).toBeFocused();
    await expect.poll(async () => (await dialog.boundingBox())?.height).toBe(width <= 600 ? 352 : 336);
    const settledKey = await geometry(dialog);
    expect(settledKey.slice(1, 3)).toEqual(initial.slice(1, 3));
    expect(settledKey[0]).toMatchObject({ x: initial[0]?.x, y: initial[0]?.y, width: initial[0]?.width });
    const keyBounds = await dialog.getByLabel("API key", { exact: true }).boundingBox();
    const footerBounds = await dialog.locator("footer").boundingBox();
    expect(keyBounds).not.toBeNull();
    expect(footerBounds).not.toBeNull();
    if (keyBounds && footerBounds) expect(footerBounds.y - keyBounds.y - keyBounds.height).toBeLessThanOrEqual(64);
    const urlBounds = await dialog.getByLabel("Connector URL", { exact: true }).boundingBox();
    if (urlBounds && keyBounds) expect(keyBounds.y - urlBounds.y - urlBounds.height).toBeLessThanOrEqual(56);
    const bodyBounds = await dialog.locator(".mcp-add-body").boundingBox();
    expect(bodyBounds).not.toBeNull();
    if (keyBounds && bodyBounds)
      expect(keyBounds.y + keyBounds.height + 4).toBeLessThanOrEqual(bodyBounds.y + bodyBounds.height);
    await expectWithinViewport(dialog);
    await expectWithinViewport(dialog.getByRole("button", { name: "Connect", exact: true }));
    await expectNoPageOverflow(page);
    await expectAccessible(page);
    await page.screenshot({ path: test.info().outputPath(`mcp-key-${width}-${height}.png`) });
    await dialog.getByLabel("Connector URL", { exact: true }).fill("https://changed.example.com/mcp");
    await expect(dialog.getByLabel("API key", { exact: true })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("button", { name: "Add custom", exact: true }).first()).toBeFocused();
    expect(fixture.writes).toHaveLength(0);
  });
}

test("OAuth cancellation restores Add custom and retries its existing binding", async ({ page }) => {
  const agentId = await createAgent(page, "MCP browser sign-in");
  const shared = server("oauth-service", "oauth");
  const fixture = await mcpFixture(page, [shared]);
  await page.context().route("**/mcp-consent-fixture?*", async (route) => {
    const target = new URL(route.request().url()).searchParams.get("return");
    if (!target) throw new Error("Missing consent return URL");
    await route.fulfill({
      contentType: "text/html",
      body: `<html lang="en"><title>Fixture sign-in</title><a href="${target}">Cancel sign-in</a></html>`,
    });
  });
  const dialog = await openAdd(page, agentId);
  await dialog.getByRole("button", { name: "oauth-service", exact: true }).click();
  const cancellation = page.waitForEvent("popup");
  await dialog.getByRole("button", { name: "Connect", exact: true }).click();
  await (await cancellation).getByRole("link", { name: "Cancel sign-in" }).click();
  const restored = page.getByRole("dialog", { name: "Add custom connector", exact: true });
  await expect(restored.getByLabel("Connector URL", { exact: true })).toHaveValue(shared.url);
  await expect(restored).toContainText("Sign-in was cancelled. You can try again.");
  await expect(page.getByText(/Authorization for oauth-service is not complete/)).toHaveCount(0);
  await expect(restored.getByLabel("API key", { exact: true })).toHaveCount(0);
  await expect.poll(() => fixture.mounts.get(agentId)).toHaveLength(0);
  const retry = page.waitForEvent("popup");
  await restored.getByRole("button", { name: "Connect", exact: true }).click();
  const retried = await retry;
  await expect(retried.getByRole("link", { name: "Cancel sign-in" })).toBeVisible();
  expect(fixture.mounts.get(agentId)).toHaveLength(1);
  expect(fixture.writes.filter((write) => write.path.endsWith("/authorization/oauth"))).toHaveLength(2);
  expect(fixture.writes.filter((write) => write.path.endsWith("/mcp-servers"))).toHaveLength(2);
  await retried.close();
});

for (const width of [1440, 320]) {
  test(`sign-in errors stay with the URL and leave saved shortcuts fully visible at ${width}px`, async ({ page }) => {
    const agentId = await createAgent(page, "MCP sign-in feedback");
    const figma = { ...server("figma", "oauth"), url: "https://mcp.figma.com/mcp" };
    const fixture = await mcpFixture(page, [figma, { ...server("monday"), url: "https://mcp.monday.com/mcp" }]);
    fixture.failOAuth();
    await page.setViewportSize({ width, height: 720 });
    const dialog = await openAdd(page, agentId);
    const shortcut = dialog.getByRole("button", { name: "Figma", exact: true });
    await shortcut.click();
    const initial = await geometry(dialog);
    await dialog.getByRole("button", { name: "Connect", exact: true }).click();
    const error = dialog.getByRole("alert");
    await expect(error).toHaveText("Couldn’t start sign-in. Try again.");
    await expect(dialog.getByLabel("Connector URL", { exact: true })).toHaveValue(figma.url);
    await expect(dialog).not.toContainText("Private upstream detail");
    expect(await geometry(dialog)).toEqual(initial);
    await expectUnclipped(error);
    for (const tag of await dialog.locator(".mcp-add-tag").all()) await expectUnclipped(tag);
    const [inputBounds, errorBounds, tagsBounds] = await Promise.all([
      dialog.getByLabel("Connector URL", { exact: true }).boundingBox(),
      error.boundingBox(),
      dialog.locator(".mcp-add-servers-heading").boundingBox(),
    ]);
    if (!inputBounds || !errorBounds || !tagsBounds) throw new Error("Missing connection feedback layout");
    expect(errorBounds.y).toBeGreaterThanOrEqual(inputBounds.y + inputBounds.height);
    expect(errorBounds.y + errorBounds.height).toBeLessThan(tagsBounds.y);
    await expectAccessible(page);
    await page.screenshot({ path: test.info().outputPath(`mcp-sign-in-error-${width}.png`) });
    await dialog.getByLabel("Connector URL", { exact: true }).fill("https://changed.example.com/mcp");
    await expect(error).toHaveCount(0);
    expect(await geometry(dialog)).toEqual(initial);
  });
}

test("long existing server names fit in two complete rows and mounted services are excluded", async ({ page }) => {
  const agentId = await createAgent(page, "MCP long server names");
  const fixture = await mcpFixture(
    page,
    Array.from({ length: 6 }, (_, i) => server(`team-${i}-with-an-extremely-long-service-name`)),
  );
  const saved = fixture.servers[0];
  if (!saved) throw new Error("Missing saved server fixture");
  fixture.mounts.set(agentId, [{ ...binding(saved), enabled: false }]);
  await page.setViewportSize({ width: 320, height: 480 });
  const dialog = await openAdd(page, agentId);
  const tags = dialog.locator(".mcp-add-tag:visible");
  await expect(tags).toHaveCount(2);
  await expect(dialog.getByRole("button", { name: saved.name, exact: true })).toHaveCount(0);
  await expect(tags.locator("svg, img")).toHaveCount(0);
  const boxes = [];
  for (const tag of await tags.all()) {
    await expectUnclipped(tag);
    boxes.push(await tag.boundingBox());
  }
  expect(new Set(boxes.map((box) => box?.y)).size).toBe(2);
  await expectUnclipped(dialog.getByRole("button", { name: "View all (5)" }));
  await expectNoPageOverflow(page);
  await page.screenshot({ path: test.info().outputPath("mcp-long-shortcuts-320.png") });
});

test("saved service shortcuts align consistently and keep recognizable names readable", async ({ page }) => {
  const agentId = await createAgent(page, "MCP saved services");
  const saved = [
    { ...server("exa"), url: "https://mcp.exa.ai/mcp" },
    { ...server("google-slides"), url: "https://slidesmcp.googleapis.com/mcp/v1" },
    { ...server("figma"), url: "https://mcp.figma.com/mcp" },
    { ...server("monday"), url: "https://mcp.monday.com/mcp" },
    { ...server("linear"), url: "https://mcp.linear.app/mcp" },
  ];
  const fixture = await mcpFixture(page, saved);
  const alreadyAdded = saved[0];
  if (!alreadyAdded) throw new Error("Missing saved service fixture");
  fixture.mounts.set(agentId, [{ ...binding(alreadyAdded), enabled: false }]);
  for (const width of [1440, 320]) {
    await page.setViewportSize({ width, height: 720 });
    const dialog = await openAdd(page, agentId);
    const tags = dialog.locator(".mcp-add-tag:visible");
    await expect(tags).toHaveCount(width === 320 ? 2 : 4);
    const viewAll = dialog.getByRole("button", { name: "View all (4)" });
    if (width === 320) await expect(viewAll).toBeVisible();
    else await expect(viewAll).toBeHidden();
    const bounds = [];
    for (const tag of await tags.all()) {
      await expectUnclipped(tag);
      expect(await tag.locator(".mcp-add-server-name").evaluate((name) => name.scrollWidth <= name.clientWidth)).toBe(
        true,
      );
      bounds.push(await tag.boundingBox());
    }
    expect(new Set(bounds.map((box) => box?.width)).size).toBe(1);
    expect(new Set(bounds.map((box) => box?.height)).size).toBe(1);
    await expect(dialog.getByRole("button", { name: "Exa", exact: true })).toHaveCount(0);
    await expect(tags.locator("svg, img")).toHaveCount(0);
    const choice = tags.first();
    const beforeSelection = await geometry(dialog);
    await choice.click();
    await expect(choice).toHaveAttribute("aria-pressed", "true");
    expect(await geometry(dialog)).toEqual(beforeSelection);
    await page.screenshot({ path: test.info().outputPath(`mcp-saved-services-${width}.png`) });
    await dialog.screenshot({ path: test.info().outputPath(`mcp-picker-${width}.png`) });
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  }
  expect(fixture.writes).toHaveLength(0);
});
