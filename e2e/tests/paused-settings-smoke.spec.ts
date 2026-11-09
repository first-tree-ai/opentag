import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { AgentStatusResponseSchema } from "@opentag/shared";
import type { Page } from "@playwright/test";
import { baseURL, repositoryRoot } from "../playwright.config.js";
import { expectAccessible, expectNoPageOverflow } from "./browser-contract.js";
import { allowExpectedDiagnostic, expect, smokeTest as test } from "./fixtures.js";

async function readPausedStatus(page: Page, agentId: string) {
  const response = await page.request.get(`/api/v1/agents/status?ids=${agentId}`);
  expect(response.ok(), await response.text()).toBeTruthy();
  const observed = AgentStatusResponseSchema.parse(await response.json()).statuses[0];
  if (!observed?.computer) throw new Error("Missing paused Agent Computer");
  return observed;
}

test("paused messaging is readable across layouts and never starts a write", async ({ page }) => {
  test.setTimeout(120_000);
  const runtime = JSON.parse(await readFile(join(repositoryRoot, "e2e/.runtime.json"), "utf8")) as {
    accountComputerId: string;
  };
  const csrf = (await page.context().cookies()).find((cookie) => cookie.name === "opentag_csrf")?.value;
  if (!csrf) throw new Error("Missing browser CSRF token");
  const headers = { Origin: baseURL, "x-opentag-csrf": csrf };
  const created = await page.request.post("/api/v1/agents", {
    headers,
    data: {
      creationIntentId: randomUUID(),
      name: `paused-${randomUUID()}`,
      displayName: "Paused Reviewer",
      runtimeProvider: "codex",
      computerId: runtime.accountComputerId,
    },
  });
  expect(created.ok(), await created.text()).toBeTruthy();
  const agent = (await created.json()) as { id: string };
  const paused = await page.request.post(`/api/v1/agents/${agent.id}/suspend`, { headers });
  expect(paused.ok(), await paused.text()).toBeTruthy();
  // The real paused read is unbound. Provider observations below isolate the rendered states from external services.
  expect((await page.request.get(`/api/v1/agents/${agent.id}/im-binding`)).status()).toBe(204);
  const observed = await readPausedStatus(page, agent.id);
  await page.addInitScript(() => localStorage.setItem("PARAGLIDE_LOCALE", "zh"));
  const writes: string[] = [];
  page.on("request", (request) => {
    if (/\/api\/v1\/(?:agents\/|im-bindings\/)/.test(request.url()) && !["GET", "HEAD"].includes(request.method()))
      writes.push(`${request.method()} ${new URL(request.url()).pathname}`);
  });
  const screenshots = join(repositoryRoot, "e2e/screenshots/paused-settings");
  await mkdir(screenshots, { recursive: true });
  for (const provider of ["feishu", "slack"] as const) {
    const binding = {
      id: randomUUID(),
      agentId: agent.id,
      provider,
      bindingState: "active",
      bot: { displayName: "Reviewer", avatarUrl: null },
      receiveMode: "mention_only",
      lastInboundAt: null,
      lastValidatedAt: null,
      lastRuntimeObservationAt: null,
    };
    const detail = {
      ...binding,
      identity: {
        provider: "slack",
        appId: "A1",
        teamId: "T1",
        enterpriseId: null,
        botUserId: "U1",
        appIdEvidence: "configured",
      },
      credentialGeneration: 1,
      grantedCapabilities: [],
      reauthorizationRequired: false,
      lastErrorCode: null,
    };
    await page.route(`**/api/v1/agents/${agent.id}/im-binding`, (route) => route.fulfill({ json: binding }));
    await page.route("**/api/v1/agents/status?**", (route) =>
      route.fulfill({
        json: {
          statuses: [
            {
              ...observed,
              state: "problem",
              reason: "agent_paused",
              computer: { ...observed.computer, online: true },
              messaging: binding,
            },
          ],
        },
      }),
    );
    await page.route(`**/api/v1/agents/${agent.id}/im-binding/handoff`, (route) =>
      route.fulfill({ json: { bindingState: "active", handoffReady: true } }),
    );
    await page.route(`**/api/v1/agents/${agent.id}/im-binding/slack/configuration`, (route) =>
      route.fulfill({
        json: {
          agentDisplayName: "Paused Reviewer",
          eventsUrl: "https://opentag.example/events",
          allowedIntent: "reauthorize",
          blockedReason: null,
          expectedMessaging: { kind: "bound", provider: "slack", bindingId: binding.id, credentialGeneration: 1 },
          preferredRecovery: "oauth",
          binding: detail,
          identityClosure: { status: "verified", verifiedAt: null },
          handoff: { bindingState: "active", handoffReady: true },
        },
      }),
    );
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`/agents/${agent.id}/settings/messaging`, { waitUntil: "networkidle" });
      await expect(page.getByText("Agent 已暂停，消息设置仅供查看。恢复运行后可修改。", { exact: true })).toBeVisible();
      await expect(
        page.locator('[data-ui="messaging-app-identity"]').getByText("已连接", { exact: true }),
      ).toBeVisible();
      const modes = page.getByRole("group", { name: "消息接收模式" }).getByRole("button");
      await expect(modes).toHaveCount(2);
      for (const mode of await modes.all()) await expect(mode).toBeDisabled();
      if (provider === "feishu") {
        await expect(page.getByRole("button", { name: "更换机器人" })).toHaveCount(0);
        await expect(page.getByRole("button", { name: "断开飞书" })).toBeDisabled();
      } else {
        const more = page.getByRole("button", { name: "更多", exact: true });
        await more.focus();
        await page.keyboard.press("Enter");
        await expect(page.getByRole("dialog")).toBeVisible();
        await page.getByRole("button", { name: "遇到问题？", exact: true }).click();
        await expect(page.getByRole("button", { name: "更新凭证", exact: true })).toHaveCount(0);
        await expect(page.getByRole("button", { name: "重新授权", exact: true })).toHaveCount(0);
        await expect(page.getByRole("button", { name: "重试自动设置", exact: true })).toHaveCount(0);
        await expectAccessible(page);
        await page.keyboard.press("Escape");
      }
      await expectNoPageOverflow(page);
      await expectAccessible(page);
      await page.screenshot({ path: join(screenshots, `${provider}-${width}.png`), fullPage: true });
    }
    for (const suffix of ["/settings", ""]) {
      await page.goto(`/agents/${agent.id}${suffix}`, { waitUntil: "networkidle" });
      await expect(page.getByText(/已连接/).first()).toBeVisible();
      if (!suffix)
        await expect(
          page.locator('[data-ui="agent-status-message-channel"]').getByText("状态暂时不可用", { exact: true }),
        ).toHaveCount(0);
    }
    if (provider === "feishu") {
      await page.unroute(`**/api/v1/agents/${agent.id}/im-binding`);
      await page.route(`**/api/v1/agents/${agent.id}/im-binding`, (route) =>
        route.fulfill({ json: { ...binding, bindingState: "error", connectionFailure: "credentials_rejected" } }),
      );
      await page.route(`**/api/v1/agents/${agent.id}/im-binding/handoff`, (route) =>
        route.fulfill({ json: { bindingState: "error", handoffReady: false } }),
      );
      await page.setViewportSize({ width: 390, height: 900 });
      await page.goto(`/agents/${agent.id}/settings/messaging`, { waitUntil: "networkidle" });
      await expect(page.getByText("应用凭据已失效。请重新连接并重新授权。", { exact: true })).toBeVisible();
      await expect(page.getByRole("button", { name: "重新连接", exact: true })).toBeDisabled();
      await expectNoPageOverflow(page);
      await expectAccessible(page);
      await page.screenshot({ path: join(screenshots, "feishu-error-390.png"), fullPage: true });
    }
    await page.unroute(`**/api/v1/agents/${agent.id}/im-binding`);
    await page.unroute("**/api/v1/agents/status?**");
  }
  allowExpectedDiagnostic(page, {
    routeTemplate: "/api/v1/agents/:id/im-binding",
    status: 503,
    code: "SERVICE_UNAVAILABLE",
  });
  await page.route(`**/api/v1/agents/${agent.id}/im-binding`, (route) =>
    route.fulfill({
      status: 503,
      json: { error: { code: "SERVICE_UNAVAILABLE", category: "transient", message: "Status unavailable" } },
    }),
  );
  await page.goto(`/agents/${agent.id}/settings/messaging`, { waitUntil: "networkidle" });
  await expect(page.getByRole("alert").filter({ hasText: "Status unavailable" })).toBeVisible();
  await expect(page.locator('[data-ui="messaging-app-identity"]')).toHaveCount(0);
  expect(writes).toEqual([]);
});
