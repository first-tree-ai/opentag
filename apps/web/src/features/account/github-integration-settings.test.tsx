import type { GitHubConnectionStatus, GitHubIntegrationOverview } from "@opentag/shared/browser";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, browserApi } from "../../api.js";
import { GitHubIntegrationSettings } from "./github-integration-settings.js";

const APP_ID = "871235";
const CONNECTION_ID = "3c63a21e-f6c7-4474-91ea-4dabf0566a24";

function overview(connection: GitHubConnectionStatus | null): GitHubIntegrationOverview {
  return {
    availability: { available: true, githubHost: "github.com", oauthClientId: APP_ID },
    connection,
  };
}

function connection(overrides: Partial<GitHubConnectionStatus> = {}): GitHubConnectionStatus {
  return {
    id: CONNECTION_ID,
    accountId: "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e",
    githubHost: "github.com",
    oauthClientId: APP_ID,
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
  it("keeps repository configuration available independently of account authorization", async () => {
    vi.spyOn(browserApi, "githubIntegration").mockResolvedValue(overview(null));
    const discover = vi.spyOn(browserApi, "githubRepositories");
    render(<GitHubIntegrationSettings />);
    expect(await screen.findByRole("button", { name: "Authorize GitHub account" })).toBeTruthy();
    expect(screen.getByText("Account authorization", { exact: true })).toBeTruthy();
    expect(screen.getByText("Repository access", { exact: true })).toBeTruthy();
    const configure = screen.getByRole("link", { name: "Configure on GitHub" });
    expect(configure.getAttribute("href")).toBe("https://github.com/settings/applications");
    expect(configure.getAttribute("target")).toBe("_blank");
    expect(discover).not.toHaveBeenCalled();
  });

  it("does not infer repository authorization from returning to the settings page", async () => {
    vi.spyOn(browserApi, "githubIntegration").mockResolvedValue(overview(connection()));
    const discover = vi.spyOn(browserApi, "githubRepositories");
    render(<GitHubIntegrationSettings />);
    const configure = await screen.findByRole("link", { name: "Configure on GitHub" });
    configure.addEventListener("click", (event) => event.preventDefault());
    fireEvent.click(configure);
    fireEvent.focus(window);
    fireEvent(document, new Event("visibilitychange"));
    expect(discover).not.toHaveBeenCalled();
    expect(screen.queryByRole("button", { name: "Check again" })).toBeNull();
    expect(screen.getByText("@octocat")).toBeTruthy();
  });

  it.each([
    ["GITHUB_CONNECTION_STATE_INVALID", "reauthorization_required", "Reauthorize"],
    ["GITHUB_CONNECTION_NOT_FOUND", null, "Authorize GitHub account"],
  ] as const)("reconciles %s against the authoritative overview", async (code, status, action) => {
    const readOverview = vi
      .spyOn(browserApi, "githubIntegration")
      .mockResolvedValueOnce(overview(connection()))
      .mockResolvedValueOnce(overview(status ? connection({ status, authorizationVersion: "3" }) : null));
    const discover = vi
      .spyOn(browserApi, "githubRepositories")
      .mockRejectedValue(new ApiError(409, "Connection changed", code));
    render(<GitHubIntegrationSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "View repositories" }));
    const authorize = await screen.findByRole("button", { name: action });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(authorize));
    expect(readOverview).toHaveBeenCalledTimes(2);
    expect(discover).toHaveBeenCalledTimes(1);
  });

  it("keeps transient repository failures independent of the account overview", async () => {
    const readOverview = vi.spyOn(browserApi, "githubIntegration").mockResolvedValue(overview(connection()));
    const discover = vi
      .spyOn(browserApi, "githubRepositories")
      .mockRejectedValue(new ApiError(502, "Upstream outage", "GITHUB_UPSTREAM_UNAVAILABLE"));
    render(<GitHubIntegrationSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "View repositories" }));
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText("Couldn't load repositories. Try again.");
    fireEvent.click(within(dialog).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(discover).toHaveBeenCalledTimes(2));
    expect(readOverview).toHaveBeenCalledTimes(1);
    fireEvent.click(within(dialog).getByRole("button", { name: "Close repository list" }));
    expect(await screen.findByRole("button", { name: "Change account" })).toBeTruthy();
    expect(screen.getByText("@octocat")).toBeTruthy();
  });

  it("preserves identity when overview reconciliation fails and retries without reloading the page", async () => {
    const readOverview = vi
      .spyOn(browserApi, "githubIntegration")
      .mockResolvedValueOnce(overview(connection()))
      .mockRejectedValueOnce(new Error("Overview unavailable"))
      .mockResolvedValueOnce(overview(connection({ status: "reauthorization_required", authorizationVersion: "3" })));
    vi.spyOn(browserApi, "githubRepositories").mockRejectedValue(
      new ApiError(409, "Connection changed", "GITHUB_CONNECTION_STATE_INVALID"),
    );
    render(<GitHubIntegrationSettings />);
    fireEvent.click(await screen.findByRole("button", { name: "View repositories" }));
    const dialog = await screen.findByRole("dialog");
    await within(dialog).findByText("Couldn't load repositories. Try again.");
    expect(screen.getByText("@octocat")).toBeTruthy();
    expect(screen.getByText("Overview unavailable")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("button", { name: "Reauthorize" })).toBeTruthy();
    expect(readOverview).toHaveBeenCalledTimes(3);
    expect(screen.queryByText("Overview unavailable")).toBeNull();
  });

  it("explains deployment unavailability without unusable controls or health badges", async () => {
    vi.spyOn(browserApi, "githubIntegration").mockResolvedValue({
      availability: { available: false, githubHost: "github.com", oauthClientId: null },
      connection: null,
    });
    render(<GitHubIntegrationSettings />);
    expect(await screen.findByText("GitHub integration unavailable")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Authorize GitHub account" })).toBeNull();
    expect(screen.queryByText("Not configured")).toBeNull();
  });

  it("shows the saved identity and server-owned repository management without discovery", async () => {
    vi.spyOn(browserApi, "githubIntegration").mockResolvedValue(overview(connection()));
    const discover = vi.spyOn(browserApi, "githubRepositories").mockRejectedValue(new Error("GitHub outage"));
    render(<GitHubIntegrationSettings />);
    expect(await screen.findByText("@octocat")).toBeTruthy();
    expect(
      screen.getByText("Authorize your GitHub account and allow openTag to access the repositories you need."),
    ).toBeTruthy();
    const link = screen.getByRole("link", { name: "Configure on GitHub" });
    expect(link.getAttribute("href")).toBe("https://github.com/settings/applications");
    expect(link.getAttribute("target")).toBe("_blank");
    expect(link.getAttribute("rel")).toBe("noopener noreferrer");
    expect(discover).not.toHaveBeenCalled();
    expect(screen.queryByText("Connected")).toBeNull();
    expect(screen.queryByRole("button", { name: "Refresh installations" })).toBeNull();
    expect(screen.getByRole("button", { name: "Change account" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove account" })).toBeTruthy();
    expect(screen.queryByRole("menu")).toBeNull();
    expect(screen.queryByText("Account", { exact: true })).toBeNull();
    expect(screen.getByText("View the repositories your Agents can access.")).toBeTruthy();
  });

  it.each([null, "pending", "revoked", "superseded"] as const)(
    "offers authorization for %s without exposing internal lifecycle labels",
    async (status) => {
      vi.spyOn(browserApi, "githubIntegration").mockResolvedValue(overview(status ? connection({ status }) : null));
      const start = vi.spyOn(browserApi, "startGitHubAuthorization").mockRejectedValue(new Error("Controlled stop"));
      render(<GitHubIntegrationSettings />);
      const authorize = await screen.findByRole("button", { name: "Authorize GitHub account" });
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
      "Authorize this account again so your Agents can continue using GitHub.",
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
    expect(within(dialog).getByText(/You can revoke it in GitHub settings/)).toBeTruthy();
    expect(disconnect).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(disconnect).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByRole("button", { name: "Remove account" }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Remove account" }));
    expect(await screen.findByText("GitHub account removed.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Authorize GitHub account" })).toBeTruthy();
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
    expect(await screen.findByText("GitHub account authorization completed.")).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Change account" }));
    expect(await screen.findByRole("button", { name: "Redirecting to GitHub…" })).toHaveProperty("disabled", true);
    expect(screen.queryByText("GitHub account authorization completed.")).toBeNull();
    reject(new Error("Authorization could not start"));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Authorization could not start");
    expect(screen.getByRole("button", { name: "Change account" })).toBeTruthy();
    expect(screen.getByText("@octocat")).toBeTruthy();
  });

  it("opens repository access help in an accessible popover beside its trigger", async () => {
    vi.spyOn(browserApi, "githubIntegration").mockResolvedValue(overview(connection()));
    render(<GitHubIntegrationSettings />);
    const help = await screen.findByRole("button", { name: "About GitHub repository access" });
    expect(help.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(help);
    const popover = await screen.findByRole("dialog", { name: "About GitHub repository access" });
    expect(help.getAttribute("aria-expanded")).toBe("true");
    expect(within(popover).getByText(/OAuth repository access follows your GitHub account permissions/)).toBeTruthy();
    expect(within(popover).getByText(/All your Agents share this repository access/)).toBeTruthy();
    expect(
      within(popover).getByText(/Organization repositories may require organization approval or SSO authorization/),
    ).toBeTruthy();
    fireEvent.click(help);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "About GitHub repository access" })).toBeNull());
    expect(help.getAttribute("aria-expanded")).toBe("false");
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
    ["success", "GitHub account authorization completed."],
    [
      "error&github_oauth_error=GITHUB_IDENTITY_MISMATCH",
      "This authorization used a different GitHub account. Choose Change to use that account.",
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
    fireEvent.click(await screen.findByRole("button", { name: "Authorize GitHub account" }));
    expect(await screen.findByText("Save your edit first")).toBeTruthy();
    expect(start).not.toHaveBeenCalled();
  });
});

describe("GitHubIntegrationSettings failure language", () => {
  /** Every Server-controlled code the Account surface maps, asserted by pressing the button. */
  it.each([
    [
      "GITHUB_INTEGRATION_UNAVAILABLE",
      "The GitHub OAuth App hasn't been set up for openTag. Contact your openTag administrator.",
    ],
    ["GITHUB_RATE_LIMITED", "GitHub's request limit has been reached. Try again shortly."],
    ["GITHUB_UPSTREAM_UNAVAILABLE", "GitHub is temporarily unavailable. Try again shortly."],
    ["GITHUB_UPSTREAM_ERROR", "GitHub is temporarily unavailable. Try again shortly."],
    ["GITHUB_AUTHORIZATION_VERSION_CONFLICT", "Your GitHub authorization has changed. Refresh the page and try again."],
    ["GITHUB_CONNECTION_CONFLICT", "Your GitHub authorization has changed. Refresh the page and try again."],
    ["GITHUB_CONNECTION_NOT_FOUND", "This action isn't available right now. Refresh the page and try again."],
    ["GITHUB_CONNECTION_STATE_INVALID", "This action isn't available right now. Refresh the page and try again."],
  ] as const)("maps %s to its own sentence, never the Server's raw message", async (code, sentence) => {
    vi.spyOn(browserApi, "githubIntegration").mockResolvedValue(overview(null));
    vi.spyOn(browserApi, "startGitHubAuthorization").mockRejectedValue(new ApiError(409, "raw upstream", code));
    render(<GitHubIntegrationSettings />);

    fireEvent.click(await screen.findByRole("button", { name: "Authorize GitHub account" }));

    expect(await screen.findByText(sentence)).toBeTruthy();
    expect(screen.queryByText("raw upstream")).toBeNull();
  });

  it("falls back to the Server's own message for a code it does not map", async () => {
    vi.spyOn(browserApi, "githubIntegration").mockResolvedValue(overview(null));
    vi.spyOn(browserApi, "startGitHubAuthorization").mockRejectedValue(
      new ApiError(500, "Something unmapped happened", "GITHUB_SOMETHING_NEW"),
    );
    render(<GitHubIntegrationSettings />);

    fireEvent.click(await screen.findByRole("button", { name: "Authorize GitHub account" }));

    expect(await screen.findByText("Something unmapped happened")).toBeTruthy();
  });

  it("uses the generic sentence when the failure carries no message at all", async () => {
    vi.spyOn(browserApi, "githubIntegration").mockResolvedValue(overview(null));
    vi.spyOn(browserApi, "startGitHubAuthorization").mockRejectedValue({ status: 500 } as never);
    render(<GitHubIntegrationSettings />);

    fireEvent.click(await screen.findByRole("button", { name: "Authorize GitHub account" }));

    expect(await screen.findByText("The GitHub request could not be completed.")).toBeTruthy();
  });

  it("uses the generic sentence for an API error whose code is empty", async () => {
    vi.spyOn(browserApi, "githubIntegration").mockResolvedValue(overview(null));
    vi.spyOn(browserApi, "startGitHubAuthorization").mockRejectedValue(new ApiError(500, ""));
    render(<GitHubIntegrationSettings />);

    fireEvent.click(await screen.findByRole("button", { name: "Authorize GitHub account" }));

    expect(await screen.findByText("The GitHub request could not be completed.")).toBeTruthy();
  });
});
