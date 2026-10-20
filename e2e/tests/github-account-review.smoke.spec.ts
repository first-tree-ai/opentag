import type {
  GitHubConnectionStatus,
  GitHubIntegrationOverview,
  GitHubRepositoryDiscoveryPage,
} from "@opentag/shared/browser";
import {
  ErrorEnvelopeSchema,
  GITHUB_INTEGRATION_AUTHORIZATION_PATH,
  GITHUB_INTEGRATION_DISCONNECT_PATH,
  GITHUB_INTEGRATION_INSTALLATION_PATH,
  GITHUB_INTEGRATION_PATH,
  GITHUB_INTEGRATION_REPOSITORIES_PATH,
} from "@opentag/shared/browser";
import type { Page } from "@playwright/test";
import { baseURL } from "../playwright.config.js";
import { expectAccessible, expectNoPageOverflow } from "./browser-contract.js";
import { expect, smokeTest as test } from "./fixtures.js";

// The built app, authentication, Server, and disposable PostgreSQL are real. GitHub management
// responses and the external authorization navigation are controlled browser fixtures. These
// tests do not exercise a live GitHub token exchange or change any real GitHub authorization.
const linkedAccount: GitHubConnectionStatus = {
  id: "3c63a21e-f6c7-4474-91ea-4dabf0566a24",
  accountId: "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e",
  githubHost: "github.com",
  appId: "871235",
  githubUserId: "42",
  githubLogin: "octocat",
  status: "active",
  authorizationVersion: "2",
  credentialGeneration: "1",
  accessExpiresAt: "2027-10-19T08:00:00.000Z",
  refreshExpiresAt: "2028-10-19T00:00:00.000Z",
  recheckRequired: false,
  nextRecheckAt: null,
  lastVerifiedAt: "2026-10-19T00:00:00.000Z",
  lastErrorCode: null,
  createdAt: "2026-10-18T00:00:00.000Z",
  updatedAt: "2026-10-19T00:00:00.000Z",
};

const discovered: GitHubRepositoryDiscoveryPage = {
  installations: [
    {
      installationId: "55123456",
      accountLogin: "review-org",
      accountType: "Organization",
      repositorySelection: "selected",
      suspended: false,
    },
  ],
  repositories: [],
  nextCursor: null,
  truncatedInstallations: [],
};

const discoveryFailure = ErrorEnvelopeSchema.parse({
  error: {
    code: "GITHUB_UPSTREAM_UNAVAILABLE",
    category: "transient",
    message: "Controlled upstream outage",
  },
});

async function githubFixture(page: Page) {
  const state = {
    current: { ...linkedAccount } as GitHubConnectionStatus | null,
    failDiscovery: false,
    disconnectCalls: 0,
    discoveryCalls: 0,
    authorizationIntents: [] as string[],
  };
  await page.route(
    /\/api\/v1\/integrations\/github(?:\/(?:repositories|authorization|disconnect))?(?:\?.*)?$/,
    async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === GITHUB_INTEGRATION_PATH) {
        const json: GitHubIntegrationOverview = {
          availability: { available: true, githubHost: "github.com", appId: linkedAccount.appId },
          connection: state.current,
        };
        await route.fulfill({ json });
        return;
      }
      if (path === GITHUB_INTEGRATION_REPOSITORIES_PATH) {
        state.discoveryCalls += 1;
        await route.fulfill(
          state.failDiscovery
            ? {
                status: 503,
                json: discoveryFailure,
              }
            : { json: discovered },
        );
        return;
      }
      if (path === GITHUB_INTEGRATION_AUTHORIZATION_PATH) {
        const body = route.request().postDataJSON() as { intent: string };
        state.authorizationIntents.push(body.intent);
        await route.fulfill({
          json: {
            connectionId: linkedAccount.id,
            authorizationUrl: "https://github.com/login/oauth/authorize?client_id=review-fixture&state=local-review",
            expiresAt: "2027-10-19T00:10:00.000Z",
          },
        });
        return;
      }
      if (path === GITHUB_INTEGRATION_DISCONNECT_PATH) {
        state.disconnectCalls += 1;
        state.current = null;
        await route.fulfill({ json: { ...linkedAccount, status: "revoked", authorizationVersion: "3" } });
        return;
      }
      throw new Error(`Unexpected GitHub fixture request: ${path}`);
    },
  );
  await page.route("https://github.com/login/oauth/authorize**", async (route) => {
    await route.fulfill({
      status: 302,
      headers: { location: `${baseURL}/account?github_oauth=error&github_oauth_error=GITHUB_OAUTH_DENIED` },
      body: "",
    });
  });
  return state;
}

test("real unavailable deployment does not offer unusable GitHub authorization", async ({ page }) => {
  await page.goto("/account", { waitUntil: "networkidle" });
  const github = page.locator('[data-ui="account-github"]');
  await expect(github.getByText("GitHub integration unavailable", { exact: true })).toBeVisible();
  await expect(github.getByRole("button", { name: "Add GitHub account", exact: true })).toHaveCount(0);
  await expectNoPageOverflow(page);
  await expectAccessible(page);
});

test("active GitHub management exposes the exact account and server-owned installation destination", async ({
  page,
}) => {
  await githubFixture(page);
  await page.goto("/account", { waitUntil: "networkidle" });
  const github = page.locator('[data-ui="account-github"]');
  await expect(github.getByText(/@octocat/)).toBeVisible();
  const install = github.getByRole("link", { name: "Configure on GitHub", exact: true });
  await expect(install).toHaveAttribute("href", GITHUB_INTEGRATION_INSTALLATION_PATH);
  await expect(install).toHaveAttribute("target", "_blank");
  await expect(install).toHaveAttribute("rel", /noopener/);
  await expectAccessible(page);
});

test("repository discovery failure preserves identity and account management", async ({ page }) => {
  const fixture = await githubFixture(page);
  fixture.failDiscovery = true;
  await page.goto("/account", { waitUntil: "networkidle" });
  const github = page.locator('[data-ui="account-github"]');
  await expect(github.getByText("@octocat", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Change account", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Remove account", exact: true })).toBeVisible();
  expect(fixture.discoveryCalls).toBe(0);
  await page.screenshot({ path: test.info().outputPath("discovery-independent.png"), fullPage: true });
});

test("removing a shared GitHub account requires confirmation before the mutation", async ({ page }) => {
  const fixture = await githubFixture(page);
  await page.goto("/account", { waitUntil: "networkidle" });
  const github = page.locator('[data-ui="account-github"]');
  const removeButton = github.getByRole("button", { name: "Remove account", exact: true });
  await removeButton.click();
  const dialog = page.getByRole("dialog", { name: "Remove GitHub account?" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("All your Agents will lose GitHub access through @octocat");
  await expect(dialog).toContainText("App installation on GitHub will remain");
  await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
  expect(fixture.disconnectCalls, "No shared authorization should be removed before confirmation").toBe(0);
  await expectAccessible(page);
  await page.screenshot({ path: test.info().outputPath("remove-confirmation.png"), fullPage: true });
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(removeButton).toBeFocused();
  expect(fixture.disconnectCalls).toBe(0);
  await removeButton.click();
  await dialog.getByRole("button", { name: "Remove account", exact: true }).click();
  await expect(github.getByRole("button", { name: "Add GitHub account" })).toBeVisible();
  await expect(page.locator('[data-ui="account-github-message"]')).toBeFocused();
  expect(fixture.disconnectCalls).toBe(1);
});

test("GitHub authorization round trip preserves an unsaved display-name draft", async ({ page }) => {
  const fixture = await githubFixture(page);
  await page.goto("/account", { waitUntil: "networkidle" });
  const displayName = page.getByRole("textbox", { name: "Display name", exact: true });
  let profileWrites = 0;
  page.on("request", (request) => {
    if (request.method() === "PATCH" && new URL(request.url()).pathname === "/api/v1/me") profileWrites += 1;
  });
  const draft = `${await displayName.inputValue()} unsaved GitHub draft`;
  await displayName.fill(draft);
  await page.getByRole("button", { name: "Change account", exact: true }).click();
  await expect(page.locator('[data-ui="account-github-outcome"]')).toHaveText("GitHub authorization was denied.");
  expect(fixture.authorizationIntents).toEqual(["replace"]);
  await expect(displayName).toBeVisible();
  await test.info().attach("profile-draft-observation", {
    body: JSON.stringify({ expected: draft, actual: await displayName.inputValue() }, null, 2),
    contentType: "application/json",
  });
  await expect(displayName).toHaveValue(draft, { timeout: 2_000 });
  await expect(page.locator('[data-ui="account-github"]').getByText("@octocat", { exact: true })).toBeVisible();
  expect(profileWrites).toBe(0);
});

test("GitHub help and cancelled removal preserve the unsaved display-name draft", async ({ page }) => {
  await githubFixture(page);
  await page.goto("/account", { waitUntil: "networkidle" });
  const displayName = page.getByRole("textbox", { name: "Display name", exact: true });
  const draft = `${await displayName.inputValue()} unsaved refresh draft`;
  await displayName.fill(draft);
  await page.getByRole("button", { name: "About GitHub repository access" }).click();
  await expect(page.getByText(/Install or configure the OpenTag App on GitHub/)).toBeVisible();
  await expect(page.getByText(/contact an organization administrator if you don't have permission/)).toBeVisible();
  await page.getByRole("button", { name: "Remove account", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(displayName).toHaveValue(draft);
});

test("the active GitHub surface has no page overflow at supported account widths", async ({ page }) => {
  await githubFixture(page);
  await page.goto("/account", { waitUntil: "networkidle" });
  for (const width of [320, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    await expectNoPageOverflow(page);
    await expect(page.locator('[data-ui="account-github"]').getByText(/@octocat/)).toBeVisible();
    if (width === 768 || width === 1440 || width === 390)
      await page.screenshot({ path: test.info().outputPath(`github-active-${width}.png`), fullPage: true });
  }
});

test("blocked draft storage keeps edits on the page and prevents authorization", async ({ page }) => {
  const fixture = await githubFixture(page);
  await page.goto("/account", { waitUntil: "networkidle" });
  const displayName = page.getByRole("textbox", { name: "Display name", exact: true });
  await displayName.fill("Keep this unsaved name");
  await page.evaluate(() => {
    Storage.prototype.setItem = () => {
      throw new DOMException("Controlled storage failure", "QuotaExceededError");
    };
  });
  await page.getByRole("button", { name: "Change account", exact: true }).click();
  await expect(page.getByRole("alert")).toContainText("Save or discard the edit before authorizing GitHub.");
  await expect(displayName).toHaveValue("Keep this unsaved name");
  expect(fixture.authorizationIntents).toEqual([]);
});

test("Chinese GitHub management keeps identity, help and confirmation usable at narrow widths", async ({ page }) => {
  await githubFixture(page);
  await page.addInitScript(() => localStorage.setItem("PARAGLIDE_LOCALE", "zh"));
  await page.goto("/account", { waitUntil: "networkidle" });
  const github = page.locator('[data-ui="account-github"]');
  await expect(github.getByText("供你的所有 Agent 使用。", { exact: true })).toBeVisible();
  for (const width of [1440, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(github.getByText("@octocat", { exact: true })).toBeVisible();
    await expect(github.getByRole("link", { name: "在 GitHub 配置", exact: true })).toBeVisible();
    await expectNoPageOverflow(page);
    await page.screenshot({ path: test.info().outputPath(`github-zh-${width}.png`), fullPage: true });
  }
  await github.getByRole("button", { name: "了解 GitHub 仓库访问" }).click();
  await expect(github.getByText(/如果没有安装或配置 App 的权限，请联系组织管理员协助/)).toBeVisible();
  await expect(page.getByRole("button", { name: "更换账户", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "移除账户", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "移除 GitHub 账户？" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("GitHub 上的授权与 App 安装会保留");
  await expect(dialog.getByRole("button", { name: "取消", exact: true })).toBeFocused();
  await expectAccessible(page);
  await expectNoPageOverflow(page);
  await page.screenshot({ path: test.info().outputPath("github-zh-confirm-320.png"), fullPage: true });
});
