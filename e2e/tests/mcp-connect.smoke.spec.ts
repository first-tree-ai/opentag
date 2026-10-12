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
async function peer(kind: MCPAuthKind) {
  let origin = "";
  let unavailable = false;
  let tokenFailure = false;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", origin);
    let raw = "";
    for await (const chunk of request) raw += chunk;
    const json = (body: unknown, status = 200) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (oauthResponse(url, response, json)) return;
    if (url.pathname !== "/mcp") return json({}, 404);
    if (unavailable) return json({ error: "unavailable" }, 503);
    if (kind !== "none" && request.headers.authorization !== "Bearer fixture-key") {
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
          tools: [{ name: "read_document", description: "Read a fixture document", inputSchema: { type: "object" } }],
        }
      : {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "connect-fixture", version: "1" },
        };
  }
  function oauthResponse(url: URL, response: ServerResponse, json: (body: unknown, status?: number) => void): boolean {
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
      json({ client_id: "connect-fixture", token_endpoint_auth_method: "none" });
      return true;
    }
    if (url.pathname === "/authorize") {
      consent(url, response);
      return true;
    }
    if (url.pathname === "/token") {
      if (tokenFailure) json({ error: "invalid_grant" }, 400);
      else json({ access_token: "fixture-key", token_type: "Bearer", expires_in: 3600 });
      return true;
    }
    return false;
  }
  function consent(url: URL, response: ServerResponse) {
    const callback = new URL(url.searchParams.get("redirect_uri") ?? baseURL);
    callback.searchParams.set("state", url.searchParams.get("state") ?? "");
    const cancel = new URL(callback);
    cancel.searchParams.set("error", "access_denied");
    callback.searchParams.set("code", "fixture-code");
    response.writeHead(200, { "content-type": "text/html" });
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
    tokenFailure: (value: boolean) => {
      tokenFailure = value;
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
      await page.getByRole("button", { name: "Retry", exact: true }).click();
      if (kind === "bearer") {
        const keyDialog = page.getByRole("dialog");
        await expect(keyDialog.getByRole("radio")).toHaveCount(0);
        const input = keyDialog.getByLabel("API key or token", { exact: true });
        await expect(input).toBeFocused();
        await input.fill("fixture-key");
        await page.keyboard.press("Enter");
      } else {
        await expect(page.getByRole("alert")).toContainText("Couldn’t load tools. Try again.");
        upstream.unavailable(false);
        await page.getByRole("button", { name: "Retry", exact: true }).click();
      }
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(page.locator('[data-ui="mcp-server-list"]')).toContainText("Connected");
      expect(await mounts(page, current.id)).toHaveLength(1);
      expect((await mounts(page, current.id))[0]?.mcpServerId).toBe(initial[0]?.mcpServerId);
    } finally {
      await upstream.stop();
    }
  });
}

test("real local OAuth success, cancellation, token failure and reconnect retain the binding", async ({ page }) => {
  const upstream = await peer("oauth");
  try {
    const current = await agent(page);
    await openAdd(page, current.id, upstream.url);
    await page.getByRole("link", { name: "Cancel sign-in" }).click();
    const restored = page.getByRole("dialog", { name: "Add custom connector", exact: true });
    await expect(restored).toContainText("Sign-in was not completed. Try again.");
    const initial = await mounts(page, current.id);
    expect(initial).toHaveLength(1);
    await restored.getByRole("button", { name: "Connect", exact: true }).click();
    await page.getByRole("link", { name: "Approve", exact: true }).click();
    await expect(page.locator('[data-ui="mcp-server-list"]')).toContainText("Connected");
    const serverId = initial[0]?.mcpServerId;
    const revoked = await page.request.delete(`/api/v1/agents/${current.id}/mcp-servers/${serverId}/authorization`, {
      headers: current.headers,
    });
    expect(revoked.ok()).toBeTruthy();
    await page.reload();
    await page.getByRole("button", { name: "Reconnect", exact: true }).click();
    await page.getByRole("link", { name: "Cancel sign-in" }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByRole("alert")).toContainText("Sign-in was not completed. Try again.");
    await page.getByRole("button", { name: "Reconnect", exact: true }).click();
    upstream.tokenFailure(true);
    await page.getByRole("link", { name: "Approve", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("Sign-in was not completed. Try again.");
    upstream.tokenFailure(false);
    await page.getByRole("button", { name: "Reconnect", exact: true }).click();
    await page.getByRole("link", { name: "Approve", exact: true }).click();
    await expect(page.locator('[data-ui="mcp-server-list"]')).toContainText("Connected");
    expect((await mounts(page, current.id))[0]?.mcpServerId).toBe(serverId);
    expect(await mounts(page, current.id)).toHaveLength(1);
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
      if (path.endsWith("/mcp-servers")) {
        if (method !== "GET") list.push({ ...binding });
        await route.fulfill({ json: method === "GET" ? { servers: list } : list[0] });
        return;
      }
      const current = list[0];
      if (!current) throw new Error("Missing fixture binding");
      await respondBinding(route, current, path);
    });
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
        await expect(page.getByText("Couldn’t start sign-in. Try again.")).toBeVisible();
        await expect(page.getByRole("radio")).toHaveCount(0);
      } else if (kind === "bearer") {
        const dialog = page.getByRole("dialog");
        const input = dialog.getByLabel(source === "add" ? "API key" : "API key or token", { exact: true });
        await expect(input).toBeFocused();
        await expect(dialog.getByRole("radio")).toHaveCount(0);
        await input.fill("fixture-key");
        await page.keyboard.press("Enter");
        await expect(dialog).toBeHidden();
      }
      if (kind !== "oauth") await expect(page.locator('[data-ui="mcp-server-list"]')).toContainText("Connected");
      expect(entries.get(id)).toHaveLength(1);
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
