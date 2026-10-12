import { randomUUID } from "node:crypto";
import type { MCPAgentServer, MCPAuthKind, MCPServer } from "@opentag/shared/browser";
import type { Locator, Page, Route } from "@playwright/test";
import { baseURL } from "../playwright.config.js";
import { expectAccessible, expectNoPageOverflow, expectWithinViewport } from "./browser-contract.js";
import { expect, smokeTest as test } from "./fixtures.js";

const timestamp = "2026-10-10T00:00:00.000Z";
function server(name: string, kind: MCPAuthKind = "none"): MCPServer {
  return {
    id: randomUUID(),
    name,
    url: `https://${name}.example.com/mcp`,
    description: null,
    defaultAuthKind: kind,
    authHeader: "authorization",
    authScheme: "Bearer",
    extraHeaders: {},
    revision: 1,
    boundAgentCount: 0,
    authorizedAgentCount: 0,
    lastProbedAt: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}
function binding(value: MCPServer): MCPAgentServer {
  return {
    mcpServerId: value.id,
    name: value.name,
    description: null,
    discoveredDescription: null,
    enabled: true,
    effective: { url: value.url, authHeader: value.authHeader, authScheme: value.authScheme, extraHeaders: {} },
    overridden: { url: false, authHeader: false, authScheme: false, extraHeaders: false },
    authorization: null,
    snapshot: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}
async function createAgent(page: Page, displayName: string) {
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === "opentag_csrf")?.value;
  if (!csrf) throw new Error("Missing authenticated CSRF cookie");
  const response = await page.request.post("/api/v1/agents", {
    data: { creationIntentId: randomUUID(), name: `mcp-${randomUUID()}`, displayName, runtimeProvider: "codex" },
    headers: { Origin: baseURL, "x-opentag-csrf": csrf },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return ((await response.json()) as { id: string }).id;
}

/** Sign-in, Agent creation, navigation, and the built app are real; MCP management responses are fixtures. */
async function mcpFixture(page: Page, servers: MCPServer[] = []) {
  const mounts = new Map<string, MCPAgentServer[]>();
  const writes: { path: string; body: Record<string, unknown> }[] = [];
  let failProbe = false;
  let releasePool: () => void = () => {};
  let poolGate: Promise<void> | undefined;
  let releaseProbe: () => void = () => {};
  let probeGate: Promise<void> | undefined;
  await page.route(/\/api\/v1\/(?:agents\/[^/]+\/)?mcp-servers(?:\/.*)?$/, async (route) => {
    const path = new URL(route.request().url()).pathname;
    const body = route.request().postDataJSON() as Record<string, unknown> | null;
    const method = route.request().method();
    if (method !== "GET") writes.push({ path, body: body ?? {} });
    if (path === "/api/v1/mcp-servers") {
      await respondPool(route, method, body);
      return;
    }
    const match = /^\/api\/v1\/agents\/([^/]+)\/mcp-servers(?:\/([^/]+))?(.*)$/.exec(path);
    if (!match?.[1]) throw new Error(`Unexpected MCP fixture request: ${path}`);
    const agentId = match[1];
    const entries = mounts.get(agentId) ?? [];
    mounts.set(agentId, entries);
    if (!match[2]) {
      await respondAgentCollection(route, method, entries, body);
      return;
    }
    const entry = entries.find((value) => value.mcpServerId === match[2]);
    if (!entry) throw new Error("Missing binding fixture");
    await respond(route, agentId, entry, match[3] ?? "", body);
  });
  async function respondAgentCollection(
    route: Route,
    method: string,
    entries: MCPAgentServer[],
    body: Record<string, unknown> | null,
  ) {
    if (method === "GET") await route.fulfill({ json: { servers: entries } });
    else {
      const value = servers.find((candidate) => candidate.id === body?.mcpServerId);
      if (!value) throw new Error("Missing server fixture");
      const entry = binding(value);
      entries.push(entry);
      await route.fulfill({ json: entry });
    }
  }
  async function respondPool(route: Route, method: string, body: Record<string, unknown> | null) {
    if (method === "GET") {
      await poolGate;
      await route.fulfill({ json: { servers } });
    } else {
      const value = { ...server(String(body?.name)), ...body } as MCPServer;
      servers.push(value);
      await route.fulfill({ json: value });
    }
  }
  async function respond(
    route: Route,
    agentId: string,
    entry: MCPAgentServer,
    operation: string,
    body: Record<string, unknown> | null,
  ) {
    if (operation === "/authorization/oauth") {
      const returnURL = `/agents/${agentId}/mcp?mcp_oauth=error&server=${entry.mcpServerId}`;
      await route.fulfill({
        json: {
          authorizationUrl: `${baseURL}/mcp-consent-fixture?return=${encodeURIComponent(returnURL)}`,
          expiresAt: "2099-01-01T00:00:00.000Z",
        },
      });
      return;
    }
    if (operation === "/authorization") {
      entry.authorization = {
        kind: body?.kind as MCPAuthKind,
        status: "active",
        hasCredential: body?.kind !== "none",
        scopes: null,
        accessTokenExpiresAt: null,
        authorizationServer: null,
        probeState: "pending",
        probedAt: null,
        probeError: null,
        toolsCount: null,
        toolsTruncated: false,
        failureCode: null,
        revision: 1,
      };
      await route.fulfill({ json: entry });
      return;
    }
    if (operation !== "/probe" || !entry.authorization) throw new Error(`Unexpected MCP operation: ${operation}`);
    await probeGate;
    entry.authorization.probeState = failProbe ? "failed" : "succeeded";
    entry.authorization.probeError = failProbe ? "Fixture unavailable" : null;
    entry.authorization.toolsCount = failProbe ? null : 1;
    entry.snapshot = {
      protocolEra: "modern",
      protocolVersion: "2026-07-28",
      serverInfo: null,
      capabilities: null,
      instructions: null,
      tools: failProbe ? null : [{ name: "read_document", description: null, inputSchema: { type: "object" } }],
    };
    await route.fulfill({
      json: {
        probeState: entry.authorization.probeState,
        probeError: entry.authorization.probeError,
        toolsCount: entry.authorization.toolsCount,
        toolsTruncated: false,
        protocolEra: "modern",
        protocolVersion: "2026-07-28",
      },
    });
  }
  return {
    servers,
    mounts,
    writes,
    failProbe: (value: boolean) => {
      failProbe = value;
    },
    holdPool: () => {
      poolGate = new Promise((resolve) => {
        releasePool = resolve;
      });
    },
    releasePool: () => releasePool(),
    holdProbe: () => {
      probeGate = new Promise((resolve) => {
        releaseProbe = resolve;
      });
    },
    releaseProbe: () => releaseProbe(),
  };
}
async function openAdd(page: Page, agentId: string) {
  await page.goto(`/agents/${agentId}/mcp`);
  await page.getByRole("button", { name: "Add server", exact: true }).first().click();
  const dialog = page.getByRole("dialog", { name: "Add server", exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}
async function geometry(dialog: Locator) {
  return Promise.all([
    dialog.boundingBox(),
    dialog.locator("header").boundingBox(),
    dialog.getByLabel("Server URL", { exact: true }).boundingBox(),
    dialog.locator("footer").boundingBox(),
  ]);
}

test("Add server accepts only a URL and retries tools without another create or bind", async ({ page }) => {
  const agentId = await createAgent(page, "MCP first Agent");
  const fixture = await mcpFixture(page);
  fixture.failProbe(true);
  const dialog = await openAdd(page, agentId);
  await expect(dialog.getByRole("textbox")).toHaveCount(1);
  const url = dialog.getByLabel("Server URL", { exact: true });
  await url.fill("claude mcp add docs https://docs.example.com/mcp");
  await dialog.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(dialog).toContainText("Enter a complete server URL.");
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
  await expect(dialog.getByRole("button", { name: "documents Added", exact: true })).toBeDisabled();
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
});

for (const { width, height } of [
  { width: 1440, height: 720 },
  { width: 320, height: 720 },
  { width: 320, height: 480 },
  { width: 390, height: 844 },
  { width: 768, height: 900 },
]) {
  test(`Add server stays stable through loading, search, selection and authentication at ${width}x${height}`, async ({
    page,
  }) => {
    const agentId = await createAgent(page, "MCP layout review");
    const fixture = await mcpFixture(
      page,
      Array.from({ length: 8 }, (_, i) => server(`service-${i}`, "bearer")),
    );
    fixture.holdPool();
    await page.setViewportSize({ width, height });
    const dialog = await openAdd(page, agentId);
    await expect(dialog.getByRole("status", { name: "Loading servers" })).toBeVisible();
    const initial = await geometry(dialog);
    fixture.releasePool();
    await dialog.getByRole("button", { name: "View all (8)" }).click();
    const expanded = await geometry(dialog);
    expect(expanded.slice(1, 3)).toEqual(initial.slice(1, 3));
    expect(expanded[0]).toMatchObject({ x: initial[0]?.x, y: initial[0]?.y, width: initial[0]?.width });
    expect(expanded[0]?.height).toBeGreaterThanOrEqual(initial[0]?.height ?? 0);
    await dialog.getByRole("textbox", { name: "Search servers" }).fill("service-7");
    await dialog.getByRole("button", { name: /service-7.*https/ }).click();
    await expect(dialog.getByRole("button", { name: "service-7", exact: true })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(await geometry(dialog)).toEqual(initial);
    await dialog.getByRole("button", { name: "Connect", exact: true }).click();
    await expect(dialog.getByLabel("API key", { exact: true })).toBeFocused();
    expect(await geometry(dialog)).toEqual(initial);
    const keyBounds = await dialog.getByLabel("API key", { exact: true }).boundingBox();
    const footerBounds = await dialog.locator("footer").boundingBox();
    expect(keyBounds).not.toBeNull();
    expect(footerBounds).not.toBeNull();
    if (keyBounds && footerBounds) expect(footerBounds.y - keyBounds.y - keyBounds.height).toBeLessThanOrEqual(64);
    const bodyBounds = await dialog.locator(".mcp-add-body").boundingBox();
    expect(bodyBounds).not.toBeNull();
    if (keyBounds && bodyBounds)
      expect(keyBounds.y + keyBounds.height + 4).toBeLessThanOrEqual(bodyBounds.y + bodyBounds.height);
    await expectWithinViewport(dialog);
    await expectWithinViewport(dialog.getByRole("button", { name: "Connect", exact: true }));
    await expectNoPageOverflow(page);
    await expectAccessible(page);
    await page.screenshot({ path: test.info().outputPath(`mcp-key-${width}-${height}.png`) });
    await dialog.getByLabel("Server URL", { exact: true }).fill("https://changed.example.com/mcp");
    await expect(dialog.getByLabel("API key", { exact: true })).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("button", { name: "Add server", exact: true }).first()).toBeFocused();
    expect(fixture.writes).toHaveLength(0);
  });
}

test("OAuth cancellation restores Add server and retries its existing binding", async ({ page }) => {
  const agentId = await createAgent(page, "MCP browser sign-in");
  const shared = server("oauth-service", "oauth");
  const fixture = await mcpFixture(page, [shared]);
  await page.route("**/mcp-consent-fixture?*", async (route) => {
    const target = new URL(route.request().url()).searchParams.get("return");
    if (!target) throw new Error("Missing consent return URL");
    await route.fulfill({
      contentType: "text/html",
      body: `<html lang="en"><title>Fixture sign-in</title><a href="${target}">Cancel sign-in</a></html>`,
    });
  });
  const dialog = await openAdd(page, agentId);
  await dialog.getByRole("button", { name: "oauth-service", exact: true }).click();
  await dialog.getByRole("button", { name: "Connect", exact: true }).click();
  await page.getByRole("link", { name: "Cancel sign-in" }).click();
  const restored = page.getByRole("dialog", { name: "Add server", exact: true });
  await expect(restored.getByLabel("Server URL", { exact: true })).toHaveValue(shared.url);
  await expect(restored).toContainText("Sign-in was not completed. Try again.");
  await expect(page.getByText(/Authorization for oauth-service is not complete/)).toHaveCount(0);
  await expect(restored.getByLabel("API key", { exact: true })).toHaveCount(0);
  await restored.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByRole("link", { name: "Cancel sign-in" })).toBeVisible();
  expect(fixture.mounts.get(agentId)).toHaveLength(1);
  expect(fixture.writes.filter((write) => write.path.endsWith("/authorization/oauth"))).toHaveLength(2);
  expect(fixture.writes.filter((write) => write.path.endsWith("/mcp-servers"))).toHaveLength(1);
});
