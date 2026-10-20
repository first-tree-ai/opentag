import type { GitHubConnectionStatus, GitHubIntegrationOverview } from "@opentag/shared/browser";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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

describe("GitHub account settings", () => {
  it("explains deployment unavailability without unusable controls or health badges", async () => {
    vi.spyOn(browserApi, "githubIntegration").mockResolvedValue({
      availability: { available: false, githubHost: "github.com", appId: null },
      connection: null,
    });
    render(<GitHubIntegrationSettings />);
    expect(await screen.findByText("GitHub integration unavailable")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Add GitHub account" })).toBeNull();
    expect(screen.queryByText("Not configured")).toBeNull();
  });

  it("shows the saved identity and server-owned repository management without discovery", async () => {
    vi.spyOn(browserApi, "githubIntegration").mockResolvedValue(overview(connection()));
    const discover = vi.spyOn(browserApi, "githubRepositories").mockRejectedValue(new Error("GitHub outage"));
    render(<GitHubIntegrationSettings />);
    expect(await screen.findByText("@octocat")).toBeTruthy();
    expect(screen.getByText("Shared by all your Agents.")).toBeTruthy();
    const link = screen.getByRole("link", { name: "Configure on GitHub" });
    expect(link.getAttribute("href")).toBe("/api/v1/integrations/github/installation");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(discover).not.toHaveBeenCalled();
    expect(screen.queryByText("Connected")).toBeNull();
    expect(screen.queryByRole("button", { name: "Refresh installations" })).toBeNull();
    expect(screen.getByRole("button", { name: "Change account" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove account" })).toBeTruthy();
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.queryByText("Account", { exact: true })).toBeNull();
    expect(screen.getByText("Choose which repositories OpenTag can access.")).toBeTruthy();
  });

  it.each([null, "pending", "revoked", "superseded"] as const)(
    "offers authorization for %s without exposing internal lifecycle labels",
    async (status) => {
      vi.spyOn(browserApi, "githubIntegration").mockResolvedValue(overview(status ? connection({ status }) : null));
      const start = vi.spyOn(browserApi, "startGitHubAuthorization").mockRejectedValue(new Error("Controlled stop"));
      render(<GitHubIntegrationSettings />);
      const authorize = await screen.findByRole("button", { name: "Add GitHub account" });
      expect(screen.queryByText("Account", { exact: true })).toBeNull();
      fireEvent.click(authorize);
      await waitFor(() =>
        expect(start).toHaveBeenCalledWith({ intent: "create", returnSurface: "account-integrations", agentId: null }),
      );
      expect(screen.queryByText("Connecting")).toBeNull();
    },
  );

  it("changes identity directly with the explicit replace intent", async () => {
    vi.spyOn(browserApi, "githubIntegration").mockResolvedValue(overview(connection()));
    const start = vi.spyOn(browserApi, "startGitHubAuthorization").mockRejectedValue(new Error("Controlled stop"));
    render(<GitHubIntegrationSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "Change account" }));
    await waitFor(() =>
      expect(start).toHaveBeenCalledWith({ intent: "replace", returnSurface: "account-integrations", agentId: null }),
    );
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("@octocat")).toBeTruthy();
  });

  it("shows an intervention only when the server requires reauthorization", async () => {
    vi.spyOn(browserApi, "githubIntegration").mockResolvedValue(
      overview(connection({ status: "reauthorization_required" })),
    );
    const start = vi.spyOn(browserApi, "startGitHubAuthorization").mockRejectedValue(new Error("Controlled stop"));
    render(<GitHubIntegrationSettings />);
    const reauthorize = await screen.findByRole("button", { name: "Reauthorize" });
    const identity = screen.getByText("@octocat").closest('[data-ui="github-account-identity"]');
    expect(identity?.contains(reauthorize)).toBe(true);
    expect(within(identity as HTMLElement).getByRole("alert").textContent).toBe(
      "Authorize again so OpenTag can continue using this account.",
    );
    fireEvent.click(reauthorize);
    await waitFor(() =>
      expect(start).toHaveBeenCalledWith({
        intent: "reauthorize",
        returnSurface: "account-integrations",
        agentId: null,
      }),
    );
    expect(screen.getByText("@octocat")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Configure on GitHub" })).toBeTruthy();
  });

  it("confirms shared removal and lets cancellation leave the account untouched", async () => {
    vi.spyOn(browserApi, "githubIntegration").mockResolvedValue(overview(connection()));
    const disconnect = vi.spyOn(browserApi, "disconnectGitHub").mockResolvedValue(connection({ status: "revoked" }));
    render(<GitHubIntegrationSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "Remove account" }));
    const dialog = await screen.findByRole("dialog", { name: "Remove GitHub account?" });
    expect(within(dialog).getByText(/All your Agents will lose GitHub access through @octocat/)).toBeTruthy();
    expect(within(dialog).getByText(/App installation on GitHub will remain/)).toBeTruthy();
    expect(disconnect).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(disconnect).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole("button", { name: "Remove account" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Remove account" }));
    expect(await screen.findByText("GitHub account removed.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add GitHub account" })).toBeTruthy();
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it("keeps failed removal in its dialog and fences repeated confirmation", async () => {
    vi.spyOn(browserApi, "githubIntegration").mockResolvedValue(overview(connection()));
    let fail!: (error: Error) => void;
    const disconnect = vi
      .spyOn(browserApi, "disconnectGitHub")
      .mockReturnValueOnce(
        new Promise((_, reject) => {
          fail = reject;
        }),
      )
      .mockResolvedValue(connection({ status: "revoked" }));
    render(<GitHubIntegrationSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "Remove account" }));
    const dialog = await screen.findByRole("dialog");
    const confirm = within(dialog).getByRole("button", { name: "Remove account" });
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect((within(dialog).getByRole("button", { name: "Cancel" }) as HTMLButtonElement).disabled).toBe(true);
    fail(new Error("Controlled removal failure"));
    expect(await within(dialog).findByRole("alert")).toHaveProperty("textContent", "Controlled removal failure");
    expect(screen.getByText("@octocat")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove account" }));
    expect(await screen.findByText("GitHub account removed.")).toBeTruthy();
    expect(disconnect).toHaveBeenCalledTimes(2);
  });

  it("clears a failed removal when its confirmation is dismissed", async () => {
    vi.spyOn(browserApi, "githubIntegration").mockResolvedValue(overview(connection()));
    const disconnect = vi.spyOn(browserApi, "disconnectGitHub").mockRejectedValue(new Error("Removal failed"));
    render(<GitHubIntegrationSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "Remove account" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove account" }));
    expect(await within(dialog).findByText("Removal failed")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.queryByText("Removal failed")).toBeNull();
    expect(screen.getByText("@octocat")).toBeTruthy();
    expect(disconnect).toHaveBeenCalledTimes(1);
  });

  it("replaces a previous callback outcome with the current authorization action and result", async () => {
    window.history.replaceState({}, "", "/account?github_oauth=success");
    vi.spyOn(browserApi, "githubIntegration").mockResolvedValue(overview(connection()));
    let reject!: (error: Error) => void;
    vi.spyOn(browserApi, "startGitHubAuthorization").mockReturnValue(
      new Promise((_, fail) => {
        reject = fail;
      }),
    );
    render(<GitHubIntegrationSettings />);
    expect(await screen.findByText("GitHub authorization completed.")).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Change account" }));
    expect(await screen.findByRole("button", { name: "Redirecting to GitHub…" })).toHaveProperty("disabled", true);
    expect(screen.queryByText("GitHub authorization completed.")).toBeNull();
    reject(new Error("Authorization could not start"));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Authorization could not start");
    expect(screen.getByRole("button", { name: "Change account" })).toBeTruthy();
    expect(screen.getByText("@octocat")).toBeTruthy();
  });

  it("makes repository access help available by an explicit accessible toggle", async () => {
    vi.spyOn(browserApi, "githubIntegration").mockResolvedValue(overview(connection()));
    render(<GitHubIntegrationSettings />);
    const help = await screen.findByRole("button", { name: "About GitHub repository access" });
    expect(help.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(help);
    expect(help.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText(/Install or configure the OpenTag App on GitHub/)).toBeTruthy();
    expect(screen.getByText(/contact an organization administrator if you don't have permission/)).toBeTruthy();
    fireEvent.click(help);
    expect(screen.queryByText(/Install or configure the OpenTag App on GitHub/)).toBeNull();
  });

  it("uses a neutral fallback when the recorded login is unavailable", async () => {
    vi.spyOn(browserApi, "githubIntegration").mockResolvedValue(overview(connection({ githubLogin: null })));
    render(<GitHubIntegrationSettings />);
    expect(await screen.findByText("GitHub account")).toBeTruthy();
    expect(await screen.findByRole("button", { name: "Change account" })).toBeTruthy();
    expect(screen.queryByText("GitHub account connected.")).toBeNull();
  });

  it.each([
    ["error&github_oauth_error=GITHUB_OAUTH_DENIED", "GitHub authorization was denied."],
    ["success", "GitHub authorization completed."],
    [
      "error&github_oauth_error=GITHUB_IDENTITY_MISMATCH",
      "That authorization returned a different GitHub account. Choose Change account to replace it.",
    ],
  ])("reports the bounded callback outcome %s once", async (query, text) => {
    window.history.replaceState({}, "", `/account?github_oauth=${query}&keep=1`);
    vi.spyOn(browserApi, "githubIntegration").mockResolvedValue(overview(connection()));
    render(<GitHubIntegrationSettings />);
    expect(await screen.findByText(text)).toBeTruthy();
    expect(window.location.search).toBe("?keep=1");
  });

  it("retains edits when the navigation guard cannot preserve them", async () => {
    vi.spyOn(browserApi, "githubIntegration").mockResolvedValue(overview(null));
    const start = vi.spyOn(browserApi, "startGitHubAuthorization");
    render(
      <GitHubIntegrationSettings
        beforeAuthorize={() => {
          throw new Error("Save your edit first");
        }}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: "Add GitHub account" }));
    expect(await screen.findByText("Save your edit first")).toBeTruthy();
    expect(start).not.toHaveBeenCalled();
  });
});

describe("GitHubIntegrationSettings failure language", () => {
  /** Every Server-controlled code the Account surface maps, asserted by pressing the button. */
  it.each([
    [
      "GITHUB_INTEGRATION_UNAVAILABLE",
      "This deployment has no GitHub App configured. Ask an administrator to configure it before adding an account.",
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

    fireEvent.click(await screen.findByRole("button", { name: "Add GitHub account" }));

    expect(await screen.findByText(sentence)).toBeTruthy();
    expect(screen.queryByText("raw upstream")).toBeNull();
  });

  it("falls back to the Server's own message for a code it does not map", async () => {
    vi.spyOn(browserApi, "githubIntegration").mockResolvedValue(overview(null));
    vi.spyOn(browserApi, "startGitHubAuthorization").mockRejectedValue(
      new ApiError(500, "Something unmapped happened", "GITHUB_SOMETHING_NEW"),
    );
    render(<GitHubIntegrationSettings />);

    fireEvent.click(await screen.findByRole("button", { name: "Add GitHub account" }));

    expect(await screen.findByText("Something unmapped happened")).toBeTruthy();
  });

  it("uses the generic sentence when the failure carries no message at all", async () => {
    vi.spyOn(browserApi, "githubIntegration").mockResolvedValue(overview(null));
    vi.spyOn(browserApi, "startGitHubAuthorization").mockRejectedValue({ status: 500 } as never);
    render(<GitHubIntegrationSettings />);

    fireEvent.click(await screen.findByRole("button", { name: "Add GitHub account" }));

    expect(await screen.findByText("The GitHub request could not be completed.")).toBeTruthy();
  });

  it("uses the generic sentence for an API error whose code is empty", async () => {
    vi.spyOn(browserApi, "githubIntegration").mockResolvedValue(overview(null));
    vi.spyOn(browserApi, "startGitHubAuthorization").mockRejectedValue(new ApiError(500, ""));
    render(<GitHubIntegrationSettings />);

    fireEvent.click(await screen.findByRole("button", { name: "Add GitHub account" }));

    expect(await screen.findByText("The GitHub request could not be completed.")).toBeTruthy();
  });
});
