import { randomUUID } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import type { MCPAuthKind } from "@opentag/shared/browser";
import type { Page, Route } from "@playwright/test";
import { baseURL } from "../playwright.config.js";
import { expectAccessible, expectNoPageOverflow, expectWithinViewport } from "./browser-contract.js";
import { expect, smokeTest as test } from "./fixtures.js";

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

async function openAdd(page: Page, id: string, url: string) {
  await page.goto(`/agents/${id}/mcp`);
  await page.getByRole("button", { name: "Add custom", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Add custom connector", exact: true });
  await dialog.getByLabel("Connector URL", { exact: true }).fill(url);
  await dialog.getByRole("button", { name: "Connect", exact: true }).click();
  return dialog;
}
async function mounts(page: Page, id: string) {
  return (await (await page.request.get(`/api/v1/agents/${id}/mcp-servers`)).json()).servers as {
    mcpServerId: string;
    authorization: { kind: MCPAuthKind } | null;
  }[];
}

async function discoverPeer(page: Page, current: Awaited<ReturnType<typeof agent>>, url: string) {
  const created = await page.request.post("/api/v1/mcp-servers", {
    headers: current.headers,
    data: { name: `discover-${randomUUID()}`, url: url, defaultAuthKind: "oauth" },
  });
  expect(created.ok()).toBeTruthy();
  const serverId = ((await created.json()) as { id: string }).id;
  // Reuse a real local peer through one catalog entry, without contacting an external provider.
  await page.context().route("**/api/v1/mcp-servers", async (route) => {
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({
      response,
      json: {
        ...body,
        servers: body.servers.map((server: { id: string }) =>
          server.id === serverId ? { ...server, url: "https://mcp.linear.app/mcp" } : server,
        ),
      },
    });
  });
  return serverId;
}

for (const kind of ["bearer", "none"] as const) {
  test(`real local ${kind} failure retries without creating or binding twice`, async ({ page }) => {
    const upstream = await peer(kind);
    try {
      const current = await agent(page);
      if (kind === "bearer") {
        const created = await page.request.post("/api/v1/mcp-servers", {
          headers: current.headers,
          data: { name: `key-${randomUUID()}`, url: upstream.url, defaultAuthKind: "bearer" },
        });
        expect(created.ok()).toBeTruthy();
      } else upstream.unavailable(true);
      const dialog = await openAdd(page, current.id, upstream.url);
      if (kind === "bearer") {
        await expect(dialog.getByLabel("API key", { exact: true })).toBeFocused();
        await dialog.getByLabel("API key", { exact: true }).fill("wrong-key");
        await dialog.getByRole("button", { name: "Connect", exact: true }).click();
        await expect(dialog).toContainText("Invalid API key. Try again.");
      } else await expect(dialog).toContainText("Couldn’t load tools. Try again.");
      const initial = await mounts(page, current.id);
      expect(initial).toHaveLength(1);
      await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect.poll(() => mounts(page, current.id)).toHaveLength(0);
      if (kind === "none") upstream.unavailable(false);
      const retryDialog = await openAdd(page, current.id, upstream.url);
      if (kind === "bearer") {
        const input = retryDialog.getByLabel("API key", { exact: true });
        await expect(input).toBeFocused();
        await input.fill("fixture-key");
        await retryDialog.getByRole("button", { name: "Connect", exact: true }).click();
      }
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(page.locator('[data-ui="mcp-server-list"]')).toContainText("Connected");
      await expect(page.locator(`[id="mcp-server-${initial[0]?.mcpServerId}"]`)).toBeFocused();
      expect(await mounts(page, current.id)).toHaveLength(1);
      expect((await mounts(page, current.id))[0]?.mcpServerId).toBe(initial[0]?.mcpServerId);
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
    await expect(dialog).toContainText("Sign-in was cancelled. You can try again.");
    await expect.poll(() => mounts(page, current.id)).toHaveLength(0);
    const approveWindow = page.waitForEvent("popup");
    await dialog.getByRole("button", { name: "Connect", exact: true }).click();
    const approved = await approveWindow;
    await approved.getByRole("link", { name: "Approve", exact: true }).click();
    await expect(page.locator('[data-ui="mcp-server-list"]')).toContainText("Connected");
    const initial = await mounts(page, current.id);
    expect(initial).toHaveLength(1);
    const serverId = initial[0]?.mcpServerId;
    const revoked = await page.request.delete(`/api/v1/agents/${current.id}/mcp-servers/${serverId}/authorization`, {
      headers: current.headers,
    });
    expect(revoked.ok()).toBeTruthy();
    await page.reload();
    const retryWindow = page.waitForEvent("popup");
    await page.getByRole("button", { name: "Reconnect", exact: true }).click();
    const retry = await retryWindow;
    await retry.getByRole("link", { name: "Cancel sign-in" }).click();
    await expect(page.getByText("Sign-in was cancelled. You can try again.")).toBeVisible();
    expect(await mounts(page, current.id)).toHaveLength(1);
    const failureWindow = page.waitForEvent("popup");
    await page.getByRole("button", { name: "Reconnect", exact: true }).click();
    upstream.tokenFailure(true);
    await (await failureWindow).getByRole("link", { name: "Approve", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("Couldn’t start sign-in. Try again.");
    upstream.tokenFailure(false);
    const finalWindow = page.waitForEvent("popup");
    await page.getByRole("button", { name: "Reconnect", exact: true }).click();
    await (await finalWindow).getByRole("link", { name: "Approve", exact: true }).click();
    await expect(page.locator('[data-ui="mcp-server-list"]')).toContainText("Connected");
    expect((await mounts(page, current.id))[0]?.mcpServerId).toBe(serverId);
    expect(await mounts(page, current.id)).toHaveLength(1);
  } finally {
    await upstream.stop();
  }
});

test("Discover retains search across a real OAuth cancellation and successful retry", async ({ page }) => {
  const upstream = await peer("oauth");
  try {
    const current = await agent(page);
    const serverId = await discoverPeer(page, current, upstream.url);
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
    await expect(discover).toContainText("Connected");
    await expect(discover.getByLabel("Search connectors", { exact: true })).toHaveValue("Linear");
    expect((await mounts(page, current.id))[0]?.mcpServerId).toBe(serverId);
    await page.screenshot({ path: test.info().outputPath("discover-oauth-connected.png") });
    await discover.getByRole("button", { name: "Close Discover", exact: true }).click();
    await expect(page.locator('[data-ui="mcp-server-list"]')).toContainText("Connected");
    await expect(page.locator('[data-ui="mcp-server-row"]')).not.toHaveClass(/outline-kumo-ring/);
  } finally {
    await upstream.stop();
  }
});

/** Compare all three UI entries against the same definition; MCP/OAuth management responses are fixtures. */
for (const kind of ["oauth", "bearer", "none"] as const) {
  test(`Add, Discover and list use the same configured ${kind} path`, async ({ page }) => {
    const first = await agent(page);
    const second = await agent(page);
    const third = await agent(page);
    // A shipped catalog URL is used only to exercise Discover's exact definition reuse.
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
        await route.fulfill({ json: { servers: [definition] } });
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
        current.authorization = {
          kind,
          status: "active",
          hasCredential: kind !== "none",
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
      add: "Couldn’t start sign-in. Try again.",
      discover: "Connection failed",
      list: "Couldn’t start sign-in. Try again.",
    };
    for (const [id, source] of [
      [first.id, "add"],
      [second.id, "discover"],
      [third.id, "list"],
    ] as const) {
      await page.goto(`/agents/${id}/mcp`);
      if (source === "add") {
        await page.getByRole("button", { name: "Add custom", exact: true }).click();
        await page.getByLabel("Connector URL", { exact: true }).fill(definition.url);
        await page.getByRole("dialog").getByRole("button", { name: "Connect", exact: true }).click();
      } else if (source === "discover") {
        await page.getByRole("button", { name: "Discover", exact: true }).click();
        await page.getByRole("button", { name: "Add: Linear", exact: true }).click();
      } else await page.getByRole("button", { name: "Connect", exact: true }).click();
      if (kind === "oauth") {
        await expect(page.getByText(oauthFailureCopy[source])).toBeVisible();
        await expect(page.getByRole("radio")).toHaveCount(0);
      } else if (kind === "bearer") {
        const dialog = page.getByRole("dialog");
        const input = dialog.getByLabel(source === "add" ? "API key" : "API key or token", { exact: true });
        await expect(input).toBeFocused();
        await expect(dialog.getByRole("radio")).toHaveCount(0);
        await input.fill("fixture-key");
        await page.keyboard.press("Enter");
        if (source !== "discover") await expect(dialog).toBeHidden();
      }
      if (kind !== "oauth") await expect(page.locator('[data-ui="mcp-server-list"]')).toContainText("Connected");
      expect(entries.get(id)).toHaveLength(kind === "oauth" && source === "discover" ? 0 : 1);
    }
    expect(writes.filter((path) => path === "/api/v1/mcp-servers")).toHaveLength(0);
    expect(writes.filter((path) => path.endsWith("/mcp-servers"))).toHaveLength(2);
  });
}

for (const width of [320, 390, 768, 1440]) {
  test(`keyboard, credential focus, settings choices and disabled copy at ${width}px`, async ({ page }) => {
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
      const attached = await page.request.post(`/api/v1/agents/${current.id}/mcp-servers`, {
        headers: current.headers,
        data: { mcpServerId: serverId, enabled: true },
      });
      expect(attached.ok()).toBeTruthy();
      await page.setViewportSize({ width, height: 844 });
      await page.goto(`/agents/${current.id}/mcp`);
      await page.getByRole("button", { name: "Connect", exact: true }).focus();
      await page.keyboard.press("Enter");
      const dialog = page.getByRole("dialog");
      await expect(dialog.getByLabel("API key or token", { exact: true })).toBeFocused();
      await expect(dialog.getByRole("radio")).toHaveCount(0);
      await expectWithinViewport(dialog);
      await expectWithinViewport(dialog.getByRole("button", { name: "Connect", exact: true }));
      await expectNoPageOverflow(page);
      await expectAccessible(page);
      await page.screenshot({ path: test.info().outputPath(`mcp-connect-${width}.png`) });
      await page.keyboard.press("Escape");
      await expect(dialog).toBeHidden();
      await expect(page.locator(`#mcp-server-${serverId}`)).toBeFocused();
      await page.getByRole("button", { name, exact: true }).click();
      await page.getByRole("button", { name: "Authentication", exact: true }).click();
      await expect(page.getByRole("radio")).toHaveCount(3);
      await page.getByRole("radio", { name: "No authentication", exact: true }).click();
      await page.getByRole("button", { name: "Continue", exact: true }).click();
      await expect.poll(async () => (await mounts(page, current.id))[0]?.authorization?.kind).toBe("none");
      await expect(page.getByRole("dialog", { name, exact: true })).toBeVisible();
      await page.getByRole("button", { name: `Close ${name}`, exact: true }).click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      const toggle = page.getByRole("switch", { name: `Allow MCP Connect review to use ${name}` });
      await toggle.click();
      await expect(page.locator('[data-ui="mcp-server-row"]')).toContainText("Disabled");
      await expect(page.getByText(/Settings kept|Disabled for/)).toHaveCount(0);
      await toggle.click();
      await expect(toggle).toBeChecked();
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
    await expect(dialog).toContainText("Complete sign-in in the authorization window.");
    await popup.getByRole("link", { name: "Approve", exact: true }).click();
    await expect(page.locator('[data-ui="mcp-server-list"]')).toContainText("Connected");
  } finally {
    await upstream.stop();
  }
});

test("mobile Discover restores search after cancellation, browser Back, and successful consent", async ({ page }) => {
  const upstream = await peer("oauth");
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    const current = await agent(page);
    const serverId = await discoverPeer(page, current, upstream.url);
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
    await expect(discover).toContainText("Connected");
    await expect(discover.getByLabel("Search connectors", { exact: true })).toHaveValue("Linear");
    expect((await mounts(page, current.id))[0]?.mcpServerId).toBe(serverId);
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
    await expect(dialog).toContainText("Sign-in was cancelled. You can try again.");
    await expect.poll(() => mounts(page, current.id)).toHaveLength(0);
    await page.request.get(approve);
    expect(await mounts(page, current.id)).toHaveLength(0);
  } finally {
    await upstream.stop();
  }
});

test("changing Add custom input still cancels the setup it created", async ({ page }) => {
  const upstream = await peer("none");
  try {
    const current = await agent(page);
    upstream.unavailable(true);
    const dialog = await openAdd(page, current.id, upstream.url);
    await expect(dialog).toContainText("Couldn’t load tools. Try again.");
    expect(await mounts(page, current.id)).toHaveLength(1);
    await dialog.getByLabel("Connector URL", { exact: true }).fill("https://another.example/mcp");
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect.poll(() => mounts(page, current.id)).toHaveLength(0);
  } finally {
    await upstream.stop();
  }
});

async function approveToolsAuthorization(page: Page, blocked: boolean) {
  let consent = page;
  if (blocked) {
    const reopened = page.waitForEvent("popup");
    await page.getByRole("button", { name: "Open authorization page", exact: true }).click();
    consent = await reopened;
  }
  await consent.getByRole("link", { name: "Approve", exact: true }).click();
}

for (const returnMode of ["mobile", "blocked popup"] as const) {
  test(`Tools OAuth restores search and scroll with ${returnMode}`, async ({ page }) => {
    const upstream = await peer("oauth", false, 20);
    try {
      const current = await agent(page);
      const opening = page.waitForEvent("popup");
      await openAdd(page, current.id, upstream.url);
      await (await opening).getByRole("link", { name: "Approve", exact: true }).click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(page.locator('[data-ui="mcp-server-list"]')).toContainText("Connected");
      const serverId = (await mounts(page, current.id))[0]?.mcpServerId;
      if (!serverId) throw new Error("Missing connected fixture");
      const name = (
        (await (await page.request.get(`/api/v1/mcp-servers/${serverId}`)).json()).server as { name: string }
      ).name;
      upstream.expire();
      await page.request.post(`/api/v1/agents/${current.id}/mcp-servers/${serverId}/probe`, {
        headers: current.headers,
      });
      // Probe failures retain tools. Model the refresh worker's expired status at the UI boundary;
      // the authorization, callback and subsequent probe still run through the real stack.
      await page.route(`**/api/v1/agents/${current.id}/mcp-servers`, async (route) => {
        if (route.request().method() !== "GET") return route.continue();
        const response = await route.fetch();
        const body = await response.json();
        for (const entry of body.servers) {
          if (entry.mcpServerId === serverId && entry.authorization?.probeState === "failed")
            entry.authorization.status = "expired";
        }
        await route.fulfill({ response, json: body });
      });
      await page.setViewportSize({ width: returnMode === "mobile" ? 390 : 1440, height: 844 });
      await page.reload();
      await page.getByRole("button", { name, exact: true }).click();
      await page.getByRole("button", { name: "Tools", exact: true }).click();
      await page.getByRole("textbox", { name: "Search tools", exact: true }).fill("fixture");
      const toolList = page.getByRole("region", { name: "Tools discovered with this Agent’s credential", exact: true });
      await toolList.hover();
      await page.mouse.wheel(0, 200);
      await expect.poll(() => toolList.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
      const scrollTop = await toolList.evaluate((element) => element.scrollTop);
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
      const reconnect = page.getByRole("dialog").getByRole("button", { name: "Reconnect", exact: true });
      await expect(reconnect).toBeVisible();
      await reconnect.click();
      await expect(
        page.getByRole("dialog").getByRole("heading", { name: "Authentication", exact: true }),
      ).toBeVisible();
      await reconnect.click();
      await approveToolsAuthorization(page, returnMode === "blocked popup");
      await expect(page.getByRole("textbox", { name: "Search tools", exact: true })).toHaveValue("fixture");
      await expect.poll(() => toolList.evaluate((element) => element.scrollTop)).toBe(scrollTop);
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
    preparing: "Connecting…",
    cancel: "Cancel: Linear",
    reconnect: "Reconnect: Linear",
    failed: "Connection failed",
  },
  zh: {
    title: "发现",
    empty: "暂无连接器",
    close: "关闭 发现",
    search: "搜索连接器",
    add: "添加: Linear",
    preparing: "正在连接…",
    cancel: "取消: Linear",
    reconnect: "重新连接: Linear",
    failed: "连接失败",
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
        await expect.poll(() => mounts(page, current.id)).toHaveLength(0);
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
