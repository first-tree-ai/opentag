import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { baseURL, repositoryRoot } from "../playwright.config.js";
import { expect, test } from "./fixtures.js";

test.describe.configure({ mode: "serial" });

let agentId: string;
let taskId: string;
const AGENT_SETUP_CREATE_HEADING = "Where should your agent run?";

test("Agent Setup renders the destination step and contains the Codex mark", async ({ page, e2eRuntime }) => {
  await e2eRuntime.setSetupIncomplete();
  await page.goto("/agents/setup", { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { name: AGENT_SETUP_CREATE_HEADING, exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Local computer / })).toBeVisible();
  const cloudComputer = page.getByRole("button", { name: /^Cloud computer Coming soon / });
  await expect(cloudComputer).toBeVisible();
  await expect(cloudComputer).toBeDisabled();
  await rm(join(repositoryRoot, "e2e/screenshots"), { recursive: true, force: true });
  await mkdir(join(repositoryRoot, "e2e/screenshots"), { recursive: true });
  await page.screenshot({ path: join(repositoryRoot, "e2e/screenshots/agent-setup.png"), fullPage: true });

  await page.getByRole("button", { name: /^Local computer / }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  const mark = page.locator('[data-brand="codex"]');
  const lightMark = mark.locator(".otv2-codex-mark--light");
  const darkMark = mark.locator(".otv2-codex-mark--dark");
  await expect(mark).toBeVisible();

  const expectContainedDimensions = async () => {
    await expect(mark).toHaveCSS("width", "40px");
    await expect(mark).toHaveCSS("height", "40px");
    await expect(mark).toHaveCSS("overflow", "hidden");
    await expect(lightMark).toHaveCSS("width", "32px");
    await expect(lightMark).toHaveCSS("height", "32px");
    const [containerBox, imageBox] = await Promise.all([mark.boundingBox(), lightMark.boundingBox()]);
    expect(containerBox).not.toBeNull();
    expect(imageBox).not.toBeNull();
    if (!containerBox || !imageBox) throw new Error("Codex mark did not produce layout boxes");
    expect(imageBox.x).toBeGreaterThanOrEqual(containerBox.x);
    expect(imageBox.y).toBeGreaterThanOrEqual(containerBox.y);
    expect(imageBox.x + imageBox.width).toBeLessThanOrEqual(containerBox.x + containerBox.width);
    expect(imageBox.y + imageBox.height).toBeLessThanOrEqual(containerBox.y + containerBox.height);
  };

  await expectContainedDimensions();
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(page.locator("html")).toHaveAttribute("data-mode", "light");
  await expect(lightMark).toHaveCSS("display", "block");
  await expect(darkMark).toHaveCSS("display", "none");
  await page.setViewportSize({ width: 390, height: 844 });
  await expectContainedDimensions();
});

test("Agent creation form creates an Agent visible in the list and detail page", async ({ page, e2eRuntime }) => {
  await e2eRuntime.setSetupComplete();
  await page.goto("/agents/setup?action=create", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: /^Local computer / }).click();
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page.getByRole("heading", { name: "Create your agent", exact: true })).toBeVisible();
  const agentName = page.getByLabel("Agent name");
  await agentName.fill("e2e-agent");
  await page.getByRole("button", { name: /^Codex / }).click();
  const create = page.getByRole("button", { name: "Create Agent" });
  await expect(create).toBeEnabled();
  await create.click();
  await expect(page.getByRole("heading", { name: "Set up e2e-agent", exact: true })).toBeVisible({ timeout: 60_000 });

  const listResponse = await page.request.get("/api/v1/agents");
  expect(listResponse.ok()).toBeTruthy();
  const list = (await listResponse.json()) as { agents: Array<{ id: string; displayName: string }> };
  const created = list.agents.find((agent) => agent.displayName === "e2e-agent");
  expect(created).toBeDefined();
  agentId = created?.id ?? "";
  expect(agentId).toMatch(/^[0-9a-f-]{36}$/);
  await e2eRuntime.setSetupComplete();
  taskId = await e2eRuntime.seedTask(agentId);

  await page.goto(`/agents/${agentId}`, { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { name: "e2e-agent" })).toBeVisible();
});

test("sign-in rejects bad credentials and accepts the configured admin", async ({ page, browser }) => {
  const rejected = await page.request.post("/api/v1/auth/email/sign-in", {
    data: { email: "password-e2e@opentag.local", password: "definitely-wrong-password" },
    headers: { Origin: baseURL },
  });
  expect([401, 403]).toContain(rejected.status());
  await expect(rejected.json()).resolves.toMatchObject({ error: { code: "AUTH_INVALID_TOKEN" } });

  const context = await browser.newContext({
    storageState: { cookies: [], origins: [] },
    viewport: { width: 1440, height: 900 },
  });
  try {
    const signInPage = await context.newPage();
    await signInPage.goto("/api/v1/auth/dev/callback?next=/agents", { waitUntil: "networkidle" });
    await expect(signInPage).toHaveURL(`${baseURL}/agents`);
    await expect(signInPage.getByRole("heading", { name: "Agents", exact: true })).toBeVisible();
  } finally {
    await context.close();
  }
});

test("Agent settings persist a change across reload", async ({ page }) => {
  expect(agentId).toMatch(/^[0-9a-f-]{36}$/);
  await page.goto(`/agents/${agentId}/settings/identity`, { waitUntil: "networkidle" });
  const input = page.getByLabel("Display name");
  await expect(input).toHaveValue("e2e-agent");
  await input.fill("E2E Agent Updated");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("status")).toContainText("Name saved.");
  await page.reload({ waitUntil: "networkidle" });
  await expect(page.getByLabel("Display name")).toHaveValue("E2E Agent Updated");
});

test("Agent navigation reaches every Agent-owned destination", async ({ page }) => {
  expect(agentId).toMatch(/^[0-9a-f-]{36}$/);
  const destinations = [
    { name: "Home", heading: "E2E Agent Updated", path: `/agents/${agentId}` },
    { name: "Tasks", heading: "Tasks", path: `/agents/${agentId}/tasks` },
    { name: "Skills", heading: "Skills", path: `/agents/${agentId}/skills` },
    { name: "Integrations", heading: "Integrations", path: `/agents/${agentId}/integrations` },
    { name: "Usage", heading: "Usage", path: `/agents/${agentId}/usage` },
  ];
  for (const destination of destinations) {
    await page.goto(`/agents/${agentId}`, { waitUntil: "networkidle" });
    await page
      .getByRole("navigation", { name: "Agent", exact: true })
      .getByRole("button", { name: destination.name })
      .click();
    await expect(page).toHaveURL(new RegExp(`${destination.path.replace("/", "\\/")}\\/?$`));
    await expect(page.getByRole("heading", { name: destination.heading, exact: true })).toBeVisible();
  }
  await page.goto(`/agents/${agentId}`, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("menuitem", { name: "Account" }).click();
  await expect(page).toHaveURL(/\/account\/?$/);
  await expect(page.getByRole("heading", { name: "Account", exact: true })).toBeVisible();
});

test("Agent home, Tasks, and Skills stay usable in a narrow Agent workspace", async ({ page }) => {
  expect(agentId).toMatch(/^[0-9a-f-]{36}$/);
  await page.setViewportSize({ width: 390, height: 844 });

  await page.goto(`/agents/${agentId}`, { waitUntil: "networkidle" });
  const usageMetrics = page.locator('[data-ui="usage-metrics"] > div');
  await expect(usageMetrics).toHaveCount(2);
  const [tokensMetric, tasksMetric] = await Promise.all([
    usageMetrics.nth(0).boundingBox(),
    usageMetrics.nth(1).boundingBox(),
  ]);
  expect(tokensMetric).not.toBeNull();
  expect(tasksMetric).not.toBeNull();
  if (!tokensMetric || !tasksMetric) throw new Error("Usage metrics did not produce layout boxes");
  expect(tokensMetric.y).toBeCloseTo(tasksMetric.y, 1);

  await page.goto(`/agents/${agentId}/usage`, { waitUntil: "networkidle" });
  const usageSummaryMetrics = page.locator('[data-ui="usage-summary"] [data-ui="usage-metrics"] > div');
  await expect(usageSummaryMetrics).toHaveCount(2);
  const [summaryTokens, summaryTasks] = await Promise.all([
    usageSummaryMetrics.nth(0).boundingBox(),
    usageSummaryMetrics.nth(1).boundingBox(),
  ]);
  if (!summaryTokens || !summaryTasks) throw new Error("Usage summary metrics did not produce layout boxes");
  expect(summaryTokens.y).toBeCloseTo(summaryTasks.y, 1);

  await page.goto(`/agents/${agentId}/tasks`, { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { name: "Tasks", exact: true })).toBeVisible();
  await expect(page.getByRole("searchbox", { name: "Search Tasks" })).toBeVisible();
  await expect(page.getByRole("columnheader", { name: "Task", exact: true })).toHaveCount(1);
  await expect(page.getByRole("link", { name: "Review the seeded E2E task" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    await page.evaluate(() => document.documentElement.clientWidth),
  );

  await page.goto(`/agents/${agentId}/skills`, { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { name: "Skills", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Upload skill:/ })).toHaveAttribute("aria-disabled", "true");
  await page.getByRole("button", { name: "Preview" }).first().click();
  await expect(page.getByRole("heading", { name: "Instructions preview" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
    await page.evaluate(() => document.documentElement.clientWidth),
  );
});

test("Agents and Usage keep their compact composition when their own containers have room", async ({ page }) => {
  expect(agentId).toMatch(/^[0-9a-f-]{36}$/);
  await page.setViewportSize({ width: 1100, height: 900 });

  await page.goto("/agents", { waitUntil: "networkidle" });
  const agentRow = page.locator('[data-ui="agent-row"]').first();
  await expect(agentRow).toBeVisible();
  const agentRowBox = await agentRow.boundingBox();
  if (!agentRowBox) throw new Error("Agent row did not produce a layout box");
  expect(agentRowBox.height).toBeLessThan(110);

  await page.goto(`/agents/${agentId}/usage`, { waitUntil: "networkidle" });
  const usageAnalysisCards = page.locator('[data-ui="usage-analysis"] > section');
  await expect(usageAnalysisCards).toHaveCount(2);
  const [trendCard, breakdownCard] = await Promise.all([
    usageAnalysisCards.nth(0).boundingBox(),
    usageAnalysisCards.nth(1).boundingBox(),
  ]);
  if (!trendCard || !breakdownCard) throw new Error("Usage analysis cards did not produce layout boxes");
  expect(trendCard.y).toBeCloseTo(breakdownCard.y, 1);
});

test("an unauthenticated protected visit redirects to login", async ({ browser }) => {
  const context = await browser.newContext({
    storageState: { cookies: [], origins: [] },
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();
  try {
    await page.goto("/agents", { waitUntil: "networkidle" });
    await expect(page).toHaveURL(/\/login\?next=%2Fagents$/);
    await expect(page.getByRole("heading", { name: "Welcome back" })).toBeVisible();
  } finally {
    await context.close();
  }
});

test("the screenshot pass captures every primary page and writes a contact sheet", async ({
  page,
  browser,
  e2eRuntime,
}) => {
  expect(agentId).toMatch(/^[0-9a-f-]{36}$/);
  expect(taskId).toMatch(/^[0-9a-f-]{36}$/);
  await e2eRuntime.setSetupComplete();
  const screenshots = join(repositoryRoot, "e2e/screenshots");
  await mkdir(screenshots, { recursive: true });
  const pages: Array<{ file: string; route: string; heading: string }> = [
    { file: "login", route: "/login", heading: "Welcome back" },
    { file: "home", route: "/", heading: "Agents" },
    { file: "agents", route: "/agents", heading: "Agents" },
    { file: "agents-setup-create", route: "/agents/setup?action=create", heading: AGENT_SETUP_CREATE_HEADING },
    { file: "agents-computers", route: "/agents/computers", heading: "Computers" },
    { file: "agents-agentId", route: `/agents/${agentId}`, heading: "E2E Agent Updated" },
    { file: "agents-agentId-usage", route: `/agents/${agentId}/usage`, heading: "Usage" },
    { file: "agents-agentId-settings", route: `/agents/${agentId}/settings`, heading: "Agent settings" },
    { file: "agents-agentId-settings-section", route: `/agents/${agentId}/settings/identity`, heading: "Name" },
    { file: "tasks", route: `/agents/${agentId}/tasks`, heading: "Tasks" },
    {
      file: "tasks-taskId",
      route: `/agents/${agentId}/tasks/${taskId}`,
      heading: "Review the seeded E2E task",
    },
    { file: "usage", route: `/agents/${agentId}/usage`, heading: "Usage" },
    { file: "skills", route: `/agents/${agentId}/skills`, heading: "Skills" },
    { file: "integrations", route: `/agents/${agentId}/integrations`, heading: "Integrations" },
    { file: "account", route: "/account", heading: "Account" },
    { file: "internal-agent-setup", route: "/internal/agent-setup", heading: "Set up Reviewer" },
  ];
  const entries: Array<{ file: string; route: string; heading: string }> = [
    { file: "agent-setup", route: "/agents/setup", heading: AGENT_SETUP_CREATE_HEADING },
  ];
  // Agent Setup resumes an existing Agent even when admission is incomplete. The initial-step
  // screenshot is therefore captured by the first test, before this serial suite creates an Agent.
  await access(join(screenshots, "agent-setup.png"));

  for (const item of pages) {
    if (item.route === "/login") {
      const context = await browser.newContext({
        storageState: { cookies: [], origins: [] },
        viewport: { width: 1440, height: 900 },
      });
      try {
        const loginPage = await context.newPage();
        await loginPage.goto(item.route, { waitUntil: "networkidle" });
        await expect(loginPage.getByRole("heading", { name: item.heading, exact: true }).first()).toBeVisible({
          timeout: 30_000,
        });
        await expect(loginPage.locator('[aria-label^="Loading"]')).toHaveCount(0, { timeout: 30_000 });
        await loginPage.screenshot({ path: join(screenshots, `${item.file}.png`), fullPage: true });
      } finally {
        await context.close();
      }
    } else {
      await page.goto(item.route, { waitUntil: "networkidle" });
      await expect(page.getByRole("heading", { name: item.heading, exact: true }).first()).toBeVisible({
        timeout: 30_000,
      });
      await expect(page.locator('[aria-label^="Loading"]')).toHaveCount(0, { timeout: 30_000 });
      await page.screenshot({ path: join(screenshots, `${item.file}.png`), fullPage: true });
    }
    entries.push(item);
  }

  const htmlEscape = (value: string) =>
    value.replace(
      /[&<>"']/g,
      (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character] ?? character,
    );
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>OpenTag E2E screenshots</title>
<style>body{font-family:system-ui,sans-serif;margin:2rem;background:#f5f7f2;color:#17210f}main{display:grid;grid-template-columns:repeat(auto-fit,minmax(22rem,1fr));gap:1.5rem}figure{margin:0;padding:1rem;background:#fff;border:1px solid #d9e2d1;border-radius:.75rem}img{display:block;width:100%;height:auto;border:1px solid #d9e2d1}figcaption{margin-top:.75rem;font-weight:600;word-break:break-word}</style></head>
<body><h1>OpenTag E2E page screenshots</h1><main>${entries.map((entry) => `<figure><img src="${htmlEscape(`${entry.file}.png`)}" alt="${htmlEscape(entry.route)}"><figcaption>${htmlEscape(entry.route)}</figcaption></figure>`).join("")}</main></body></html>
`;
  await writeFile(join(screenshots, "index.html"), html);
  expect(entries).toHaveLength(17);
});
