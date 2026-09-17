import type { GitHubConnectionStatus, GitHubIntegrationOverview } from "@opentag/shared/browser";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, browserApi } from "../../api.js";
import { GitHubIntegrationSettings } from "./github-integration-settings.js";

const APP_ID = "871235";
const CONNECTION_ID = "3c63a21e-f6c7-4474-91ea-4dabf0566a24";

function overview(connection: GitHubConnectionStatus | null): GitHubIntegrationOverview {
  return {
    availability: { available: true, githubHost: "github.com", appId: APP_ID },
    connection,
  };
}

function connection(overrides: Partial<GitHubConnectionStatus> = {}): GitHubConnectionStatus {
  return {
    id: CONNECTION_ID,
    accountId: "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e",
    githubHost: "github.com",
    appId: APP_ID,
    githubUserId: "42",
    githubLogin: "octocat",
    status: "active",
    bindingsSchemaVersion: 1,
    bindings: [],
    authorizationVersion: "2",
    credentialGeneration: "1",
    accessExpiresAt: "2026-09-16T08:00:00.000Z",
    refreshExpiresAt: "2027-03-16T00:00:00.000Z",
    recheckRequired: false,
    nextRecheckAt: null,
    lastVerifiedAt: "2026-09-16T00:00:00.000Z",
    lastErrorCode: null,
    createdAt: "2026-09-15T00:00:00.000Z",
    updatedAt: "2026-09-16T00:00:00.000Z",
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  window.history.replaceState({}, "", "/account");
});

describe("GitHubIntegrationSettings", () => {
  it("explains an unavailable deployment instead of showing demo integrations", async () => {
    vi.spyOn(browserApi, "githubIntegration").mockResolvedValue({
      availability: { available: false, githubHost: "github.com", appId: null },
      connection: null,
    });
    render(<GitHubIntegrationSettings />);

    expect(await screen.findByText("GitHub integration unavailable")).toBeTruthy();
    expect(screen.getByText("Not configured")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Connect GitHub" })).toBeNull();
    expect(screen.queryByText("Demo")).toBeNull();
  });

  it("starts a real authorization with the Server-owned surface contract", async () => {
    vi.spyOn(browserApi, "githubIntegration").mockResolvedValue(overview(null));
    const start = vi.spyOn(browserApi, "startGitHubAuthorization").mockResolvedValue({
      connectionId: CONNECTION_ID,
      authorizationUrl: "https://github.com/login/oauth/authorize?client_id=Iv1.client&state=opaque",
      expiresAt: "2026-09-16T00:10:00.000Z",
    });
    render(<GitHubIntegrationSettings />);

    fireEvent.click(await screen.findByRole("button", { name: "Connect GitHub" }));
    await waitFor(() =>
      expect(start).toHaveBeenCalledWith({
        intent: "create",
        returnSurface: "account-integrations",
        agentId: null,
      }),
    );
    // The browser only ever navigates to the URL the Server authored; it never composes one.
    expect(new URL("https://github.com/login/oauth/authorize?client_id=Iv1.client&state=opaque").hostname).toBe(
      "github.com",
    );
  });

  it("shows the connected identity, installations, and bound repositories", async () => {
    vi.spyOn(browserApi, "githubIntegration").mockResolvedValue(
      overview(
        connection({
          bindings: [
            {
              bindingId: "9f0f2f6c-2f5c-4d43-a9fb-9a1c9f000001",
              installationId: "55123456",
              repositoryId: "987654321",
              fullNameDisplay: "octocat/hello-world",
              agentScopes: [{ agentId: "1a63a21e-f6c7-4474-91ea-4dabf0566a24", role: "code", access: "read" }],
            },
          ],
        }),
      ),
    );
    vi.spyOn(browserApi, "githubRepositories").mockResolvedValue({
      installations: [
        {
          installationId: "55123456",
          accountLogin: "octocat",
          accountType: "Organization",
          repositorySelection: "selected",
          suspended: false,
        },
      ],
      repositories: [],
      nextCursor: null,
      truncatedInstallations: [],
    });
    render(<GitHubIntegrationSettings />);

    expect(await screen.findByText("Connected as @octocat.")).toBeTruthy();
    expect(screen.getByText("Connected")).toBeTruthy();
    expect(screen.getByText("octocat")).toBeTruthy();
    expect(screen.getByText("octocat/hello-world")).toBeTruthy();
    expect(screen.getByText("Repositories (1)")).toBeTruthy();
  });

  it("reports the bounded callback outcome and clears the query parameters", async () => {
    window.history.replaceState({}, "", "/account?github_oauth=error&github_oauth_error=GITHUB_OAUTH_DENIED&keep=1");
    vi.spyOn(browserApi, "githubIntegration").mockResolvedValue(overview(null));
    render(<GitHubIntegrationSettings />);

    expect(await screen.findByText("GitHub authorization was denied.")).toBeTruthy();
    expect(window.location.search).toBe("?keep=1");
  });

  it("routes a different-user reauthorization to the explicit replace action", async () => {
    window.history.replaceState({}, "", "/account?github_oauth=error&github_oauth_error=GITHUB_IDENTITY_MISMATCH");
    vi.spyOn(browserApi, "githubIntegration").mockResolvedValue(
      overview(connection({ status: "reauthorization_required" })),
    );
    render(<GitHubIntegrationSettings />);

    expect(
      await screen.findByText(
        "That authorization returned a different GitHub account. Use a different account to replace it.",
      ),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Use a different account" })).toBeTruthy();
  });

  it("disconnects through the API and reloads the resulting state", async () => {
    const summary = vi
      .spyOn(browserApi, "githubIntegration")
      .mockResolvedValueOnce(overview(connection()))
      .mockResolvedValueOnce(overview(null));
    vi.spyOn(browserApi, "githubRepositories").mockResolvedValue({
      installations: [],
      repositories: [],
      nextCursor: null,
      truncatedInstallations: [],
    });
    const disconnect = vi.spyOn(browserApi, "disconnectGitHub").mockResolvedValue(connection({ status: "revoked" }));
    render(<GitHubIntegrationSettings />);

    fireEvent.click(await screen.findByRole("button", { name: "Disconnect" }));
    await waitFor(() => expect(disconnect).toHaveBeenCalledTimes(1));
    expect(await screen.findByText("GitHub disconnected.")).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Connect GitHub" })).toBeTruthy();
    expect(summary).toHaveBeenCalledTimes(2);
  });

  it("surfaces a controlled conflict from the Server as product language", async () => {
    vi.spyOn(browserApi, "githubIntegration").mockResolvedValue(overview(connection()));
    vi.spyOn(browserApi, "githubRepositories").mockResolvedValue({
      installations: [],
      repositories: [],
      nextCursor: null,
      truncatedInstallations: [],
    });
    vi.spyOn(browserApi, "startGitHubAuthorization").mockRejectedValue(
      new ApiError(409, "The connection changed", "GITHUB_CONNECTION_CONFLICT"),
    );
    render(<GitHubIntegrationSettings />);

    fireEvent.click(await screen.findByRole("button", { name: "Reconnect" }));
    expect(await screen.findByText("The connection changed. Reload and try again.")).toBeTruthy();
  });

  it("explains a reauthorization requirement with the reconnect action", async () => {
    vi.spyOn(browserApi, "githubIntegration").mockResolvedValue(
      overview(
        connection({
          status: "reauthorization_required",
          githubLogin: "octocat",
          lastErrorCode: "GITHUB_CREDENTIAL_INVALID",
        }),
      ),
    );
    render(<GitHubIntegrationSettings />);

    expect(await screen.findByText("Reconnect needed")).toBeTruthy();
    expect(screen.getByText("Reconnect GitHub")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Reconnect" })).toHaveLength(2);
  });
});
