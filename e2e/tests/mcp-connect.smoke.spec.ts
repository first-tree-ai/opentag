import { randomUUID } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import type { ListAgentMCPServersResponse, MCPAgentServer, MCPAuthKind } from "@opentag/shared/browser";
import type { Page, Route } from "@playwright/test";
import { baseURL } from "../playwright.config.js";
import { expectAccessible, expectNoPageOverflow, expectWithinViewport } from "./browser-contract.js";
import { expect, smokeTest as test } from "./fixtures.js";

// Real API scenarios share the Account's definition-name namespace.
test.describe.configure({ mode: "default" });

async function agent(page: Page) {
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === "opentag_csrf")?.value;
  if (!csrf) throw new Error("Missing CSRF cookie");
  const headers = { Origin: baseURL, "x-opentag-csrf": csrf };
  const response = await page.request.post("/api/v1/agents", {
    headers,
    data: {
      creationIntentId: randomUUID(),
      name: `mcp-${randomUUID()}`,
      displayName: "MCP Connect review",
      runtimeProvider: "codex",
    },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  return { id: ((await response.json()) as { id: string }).id, headers };
}

/** A local HTTP MCP/OAuth peer; OpenTag's API, storage, redirects, and probes are real. */
async function peer(kind: MCPAuthKind, isolated = false, toolCount = 1) {
  let origin = "";
  let unavailable = false;
  let tokenFailure = false;
  let expired = false;
  let registrationGate: Promise<void> | undefined;
  const requiresCredential = (authorization?: string) =>
    kind !== "none" && (expired || authorization !== "Bearer fixture-key");
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", origin);
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const json = (body: unknown, status = 200) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (await oauthResponse(url, response, json)) return;
    if (url.pathname !== "/mcp") return json({}, 404);
    if (unavailable) return json({ error: "unavailable" }, 503);
    if (requiresCredential(request.headers.authorization)) {
      response.setHeader(
        "www-authenticate",
        `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
      );
      return json({}, 401);
    }
    const rpc = JSON.parse(raw || "{}") as { id?: unknown; method?: string };
    if (!rpc.id) {
      response.writeHead(202);
      response.end();
      return;
    }
    const result = rpcResult(rpc.method);
    json({ jsonrpc: "2.0", id: rpc.id, result });
  });
  function rpcResult(method: string | undefined) {
    return method === "tools/list"
      ? {
          tools: Array.from({ length: toolCount }, (_, index) => ({
            name: index ? `read_document_${index}` : "read_document",
            description: "Read a fixture document",
            inputSchema: { type: "object" },
          })),
        }
      : {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "connect-fixture", version: "1" },
        };
  }
  async function oauthResponse(
    url: URL,
    response: ServerResponse,
    json: (body: unknown, status?: number) => void,
  ): Promise<boolean> {
    if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
      json({ resource: `${origin}/mcp`, authorization_servers: [origin] });
      return true;
    }
    if (url.pathname === "/.well-known/oauth-authorization-server") {
      json({
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        registration_endpoint: `${origin}/register`,
      });
      return true;
    }
    if (url.pathname === "/register") {
      await registerClient(json);
      return true;
    }
    if (url.pathname === "/authorize") {
      consent(url, response);
      return true;
    }
    if (url.pathname === "/token") {
      if (tokenFailure) json({ error: "invalid_grant" }, 400);
      else {
        expired = false;
        json({ access_token: "fixture-key", token_type: "Bearer", expires_in: 3600 });
      }
      return true;
    }
    return false;
  }
  async function registerClient(json: (body: unknown, status?: number) => void) {
    if (registrationGate) {
      await registrationGate;
      json({ error: "temporarily_unavailable" }, 503);
    } else {
      json({ client_id: "connect-fixture", token_endpoint_auth_method: "none" });
    }
  }
  function consent(url: URL, response: ServerResponse) {
    const callback = new URL(url.searchParams.get("redirect_uri") ?? baseURL);
    callback.searchParams.set("state", url.searchParams.get("state") ?? "");
    const cancel = new URL(callback);
    cancel.searchParams.set("error", "access_denied");
    callback.searchParams.set("code", "fixture-code");
    response.writeHead(200, {
      "content-type": "text/html",
      ...(isolated ? { "cross-origin-opener-policy": "same-origin" } : {}),
    });
    response.end(
      `<html lang="en"><title>Local consent fixture</title><h1>Local consent fixture</h1><a href="${callback}">Approve</a><a href="${cancel}">Cancel sign-in</a></html>`,
    );
  }
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing peer port");
  origin = `http://127.0.0.1:${address.port}`;
  return {
    url: `${origin}/mcp`,
    unavailable: (value: boolean) => {
      unavailable = value;
    },
    expire: () => {
      expired = true;
    },
    tokenFailure: (value: boolean) => {
      tokenFailure = value;
    },
    failRegistrationAfter: (gate: Promise<void>) => {
      registrationGate = gate;
    },
    stop: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}

async function openAdd(page: Page, id: string, url: string, kind: MCPAuthKind = "oauth") {
  await page.goto(`/agents/${id}/mcp`);
  await page.getByRole("button", { name: "Add custom", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add custom connector", exact: true });
  await dialog.getByLabel("Connector address", { exact: true }).fill(url);
  await dialog
    .getByRole("radio", {
      name: kind === "none" ? "No authentication" : kind === "bearer" ? "API key or token" : "Account sign-in",
      exact: true,
    })
    .click();
  await dialog.getByRole("button", { name: "Connect", exact: true }).click();
  return dialog;
}
async function mounts(page: Page, id: string) {
  return (await (await page.request.get(`/api/v1/agents/${id}/mcp-servers`)).json()).servers as MCPAgentServer[];
}

async function expectReady(page: Page, id: string) {
  await expect
    .poll(async () => {
      const rows = await mounts(page, id);
      return (
        rows.length === 1 &&
        rows[0]?.authorization?.status === "active" &&
        rows[0]?.authorization.probeState === "succeeded"
      );
    })
    .toBe(true);
  await expect(page.locator('[data-ui="mcp-server-list"]')).toBeVisible();
  await expect(page.locator('[data-ui="mcp-server-list"]').getByText("Connected", { exact: true })).toHaveCount(0);
}

async function discoverPeer(page: Page, current: Awaited<ReturnType<typeof agent>>, url: string) {
  const fixture = { id: "" };
  // Rewrite only catalog identity; creation, deletion, credentials and provider calls remain real.
  await page.context().route("**/api/v1/mcp-servers", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const response = await route.fetch({ postData: { ...route.request().postDataJSON(), url } });
    if (!response.ok()) return route.fulfill({ response });
    const definition = await response.json();
    fixture.id = definition.id;
    await route.fulfill({ response, json: { ...definition, url: "https://mcp.linear.app/mcp" } });
  });
  await page.context().route("**/api/v1/mcp-servers/*", async (route) => {
    const response = await route.fetch();
    if (route.request().method() !== "GET" || !response.ok()) return route.fulfill({ response });
    const body = await response.json();
    await route.fulfill({ response, json: { ...body, server: { ...body.server, url: "https://mcp.linear.app/mcp" } } });
  });
  await page.context().route(`**/api/v1/agents/${current.id}/mcp-servers`, async (route) => {
    const response = await route.fetch();
    if (!response.ok()) return route.fulfill({ response });
    const body = await response.json();
    const identify = (entry: MCPAgentServer) =>
      entry.mcpServerId === fixture.id ? { ...entry, overridden: { ...entry.overridden, url: true } } : entry;
    await route.fulfill({
      response,
      json: body.servers ? { ...body, servers: body.servers.map(identify) } : identify(body),
    });
  });
  return fixture;
}

test("real API creates independent installations across Agents despite Account name conflicts", async ({ page }) => {
  const upstream = await peer("none");
  try {
    const first = await agent(page);
    const second = await agent(page);
    let nameConflicts = 0;
    page.on("response", (response) => {
      if (
        new URL(response.url()).pathname === "/api/v1/mcp-servers" &&
        response.request().method() === "POST" &&
        response.status() === 409
      )
        nameConflicts++;
    });
    const ids: string[] = [];
    for (const current of [first, second]) {
      const dialog = await openAdd(page, current.id, upstream.url, "none");
      await expect(dialog).toBeHidden();
      await expectReady(page, current.id);
      const installed = await mounts(page, current.id);
      expect(installed).toHaveLength(1);
      const id = installed[0]?.mcpServerId;
      if (!id) throw new Error("Missing independently created installation");
      ids.push(id);
    }
    expect(ids[0]).not.toBe(ids[1]);
    expect(nameConflicts).toBeGreaterThanOrEqual(1);
    const definitions = (await (await page.request.get("/api/v1/mcp-servers")).json()).servers as {
      id: string;
      name: string;
      url: string;
      boundAgentCount: number;
    }[];
    const own = definitions.filter((definition) => definition.url === upstream.url);
    expect(own).toHaveLength(2);
    expect(new Set(own.map((definition) => definition.name)).size).toBe(2);
    expect(own.map((definition) => definition.boundAgentCount)).toEqual([1, 1]);
    const duplicate = await openAdd(page, second.id, upstream.url, "none");
    await expect(duplicate).toBeHidden();
    expect(await mounts(page, second.id)).toHaveLength(1);
    const revoked = await page.request.delete(`/api/v1/agents/${first.id}/mcp-servers/${ids[0]}/authorization`, {
      headers: first.headers,
    });
    expect(revoked.ok()).toBeTruthy();
    expect((await mounts(page, first.id))[0]?.authorization).toMatchObject({ status: "revoked" });
    expect((await mounts(page, second.id))[0]?.authorization).toMatchObject({ kind: "none", status: "active" });
    await page.reload();
    await expectReady(page, second.id);
  } finally {
    await upstream.stop();
  }
});

for (const kind of ["bearer", "none"] as const) {
  test(`real local ${kind} failure preserves the appropriate installation lifecycle`, async ({ page }) => {
    const upstream = await peer(kind);
    try {
      const current = await agent(page);
      if (kind === "bearer") {
        const created = await page.request.post("/api/v1/mcp-servers", {
          headers: current.headers,
          data: { name: `key-${randomUUID()}`, url: upstream.url, defaultAuthKind: "bearer" },
        });
        expect(created.ok()).toBeTruthy();
        const serverId = ((await created.json()) as { id: string }).id;
        expect(
          (
            await page.request.post(`/api/v1/agents/${current.id}/mcp-servers`, {
              headers: current.headers,
              data: { mcpServerId: serverId, enabled: true },
            })
          ).ok(),
        ).toBeTruthy();
        await page.goto(`/agents/${current.id}/mcp`);
        await page.locator(".mcp-server-identity").click();
        await page.getByRole("dialog").getByRole("button", { name: "Authorize", exact: true }).click();
      } else upstream.unavailable(true);
      const dialog =
        kind === "bearer" ? page.getByRole("dialog") : await openAdd(page, current.id, upstream.url, "none");
      if (kind === "bearer") {
        await dialog.locator('input[type="password"]').fill("wrong-key");
        await dialog.getByRole("button", { name: "Save", exact: true }).click();
        await expect(dialog).toContainText("Authorization failed");
      } else await expect(dialog).toContainText("Couldn't load tools");
      const initial = await mounts(page, current.id);
      expect(initial).toHaveLength(1);
      await dialog.getByRole("button", { name: /^Close / }).click();
      await expect.poll(() => mounts(page, current.id)).toHaveLength(1);
      upstream.unavailable(false);
      await page.locator(".mcp-server-identity").click();
      if (kind === "bearer")
        await page.getByRole("dialog").getByRole("button", { name: "Update", exact: true }).click();
      if (kind === "bearer") {
        const retry = page.getByRole("dialog");
        await retry.locator('input[type="password"]').fill("fixture-key");
        await retry.getByRole("button", { name: "Save", exact: true }).click();
        await expect(retry.getByRole("button", { name: "Update", exact: true })).toBeVisible();
        await retry.getByRole("button", { name: /^Close / }).click();
      } else {
        await page.getByRole("dialog").getByRole("button", { name: "Retry", exact: true }).click();
        await expectReady(page, current.id);
        await page
          .getByRole("dialog")
          .getByRole("button", { name: /^Close / })
          .click();
      }
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expectReady(page, current.id);
      const final = await mounts(page, current.id);
      expect(final).toHaveLength(1);
      expect(final[0]?.mcpServerId).toBe(initial[0]?.mcpServerId);
    } finally {
      await upstream.stop();
    }
  });
}

test("real local OAuth popup cancellation removes new setup and reconnect retains its binding", async ({ page }) => {
  const upstream = await peer("oauth");
  try {
    const current = await agent(page);
    const firstWindow = page.waitForEvent("popup");
    const dialog = await openAdd(page, current.id, upstream.url);
    const cancelled = await firstWindow;
    await cancelled.getByRole("link", { name: "Cancel sign-in" }).click();
    await expect(dialog.getByRole("button", { name: "Connect", exact: true })).toBeEnabled();
    await expect.poll(() => mounts(page, current.id)).toHaveLength(0);
    const approveWindow = page.waitForEvent("popup");
    await dialog.getByRole("button", { name: "Connect", exact: true }).click();
    const approved = await approveWindow;
    await approved.getByRole("link", { name: "Approve", exact: true }).click();
    await expectReady(page, current.id);
    const initial = await mounts(page, current.id);
    expect(initial).toHaveLength(1);
    const serverId = initial[0]?.mcpServerId;
    const revoked = await page.request.delete(`/api/v1/agents/${current.id}/mcp-servers/${serverId}/authorization`, {
      headers: current.headers,
    });
    expect(revoked.ok()).toBeTruthy();
    await page.reload();
    await page.locator(".mcp-server-identity").click();
    const retryWindow = page.waitForEvent("popup");
    await page
      .getByRole("dialog")
      .getByRole("button", { name: /^(Authorize|Reauthorize)(?:: .+)?$/, exact: true })
      .click();
    const retry = await retryWindow;
    await retry.getByRole("link", { name: "Cancel sign-in" }).click();
    await expect(page.getByRole("button", { name: "Authorize", exact: true })).toBeEnabled();
    expect(await mounts(page, current.id)).toHaveLength(1);
    const failureWindow = page.waitForEvent("popup");
    await page.getByRole("button", { name: /^(Authorize|Reauthorize)(?:: .+)?$/, exact: true }).click();
    upstream.tokenFailure(true);
    await (await failureWindow).getByRole("link", { name: "Approve", exact: true }).click();
    await expect(
      page.locator('[data-ui="mcp-server-list"]').getByText("Authorization failed", { exact: true }),
    ).toBeVisible();
    upstream.tokenFailure(false);
    const finalWindow = page.waitForEvent("popup");
    await page.getByRole("button", { name: /^(Authorize|Reauthorize)(?:: .+)?$/, exact: true }).click();
    await (await finalWindow).getByRole("link", { name: "Approve", exact: true }).click();
    await expectReady(page, current.id);
    expect((await mounts(page, current.id))[0]?.mcpServerId).toBe(serverId);
    expect(await mounts(page, current.id)).toHaveLength(1);
  } finally {
    await upstream.stop();
  }
});

test("closing reauthorization keeps saved tools quiet without waiting for a background probe", async ({
  page,
}, testInfo) => {
  const upstream = await peer("oauth");
  try {
    const current = await agent(page);
    const initial = page.waitForEvent("popup");
    await openAdd(page, current.id, upstream.url);
    await (await initial).getByRole("link", { name: "Approve", exact: true }).click();
    await expectReady(page, current.id);
    const installed = (await mounts(page, current.id))[0];
    if (!installed) throw new Error("Missing working installation");
    await page.getByRole("button", { name: installed.name, exact: true }).click();
    const details = page.getByRole("dialog", { name: installed.name, exact: true });
    const opening = page.waitForEvent("popup");
    const pendingRead = page.waitForResponse(async (response) => {
      if (
        response.request().method() !== "GET" ||
        new URL(response.url()).pathname !== `/api/v1/agents/${current.id}/mcp-servers`
      )
        return false;
      const body = (await response.json()) as ListAgentMCPServersResponse;
      return body.servers.some(
        (row) => row.mcpServerId === installed.mcpServerId && row.authorization?.probeState === "pending",
      );
    });
    await details.getByRole("button", { name: "Reauthorize", exact: true }).click();
    const consent = await opening;
    await consent.getByRole("heading", { name: "Local consent fixture", exact: true }).waitFor();
    const pendingRows = (await (await pendingRead).json()) as ListAgentMCPServersResponse;
    const lastProbeAt = pendingRows.servers.find((row) => row.mcpServerId === installed.mcpServerId)?.authorization
      ?.probedAt;
    expect(lastProbeAt).toEqual(expect.any(String));
    await consent.close();
    await details.getByRole("button", { name: `Close ${installed.name}`, exact: true }).click();
    await expect(page.locator('[data-ui="mcp-server-list"]').getByText("Checking connection…")).toHaveCount(0);
    expect((await mounts(page, current.id))[0]?.authorization).toMatchObject({
      status: "active",
      hasCredential: true,
      probeState: "pending",
      probedAt: lastProbeAt,
    });
    await page.screenshot({ path: testInfo.outputPath("reauthorization-background.png") });
  } finally {
    await upstream.stop();
  }
});

for (const interruption of ["cancel", "close", "deny", "mobile Back"] as const) {
  test(`a working OAuth credential survives reauthorization interruption (${interruption})`, async ({ page }) => {
    const upstream = await peer("oauth");
    try {
      const current = await agent(page);
      const initial = page.waitForEvent("popup");
      await openAdd(page, current.id, upstream.url);
      await (await initial).getByRole("link", { name: "Approve", exact: true }).click();
      await expectReady(page, current.id);
      const installed = (await mounts(page, current.id))[0];
      if (!installed) throw new Error("Missing working installation");
      const mobile = interruption === "mobile Back";
      if (mobile) await page.setViewportSize({ width: 390, height: 844 });
      await page.getByRole("button", { name: installed.name, exact: true }).click();
      const details = page.getByRole("dialog", { name: installed.name, exact: true });
      const opening = mobile ? undefined : page.waitForEvent("popup");
      await details.getByRole("button", { name: "Reauthorize", exact: true }).click();
      const consent = opening ? await opening : page;
      await consent.getByRole("heading", { name: "Local consent fixture", exact: true }).waitFor();
      if (interruption === "cancel") await details.getByRole("button", { name: "Cancel", exact: true }).click();
      else if (interruption === "close") await consent.close();
      else if (interruption === "deny")
        await consent.getByRole("link", { name: "Cancel sign-in", exact: true }).click();
      else await page.goBack();
      await expect
        .poll(async () => (await mounts(page, current.id))[0]?.authorization)
        .toMatchObject({ kind: "oauth", status: "active", hasCredential: true });
      const probe = await page.request.post(`/api/v1/agents/${current.id}/mcp-servers/${installed.mcpServerId}/probe`, {
        headers: current.headers,
      });
      expect(probe.ok()).toBeTruthy();
      expect((await probe.json()).probeState).toBe("succeeded");
      expect((await mounts(page, current.id))[0]?.mcpServerId).toBe(installed.mcpServerId);
    } finally {
      await upstream.stop();
    }
  });
}

test("Discover retains search across a real OAuth cancellation and successful retry", async ({ page }) => {
  const upstream = await peer("oauth");
  try {
    const current = await agent(page);
    const discovery = await discoverPeer(page, current, upstream.url);
    await page.goto(`/agents/${current.id}/mcp`);
    await page.getByRole("button", { name: "Discover", exact: true }).click();
    const discover = page.getByRole("dialog", { name: "Discover", exact: true });
    await discover.getByLabel("Search connectors", { exact: true }).fill("Linear");
    await expectAccessible(page);
    await page.screenshot({ path: test.info().outputPath("discover-add-icon-desktop.png") });
    const cancellation = page.waitForEvent("popup");
    await discover.getByRole("button", { name: "Add: Linear", exact: true }).click();
    const popup = await cancellation;
    await popup.getByRole("link", { name: "Cancel sign-in" }).click();
    await expect(discover.getByRole("button", { name: "Add: Linear", exact: true })).toBeEnabled();
    await expect.poll(() => mounts(page, current.id)).toHaveLength(0);
    await expect(discover.getByLabel("Search connectors", { exact: true })).toHaveValue("Linear");
    const success = page.waitForEvent("popup");
    await discover.getByRole("button", { name: "Add: Linear", exact: true }).click();
    await (await success).getByRole("link", { name: "Approve", exact: true }).click();
    await expect(discover.getByRole("img", { name: "Added", exact: true })).toBeVisible();
    await expect(discover.getByLabel("Search connectors", { exact: true })).toHaveValue("Linear");
    expect((await mounts(page, current.id))[0]?.mcpServerId).toBe(discovery.id);
    await page.screenshot({ path: test.info().outputPath("discover-oauth-connected.png") });
    await discover.getByRole("button", { name: "Close Discover", exact: true }).click();
    await expectReady(page, current.id);
    await expect(page.locator('[data-ui="mcp-server-row"]')).not.toHaveClass(/bg-kumo-tint/);
  } finally {
    await upstream.stop();
  }
});

function mcpEntrySources(
  kind: MCPAuthKind,
  first: string,
  second: string,
  third: string,
): [string, "add" | "discover" | "list"][] {
  const sources: [string, "add" | "discover" | "list"][] = [[third, "list"]];
  if (kind === "oauth") sources.unshift([first, "add"], [second, "discover"]);
  return sources;
}

async function startCatalogConnection(page: Page, source: "add" | "discover" | "list", kind: MCPAuthKind, url: string) {
  if (source === "add") {
    await page.getByRole("button", { name: "Add custom", exact: true }).click();
    await page.getByLabel("Connector address", { exact: true }).fill(url);
    await page.getByRole("dialog").getByRole("button", { name: "Connect", exact: true }).click();
  } else if (source === "discover") {
    await page.getByRole("button", { name: "Discover", exact: true }).click();
    await page.getByRole("button", { name: "Add: Linear", exact: true }).click();
  } else {
    await page.locator(".mcp-server-identity").click();
    if (kind === "oauth")
      await page.getByRole("dialog").getByRole("button", { name: "Authorize", exact: true }).click();
  }
}

/** Compare all three UI entries against the same definition; MCP/OAuth management responses are fixtures. */
for (const kind of ["oauth", "bearer", "none"] as const) {
  test(`catalog additions and existing ${kind} list connections retain their authentication behavior`, async ({
    page,
  }) => {
    const first = await agent(page);
    const second = await agent(page);
    const third = await agent(page);
    // New catalog installations use OAuth; existing list connections retain their method.
    const serverId = randomUUID();
    const stamp = "2026-10-12T00:00:00.000Z";
    const definition = {
      id: serverId,
      name: "linear",
      url: "https://mcp.linear.app/mcp",
      description: null,
      defaultAuthKind: kind,
      authHeader: "authorization",
      authScheme: "Bearer",
      extraHeaders: {},
      revision: 1,
      boundAgentCount: 0,
      authorizedAgentCount: 0,
      lastProbedAt: null,
      createdAt: stamp,
      updatedAt: stamp,
    };
    const binding = {
      mcpServerId: serverId,
      name: definition.name,
      description: null,
      discoveredDescription: null,
      enabled: true,
      effective: {
        url: definition.url,
        authHeader: definition.authHeader,
        authScheme: definition.authScheme,
        extraHeaders: {},
      },
      overridden: { url: false, authHeader: false, authScheme: false, extraHeaders: false },
      authorization: null as unknown,
      snapshot: null as unknown,
      createdAt: stamp,
      updatedAt: stamp,
    };
    const entries = new Map<string, (typeof binding)[]>([[third.id, [{ ...binding }]]]);
    const writes: string[] = [];
    await page.route(/\/api\/v1\/(?:agents\/[^/]+\/)?mcp-servers(?:\/.*)?$/, async (route) => {
      const path = new URL(route.request().url()).pathname;
      const method = route.request().method();
      if (method !== "GET") writes.push(path);
      if (await respondDefinition(route, path)) return;
      const id = path.split("/")[4] ?? "";
      const list = fixtureEntries(id);
      if (await respondCollection(route, path, method, list)) return;
      if (await respondRemoval(route, path, method, list)) return;
      const current = list[0];
      if (!current) throw new Error("Missing fixture binding");
      await respondBinding(route, current, path);
    });
    async function respondCollection(route: Route, path: string, method: string, list: (typeof binding)[]) {
      if (!path.endsWith("/mcp-servers")) return false;
      if (method !== "GET") list.push({ ...binding });
      await route.fulfill({ json: method === "GET" ? { servers: list } : list[0] });
      return true;
    }
    async function respondRemoval(route: Route, path: string, method: string, list: (typeof binding)[]) {
      if (method !== "DELETE" || !path.endsWith(serverId)) return false;
      list.splice(0);
      await route.fulfill({ status: 204 });
      return true;
    }
    function fixtureEntries(id: string) {
      const list = entries.get(id) ?? [];
      entries.set(id, list);
      return list;
    }
    async function respondDefinition(route: Route, path: string): Promise<boolean> {
      if (path === "/api/v1/mcp-servers") {
        await route.fulfill({ json: route.request().method() === "POST" ? definition : { servers: [definition] } });
        return true;
      }
      if (path === `/api/v1/mcp-servers/${serverId}`) {
        await route.fulfill({ json: { server: definition, agents: [] } });
        return true;
      }
      return false;
    }
    async function respondBinding(route: Route, current: typeof binding, path: string) {
      if (path.endsWith("/authorization/oauth")) {
        await route.fulfill({ status: 503, json: { error: { message: "Fixture OAuth start unavailable" } } });
        return;
      }
      if (path.endsWith("/authorization")) {
        if (route.request().method() === "DELETE") {
          current.authorization = null;
          await route.fulfill({ json: current });
          return;
        }
        current.authorization = {
          kind,
          status: "active",
          hasCredential: kind !== "none",
          scopes: null,
          accessTokenExpiresAt: null,
          authorizationServer: null,
          probeState: "succeeded",
          probedAt: null,
          probeError: null,
          toolsCount: 1,
          toolsTruncated: false,
          failureCode: null,
          revision: 1,
        };
        await route.fulfill({ json: current });
        return;
      }
      current.authorization = { ...(current.authorization as object), probeState: "succeeded", toolsCount: 1 };
      current.snapshot = {
        protocolEra: "modern",
        protocolVersion: "2026-07-28",
        serverInfo: null,
        capabilities: null,
        instructions: null,
        tools: [{ name: "read_document", description: null, inputSchema: null }],
      };
      await route.fulfill({
        json: {
          probeState: "succeeded",
          probeError: null,
          toolsCount: 1,
          toolsTruncated: false,
          protocolEra: "modern",
          protocolVersion: "2026-07-28",
        },
      });
    }
    const oauthFailureCopy = {
      add: "Authorization failed",
      discover: "Authorization failed",
      list: "Authorization failed",
    };
    const sources = mcpEntrySources(kind, first.id, second.id, third.id);
    const addedCount = Number(kind === "oauth") * 2;
    for (const [id, source] of sources) {
      await page.goto(`/agents/${id}/mcp`);
      await startCatalogConnection(page, source, kind, definition.url);
      if (kind === "oauth") {
        await expect(page.getByRole("dialog").getByText(oauthFailureCopy[source], { exact: true })).toBeVisible();
        await expect(page.getByRole("radio")).toHaveCount(source === "add" ? 3 : 0);
      } else if (kind === "bearer") {
        const dialog = page.getByRole("dialog");
        const input = dialog.locator('input[type="password"]');
        await expect(input).toBeVisible();
        await expect(dialog.getByRole("radio")).toHaveCount(0);
        await input.fill("fixture-key");
        await dialog.getByRole("button", { name: "Save", exact: true }).click();
        await expect(dialog.getByRole("button", { name: "Update", exact: true })).toBeVisible();
        await dialog.getByRole("button", { name: "Close Linear", exact: true }).click();
      }
      if (kind === "none") {
        const dialog = page.getByRole("dialog");
        await dialog.getByRole("button", { name: "Save", exact: true }).click();
        await dialog.getByRole("button", { name: "Close Linear", exact: true }).click();
      }
      if (kind !== "oauth") {
        await expect
          .poll(() => (entries.get(id)?.[0]?.authorization as { probeState?: string })?.probeState)
          .toBe("succeeded");
        await expect(
          page
            .locator('[data-ui="mcp-server-list"]')
            .getByRole("button", { name: /^(Authorize|Reauthorize|Retry)(?:: .+)?$/ }),
        ).toHaveCount(0);
      }
      expect(entries.get(id)).toHaveLength(1);
    }
    expect(writes.filter((path) => path === "/api/v1/mcp-servers")).toHaveLength(addedCount);
    expect(writes.filter((path) => path.startsWith("/api/v1/agents/") && path.endsWith("/mcp-servers"))).toHaveLength(
      addedCount,
    );
  });
}

for (const width of [320, 390, 768, 1440]) {
  test(`keyboard and custom authentication settings at ${width}px`, async ({ page }) => {
    const upstream = await peer("none");
    try {
      const current = await agent(page);
      const name = `public-${width}-${randomUUID().slice(0, 6)}`;
      const created = await page.request.post("/api/v1/mcp-servers", {
        headers: current.headers,
        data: { name, url: upstream.url, defaultAuthKind: "bearer" },
      });
      expect(created.ok()).toBeTruthy();
      const serverId = ((await created.json()) as { id: string }).id;
      expect(
        (
          await page.request.post(`/api/v1/agents/${current.id}/mcp-servers`, {
            headers: current.headers,
            data: { mcpServerId: serverId, enabled: true },
          })
        ).ok(),
      ).toBeTruthy();
      await page.setViewportSize({ width, height: 844 });
      await page.goto(`/agents/${current.id}/mcp`);
      const row = page.locator('[data-ui="mcp-server-row"]');
      const controls = row.locator(".mcp-server-controls");
      await expect(row.getByText("Authorization required", { exact: true })).toBeVisible();
      await expect(controls.getByRole("switch")).toHaveCount(0);
      await expect(controls.getByRole("button", { name: `Authorize: ${name}`, exact: true })).toBeVisible();
      await expect(controls.getByRole("button", { name: `Remove ${name}`, exact: true })).toBeVisible();
      const rowBox = await row.boundingBox();
      const controlBox = await controls.boundingBox();
      if (!rowBox || !controlBox) throw new Error("Missing connector row geometry");
      if (width >= 768)
        expect(Math.abs(rowBox.y + rowBox.height / 2 - controlBox.y - controlBox.height / 2)).toBeLessThan(1);
      else expect(controlBox.y + controlBox.height).toBeLessThanOrEqual(rowBox.y + rowBox.height);
      await page.screenshot({ path: test.info().outputPath(`mcp-row-${width}.png`) });
      await page.getByRole("button", { name, exact: true }).focus();
      await page.keyboard.press("Enter");
      const dialog = page.getByRole("dialog");
      await dialog.getByRole("button", { name: "Authorize", exact: true }).click();
      const key = dialog.locator('input[type="password"]');
      await expect(key).toHaveAccessibleName("API key or token");
      await key.click();
      await expect(key).toBeFocused();
      await expect(dialog.getByRole("radio")).toHaveCount(3);
      await expectWithinViewport(dialog);
      await expectWithinViewport(dialog.getByRole("button", { name: "Save", exact: true }));
      await expectNoPageOverflow(page);
      await expectAccessible(page);
      await page.screenshot({ path: test.info().outputPath(`mcp-authentication-${width}.png`) });
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      await expect(page.getByRole("button", { name, exact: true })).toBeFocused();
      await row.getByText("Authorization required", { exact: true }).click();
      await dialog.getByRole("radio", { name: "No authentication", exact: true }).click();
      await dialog.getByRole("button", { name: "Save", exact: true }).click();
      await expect.poll(async () => (await mounts(page, current.id))[0]?.authorization?.kind).toBe("none");
      await expect(dialog.getByRole("button", { name: "Tools", exact: true })).toHaveCount(0);
      await dialog.getByRole("button", { name: `Close ${name}`, exact: true }).click();
      const disabled = await page.request.patch(`/api/v1/agents/${current.id}/mcp-servers/${serverId}`, {
        headers: current.headers,
        data: { enabled: false },
      });
      expect(disabled.ok()).toBeTruthy();
      await page.reload();
      await expect(row.getByText("Disabled", { exact: true })).toBeVisible();
      await expect(page.locator('[data-ui="mcp-server-row"] .mcp-server-controls')).not.toContainText(
        /Authorize|Retry|Cancel/,
      );
      await row.getByRole("button", { name: `Resume: ${name}`, exact: true }).click();
      await expect(row.getByRole("button", { name: `Resume: ${name}`, exact: true })).toHaveCount(0);
      await expectReady(page, current.id);
      expect((await mounts(page, current.id))[0]?.authorization?.kind).toBe("none");
    } finally {
      await upstream.stop();
    }
  });
}

test("OAuth callback survives a provider isolating its browsing context", async ({ page }) => {
  const upstream = await peer("oauth", true);
  try {
    const current = await agent(page);
    const opening = page.waitForEvent("popup");
    const dialog = await openAdd(page, current.id, upstream.url);
    const popup = await opening;
    await popup.getByRole("heading", { name: "Local consent fixture" }).waitFor();
    // Let the closed-window monitor run while the provider applies its isolation policy.
    await popup.waitForTimeout(1200);
    await expect(dialog).toContainText("Authorizing…");
    await popup.getByRole("link", { name: "Approve", exact: true }).click();
    await expectReady(page, current.id);
  } finally {
    await upstream.stop();
  }
});

test("mobile Discover restores search after cancellation, browser Back, and successful consent", async ({ page }) => {
  const upstream = await peer("oauth");
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    const current = await agent(page);
    const discovery = await discoverPeer(page, current, upstream.url);
    await page.goto(`/agents/${current.id}/mcp`);
    await page.getByRole("button", { name: "Discover", exact: true }).click();
    const discover = page.getByRole("dialog", { name: "Discover", exact: true });
    await discover.getByLabel("Search connectors", { exact: true }).fill("Linear");
    await expectAccessible(page);
    await page.screenshot({ path: test.info().outputPath("discover-add-icon-mobile.png") });
    await discover.getByRole("button", { name: "Add: Linear", exact: true }).click();
    await page.getByRole("link", { name: "Cancel sign-in" }).click();
    await expect(discover.getByLabel("Search connectors", { exact: true })).toHaveValue("Linear");
    await expect.poll(() => mounts(page, current.id)).toHaveLength(0);
    await discover.getByRole("button", { name: "Add: Linear", exact: true }).click();
    await page.getByRole("heading", { name: "Local consent fixture" }).waitFor();
    await page.goBack();
    await expect(discover.getByLabel("Search connectors", { exact: true })).toHaveValue("Linear");
    await expect.poll(() => mounts(page, current.id)).toHaveLength(0);
    await discover.getByRole("button", { name: "Add: Linear", exact: true }).click();
    await page.getByRole("link", { name: "Approve", exact: true }).click();
    await expect(discover.getByRole("img", { name: "Added", exact: true })).toBeVisible();
    await expect(discover.getByLabel("Search connectors", { exact: true })).toHaveValue("Linear");
    expect((await mounts(page, current.id))[0]?.mcpServerId).toBe(discovery.id);
    await expectAccessible(page);
    await expectNoPageOverflow(page);
    await page.screenshot({ path: test.info().outputPath("discover-oauth-mobile-connected.png") });
  } finally {
    await upstream.stop();
  }
});

test("explicit cancellation removes new setup and ignores a late callback", async ({ page }) => {
  const upstream = await peer("oauth");
  try {
    const current = await agent(page);
    const opening = page.waitForEvent("popup");
    const dialog = await openAdd(page, current.id, upstream.url);
    const popup = await opening;
    const approve = await popup.getByRole("link", { name: "Approve", exact: true }).getAttribute("href");
    if (!approve) throw new Error("Missing local callback");
    await dialog.getByRole("button", { name: "Cancel", exact: true }).first().click();
    await expect(dialog.getByRole("button", { name: "Connect", exact: true })).toBeEnabled();
    await expect.poll(() => mounts(page, current.id)).toHaveLength(0);
    await page.request.get(approve);
    expect(await mounts(page, current.id)).toHaveLength(0);
  } finally {
    await upstream.stop();
  }
});

test("changing Add custom input preserves the submitted installation when the dialog closes", async ({ page }) => {
  const upstream = await peer("none");
  try {
    const current = await agent(page);
    upstream.unavailable(true);
    const dialog = await openAdd(page, current.id, upstream.url, "none");
    await expect(dialog).toContainText("Couldn't load tools");
    expect(await mounts(page, current.id)).toHaveLength(1);
    await dialog.getByLabel("Connector address", { exact: true }).fill("https://another.example/mcp");
    await dialog.getByRole("button", { name: "Close Add custom connector", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect.poll(() => mounts(page, current.id)).toHaveLength(1);
    expect((await mounts(page, current.id))[0]?.effective.url).toBe(upstream.url);
  } finally {
    await upstream.stop();
  }
});

test("editing Add custom away and back retries the submitted installation without duplicating it", async ({ page }) => {
  const upstream = await peer("none");
  try {
    const current = await agent(page);
    upstream.unavailable(true);
    const dialog = await openAdd(page, current.id, upstream.url, "none");
    await expect(dialog).toContainText("Couldn't load tools");
    const initial = await mounts(page, current.id);
    expect(initial).toHaveLength(1);
    await dialog.getByLabel("Connector address", { exact: true }).fill(`${upstream.url}x`);
    await dialog.getByLabel("Connector address", { exact: true }).fill(upstream.url);
    upstream.unavailable(false);
    await dialog.getByRole("button", { name: "Connect", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect
      .poll(async () => (await mounts(page, current.id)).map((entry) => entry.mcpServerId))
      .toEqual(initial.map((entry) => entry.mcpServerId));
    await expectReady(page, current.id);
  } finally {
    await upstream.stop();
  }
});

for (const returnMode of ["mobile", "blocked popup"] as const) {
  test(`Details OAuth returns to the same connector with ${returnMode}`, async ({ page }) => {
    const upstream = await peer("oauth", false, 20);
    try {
      const current = await agent(page);
      const opening = page.waitForEvent("popup");
      await openAdd(page, current.id, upstream.url);
      await (await opening).getByRole("link", { name: "Approve", exact: true }).click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expectReady(page, current.id);
      const installed = (await mounts(page, current.id))[0];
      if (!installed) throw new Error("Missing connected fixture");
      const serverId = installed.mcpServerId;
      const name = installed.name;
      upstream.expire();
      expect(
        (
          await page.request.post(`/api/v1/agents/${current.id}/mcp-servers/${serverId}/probe`, {
            headers: current.headers,
          })
        ).ok(),
      ).toBeTruthy();
      await page.setViewportSize({ width: returnMode === "mobile" ? 390 : 1440, height: 844 });
      await page.reload();
      await page.getByRole("button", { name, exact: true }).click();
      const details = page.getByRole("dialog", { name, exact: true });
      await expect(details.getByRole("button", { name: "Tools", exact: true })).toHaveCount(0);
      if (returnMode === "blocked popup")
        await page.evaluate(() => {
          const open = window.open;
          let blocked = true;
          window.open = (...args) => {
            if (blocked) {
              blocked = false;
              return null;
            }
            return open.apply(window, args);
          };
        });
      await details.getByRole("button", { name: "Reauthorize", exact: true }).click();
      let consent = page;
      if (returnMode === "blocked popup") {
        const reopened = page.waitForEvent("popup");
        await details.getByRole("button", { name: "Open window", exact: true }).click();
        consent = await reopened;
      }
      await consent.getByRole("link", { name: "Approve", exact: true }).click();
      await expect(details).toBeVisible();
      await expect(details.getByLabel("Connector address", { exact: true })).toHaveValue(upstream.url);
      await expect(details.getByRole("radio", { name: "Account sign-in", exact: true })).toBeChecked();
      await expectReady(page, current.id);
      expect((await mounts(page, current.id))[0]?.mcpServerId).toBe(serverId);
      await expectNoPageOverflow(page);
      await expectAccessible(page);
    } finally {
      await upstream.stop();
    }
  });
}

const discoverCopy = {
  en: {
    title: "Discover",
    empty: "No connectors yet",
    close: "Close Discover",
    search: "Search connectors",
    add: "Add: Linear",
    preparing: "Authorizing…",
    cancel: "Cancel: Linear",
    reconnect: "Authorize: Linear",
    failed: "Authorization failed",
  },
  zh: {
    title: "发现",
    empty: "暂无连接器",
    close: "关闭 发现",
    search: "搜索连接器",
    add: "添加: Linear",
    preparing: "正在授权…",
    cancel: "取消: Linear",
    reconnect: "授权: Linear",
    failed: "授权失败",
  },
} as const;

async function expectAddContrast(button: import("@playwright/test").Locator) {
  const colors = await button.evaluate((element) => {
    const style = getComputedStyle(element);
    const background =
      style.backgroundColor === "rgba(0, 0, 0, 0)"
        ? getComputedStyle(element.closest("li") as HTMLElement).backgroundColor
        : style.backgroundColor;
    return { foreground: style.color, background };
  });
  const luminance = (color: string) => {
    const values = (color.match(/[\d.]+/g) ?? [])
      .slice(0, 3)
      .map(Number)
      .map((value) => {
        const channel = value / 255;
        return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
      });
    return (values[0] ?? 0) * 0.2126 + (values[1] ?? 0) * 0.7152 + (values[2] ?? 0) * 0.0722;
  };
  const foreground = luminance(colors.foreground);
  const background = luminance(colors.background);
  expect(
    (Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05),
    "add icon contrast",
  ).toBeGreaterThanOrEqual(3);
  return colors;
}

for (const locale of ["en", "zh"] as const) {
  for (const width of [320, 390, 768, 1440]) {
    test(`Discover visual and interaction states in ${locale} at ${width}px`, async ({ page }) => {
      const upstream = await peer("oauth");
      let release = () => {};
      try {
        await page.addInitScript((language) => localStorage.setItem("PARAGLIDE_LOCALE", language), locale);
        await page.setViewportSize({ width, height: 844 });
        const current = await agent(page);
        await discoverPeer(page, current, upstream.url);
        const gate = new Promise<void>((resolve) => {
          release = resolve;
        });
        upstream.failRegistrationAfter(gate);
        await page.goto(`/agents/${current.id}/mcp`);
        const copy = discoverCopy[locale];
        await expect(page.getByRole("heading", { name: copy.empty, exact: true })).toBeVisible();
        await expect(page.locator('[data-ui="mcp-quick-start"]')).toHaveCount(0);
        await expectNoPageOverflow(page);
        await expectAccessible(page);
        await page.screenshot({ path: test.info().outputPath(`empty-${locale}-${width}.png`) });
        await page.getByRole("button", { name: copy.title, exact: true }).click();
        const dialog = page.getByRole("dialog", { name: copy.title, exact: true });
        await dialog.getByLabel(copy.search, { exact: true }).fill("Linear");
        const add = dialog.getByRole("button", { name: copy.add, exact: true });
        const box = await add.boundingBox();
        if (!box) throw new Error("Missing add control");
        expect(Math.min(box.width, box.height)).toBeGreaterThanOrEqual(width < 768 ? 44 : 24);
        await expectAddContrast(add);
        await add.hover();
        await expectAddContrast(add);
        await add.focus();
        await page.keyboard.press("Tab");
        await expect(dialog.getByRole("button", { name: copy.close, exact: true })).toBeFocused();
        await page.keyboard.press("Shift+Tab");
        await expect(add).toBeFocused();
        const focus = await add.evaluate((element) => {
          const style = getComputedStyle(element);
          return { visible: element.matches(":focus-visible"), outline: style.outlineStyle, shadow: style.boxShadow };
        });
        expect(focus.visible).toBe(true);
        expect(focus.outline !== "none" || focus.shadow !== "none", "visible keyboard focus").toBe(true);
        await expectWithinViewport(dialog);
        await expectWithinViewport(add);
        await expectNoPageOverflow(page);
        await expectAccessible(page);
        await dialog.screenshot({ path: test.info().outputPath(`discover-${locale}-${width}-ready.png`) });
        const card = dialog.getByRole("listitem").filter({ has: page.getByText("Linear", { exact: true }) });
        const height = (await card.boundingBox())?.height;
        const opening = width > 640 ? page.waitForEvent("popup") : undefined;
        await add.click();
        await expect(card.getByRole("status")).toHaveText(copy.preparing);
        await expect(card.getByRole("button", { name: copy.cancel, exact: true })).toBeEnabled();
        await expect(dialog.getByLabel(copy.search, { exact: true })).toBeEnabled({ enabled: width > 640 });
        await expect.poll(async () => (await card.boundingBox())?.height).toBe(height);
        await expectWithinViewport(dialog);
        await expectAccessible(page);
        await dialog.screenshot({ path: test.info().outputPath(`discover-${locale}-${width}-preparing.png`) });
        if (opening) {
          const popup = await opening;
          await page.context().unroute("**/api/v1/mcp-servers");
          expect(popup.url()).toBe("about:blank");
          await expect(popup.locator("body")).toBeEmpty();
        }
        release();
        await expect(card.getByRole("alert")).toHaveText(copy.failed);
        await expect(card.getByRole("button", { name: copy.reconnect, exact: true })).toBeEnabled();
        await expect.poll(async () => (await card.boundingBox())?.height).toBe(height);
        await expect.poll(() => mounts(page, current.id)).toHaveLength(1);
        await expect(dialog.getByLabel(copy.search, { exact: true })).toHaveValue("Linear");
        await expectAccessible(page);
        await expectNoPageOverflow(page);
        await dialog.screenshot({ path: test.info().outputPath(`discover-${locale}-${width}-error.png`) });
      } finally {
        release();
        await upstream.stop();
      }
    });
  }
}
