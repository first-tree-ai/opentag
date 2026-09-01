import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "@playwright/test";
import { baseURL, repositoryRoot } from "../playwright.config.js";
import { expect, test } from "./fixtures.js";

test.describe.configure({ mode: "serial" });

let agentId: string;
const screenshots = join(repositoryRoot, "e2e/screenshots");

test.afterEach(async ({ e2eRuntime }) => {
  await e2eRuntime.setClaudeStubMode("pass");
});

test("runtime test pass is user-visible through the saved Claude Code path", async ({ page, e2eRuntime }) => {
  await e2eRuntime.setSetupComplete();
  await mkdir(screenshots, { recursive: true });
  agentId = await createClaudeAgent(page, e2eRuntime.accountComputerId);
  await page.goto(`/agents/${agentId}/settings/execution`, { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { name: "Model", exact: true })).toBeVisible();
  await expect(
    page.getByText("Send a short request using the saved model settings. This may use provider quota."),
  ).toBeVisible();
  await page.getByRole("button", { name: "Run test" }).click();
  await expect(page.getByRole("status")).toHaveText(
    "Connection succeeded. The saved model settings worked for this request.",
    { timeout: 60_000 },
  );
  await page.screenshot({ path: join(screenshots, "runtime-test-pass.png"), fullPage: true });
});

test("runtime test failure shows a sanitized Provider failure", async ({ page, e2eRuntime }) => {
  await e2eRuntime.setClaudeStubMode("fail");
  await page.goto(`/agents/${agentId}/settings/execution`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Run test" }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "The model request failed. Check provider access and quota, then try again.",
    { timeout: 60_000 },
  );
  await expect(page.getByRole("alert")).not.toContainText(/sentinel|token|usage|trace/i);
  await page.screenshot({ path: join(screenshots, "runtime-test-failure.png"), fullPage: true });
});

test("runtime test pending disables the action", async ({ page, e2eRuntime }) => {
  await e2eRuntime.setClaudeStubMode("hold");
  await page.goto(`/agents/${agentId}/settings/execution`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Run test" }).click();
  const pending = page.getByRole("button", { name: "Testing…" });
  await expect(pending).toBeVisible();
  await expect(pending).toBeDisabled();
  await page.screenshot({ path: join(screenshots, "runtime-test-pending.png"), fullPage: true });
  await e2eRuntime.setClaudeStubMode("pass");
  await expect(page.getByRole("status")).toContainText("Connection succeeded.", { timeout: 60_000 });
});

test("runtime test reports stale configuration without a daemon retry", async ({ page }) => {
  await page.goto(`/agents/${agentId}/settings/execution`, { waitUntil: "networkidle" });
  const configResponse = await page.request.get(`/api/v1/agents/${agentId}/config`);
  expect(configResponse.ok()).toBeTruthy();
  const config = (await configResponse.json()) as { revision: number };
  const update = await page.request.patch(`/api/v1/agents/${agentId}`, {
    data: { expectedRevision: config.revision, displayName: "Runtime Test Agent Stale" },
    headers: await csrfHeaders(page),
  });
  expect(update.ok()).toBeTruthy();
  await page.getByRole("button", { name: "Run test" }).click();
  await expect(page.getByRole("alert")).toHaveText(
    "The saved model settings changed. Run the test again to use the current settings.",
  );
  await page.screenshot({ path: join(screenshots, "runtime-test-stale-config.png"), fullPage: true });
});

test("leaving the page cancels an in-flight runtime test", async ({ page, e2eRuntime }) => {
  expect(await e2eRuntime.claudeStubCancellationCount()).toBe(0);
  const startsBefore = await e2eRuntime.claudeStubStartCount();
  await e2eRuntime.setClaudeStubMode("hold");
  await page.goto(`/agents/${agentId}/settings/execution`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Run test" }).click();
  await expect(page.getByRole("button", { name: "Testing…" })).toBeVisible();
  await expect.poll(() => e2eRuntime.claudeStubStartCount()).toBe(startsBefore + 1);
  await page.goto(`/agents/${agentId}/settings`, { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { name: "Agent settings", exact: true })).toBeVisible();
  await expect.poll(() => e2eRuntime.claudeStubCancellationCount()).toBe(1);
  await page.screenshot({ path: join(screenshots, "runtime-test-disconnect.png"), fullPage: true });
  await page.goto(`/agents/${agentId}/settings/execution`, { waitUntil: "networkidle" });
  await expect(page.getByRole("button", { name: "Run test" })).toBeEnabled();
  await expect(page.getByText(/^Connection succeeded\./)).toHaveCount(0);
  await expect(page.getByRole("alert")).toHaveCount(0);
});

async function createClaudeAgent(page: Page, computerId: string): Promise<string> {
  const name = `rt-${randomUUID()}`;
  const response = await page.request.post("/api/v1/agents", {
    data: {
      creationIntentId: randomUUID(),
      name,
      displayName: "Runtime Test Agent",
      runtimeProvider: "claude-code",
      computerId,
    },
    headers: await csrfHeaders(page),
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  const created = (await response.json()) as { id: string };
  expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
  return created.id;
}

async function csrfHeaders(page: Page): Promise<Record<string, string>> {
  const cookies = await page.context().cookies();
  const csrf = cookies.find((cookie) => cookie.name === "opentag_csrf")?.value;
  if (!csrf) throw new Error("The authenticated storage state has no OpenTag CSRF cookie");
  return { Origin: baseURL, "content-type": "application/json", "x-opentag-csrf": csrf };
}
