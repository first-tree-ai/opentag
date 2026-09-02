import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, type Page, test } from "@playwright/test";
import { baseURL, repositoryRoot } from "../playwright.config.js";
import { expectAccessible, expectNoPageOverflow } from "./browser-contract.js";
import { type UsageVisualFixture, usageVisualFixtures, usageVisualScreenshotEntries } from "./usage-visual-fixtures.js";

const execFileAsync = promisify(execFile);
const screenshots = join(repositoryRoot, "e2e/screenshots/usage-visual");
const runtimeFile = join(repositoryRoot, "e2e/.runtime.json");

async function createVisualTestAgent(page: Page): Promise<string> {
  const cookies = await page.context().cookies();
  const csrf = cookies.find((cookie) => cookie.name === "opentag_csrf")?.value;
  if (!csrf) throw new Error("The authenticated storage state has no OpenTag CSRF cookie");
  const response = await page.request.post("/api/v1/agents", {
    data: {
      creationIntentId: randomUUID(),
      name: `usage-visual-${randomUUID()}`,
      displayName: "Usage Visual Agent",
      runtimeProvider: "codex",
    },
    headers: { Origin: baseURL, "content-type": "application/json", "x-opentag-csrf": csrf },
  });
  expect(response.ok(), await response.text()).toBeTruthy();
  const agent = (await response.json()) as { id: string };
  expect(agent.id).toMatch(/^[0-9a-f-]{36}$/iu);
  return agent.id;
}

function connectionTarget(url: string): { dsn: string; password: string } {
  const target = new URL(url);
  const password = decodeURIComponent(target.password);
  target.password = "";
  return { dsn: target.href, password };
}

async function setSetupComplete(): Promise<void> {
  const runtime = JSON.parse(await readFile(runtimeFile, "utf8")) as { databaseURL: string; userId: string };
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(runtime.userId)) {
    throw new Error("The E2E runtime has an invalid user identity");
  }
  const { dsn, password } = connectionTarget(runtime.databaseURL);
  await execFileAsync(
    "psql",
    [
      dsn,
      "-v",
      "ON_ERROR_STOP=1",
      "-Atc",
      `update users set setup_completed_at = now(), updated_at = now() where id = '${runtime.userId}'`,
    ],
    { env: { ...process.env, PGPASSWORD: password } },
  );
}

async function installUsageFixture(page: Page, agentId: string, fixture: UsageVisualFixture): Promise<string> {
  const usageApi = `**/api/v1/agents/${agentId}/usage?**`;
  const { name: _fixtureName, ...response } = fixture;
  await page.route(usageApi, async (route) => {
    await route.fulfill({ contentType: "application/json", body: JSON.stringify(response) });
  });
  return usageApi;
}

async function expectUsageFixtureState(page: Page, fixture: UsageVisualFixture): Promise<void> {
  if (fixture.tokens === 0 && fixture.cachedInputTokens === 0) {
    await expect(page.getByRole("heading", { level: 2, name: "No token usage" })).toBeVisible();
    await expect(page.locator('[data-ui="usage-analysis"]')).toHaveCount(0);
    await expect(page.getByRole("table", { name: "Token breakdown" })).toHaveCount(0);
    await expect(page.locator('[data-ui="usage-empty"] > div')).toHaveClass(/border-0/);
    return;
  }

  await expect(page.getByRole("heading", { level: 2, name: "Token usage over time" })).toBeVisible();
  await expect(page.getByRole("heading", { level: 2, name: "Token breakdown" })).toBeVisible();
  const table = page.getByRole("table", { name: "Token breakdown" });
  await expect(table).toBeVisible();
  await expect(table.locator("xpath=..")).not.toHaveClass(/(?:^|\s)ring(?:\s|$)/);
}

async function waitForUsageChartAnimation(page: Page, fixture: UsageVisualFixture): Promise<void> {
  if (fixture.tokens === 0 && fixture.cachedInputTokens === 0) return;
  await expect(page.locator('[data-ui="usage-chart"] canvas')).toBeVisible();
  await page.waitForTimeout(1_200);
}

async function expectDesktopUsageLayout(page: Page, fixture: UsageVisualFixture): Promise<void> {
  if (fixture.tokens === 0 && fixture.cachedInputTokens === 0) return;
  const cards = page.locator('[data-ui="usage-analysis"] > section');
  const [trend, breakdown] = await Promise.all([cards.nth(0).boundingBox(), cards.nth(1).boundingBox()]);
  if (!trend || !breakdown) throw new Error(`Usage fixture ${fixture.name} did not render both analysis cards`);
  expect(trend.y).toBeCloseTo(breakdown.y, 1);
}

async function expectMobileUsageLayout(page: Page): Promise<void> {
  const cards = page.locator('[data-ui="usage-analysis"] > section');
  const [trend, breakdown] = await Promise.all([cards.nth(0).boundingBox(), cards.nth(1).boundingBox()]);
  if (!trend || !breakdown) throw new Error("Mobile Usage analysis cards did not render");
  expect(breakdown.y).toBeGreaterThan(trend.y + trend.height);
}

function visualContactSheet(): string {
  const figures = usageVisualScreenshotEntries
    .map(
      (entry) =>
        `<figure><img src="${entry.file}.png" alt="${entry.route}"><figcaption>${entry.route}</figcaption></figure>`,
    )
    .join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Usage visual scenarios</title><style>body{font-family:system-ui,sans-serif;margin:2rem;background:#f5f7f2;color:#17210f}main{display:grid;grid-template-columns:repeat(auto-fit,minmax(22rem,1fr));gap:1.5rem}figure{margin:0;padding:1rem;background:#fff;border:1px solid #d9e2d1;border-radius:.75rem}img{display:block;width:100%;height:auto;border:1px solid #d9e2d1}figcaption{margin-top:.75rem;font-weight:600;word-break:break-word}</style></head><body><h1>Usage visual scenarios</h1><main>${figures}</main></body></html>`;
}

test("Usage renders representative visual states across responsive widths", async ({ page }) => {
  test.setTimeout(180_000);
  await setSetupComplete();
  const agentId = await createVisualTestAgent(page);
  await rm(screenshots, { recursive: true, force: true });
  await mkdir(screenshots, { recursive: true });

  await page.goto(`/agents/${agentId}/usage`, { waitUntil: "networkidle" });
  await expect(page.getByRole("heading", { level: 1, name: "Usage" })).toBeVisible();
  await expectUsageFixtureState(page, usageVisualFixtures[0]);

  for (const fixture of usageVisualFixtures) {
    const usageApi = await installUsageFixture(page, agentId, fixture);
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`/agents/${agentId}/usage`, { waitUntil: "networkidle" });
    await expect(page.getByRole("heading", { level: 1, name: "Usage" })).toBeVisible();
    await expect(page.locator('[data-ui="usage-summary"]')).toBeVisible();
    await expectNoPageOverflow(page);
    await expectUsageFixtureState(page, fixture);
    await waitForUsageChartAnimation(page, fixture);
    await expectDesktopUsageLayout(page, fixture);
    await expectAccessible(page);
    await page.screenshot({ path: join(screenshots, `usage-${fixture.name}-desktop.png`), fullPage: true });
    await page.unroute(usageApi);
  }

  for (const fixtureName of ["empty", "single-spike"] as const) {
    const fixture = usageVisualFixtures.find((candidate) => candidate.name === fixtureName);
    if (!fixture) throw new Error(`Missing Usage visual fixture: ${fixtureName}`);
    const usageApi = await installUsageFixture(page, agentId, fixture);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`/agents/${agentId}/usage`, { waitUntil: "networkidle" });
    await expect(page.locator('[data-ui="usage-summary"]')).toBeVisible();
    await expectNoPageOverflow(page);
    await expectUsageFixtureState(page, fixture);
    await waitForUsageChartAnimation(page, fixture);
    if (fixtureName === "single-spike") await expectMobileUsageLayout(page);
    await expectAccessible(page);
    await page.screenshot({ path: join(screenshots, `usage-${fixture.name}-mobile.png`), fullPage: true });
    if (fixtureName === "single-spike") {
      await page
        .locator('[data-ui="usage-analysis"] > section')
        .nth(1)
        .screenshot({
          path: join(screenshots, "usage-single-spike-mobile-breakdown.png"),
        });
    }
    await page.unroute(usageApi);
  }

  const narrowFixture = usageVisualFixtures.find((fixture) => fixture.name === "single-spike");
  if (!narrowFixture) throw new Error("Missing Usage visual fixture: single-spike");
  const narrowUsageApi = await installUsageFixture(page, agentId, narrowFixture);
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto(`/agents/${agentId}/usage`, { waitUntil: "networkidle" });
  await expectUsageFixtureState(page, narrowFixture);
  await expectNoPageOverflow(page);
  await waitForUsageChartAnimation(page, narrowFixture);
  await expectMobileUsageLayout(page);
  await expectAccessible(page);
  await page.screenshot({ path: join(screenshots, "usage-single-spike-narrow.png"), fullPage: true });
  await page.unroute(narrowUsageApi);

  const tabletFixture = usageVisualFixtures.find((fixture) => fixture.name === "steady-volume");
  if (!tabletFixture) throw new Error("Missing Usage visual fixture: steady-volume");
  const tabletUsageApi = await installUsageFixture(page, agentId, tabletFixture);
  await page.setViewportSize({ width: 768, height: 900 });
  await page.goto(`/agents/${agentId}/usage`, { waitUntil: "networkidle" });
  await expectUsageFixtureState(page, tabletFixture);
  await expectNoPageOverflow(page);
  await waitForUsageChartAnimation(page, tabletFixture);
  await expectMobileUsageLayout(page);
  await expectAccessible(page);
  await page.screenshot({ path: join(screenshots, "usage-steady-volume-tablet.png"), fullPage: true });
  await page.unroute(tabletUsageApi);

  await writeFile(join(screenshots, "index.html"), visualContactSheet());
});
