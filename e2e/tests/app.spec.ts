import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { baseURL, repositoryRoot } from "../playwright.config.js";
import { expect, test } from "./fixtures.js";

test.describe.configure({ mode: "serial" });

let agentId: string;
let taskId: string;

test("onboarding renders server readiness facts", async ({ page }) => {
  await page.goto("/onboarding", { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { name: "Set up OpenTag" })).toBeVisible();
  await expect(page.getByText("Claude Code", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Ready to run", { exact: true })).toBeVisible();
  await page.screenshot({ path: join(repositoryRoot, "e2e/screenshots/onboarding.png"), fullPage: true });
});

test("Agent creation form creates an Agent visible in the list and detail page", async ({ page, e2eRuntime }) => {
  await page.goto("/onboarding", { waitUntil: "networkidle" });
  const displayName = page.getByLabel("Display name");
  await expect(displayName).toBeVisible();
  await displayName.fill("E2E Agent");
  const create = page.getByRole("button", { name: "Create Agent" });
  await expect(create).toBeEnabled();
  await create.click();
  await expect(page.getByRole("heading", { name: "Connect OpenTag to Feishu" })).toBeVisible({ timeout: 60_000 });

  const listResponse = await page.request.get("/api/v1/agents");
  expect(listResponse.ok()).toBeTruthy();
  const list = (await listResponse.json()) as { agents: Array<{ id: string; displayName: string }> };
  const created = list.agents.find((agent) => agent.displayName === "E2E Agent");
  expect(created).toBeDefined();
  agentId = created?.id ?? "";
  expect(agentId).toMatch(/^[0-9a-f-]{36}$/);
  await e2eRuntime.setSetupComplete();
  taskId = await e2eRuntime.seedTask(agentId);

  await page.goto(`/agents/${agentId}`, { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { name: "E2E Agent" })).toBeVisible();
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
  await expect(input).toHaveValue("E2E Agent");
  await input.fill("E2E Agent Updated");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("status")).toContainText("Name saved.");
  await page.reload({ waitUntil: "networkidle" });
  await expect(page.getByLabel("Display name")).toHaveValue("E2E Agent Updated");
});

test("shell navigation reaches every primary destination", async ({ page }) => {
  const destinations = [
    { name: "Agents", heading: "Agents", path: "/agents" },
    { name: "Tasks", heading: "Tasks", path: "/tasks" },
    { name: "Skills", heading: "Skills", path: "/skills" },
    { name: "Integrations", heading: "Integrations", path: "/integrations" },
  ];
  for (const destination of destinations) {
    await page.goto("/agents", { waitUntil: "networkidle" });
    await page.getByRole("navigation", { name: "Product" }).getByRole("link", { name: destination.name }).click();
    await expect(page).toHaveURL(new RegExp(`${destination.path.replace("/", "\\/")}\\/?$`));
    await expect(page.getByRole("heading", { name: destination.heading, exact: true })).toBeVisible();
  }
  await page.goto("/agents", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Account menu" }).click();
  await page.getByRole("menuitem", { name: "Account" }).click();
  await expect(page).toHaveURL(/\/account\/?$/);
  await expect(page.getByRole("heading", { name: "Account", exact: true })).toBeVisible();
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

test("the screenshot pass captures every addressable page and writes a contact sheet", async ({
  page,
  browser,
  e2eRuntime,
}) => {
  expect(agentId).toMatch(/^[0-9a-f-]{36}$/);
  expect(taskId).toMatch(/^[0-9a-f-]{36}$/);
  await e2eRuntime.setSetupComplete();
  const screenshots = join(repositoryRoot, "e2e/screenshots");
  await mkdir(screenshots, { recursive: true });
  const pages: Array<{ file: string; route: string; heading: string | RegExp }> = [
    { file: "login", route: "/login", heading: "Welcome back" },
    { file: "home", route: "/", heading: "Agents" },
    { file: "agents", route: "/agents", heading: "Agents" },
    { file: "agents-new", route: "/agents/new", heading: "Create Agent" },
    { file: "agents-computers", route: "/agents/computers", heading: "Agents" },
    { file: "agents-agentId", route: `/agents/${agentId}`, heading: "E2E Agent Updated" },
    { file: "agents-agentId-usage", route: `/agents/${agentId}/usage`, heading: /Usage|usage/i },
    { file: "agents-agentId-settings", route: `/agents/${agentId}/settings`, heading: "Agent settings" },
    { file: "agents-agentId-settings-section", route: `/agents/${agentId}/settings/identity`, heading: "Name" },
    { file: "tasks", route: "/tasks", heading: "Tasks" },
    { file: "tasks-taskId", route: `/tasks/${taskId}`, heading: "Review the seeded E2E task" },
    { file: "usage", route: "/usage", heading: "Agents" },
    { file: "skills", route: "/skills", heading: "Skills" },
    { file: "resources", route: "/resources", heading: "Skills" },
    { file: "integrations", route: "/integrations", heading: "Integrations" },
    { file: "account", route: "/account", heading: "Account" },
    { file: "internal-onboarding-lab", route: "/internal/onboarding-lab", heading: /not found|does not exist/i },
    { file: "internal-onboarding-v2", route: "/internal/onboarding-v2", heading: /Where|Agent|OpenTag/i },
  ];
  const entries: Array<{ file: string; route: string; heading: string | RegExp }> = [
    { file: "onboarding", route: "/onboarding", heading: "Set up OpenTag" },
  ];
  await e2eRuntime.setSetupIncomplete();
  await page.goto("/onboarding", { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { name: "Set up OpenTag" })).toBeVisible();
  await page.screenshot({ path: join(screenshots, "onboarding.png"), fullPage: true });
  await e2eRuntime.setSetupComplete();

  for (const item of pages) {
    if (item.route === "/login") {
      const context = await browser.newContext({
        storageState: { cookies: [], origins: [] },
        viewport: { width: 1440, height: 900 },
      });
      try {
        const loginPage = await context.newPage();
        await loginPage.goto(item.route, { waitUntil: "networkidle" });
        await expect(loginPage.getByRole("heading", { name: item.heading }).first()).toBeVisible({ timeout: 30_000 });
        await loginPage.screenshot({ path: join(screenshots, `${item.file}.png`), fullPage: true });
      } finally {
        await context.close();
      }
    } else {
      await page.goto(item.route, { waitUntil: "networkidle" });
      await expect(page.getByRole("heading", { name: item.heading }).first()).toBeVisible({ timeout: 30_000 });
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
  expect(entries).toHaveLength(19);
});
