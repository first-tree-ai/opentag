import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { MCP_AUTH_REJECTION_SUMMARY, MCP_ERROR_CODES } from "@opentag/shared/browser";
import type { Page } from "@playwright/test";
import { baseURL } from "../playwright.config.js";
import { expect, smokeTest as test } from "./fixtures.js";

/** Real HTTP peer: rejects MCP access, publishes OAuth metadata, and stops at the sign-in page. */
async function rejectingServer(status: number) {
  let origin = "";
  const upstream = createServer((request, response) => {
    request.resume();
    const path = new URL(request.url ?? "/", origin).pathname;
    const json = (value: unknown, code = 200) => {
      response.writeHead(code, { "content-type": "application/json" });
      response.end(JSON.stringify(value));
    };
    if (path === "/mcp") {
      response.setHeader(
        "www-authenticate",
        `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
      );
      json({ message: "Authentication required" }, status);
    } else if (path.startsWith("/.well-known/oauth-protected-resource")) {
      json({ resource: `${origin}/mcp`, authorization_servers: [origin] });
    } else if (path === "/.well-known/oauth-authorization-server") {
      json({
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        registration_endpoint: `${origin}/register`,
      });
    } else if (path === "/register") {
      json({ client_id: "rejection-fixture", token_endpoint_auth_method: "none" });
    } else if (path === "/authorize") {
      response.writeHead(200, { "content-type": "text/html" });
      response.end('<html lang="en"><title>Fixture sign-in</title><h1>Fixture sign-in</h1></html>');
    } else json({ error: "Not found" }, 404);
  });
  await new Promise<void>((resolve, reject) => {
    upstream.once("error", reject);
    upstream.listen(0, "127.0.0.1", resolve);
  });
  const address = upstream.address();
  if (!address || typeof address === "string") throw new Error("Missing MCP fixture port");
  origin = `http://127.0.0.1:${address.port}`;
  return {
    endpoint: `${origin}/mcp`,
    stop: async () => {
      upstream.closeAllConnections();
      await new Promise<void>((resolve, reject) => upstream.close((error) => (error ? reject(error) : resolve())));
    },
  };
}

async function setupAgent(page: Page, endpoint: string, bearer: boolean) {
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === "opentag_csrf")?.value;
  if (!csrf) throw new Error("Missing authenticated CSRF cookie");
  const headers = { Origin: baseURL, "x-opentag-csrf": csrf };
  const response = await page.request.post("/api/v1/agents", {
    headers,
    data: {
      creationIntentId: randomUUID(),
      name: `mcp-${randomUUID()}`,
      displayName: "MCP rejection",
      runtimeProvider: "codex",
    },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  const agentId = ((await response.json()) as { id: string }).id;
  if (bearer) {
    const server = await page.request.post("/api/v1/mcp-servers", {
      headers,
      data: { name: `rejection-${randomUUID()}`, url: endpoint, defaultAuthKind: "bearer" },
    });
    expect(server.ok(), await server.text()).toBeTruthy();
    const serverId = ((await server.json()) as { id: string }).id;
    const attached = await page.request.post(`/api/v1/agents/${agentId}/mcp-servers`, {
      headers,
      data: { mcpServerId: serverId, enabled: true },
    });
    expect(attached.ok(), await attached.text()).toBeTruthy();
  }
  return agentId;
}

for (const status of [401, 403]) {
  for (const bearer of [false, true]) {
    test(`real HTTP ${status} ${bearer ? "bearer rejection keeps the API key editable" : "anonymous rejection starts OAuth"}`, async ({
      page,
    }) => {
      const upstream = await rejectingServer(status);
      try {
        const agent = await setupAgent(page, upstream.endpoint, bearer);
        const oauthRequests: string[] = [];
        page.on("request", (request) => {
          if (request.method() === "POST" && request.url().endsWith("/authorization/oauth"))
            oauthRequests.push(request.url());
        });
        await page.goto(`/agents/${agent}/mcp`);
        const rejected = {
          probeState: "failed",
          probeError: `${MCP_ERROR_CODES.UPSTREAM_ERROR}: ${MCP_AUTH_REJECTION_SUMMARY}`,
        };
        if (bearer) {
          // A key installation that needs a key offers Authorize on its row; the key is saved from Details.
          await page.getByRole("button", { name: /^Authorize: rejection-/ }).click();
          const dialog = page.getByRole("dialog");
          await dialog.getByRole("textbox", { name: "API key or token", exact: true }).fill("wrong-fixture-key");
          await dialog.getByRole("button", { name: "Save", exact: true }).click();
          // The rejected key stays a local form error that offers Update, never an OAuth attempt.
          await expect(dialog).toContainText("The key was rejected. Update it.");
          await expect(dialog.getByRole("button", { name: "Update", exact: true })).toBeVisible();
          await expect
            .poll(async () => {
              const listed = (await (await page.request.get(`/api/v1/agents/${agent}/mcp-servers`)).json()) as {
                servers: Array<{ authorization: { probeState: string; probeError: string | null } | null }>;
              };
              const authorization = listed.servers[0]?.authorization;
              return authorization && { probeState: authorization.probeState, probeError: authorization.probeError };
            })
            .toEqual(rejected);
          expect(oauthRequests).toHaveLength(0);
        } else {
          // Account sign-in is the default: Connect tries the address, the real rejection leaves it
          // unconnected, and authorization starts in its own window.
          await page.getByRole("button", { name: "Add custom", exact: true }).first().click();
          const dialog = page.getByRole("dialog");
          await dialog.getByLabel("Connector address", { exact: true }).fill(upstream.endpoint);
          const connect = page.waitForResponse(
            (response) => response.request().method() === "POST" && response.url().endsWith("/authorization/connect"),
          );
          const oauth = page.waitForResponse(
            (response) => response.request().method() === "POST" && response.url().endsWith("/authorization/oauth"),
          );
          const consent = page.waitForEvent("popup");
          await dialog.getByRole("button", { name: "Connect", exact: true }).click();
          expect(await (await connect).json()).toEqual({ connected: false });
          expect((await oauth).ok()).toBeTruthy();
          const signIn = await consent;
          await expect(signIn.getByRole("heading", { name: "Fixture sign-in" })).toBeVisible();
          expect(oauthRequests).toHaveLength(1);
        }
      } finally {
        await upstream.stop();
      }
    });
  }
}
