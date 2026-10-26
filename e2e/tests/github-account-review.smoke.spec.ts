import type {
  GitHubConnectionStatus,
  GitHubIntegrationOverview,
  GitHubRepositoryDiscoveryPage,
} from "@opentag/shared/browser";
import {
  ErrorEnvelopeSchema,
  GITHUB_INTEGRATION_AUTHORIZATION_PATH,
  GITHUB_INTEGRATION_DISCONNECT_PATH,
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
  oauthClientId: "871235",
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
  repositories: [],
  nextCursor: null,
  truncated: false,
};

const discoveryFailure = ErrorEnvelopeSchema.parse({
  error: {
    code: "GITHUB_UPSTREAM_UNAVAILABLE",
    category: "transient",
    message: "Controlled upstream outage",
  },
});

function matchesDiscoveryAuthorization(query: URLSearchParams, connection: GitHubConnectionStatus | null) {
  return (
    connection !== null &&
    query.get("connectionId") === connection.id &&
    query.get("authorizationVersion") === connection.authorizationVersion
  );
}

async function githubFixture(page: Page) {
  const state = {
    current: { ...linkedAccount } as GitHubConnectionStatus | null,
    failDiscovery: false,
    disconnectCalls: 0,
    discoveryCalls: 0,
    discoveryPages: { start: discovered } as Record<string, GitHubRepositoryDiscoveryPage>,
    authorizationIntents: [] as string[],
  };
  await page.route(
    /\/api\/v2\/integrations\/github(?:\/(?:repositories|authorization|disconnect))?(?:\?.*)?$/,
    async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === GITHUB_INTEGRATION_PATH) {
        const json: GitHubIntegrationOverview = {
          availability: { available: true, githubHost: "github.com", oauthClientId: linkedAccount.oauthClientId },
          connection: state.current,
        };
        await route.fulfill({ json });
        return;
      }
      if (path === GITHUB_INTEGRATION_REPOSITORIES_PATH) {
        state.discoveryCalls += 1;
        const query = new URL(route.request().url()).searchParams;
        if (!matchesDiscoveryAuthorization(query, state.current)) {
          await route.fulfill({
            status: 409,
            json: ErrorEnvelopeSchema.parse({
              error: {
                code: "GITHUB_AUTHORIZATION_VERSION_CONFLICT",
                category: "credential",
                message: "The GitHub authorization changed",
              },
            }),
          });
          return;
        }
        await route.fulfill(
          state.failDiscovery
            ? {
                status: 503,
                json: discoveryFailure,
              }
            : { json: state.discoveryPages[query.get("cursor") ?? "start"] },
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
  await expect(github.getByRole("button", { name: "Authorize GitHub account", exact: true })).toHaveCount(0);
  await expectNoPageOverflow(page);
  await expectAccessible(page);
});

test("an unlinked GitHub account offers authorization without a repository configuration step", async ({ page }) => {
  const fixture = await githubFixture(page);
  fixture.current = null;
  await page.goto("/account", { waitUntil: "networkidle" });
  const github = page.locator('[data-ui="account-github"]');
  await expect(github.getByRole("button", { name: "Authorize GitHub account", exact: true })).toBeVisible();
  await expect(github.getByRole("button", { name: "View repositories", exact: true })).toHaveCount(0);
  await expect(github.getByRole("button", { name: "Disconnect account authorization", exact: true })).toHaveCount(0);
  await expect(github.getByText("Repository access", { exact: true })).toHaveCount(0);
  await expect(github.getByRole("link")).toHaveCount(0);
  expect(fixture.discoveryCalls).toBe(0);
  await expectNoPageOverflow(page);
  await expectAccessible(page);
});

test("active GitHub management exposes the exact account and OAuth authorization settings destination", async ({
  page,
}) => {
  await githubFixture(page);
  await page.goto("/account", { waitUntil: "networkidle" });
  const github = page.locator('[data-ui="account-github"]');
  await expect(github.getByText(/@octocat/)).toBeVisible();
  await expect(github.getByRole("link", { name: "GitHub authorization settings", exact: true })).toHaveCount(0);
  const helpButton = github.getByRole("button", { name: "About GitHub authorization", exact: true });
  await helpButton.click();
  const help = page.getByRole("dialog", { name: "About GitHub authorization", exact: true });
  const settings = help.getByRole("link", { name: "GitHub authorization settings", exact: true });
  await expect(settings).toHaveAttribute("href", "https://github.com/settings/applications");
  await expect(settings).toHaveAttribute("target", "_blank");
  await expect(settings).toHaveAttribute("rel", "noopener noreferrer");
  await expect(help).toHaveCSS("opacity", "1");
  await expectAccessible(page);
  await page.keyboard.press("Escape");
  await expect(help).toBeHidden();
  await expect(helpButton).toBeFocused();
});

test("repository access is queried on demand and keeps missing-filter results separate from authorization", async ({
  page,
}) => {
  const fixture = await githubFixture(page);
  const repositories = Array.from({ length: 101 }, (_, i) => ({
    repositoryId: String(i + 1),

    fullName: `review-org/repo-${i + 1}`,
    private: true,
    defaultBranch: "main",
    permissions: { pull: true, push: false },
  }));
  fixture.discoveryPages = {
    start: { ...discovered, repositories: repositories.slice(0, 100), nextCursor: "last" },
    last: { ...discovered, repositories: repositories.slice(100) },
  };
  await page.goto("/account", { waitUntil: "networkidle" });
  expect(fixture.discoveryCalls).toBe(0);
  const trigger = page.getByRole("button", { name: "View repositories", exact: true });
  await trigger.click();
  const dialog = page.getByRole("dialog", { name: "Accessible repositories", exact: true });
  await expect(dialog.getByRole("listitem")).toHaveCount(100);
  await expect(dialog.getByText("@octocat", { exact: true })).toHaveCount(0);
  await dialog.getByRole("searchbox").fill("repo-101");
  await expect(dialog.getByText("No matches in the loaded repositories.", { exact: true })).toBeVisible();
  await dialog.getByRole("button", { name: "Load more", exact: true }).click();
  await expect(dialog.getByText("review-org/repo-101", { exact: true })).toBeVisible();
  expect(fixture.discoveryCalls).toBe(2);
  await expectAccessible(page);
  await dialog.getByRole("button", { name: "Close repository list", exact: true }).click();
  await expect(trigger).toBeFocused();
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  expect(fixture.discoveryCalls).toBe(2);
});

test("paginated repository results never mix after account replacement in another tab", async ({ page }) => {
  const fixture = await githubFixture(page);
  const repositories = Array.from({ length: 102 }, (_, i) => ({
    repositoryId: String(i + 1),

    fullName: `review-org/previous-${i + 1}`,
    private: true,
    defaultBranch: "main",
    permissions: { pull: true, push: false },
  }));
  fixture.discoveryPages = {
    start: { ...discovered, repositories: repositories.slice(0, 100), nextCursor: "second" },
    second: { ...discovered, repositories: repositories.slice(100, 101), nextCursor: "third" },
    third: { ...discovered, repositories: repositories.slice(101) },
  };
  await page.goto("/account", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "View repositories", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Accessible repositories", exact: true });
  await expect(dialog.getByRole("listitem")).toHaveCount(100);
  await expect(dialog.getByRole("button", { name: "Load more", exact: true })).toBeEnabled();
  fixture.current = { ...linkedAccount, githubLogin: "replacement-user", authorizationVersion: "3" };
  fixture.discoveryPages = {
    start: {
      ...discovered,
      repositories: repositories.slice(0, 1).map((repository) => ({
        ...repository,
        repositoryId: "201",
        fullName: "review-org/replacement",
      })),
    },
  };
  await dialog.getByRole("button", { name: "Load more", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText("@replacement-user", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "View repositories", exact: true }).click();
  await expect(dialog.getByRole("listitem")).toHaveText(["review-org/replacement"]);
  await expect(dialog).toHaveCSS("opacity", "1");
  await expectAccessible(page);
});

test("repository read failure retries into a compact OAuth authorization empty result", async ({ page }) => {
  const fixture = await githubFixture(page);
  fixture.failDiscovery = true;
  await page.goto("/account", { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "View repositories", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Accessible repositories", exact: true });
  await expect(dialog.getByText("Couldn't load repositories. Try again.", { exact: true })).toBeVisible();
  fixture.failDiscovery = false;
  await dialog.getByRole("button", { name: "Try again", exact: true }).click();
  await expect(
    dialog.getByText(
      "No accessible repositories found. Check your GitHub account permissions and OAuth authorization.",
      { exact: true },
    ),
  ).toBeVisible();
  await expect(dialog.getByRole("heading")).toHaveCount(1);
  await expect(dialog.getByRole("searchbox")).toHaveCount(0);
  await expect(dialog.getByRole("link", { name: "GitHub authorization settings", exact: true })).toHaveCount(0);
  await dialog.getByRole("button", { name: "About repository access", exact: true }).click();
  const help = page.getByRole("dialog", { name: "About repository access", exact: true });
  const settings = help.getByRole("link", { name: "GitHub authorization settings", exact: true });
  await expect(settings).toHaveAttribute("href", "https://github.com/settings/applications");
  await expect(settings).toHaveAttribute("target", "_blank");
  await expect(settings).toHaveAttribute("rel", "noopener noreferrer");
  await expect(help).toHaveCSS("opacity", "1");
  await expectAccessible(page);
});

for (const status of ["reauthorization_required", "revoked"] as const) {
  test(`repository access reconciles a ${status} authorization without a page reload`, async ({ page }) => {
    const fixture = await githubFixture(page);
    await page.goto("/account", { waitUntil: "networkidle" });
    await expect(page.getByRole("button", { name: "View repositories", exact: true })).toBeVisible();
    fixture.current = status === "revoked" ? null : { ...linkedAccount, status, authorizationVersion: "3" };
    await page.route(`**${GITHUB_INTEGRATION_REPOSITORIES_PATH}*`, (route) =>
      route.fulfill({
        status: status === "revoked" ? 404 : 409,
        json: ErrorEnvelopeSchema.parse({
          error: {
            code: status === "revoked" ? "GITHUB_CONNECTION_NOT_FOUND" : "GITHUB_CONNECTION_STATE_INVALID",
            category: "credential",
            message: "The GitHub authorization has changed",
          },
        }),
      }),
    );
    await page.getByRole("button", { name: "View repositories", exact: true }).click();
    await expect(page.getByRole("dialog", { name: "Accessible repositories", exact: true })).toHaveCount(0);
    const authorize = page.getByRole("button", {
      name: status === "revoked" ? "Authorize GitHub account" : "Reauthorize",
      exact: true,
    });
    await expect(authorize).toBeVisible();
    await expect(authorize).toBeFocused();
    await expectAccessible(page);
  });
}

const viewerLabels = {
  en: {
    view: "View repositories",
    title: "Accessible repositories",
    close: "Close repository list",
    help: "About repository access",
    empty: "No accessible repositories found.",
    error: "Couldn't load repositories. Try again.",
  },
  zh: {
    view: "查看仓库",
    title: "Agent 可访问的仓库",
    close: "关闭仓库列表",
    help: "了解仓库访问范围",
    empty: "未找到可访问的仓库。",
    error: "暂时无法读取仓库，请重试。",
  },
};
type ViewerScene = "loaded" | "empty" | "error";

async function expectDialogReady(dialog: ReturnType<Page["getByRole"]>) {
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveCSS("opacity", "1");
  // Contrast is measured on the settled surface, not intermediate fade-in colors.
  await dialog.evaluate(async (element) => {
    const animations = element
      .getAnimations({ subtree: true })
      .filter((animation) => animation.effect?.getTiming().iterations !== Infinity);
    await Promise.all(animations.map((animation) => animation.finished.catch(() => undefined)));
  });
}

async function reviewViewerCase(
  page: Page,
  fixture: Awaited<ReturnType<typeof githubFixture>>,
  locale: keyof typeof viewerLabels,
  width: number,
  scene: ViewerScene,
) {
  fixture.failDiscovery = scene === "error";
  fixture.discoveryPages = {
    start: {
      ...discovered,
      repositories:
        scene === "loaded"
          ? [
              {
                repositoryId: "1",
                fullName: "review-org/web",
                private: true,
                defaultBranch: "main",
                permissions: { pull: true, push: true },
              },
              {
                repositoryId: "2",
                fullName: "review-org/api",
                private: true,
                defaultBranch: "main",
                permissions: { pull: true, push: false },
              },
            ]
          : [],
    },
  };
  const labels = viewerLabels[locale];
  await page.getByRole("button", { name: labels.view, exact: true }).click();
  const dialog = page.getByRole("dialog", { name: labels.title, exact: true });
  if (scene === "loaded") await expect(dialog.getByRole("listitem")).toHaveCount(2);
  else await expect(dialog).toContainText(scene === "error" ? labels.error : labels.empty);
  await expectDialogReady(dialog);
  await expectAccessible(page);
  await expectNoPageOverflow(page);
  const bounds = await dialog.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds?.x ?? -1).toBeGreaterThanOrEqual(0);
  expect((bounds?.x ?? 0) + (bounds?.width ?? 0)).toBeLessThanOrEqual(width);
  expect((bounds?.y ?? 0) + (bounds?.height ?? 0)).toBeLessThanOrEqual(900);
  await dialog.screenshot({ path: test.info().outputPath(`repositories-${locale}-${width}-${scene}.png`) });
  if (scene === "loaded") {
    await dialog.getByRole("button", { name: labels.help, exact: true }).click();
    const help = page.getByRole("dialog", { name: labels.help, exact: true });
    await expectDialogReady(help);
    await expectAccessible(page);
    await page.keyboard.press("Escape");
    await expect(help).toBeHidden();
    await expect(dialog).toBeVisible();
  }
  await dialog.getByRole("button", { name: labels.close, exact: true }).click();
  await expect(dialog).toBeHidden();
}

test("repository viewer keeps results, empty guidance and errors readable in both locales", async ({ page }) => {
  const fixture = await githubFixture(page);
  await page.goto("/account", { waitUntil: "networkidle" });
  for (const locale of ["en", "zh"] as const) {
    await page.evaluate((value) => localStorage.setItem("PARAGLIDE_LOCALE", value), locale);
    await page.reload({ waitUntil: "networkidle" });
    for (const width of [1440, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await page
        .locator('[data-ui="account-github"]')
        .screenshot({ path: test.info().outputPath(`account-github-${locale}-${width}.png`) });
      for (const scene of ["loaded", "empty", "error"] as const) {
        await reviewViewerCase(page, fixture, locale, width, scene);
      }
    }
  }
});

test("repository discovery failure preserves identity and account management", async ({ page }) => {
  const fixture = await githubFixture(page);
  fixture.failDiscovery = true;
  await page.goto("/account", { waitUntil: "networkidle" });
  const github = page.locator('[data-ui="account-github"]');
  await expect(github.getByText("@octocat", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Change account", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Disconnect account authorization", exact: true })).toBeVisible();
  expect(fixture.discoveryCalls).toBe(0);
  await page.screenshot({ path: test.info().outputPath("discovery-independent.png"), fullPage: true });
});

test("disconnecting the Context Tree GitHub account requires confirmation before the mutation", async ({ page }) => {
  const fixture = await githubFixture(page);
  await page.goto("/account", { waitUntil: "networkidle" });
  const github = page.locator('[data-ui="account-github"]');
  const removeButton = github.getByRole("button", { name: "Disconnect account authorization", exact: true });
  await removeButton.click();
  const dialog = page.getByRole("dialog", { name: "Disconnect GitHub account authorization?" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("Context Tree will lose access through @octocat");
  await expect(dialog).toContainText("You can revoke it in GitHub settings");
  await expect(dialog.getByRole("button", { name: "Cancel", exact: true })).toBeFocused();
  expect(fixture.disconnectCalls, "No shared authorization should be disconnected before confirmation").toBe(0);
  await expect(dialog).toHaveCSS("opacity", "1");
  await expectAccessible(page);
  await page.screenshot({ path: test.info().outputPath("remove-confirmation.png"), fullPage: true });
  await dialog.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(removeButton).toBeFocused();
  expect(fixture.disconnectCalls).toBe(0);
  await removeButton.click();
  await dialog.getByRole("button", { name: "Disconnect account authorization", exact: true }).click();
  await expect(github.getByRole("button", { name: "Authorize GitHub account" })).toBeVisible();
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

test("a failed GitHub authorization start does not restore an abandoned profile edit", async ({ page }) => {
  await githubFixture(page);
  await page.route(`**${GITHUB_INTEGRATION_AUTHORIZATION_PATH}`, (route) =>
    route.fulfill({ status: 503, json: discoveryFailure }),
  );
  await page.goto("/account", { waitUntil: "networkidle" });
  const displayName = page.getByRole("textbox", { name: "Display name", exact: true });
  const confirmed = await displayName.inputValue();
  await displayName.fill(`${confirmed} abandoned edit`);
  await page.getByRole("button", { name: "Change account", exact: true }).click();
  await expect(page.locator('[data-ui="account-github-message"]')).toContainText("GitHub is temporarily unavailable");
  await displayName.fill(confirmed);
  await expect(page.getByText("Unsaved changes", { exact: true })).toHaveCount(0);
  await page.goto("/agents", { waitUntil: "networkidle" });
  await page.goto("/account", { waitUntil: "networkidle" });
  await expect(displayName).toHaveValue(confirmed);
  await expect(page.getByText("Unsaved changes", { exact: true })).toHaveCount(0);
});

test("GitHub help and cancelled disconnection preserve the unsaved display-name draft", async ({ page }) => {
  await githubFixture(page);
  await page.goto("/account", { waitUntil: "networkidle" });
  const displayName = page.getByRole("textbox", { name: "Display name", exact: true });
  const draft = `${await displayName.inputValue()} unsaved refresh draft`;
  await displayName.fill(draft);
  await page.getByRole("button", { name: "About GitHub authorization" }).click();
  const help = page.getByRole("dialog", { name: "About GitHub authorization" });
  await expect(help.getByText(/This account authorization is used by Context Tree/)).toBeVisible();
  await expect(help.getByText(/Each Agent uses its own GitHub MCP connector for GitHub tasks/)).toBeVisible();
  await expect(
    help.getByText(/Organization repositories may require organization approval or SSO authorization/),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(help).toBeHidden();
  await expect(page.getByRole("button", { name: "About GitHub authorization" })).toBeFocused();
  await page.getByRole("button", { name: "Disconnect account authorization", exact: true }).click();
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
  await expect(
    github.getByText("为 Context Tree 授权 GitHub。Agent 的 GitHub 操作请在各自的 Connector 中连接 GitHub MCP。", {
      exact: true,
    }),
  ).toBeVisible();
  for (const width of [1440, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await expect(github.getByText("@octocat", { exact: true })).toBeVisible();
    await expect(github.getByRole("link", { name: "GitHub 授权设置", exact: true })).toHaveCount(0);
    const helpButton = github.getByRole("button", { name: "了解 GitHub 账户授权", exact: true });
    await helpButton.click();
    const help = page.getByRole("dialog", { name: "了解 GitHub 账户授权", exact: true });
    const settings = help.getByRole("link", { name: "GitHub 授权设置", exact: true });
    await expect(settings).toHaveAttribute("href", "https://github.com/settings/applications");
    await expect(settings).toHaveAttribute("target", "_blank");
    await expect(settings).toHaveAttribute("rel", "noopener noreferrer");
    await expect(help.getByText(/组织仓库可能需要组织审批或 SSO 授权/)).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(help).toBeHidden();
    await expect(helpButton).toBeFocused();
    await expectNoPageOverflow(page);
    await page.screenshot({ path: test.info().outputPath(`github-zh-${width}.png`), fullPage: true });
  }
  await expect(page.getByRole("button", { name: "更换账户", exact: true })).toBeVisible();
  const disconnect = page.getByRole("button", { name: "断开授权（GitHub 账户）", exact: true });
  await expect(disconnect).toHaveText("断开授权");
  await disconnect.click();
  const dialog = page.getByRole("dialog", { name: "断开 GitHub 账户授权？" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("可以前往 GitHub 设置撤销");
  await expect(dialog.getByRole("button", { name: "取消", exact: true })).toBeFocused();
  await expectDialogReady(dialog);
  await expectAccessible(page);
  await expectNoPageOverflow(page);
  await page.screenshot({ path: test.info().outputPath("github-zh-confirm-320.png"), fullPage: true });
});
