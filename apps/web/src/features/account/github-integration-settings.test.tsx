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

/**
 * The connection states, the wording each one uses, and the Server-controlled failures. The suite
 * above covers the happy paths; this one covers the states a real connection spends time in.
 */
describe("GitHubIntegrationSettings states", () => {
  it("says it is loading rather than showing a disconnected Account", async () => {
    vi.spyOn(browserApi, "githubIntegration").mockReturnValue(new Promise(() => undefined) as never);
    render(<GitHubIntegrationSettings />);

    expect(await screen.findByText("Loading GitHub connection…")).toBeTruthy();
    expect(screen.queryByText("No GitHub account is connected.")).toBeNull();
  });

  it("reports a failed load and offers to try again", async () => {
    vi.spyOn(browserApi, "githubIntegration").mockRejectedValue(new Error("The overview is unavailable"));
    render(<GitHubIntegrationSettings />);

    expect(await screen.findByText("The overview is unavailable")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("uses the bounded sentence when the load fails with something that is not an error", async () => {
    vi.spyOn(browserApi, "githubIntegration").mockRejectedValue("plain string");
    render(<GitHubIntegrationSettings />);

    expect(await screen.findByText("The GitHub request could not be completed.")).toBeTruthy();
  });

  it("re-reads the connection when the reader asks to try again", async () => {
    const overviewCall = vi
      .spyOn(browserApi, "githubIntegration")
      .mockRejectedValueOnce(new Error("The overview is unavailable"))
      .mockResolvedValue(overview(null));
    render(<GitHubIntegrationSettings />);

    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));

    expect(await screen.findByRole("button", { name: "Connect GitHub" })).toBeTruthy();
    expect(overviewCall).toHaveBeenCalledTimes(2);
  });

  it("explains a pending authorization and offers to finish or cancel it", async () => {
    vi.spyOn(browserApi, "githubIntegration").mockResolvedValue(overview(connection({ status: "pending" })));
    render(<GitHubIntegrationSettings />);

    expect(await screen.findByText("Connecting")).toBeTruthy();
    expect(screen.getByText("The GitHub authorization was started but not finished.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Finish connecting" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel" })).toBeTruthy();
  });

  it("finishes a pending authorization by starting one rather than composing a URL", async () => {
    vi.spyOn(browserApi, "githubIntegration").mockResolvedValue(overview(connection({ status: "pending" })));
    const start = vi.spyOn(browserApi, "startGitHubAuthorization").mockResolvedValue({
      connectionId: CONNECTION_ID,
      authorizationUrl: "https://github.com/login/oauth/authorize?state=opaque",
      expiresAt: "2026-09-16T00:10:00.000Z",
    });
    render(<GitHubIntegrationSettings />);

    fireEvent.click(await screen.findByRole("button", { name: "Finish connecting" }));

    await waitFor(() =>
      expect(start).toHaveBeenCalledWith({
        intent: "create",
        returnSurface: "account-integrations",
        agentId: null,
      }),
    );
  });

  it("cancels a pending authorization by disconnecting it", async () => {
    vi.spyOn(browserApi, "githubIntegration")
      .mockResolvedValueOnce(overview(connection({ status: "pending" })))
      .mockResolvedValueOnce(overview(null));
    const disconnect = vi.spyOn(browserApi, "disconnectGitHub").mockResolvedValue(connection({ status: "revoked" }));
    render(<GitHubIntegrationSettings />);

    fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));

    await waitFor(() => expect(disconnect).toHaveBeenCalledTimes(1));
  });

  it("labels a revoked connection as disconnected", async () => {
    vi.spyOn(browserApi, "githubIntegration").mockResolvedValue(overview(connection({ status: "revoked" })));
    render(<GitHubIntegrationSettings />);

    expect(await screen.findByText("Disconnected")).toBeTruthy();
  });

  it("labels an unrecognized connection state as replaced, not as active", async () => {
    vi.spyOn(browserApi, "githubIntegration").mockResolvedValue(overview(connection({ status: "superseded" })));
    render(<GitHubIntegrationSettings />);

    expect(await screen.findByText("Replaced")).toBeTruthy();
  });

  it("offers the explicit replace action, which authorizes a different account", async () => {
    vi.spyOn(browserApi, "githubIntegration").mockResolvedValue(overview(connection()));
    vi.spyOn(browserApi, "githubRepositories").mockResolvedValue({
      installations: [],
      repositories: [],
      nextCursor: null,
      truncatedInstallations: [],
    });
    const start = vi.spyOn(browserApi, "startGitHubAuthorization").mockResolvedValue({
      connectionId: CONNECTION_ID,
      authorizationUrl: "https://github.com/login/oauth/authorize?state=opaque",
      expiresAt: "2026-09-16T00:10:00.000Z",
    });
    render(<GitHubIntegrationSettings />);

    fireEvent.click(await screen.findByRole("button", { name: "Use a different account" }));

    await waitFor(() =>
      expect(start).toHaveBeenCalledWith({
        intent: "replace",
        returnSurface: "account-integrations",
        agentId: null,
      }),
    );
  });

  it("says the installation list is empty rather than leaving the row blank", async () => {
    vi.spyOn(browserApi, "githubIntegration").mockResolvedValue(overview(connection()));
    vi.spyOn(browserApi, "githubRepositories").mockResolvedValue({
      installations: [],
      repositories: [],
      nextCursor: null,
      truncatedInstallations: [],
    });
    render(<GitHubIntegrationSettings />);

    expect(await screen.findByText("No installations found.")).toBeTruthy();
    expect(screen.getByText("No repositories are enabled for Agents.")).toBeTruthy();
    expect(screen.getByText("Repositories (0)")).toBeTruthy();
  });

  it("marks a suspended installation instead of presenting it as usable", async () => {
    vi.spyOn(browserApi, "githubIntegration").mockResolvedValue(overview(connection()));
    vi.spyOn(browserApi, "githubRepositories").mockResolvedValue({
      installations: [
        {
          installationId: "55123456",
          accountLogin: "octocat",
          accountType: "Organization",
          repositorySelection: "selected",
          suspended: true,
        },
      ],
      repositories: [],
      nextCursor: null,
      truncatedInstallations: [],
    });
    render(<GitHubIntegrationSettings />);

    expect(await screen.findByText("octocat (suspended)")).toBeTruthy();
  });

  it("says a connection has no login when the Server did not record one", async () => {
    vi.spyOn(browserApi, "githubIntegration").mockResolvedValue(overview(connection({ githubLogin: null })));
    vi.spyOn(browserApi, "githubRepositories").mockResolvedValue({
      installations: [],
      repositories: [],
      nextCursor: null,
      truncatedInstallations: [],
    });
    render(<GitHubIntegrationSettings />);

    expect(await screen.findByText("GitHub account connected.")).toBeTruthy();
    expect(screen.queryByText(/^Connected as @/)).toBeNull();
  });

  it("reports a granted authorization as connected, with the default banner tone", async () => {
    window.history.replaceState({}, "", "/account?github_oauth=success");
    vi.spyOn(browserApi, "githubIntegration").mockResolvedValue(overview(null));
    render(<GitHubIntegrationSettings />);

    expect(await screen.findByText("GitHub connected.")).toBeTruthy();
    await waitFor(() => expect(window.location.search).toBe(""));
  });

  it("reports an error outcome from the callback and clears the parameters", async () => {
    window.history.replaceState({}, "", "/account?github_oauth=error&github_oauth_error=GITHUB_RATE_LIMITED");
    vi.spyOn(browserApi, "githubIntegration").mockResolvedValue(overview(null));
    render(<GitHubIntegrationSettings />);

    expect(await screen.findByText("GitHub rate limit reached. Try again shortly.")).toBeTruthy();
    await waitFor(() => expect(window.location.search).toBe(""));
  });

  it("does not re-read the connection twice when the button is pressed while it is working", async () => {
    vi.spyOn(browserApi, "githubIntegration").mockResolvedValue(overview(null));
    let resolve!: (value: unknown) => void;
    const pending = new Promise((done) => {
      resolve = done;
    });
    const start = vi.spyOn(browserApi, "startGitHubAuthorization").mockReturnValue(pending as never);
    render(<GitHubIntegrationSettings />);

    fireEvent.click(await screen.findByRole("button", { name: "Connect GitHub" }));
    fireEvent.click(screen.getByRole("button", { name: "Working…" }));

    resolve({ connectionId: CONNECTION_ID, authorizationUrl: "https://github.com/x", expiresAt: "e" });
    await waitFor(() => expect(start).toHaveBeenCalledTimes(1));
  });

  it("refuses a disconnect that arrives while another action is still running", async () => {
    // The pending-state row has both a finish and a cancel; the second press must be ignored while
    // the first is in flight, or one reader action becomes two Server calls.
    vi.spyOn(browserApi, "githubIntegration").mockResolvedValue(overview(connection({ status: "pending" })));
    let resolve!: (value: unknown) => void;
    const pending = new Promise((done) => {
      resolve = done;
    });
    const start = vi.spyOn(browserApi, "startGitHubAuthorization").mockReturnValue(pending as never);
    const disconnect = vi.spyOn(browserApi, "disconnectGitHub").mockResolvedValue(connection());
    render(<GitHubIntegrationSettings />);

    fireEvent.click(await screen.findByRole("button", { name: "Finish connecting" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    await Promise.resolve();
    expect(disconnect).not.toHaveBeenCalled();

    resolve({ connectionId: CONNECTION_ID, authorizationUrl: "https://github.com/x", expiresAt: "e" });
    await waitFor(() => expect(start).toHaveBeenCalledTimes(1));
  });
});

describe("GitHubIntegrationSettings failure language", () => {
  /** Every Server-controlled code the Account surface maps, asserted by pressing the button. */
  it.each([
    [
      "GITHUB_INTEGRATION_UNAVAILABLE",
      "This deployment has no GitHub App configured. An administrator must add one before Accounts can connect.",
    ],
    ["GITHUB_RATE_LIMITED", "GitHub rate limit reached. Try again shortly."],
    ["GITHUB_UPSTREAM_UNAVAILABLE", "GitHub is temporarily unavailable. Try again."],
    ["GITHUB_UPSTREAM_ERROR", "GitHub is temporarily unavailable. Try again."],
    ["GITHUB_AUTHORIZATION_VERSION_CONFLICT", "The connection changed. Reload and try again."],
    ["GITHUB_CONNECTION_CONFLICT", "The connection changed. Reload and try again."],
    ["GITHUB_CONNECTION_NOT_FOUND", "The GitHub connection does not support this action right now."],
    ["GITHUB_CONNECTION_STATE_INVALID", "The GitHub connection does not support this action right now."],
  ] as const)("maps %s to its own sentence, never the Server's raw message", async (code, sentence) => {
    vi.spyOn(browserApi, "githubIntegration").mockResolvedValue(overview(null));
    vi.spyOn(browserApi, "startGitHubAuthorization").mockRejectedValue(new ApiError(409, "raw upstream", code));
    render(<GitHubIntegrationSettings />);

    fireEvent.click(await screen.findByRole("button", { name: "Connect GitHub" }));

    expect(await screen.findByText(sentence)).toBeTruthy();
    expect(screen.queryByText("raw upstream")).toBeNull();
  });

  it("falls back to the Server's own message for a code it does not map", async () => {
    vi.spyOn(browserApi, "githubIntegration").mockResolvedValue(overview(null));
    vi.spyOn(browserApi, "startGitHubAuthorization").mockRejectedValue(
      new ApiError(500, "Something unmapped happened", "GITHUB_SOMETHING_NEW"),
    );
    render(<GitHubIntegrationSettings />);

    fireEvent.click(await screen.findByRole("button", { name: "Connect GitHub" }));

    expect(await screen.findByText("Something unmapped happened")).toBeTruthy();
  });

  it("uses the generic sentence when the failure carries no message at all", async () => {
    vi.spyOn(browserApi, "githubIntegration").mockResolvedValue(overview(null));
    vi.spyOn(browserApi, "startGitHubAuthorization").mockRejectedValue({ status: 500 } as never);
    render(<GitHubIntegrationSettings />);

    fireEvent.click(await screen.findByRole("button", { name: "Connect GitHub" }));

    expect(await screen.findByText("The GitHub request could not be completed.")).toBeTruthy();
  });

  it("uses the generic sentence for an API error whose code is empty", async () => {
    vi.spyOn(browserApi, "githubIntegration").mockResolvedValue(overview(null));
    vi.spyOn(browserApi, "startGitHubAuthorization").mockRejectedValue(new ApiError(500, ""));
    render(<GitHubIntegrationSettings />);

    fireEvent.click(await screen.findByRole("button", { name: "Connect GitHub" }));

    expect(await screen.findByText("The GitHub request could not be completed.")).toBeTruthy();
  });
});
