import type { Page } from "@playwright/test";
import { expectAccessible, expectNoPageOverflow } from "./browser-contract.js";
import { expect, smokeTest as test } from "./fixtures.js";
import { binding, createAgent, mcpFixture, server } from "./mcp-browser-fixture.js";

const groups = {
  en: [
    "All",
    "Docs & Content",
    "Communication & Meetings",
    "Work Management",
    "Search & Extraction",
    "Data & Analytics",
    "Design & Creative",
    "Customers & Growth",
    "Automation",
    "Finance & Payments",
    "Development & Ops",
  ],
  zh: [
    "全部",
    "文档内容",
    "沟通会议",
    "工作管理",
    "搜索采集",
    "数据分析",
    "设计创作",
    "客户增长",
    "自动化",
    "财务支付",
    "开发运维",
  ],
};
const additions = [
  ["miro", "Miro"],
  ["todoist", "Todoist"],
  ["fireflies", "Fireflies"],
  ["intercom", "Intercom"],
  ["dovetail", "Dovetail"],
  ["superhuman-docs", "Superhuman Docs / Coda"],
  ["webflow", "Webflow"],
  ["wordpress-com", "WordPress.com"],
  ["contentful", "Contentful"],
  ["sanity", "Sanity"],
  ["klaviyo", "Klaviyo"],
  ["brevo", "Brevo"],
  ["similarweb", "Similarweb"],
  ["se-ranking", "SE Ranking"],
  ["clay", "Clay"],
  ["ashby", "Ashby"],
  ["airwallex", "Airwallex AgentOS"],
  ["mercury", "Mercury"],
  ["heygen", "HeyGen"],
  ["fal", "fal"],
  ["ideogram", "Ideogram"],
  ["veed", "VEED"],
  ["hugging-face", "Hugging Face"],
  ["perplexity", "Perplexity API"],
  ["apify", "Apify"],
  ["gitlab", "GitLab"],
  ["postman", "Postman"],
  ["cloudflare", "Cloudflare"],
  ["digitalocean", "DigitalOcean"],
  ["netlify", "Netlify"],
  ["grafana-cloud", "Grafana Cloud"],
  ["new-relic", "New Relic"],
  ["dynatrace", "Dynatrace"],
  ["elastic", "Elastic Agent Builder"],
  ["honeycomb", "Honeycomb"],
  ["pagerduty", "PagerDuty"],
  ["snowflake", "Snowflake"],
  ["databricks", "Databricks"],
  ["dbt", "dbt platform"],
  ["fivetran", "Fivetran Agent Context"],
  ["langsmith", "LangSmith"],
  ["make", "Make"],
  ["n8n", "n8n"],
  ["storyblok", "Storyblok"],
  ["lemlist", "lemlist"],
  ["vidiq", "vidIQ"],
  ["close", "Close"],
  ["pipedrive", "Pipedrive"],
  ["granola", "Granola"],
  ["higgsfield", "Higgsfield"],
  ["tally", "Tally"],
] as const;

async function discover(page: Page, agentId: string) {
  if (new URL(page.url()).pathname !== `/agents/${agentId}/mcp`) await page.goto(`/agents/${agentId}/mcp`);
  await page.getByRole("button", { name: "Discover", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Discover", exact: true });
  await expect(dialog.getByLabel("Search connectors")).toBeVisible();
  return dialog;
}
async function setupDbt(page: Page, agentId: string, environment = "123") {
  const directory = await discover(page, agentId);
  await directory.getByLabel("Search connectors").fill("dbt");
  await directory.getByRole("button", { name: "Add: dbt platform", exact: true }).click();
  const form = page.getByRole("dialog", { name: "Connect dbt platform", exact: true });
  await form.getByLabel("Connector address", { exact: true }).fill("https://tenant.example.com/api/ai/v1/mcp/");
  await form.locator('input[id="mcp-setup-x-dbt-prod-environment-id"]').fill(environment);
  await form.getByLabel("API key or token", { exact: true }).fill("fixture-dbt-key");
  return form;
}

for (const locale of ["en", "zh"] as const) {
  for (const width of [320, 390, 768, 1440]) {
    test(`expanded directory and fixed category order in ${locale} at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript((value) => localStorage.setItem("PARAGLIDE_LOCALE", value), locale);
      const agentId = await createAgent(page, "Catalog layout");
      const fixture = await mcpFixture(page);
      await page.goto(`/agents/${agentId}/mcp`);
      await page.getByRole("button", { name: locale === "en" ? "Discover" : "发现", exact: true }).click();
      const dialog = page.getByRole("dialog");
      await expect(dialog.getByRole("listitem")).toHaveCount(79);
      const select = dialog.getByRole("combobox", { name: locale === "en" ? "Categories" : "分类", exact: true });
      if (await select.isVisible()) {
        await select.click();
        await expect(page.getByRole("option")).toHaveText(groups[locale]);
        await page.getByRole("option", { name: groups[locale][0], exact: true }).click();
      } else {
        const tabs = dialog.locator('[data-ui="overflow-filter"]');
        await tabs.locator('button[aria-haspopup="menu"]').click();
        await expect
          .poll(async () => [
            ...(await tabs.locator("button[aria-pressed]").allTextContents()),
            ...(await page.getByRole("menuitemradio").allTextContents()),
          ])
          .toEqual(groups[locale]);
        await page.keyboard.press("Escape");
      }
      await expectNoPageOverflow(page);
      await expectAccessible(page);
      await dialog.screenshot({ path: test.info().outputPath(`catalog-${locale}-${width}.png`) });
      expect(fixture.writes).toHaveLength(0);
    });
  }
}

test("all 51 additions are searchable and customer setup cancels without writes", async ({ page }) => {
  test.setTimeout(180_000);
  const agentId = await createAgent(page, "Catalog search");
  const fixture = await mcpFixture(page);
  const dialog = await discover(page, agentId);
  for (const [id, title] of additions) {
    await dialog.getByLabel("Search connectors").fill(id);
    await expect(dialog.getByRole("button", { name: `Add: ${title}`, exact: true })).toBeVisible();
  }
  await dialog.getByLabel("Search connectors").fill("dbt");
  await dialog.getByRole("button", { name: "Add: dbt platform", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog.getByLabel("Search connectors")).toHaveValue("dbt");
  expect(fixture.writes).toHaveLength(0);
});

test("dbt setup validates before writing and retries the same installation", async ({ page }) => {
  const agentId = await createAgent(page, "dbt setup");
  const fixture = await mcpFixture(page);
  const form = await setupDbt(page, agentId, "invalid");
  await form.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(form.getByRole("alert")).toBeVisible();
  await expect(form.getByLabel("Connector address", { exact: true })).toHaveAttribute("aria-invalid", "false");
  await expect(form.locator('input[id="mcp-setup-x-dbt-prod-environment-id"]')).toHaveAttribute("aria-invalid", "true");
  await expect(form.getByRole("alert")).toHaveText("Enter a positive whole number.");
  expect(fixture.writes).toHaveLength(0);
  await form.locator('input[id="mcp-setup-x-dbt-prod-environment-id"]').fill("123");
  await form
    .getByLabel("Connector address", { exact: true })
    .fill("https://tenant.example.com/api/ai/v1/mcp/?token=secret");
  await form.getByRole("button", { name: "Connect", exact: true }).click();
  expect(fixture.writes).toHaveLength(0);
  await form.getByLabel("Connector address", { exact: true }).fill("https://tenant.example.com/api/ai/v1/mcp/");
  fixture.failProbe(true);
  await form.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(form.getByRole("alert")).toBeVisible();
  expect(fixture.servers).toHaveLength(1);
  expect(fixture.servers[0]).toMatchObject({
    defaultAuthKind: "bearer",
    authScheme: "Token",
    extraHeaders: { "x-dbt-prod-environment-id": "123" },
  });
  await expect(form.getByLabel("API key or token", { exact: true })).toHaveValue("fixture-dbt-key");
  fixture.failProbe(false);
  await form.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Discover", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Close Discover", exact: true }).click();
  await expect(page.getByRole("button", { name: "dbt platform", exact: true })).toBeVisible();
  expect(fixture.servers).toHaveLength(1);
  expect(fixture.mounts.get(agentId)).toHaveLength(1);
  expect(
    fixture.writes
      .filter((write) => write.path.endsWith("/authorization"))
      .every((write) => write.body.kind === "bearer" && write.body.bearerKey === "fixture-dbt-key"),
  ).toBe(true);
});

for (const locale of ["en", "zh"] as const) {
  for (const width of [320, 1440]) {
    test(`customer field validation is accessible in ${locale} at ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript((value) => localStorage.setItem("PARAGLIDE_LOCALE", value), locale);
      const agentId = await createAgent(page, "Field validation");
      const fixture = await mcpFixture(page);
      await page.goto(`/agents/${agentId}/mcp`);
      await page.getByRole("button", { name: locale === "en" ? "Discover" : "发现", exact: true }).click();
      const directory = page.getByRole("dialog");
      await directory.getByLabel(locale === "en" ? "Search connectors" : "搜索连接器").fill("dbt");
      await directory
        .getByRole("button", { name: locale === "en" ? "Add: dbt platform" : "添加: dbt platform", exact: true })
        .click();
      const form = page.getByRole("dialog");
      const address = form.getByLabel(locale === "en" ? "Connector address" : "连接器地址", { exact: true });
      const environment = form.getByLabel(locale === "en" ? "Production environment ID" : "生产环境 ID", {
        exact: true,
      });
      const key = form.getByLabel(locale === "en" ? "API key or token" : "API 密钥或令牌", { exact: true });
      await address.fill("https://tenant.example.com/api/ai/v1/mcp/");
      await key.fill("fixture-key");
      await form.getByRole("button", { name: locale === "en" ? "Connect" : "连接", exact: true }).click();
      await expect(environment).toHaveAttribute("aria-required", "true");
      await expect(environment).toHaveAttribute("aria-invalid", "true");
      await expect(address).toHaveAttribute("aria-invalid", "false");
      await expect(form.getByRole("alert")).toHaveText(locale === "en" ? "Required" : "必填");
      await environment.fill("1.5");
      await expect(form.getByRole("alert")).toHaveText(
        locale === "en" ? "Enter a positive whole number." : "请输入正整数。",
      );
      await expect(environment).toHaveAttribute("aria-describedby", /mcp-setup-x-dbt-prod-environment-id-error/);
      expect(
        await environment.evaluate((input) =>
          (input.getAttribute("aria-describedby") ?? "")
            .split(/\s+/)
            .every((id) => Boolean(document.getElementById(id))),
        ),
      ).toBe(true);
      await environment.scrollIntoViewIfNeeded();
      await expectAccessible(page);
      await expectNoPageOverflow(page);
      await form.screenshot({ path: test.info().outputPath(`setup-error-${locale}-${width}.png`) });
      await environment.fill("123");
      await expect(environment).toHaveAttribute("aria-invalid", "false");
      await expect(form.getByRole("alert")).toHaveCount(0);
      await expect(environment).not.toHaveAttribute("aria-describedby", /mcp-setup-x-dbt-prod-environment-id-error/);
      expect(fixture.writes).toHaveLength(0);
    });
  }
}

for (const kind of ["none", "oauth", "bearer"] as const) {
  test(`dbt setup isolates an existing ${kind} mount with a different environment or method`, async ({ page }) => {
    const agentId = await createAgent(page, "dbt isolation");
    const existing = {
      ...server("dbt", kind),
      url: "https://tenant.example.com/api/ai/v1/mcp/",
      authScheme: "Token",
      extraHeaders: { "x-dbt-prod-environment-id": kind === "bearer" ? "456" : "123" },
    };
    const fixture = await mcpFixture(page, [existing]);
    fixture.mounts.set(agentId, [
      {
        ...binding(existing),
        authorization: {
          kind,
          status: "revoked",
          hasCredential: false,
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
        },
      },
    ]);
    const form = await setupDbt(page, agentId);
    await form.getByRole("button", { name: "Connect", exact: true }).click();
    await expect.poll(() => fixture.mounts.get(agentId)?.length).toBe(2);
    expect(fixture.servers).toHaveLength(2);
    await expect
      .poll(() => fixture.writes.find((write) => write.path.endsWith("/authorization"))?.body)
      .toEqual({ kind: "bearer", bearerKey: "fixture-dbt-key" });
    const authorization = fixture.writes.find((write) => write.path.endsWith("/authorization"));
    expect(authorization?.path).not.toContain(existing.id);
    expect(authorization?.body).toEqual({ kind: "bearer", bearerKey: "fixture-dbt-key" });
  });
}

test("failed customer authorization cancels its own provisional mount", async ({ page }) => {
  const agentId = await createAgent(page, "dbt cancellation");
  const fixture = await mcpFixture(page);
  fixture.failAuthorization(true);
  const form = await setupDbt(page, agentId);
  await form.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(form.getByRole("alert")).toBeVisible();
  await form.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Discover", exact: true })).toBeVisible();
  expect(fixture.mounts.get(agentId)).toHaveLength(0);
});

test("customer setup creates a distinct installation after the prior mount's URL is overridden", async ({ page }) => {
  const agentId = await createAgent(page, "dbt override");
  const fixture = await mcpFixture(page);
  const form = await setupDbt(page, agentId);
  await form.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Discover", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Close Discover", exact: true }).click();
  await expect(page.getByRole("button", { name: "dbt platform", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "dbt platform", exact: true }).click();
  const details = page.getByRole("dialog");
  await details.getByLabel("Connector address", { exact: true }).fill("https://other.example.com/api/ai/v1/mcp/");
  await details.getByRole("button", { name: "Save", exact: true }).click();
  await expect(details).toBeHidden();
  const second = await setupDbt(page, agentId);
  await second.getByRole("button", { name: "Connect", exact: true }).click();
  await expect.poll(() => fixture.mounts.get(agentId)?.length).toBe(2);
  expect(fixture.servers).toHaveLength(2);
  expect(new Set(fixture.mounts.get(agentId)?.map((value) => value.mcpServerId)).size).toBe(2);
});

test("PagerDuty formats a raw key once while fixed raw-header services preserve their scheme", async ({ page }) => {
  const agentId = await createAgent(page, "Catalog keys");
  const fixture = await mcpFixture(page);
  for (const [id, title, key] of [
    ["pagerduty", "PagerDuty", "raw-fixture-key"],
    ["close", "Close", "close-fixture-key"],
  ] as const) {
    const dialog = await discover(page, agentId);
    await dialog.getByLabel("Search connectors").fill(id);
    await dialog.getByRole("button", { name: `Add: ${title}`, exact: true }).click();
    await page.getByRole("dialog").getByLabel("API key or token", { exact: true }).fill(key);
    await page.getByRole("dialog").getByRole("button", { name: "Save", exact: true }).click();
    await expect(
      page.getByRole("dialog", { name: "Discover", exact: true }).getByRole("img", { name: "Added", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Close Discover", exact: true }).click();
    await expect(page.getByRole("button", { name: title, exact: true })).toBeVisible();
  }
  const pager = fixture.servers.find((value) => value.name === "pagerduty");
  const close = fixture.servers.find((value) => value.name === "close");
  expect(pager).toMatchObject({ authHeader: "authorization", authScheme: "Token" });
  expect(close).toMatchObject({
    authHeader: "close-api-key",
    authScheme: "",
    extraHeaders: { "close-scope": "mcp.read" },
  });
  expect(
    fixture.writes.filter((value) => value.path.endsWith("/authorization")).map((value) => value.body.bearerKey),
  ).toEqual(["token=raw-fixture-key", "close-fixture-key"]);
});

for (const [id, title, guidance] of [
  ["honeycomb", "Honeycomb", "KEY_ID:SECRET_KEY"],
  ["brevo", "Brevo", "MCP-enabled"],
  ["superhuman-docs", "Superhuman Docs / Coda", "MCP enabled"],
  ["fivetran", "Fivetran Agent Context", "Context Layer system key"],
] as const) {
  test(`${title} explains its specific credential and links official setup instructions`, async ({ page }) => {
    const agentId = await createAgent(page, "Credential guidance");
    const fixture = await mcpFixture(page);
    const directory = await discover(page, agentId);
    await directory.getByLabel("Search connectors").fill(id);
    await directory.getByRole("button", { name: `Add: ${title}`, exact: true }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText(guidance);
    await expect(dialog.getByRole("link", { name: "Setup instructions", exact: true })).toHaveAttribute(
      "href",
      /^https:/,
    );
    await expect(dialog.getByLabel("API key or token", { exact: true })).toHaveAttribute("type", "password");
    await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Discover", exact: true })).toBeVisible();
    expect(fixture.mounts.get(agentId)).toHaveLength(0);
    expect(fixture.writes.some((write) => write.body.bearerKey !== undefined)).toBe(false);
  });
}
