import { randomUUID } from "node:crypto";
import type { AccountComputerSummary, AgentListItem, ImBindingSummary, Skill } from "@opentag/shared/browser";
import type { Locator, Page } from "@playwright/test";
import { expectAccessible, expectNoPageOverflow, expectWithinViewport } from "./browser-contract.js";
import { expect, smokeTest as test } from "./fixtures.js";
import { createAgent } from "./mcp-browser-fixture.js";

test.describe.configure({ mode: "parallel" });

async function expectTouchTarget(control: Locator) {
  const box = await control.boundingBox();
  if (!box) throw new Error("Missing control geometry");
  expect(box.width).toBeGreaterThanOrEqual(44);
  expect(box.height).toBeGreaterThanOrEqual(44);
}

/** Real identities and destinations, with deterministic Computer/messaging evidence for layout states. */
async function rosterFixture(page: Page, locale: "en" | "zh") {
  const names =
    locale === "en"
      ? (["Product research assistant", "Runtime configuration reviewer", "Customer messaging assistant"] as const)
      : (["产品研究助理", "运行环境配置审核助理", "客户消息协作助理"] as const);
  const ids = await Promise.all(names.map((name) => createAgent(page, name)));
  const messagingAgentId = ids[2];
  if (!messagingAgentId) throw new Error("Missing messaging Agent identity");
  const response = await page.request.get("/api/v1/agents");
  expect(response.ok()).toBe(true);
  const { agents: all } = (await response.json()) as { agents: AgentListItem[] };
  const now = new Date().toISOString();
  const computers: AccountComputerSummary[] = ids.slice(1).map((id, index) => ({
    computerId: randomUUID(),
    displayName: `Review computer ${index}`,
    platform: "darwin",
    connectionStatus: "online",
    connectedAt: now,
    lastSeenAt: now,
    observedAt: now,
    createdAt: now,
    agentIds: [id],
    providerReadiness: [{ provider: "codex", status: index ? "ready" : "sign-in", observedAt: now }],
  }));
  const agents = ids.map((id, index) => {
    const agent = all.find((item) => item.id === id);
    if (!agent) throw new Error("Missing created Agent");
    const computer = computers[index - 1];
    return {
      ...agent,
      computer: computer
        ? {
            computerId: computer.computerId,
            displayName: computer.displayName,
            platform: computer.platform,
          }
        : null,
    };
  });
  const binding: ImBindingSummary = {
    id: randomUUID(),
    agentId: messagingAgentId,
    provider: "slack",
    bindingState: "reauthorization_required",
    bot: { displayName: names[2], avatarUrl: null },
    receiveMode: "mention_only",
    lastInboundAt: null,
    lastValidatedAt: now,
    lastRuntimeObservationAt: now,
  };
  await page.route("**/api/v1/agents", (route) => route.fulfill({ json: { agents } }));
  await page.route("**/api/v1/computers", (route) => route.fulfill({ json: { computers } }));
  await page.route(/\/api\/v1\/agents\/[^/]+\/im-binding(?:\/handoff)?$/, (route) => {
    const path = new URL(route.request().url()).pathname;
    return path === `/api/v1/agents/${ids[2]}/im-binding`
      ? route.fulfill({ json: binding })
      : route.fulfill({ status: 204 });
  });
  return { ids, names };
}

for (const locale of ["en", "zh"] as const) {
  for (const width of [320, 390, 700, 1440]) {
    test(`roster identities and shell targets remain usable in ${locale} at ${width}px`, async ({ page }) => {
      await page.addInitScript((language) => localStorage.setItem("PARAGLIDE_LOCALE", language), locale);
      await page.setViewportSize({ width, height: 844 });
      const { ids, names } = await rosterFixture(page, locale);
      await page.goto("/agents", { waitUntil: "networkidle" });
      const rows = page.locator('[data-ui="agent-row"]');
      await expect(rows).toHaveCount(3);
      const labels =
        locale === "en"
          ? ["No computer assigned", "Codex sign-in required", "Messaging permissions required"]
          : ["未指定电脑", "需要登录 Codex", "需要更新消息权限"];
      for (const [index, displayName] of names.entries()) {
        const row = rows.nth(index);
        const name = row.locator("strong");
        const label = labels[index];
        if (!label) throw new Error("Missing expected availability label");
        await expect(name).toHaveText(displayName);
        await expect(row.locator(".ui-status")).toHaveText(label);
        const readable = await name.evaluate((element) => ({
          width: element.clientWidth,
          content: element.scrollWidth,
        }));
        expect(readable.width, "Agent name has a visible column").toBeGreaterThan(0);
        expect(readable.content, "Agent name is not clipped").toBeLessThanOrEqual(readable.width);
      }
      await expectNoPageOverflow(page);
      await expectAccessible(page);
      await page.screenshot({ path: test.info().outputPath(`roster-${locale}-${width}.png`), fullPage: true });
      const home = page.locator(".app-home-link");
      const account = page.locator(".app-account-trigger");
      if (width < 768) {
        await expectTouchTarget(home);
        await expectTouchTarget(account);
        await account.click();
        const firstItem = page.getByRole("menuitem").first();
        await expect(firstItem).toBeVisible();
        for (const item of await page.getByRole("menuitem").all()) await expectTouchTarget(item);
        await firstItem.focus();
        await expect(firstItem).toBeFocused();
        await firstItem.press("Escape");
        await expect(account).toBeFocused();
        await expect(page.getByRole("menu")).toHaveCount(0);
      }
      const open = rows.first().locator('[data-ui="agent-row-open"]');
      await open.focus();
      await expect(open).toBeFocused();
      await open.press("Enter");
      await expect(page).toHaveURL(new RegExp(`/agents/${ids[0]}$`));
      await expect(page.getByRole("heading", { name: names[0], exact: true })).toBeVisible();
      if (width < 768) {
        await expectTouchTarget(home);
        await expectTouchTarget(account);
        const switcher = page.locator(".app-agent-switcher button");
        await expectTouchTarget(switcher);
        await switcher.click();
        const firstItem = page.getByRole("menuitem").first();
        await expect(firstItem).toBeVisible();
        for (const item of await page.getByRole("menuitem").all()) await expectTouchTarget(item);
        await firstItem.focus();
        await expect(firstItem).toBeFocused();
        await firstItem.press("Escape");
        await expect(switcher).toBeFocused();
      }
      await home.focus();
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(/\/agents$/);
      const setup = rows.first().locator('[data-ui="agent-row-continue-setup"]');
      await setup.scrollIntoViewIfNeeded();
      await expectWithinViewport(setup);
      await setup.focus();
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(new RegExp(`/agents/setup\\?agentId=${ids[0]}$`));
      await expectNoPageOverflow(page);
    });
  }
}

test("Skill file selection, links, and scroll focus retain accessible contrast", async ({ page }) => {
  const agentId = await createAgent(page, "Skill reader contrast");
  const now = new Date().toISOString();
  const skill: Skill = {
    id: randomUUID(),
    agentId,
    name: "reader",
    description: "A package to read",
    archiveSha256: "a".repeat(64),
    archiveBytes: 100,
    fileCount: 2,
    enabled: true,
    revision: 1,
    source: "web_upload",
    createdAt: now,
    updatedAt: now,
  };
  await page.route(`**/api/v1/agents/${agentId}/skills`, (route) =>
    route.fulfill({ json: { skills: [skill], storage: "available" } }),
  );
  await page.route(`**/api/v1/agents/${agentId}/skills/${skill.id}/file?*`, (route) => {
    const path = new URL(route.request().url()).searchParams.get("path") ?? "SKILL.md";
    return route.fulfill({
      json: {
        path,
        archiveSha256: skill.archiveSha256,
        files: [
          { path: "SKILL.md", bytes: 100 },
          { path: "guide.md", bytes: 20 },
        ],
        preview: {
          status: "text",
          content:
            path === "SKILL.md"
              ? "# Read this skill\n\n[Guide](guide.md) and [Documentation](https://example.com)\n\n```ts\nconst answer = 42;\n```"
              : "# Guide content",
        },
      },
    });
  });
  await page.goto(`/agents/${agentId}/skills`);
  await page.getByRole("button", { name: "View reader", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "reader", exact: true });
  await expect(dialog.getByRole("heading", { name: "Read this skill" })).toBeVisible();
  await expect(dialog).toHaveCSS("opacity", "1");
  await expectAccessible(page);
  const code = dialog.locator(".skill-reader-code");
  await page.keyboard.press("Tab");
  await code.focus();
  await expect(code).toBeFocused();
  await expect(code).toHaveCSS("outline-color", "rgb(105, 117, 134)");
  await dialog.screenshot({ path: test.info().outputPath("skill-reader-contrast.png") });
  await dialog.getByRole("button", { name: "Guide", exact: true }).click();
  await expect(dialog.getByRole("heading", { name: "Guide content" })).toBeVisible();
  await expectAccessible(page);
});
