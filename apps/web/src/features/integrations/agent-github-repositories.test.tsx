import type { GitHubIntegrationOverview, GitHubRepositoryBinding } from "@opentag/shared/browser";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiError, browserApi } from "../../api.js";
import { AgentGitHubRepositories } from "./agent-github-repositories.js";

const AGENT_ID = "1a63a21e-f6c7-4474-91ea-4dabf0566a24";
const COLLABORATOR_ID = "2b74b32f-a7d8-4585-92fb-5ecbf1677b35";
const BINDING_ID = "9d4e1378-8ff2-4e41-a6dd-e8bf59ed775b";
const CONNECTION_ID = "3c63a21e-f6c7-4474-91ea-4dabf0566a24";

const repository = {
  installationId: "55123456",
  repositoryId: "987654321",
  fullName: "octocat/hello-world",
  private: true,
  defaultBranch: "main",
  permissions: { pull: true, push: true },
} as const;

const installation = {
  installationId: "55123456",
  accountLogin: "octocat",
  accountType: "Organization",
  repositorySelection: "selected",
  suspended: false,
} as const;

function activeConnection(bindings: GitHubRepositoryBinding[] = []) {
  return {
    id: CONNECTION_ID,
    accountId: "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e",
    githubHost: "github.com",
    appId: "871235",
    githubUserId: "42",
    githubLogin: "octocat",
    status: "active",
    bindingsSchemaVersion: 1,
    bindings,
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
  } as const;
}

function overview(connection: ReturnType<typeof activeConnection> | null): GitHubIntegrationOverview {
  return {
    availability: { available: true, githubHost: "github.com", appId: "871235" },
    connection,
  };
}

function stubCommon(connection: ReturnType<typeof activeConnection> | null) {
  vi.spyOn(browserApi, "agent").mockResolvedValue({
    id: AGENT_ID,
    name: "reviewer",
    displayName: "Reviewer",
  } as never);
  vi.spyOn(browserApi, "githubIntegration").mockResolvedValue(overview(connection));
}

function stubDiscovery() {
  vi.spyOn(browserApi, "githubRepositories").mockResolvedValue({
    installations: [installation],
    repositories: [repository],
    nextCursor: null,
    truncatedInstallations: [],
  });
  vi.spyOn(browserApi, "agents").mockResolvedValue({
    agents: [
      { id: AGENT_ID, displayName: "Reviewer" },
      { id: COLLABORATOR_ID, displayName: "Helper" },
    ],
  } as never);
  vi.spyOn(browserApi, "imBinding").mockResolvedValue({
    id: BINDING_ID,
    agentId: AGENT_ID,
    provider: "feishu",
    bindingState: "active",
    bot: { displayName: "Reviewer", avatarUrl: null },
    receiveMode: "mention_only",
    lastInboundAt: null,
    lastValidatedAt: null,
    lastRuntimeObservationAt: null,
  } as never);
}

/** Base UI selects open on a pointer sequence and accept a plain click on an owned option. */
async function chooseOption(comboboxName: string, optionName: string): Promise<void> {
  fireEvent.click(screen.getByRole("combobox", { name: comboboxName }));
  const option = await screen.findByRole("option", { name: optionName });
  fireEvent.pointerMove(option, { pointerType: "mouse" });
  fireEvent.pointerDown(option, { pointerType: "mouse" });
  fireEvent.pointerUp(option, { pointerType: "mouse" });
  fireEvent.click(option);
}

afterEach(() => {
  vi.restoreAllMocks();
  window.history.replaceState({}, "", "/agents");
});

describe("AgentGitHubRepositories", () => {
  it("explains a bounded repository discovery page instead of claiming an exhaustive list", async () => {
    stubCommon(activeConnection());
    stubDiscovery();
    vi.mocked(browserApi.githubRepositories).mockResolvedValue({
      installations: [installation],
      repositories: [repository],
      nextCursor: null,
      truncatedInstallations: [installation.installationId],
    });
    render(<AgentGitHubRepositories agentId={AGENT_ID} />);
    expect(
      await screen.findByText(
        "Only the first 1,000 repositories per installation can be listed. Some repositories are omitted; existing access is preserved.",
      ),
    ).toBeTruthy();
    expect(screen.getByText(repository.fullName)).toBeTruthy();
  });

  it("explains an unavailable deployment", async () => {
    vi.spyOn(browserApi, "agent").mockResolvedValue({ id: AGENT_ID, displayName: "Reviewer" } as never);
    vi.spyOn(browserApi, "githubIntegration").mockResolvedValue({
      availability: { available: false, githubHost: "github.com", appId: null },
      connection: null,
    });
    render(<AgentGitHubRepositories agentId={AGENT_ID} />);

    expect(
      await screen.findByText(
        "This deployment has no GitHub App configured. An administrator must add one before Accounts can connect.",
      ),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Connect GitHub" })).toBeNull();
  });

  it("reports the bounded callback outcome on the Agent return surface", async () => {
    window.history.replaceState({}, "", `/agents/${AGENT_ID}/integrations?github_oauth=success&github_oauth_error=`);
    stubCommon(null);
    render(<AgentGitHubRepositories agentId={AGENT_ID} />);

    expect(await screen.findByText("GitHub connected.")).toBeTruthy();
    expect(window.location.search).toBe("");
  });

  it("connects back to this exact Agent through the Agent return surface", async () => {
    stubCommon(null);
    const start = vi.spyOn(browserApi, "startGitHubAuthorization").mockResolvedValue({
      connectionId: CONNECTION_ID,
      authorizationUrl: "https://github.com/login/oauth/authorize?state=opaque",
      expiresAt: "2026-09-16T00:10:00.000Z",
    });
    render(<AgentGitHubRepositories agentId={AGENT_ID} />);

    fireEvent.click(await screen.findByRole("button", { name: "Connect GitHub" }));
    await waitFor(() =>
      expect(start).toHaveBeenCalledWith({
        intent: "create",
        returnSurface: "agent-integrations",
        agentId: AGENT_ID,
      }),
    );
  });

  it("writes one Agent scope with its delegation through the version-fenced update", async () => {
    const connection = activeConnection();
    stubCommon(connection);
    stubDiscovery();
    const update = vi
      .spyOn(browserApi, "updateGitHubBindings")
      .mockResolvedValue({ ...connection, authorizationVersion: "3" } as never);
    render(<AgentGitHubRepositories agentId={AGENT_ID} />);

    expect(await screen.findByText("octocat/hello-world")).toBeTruthy();
    fireEvent.click(screen.getByRole("checkbox", { name: /Use with this Agent/ }));
    await chooseOption("Role", "Context Tree");
    await chooseOption("Access", "Read only");
    fireEvent.change(screen.getByPlaceholderText("Sender ID"), { target: { value: "ou_teammate" } });
    fireEvent.click(screen.getByRole("button", { name: "Add" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Helper" }));
    fireEvent.click(screen.getByRole("button", { name: "Save repository access" }));

    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    const payload = update.mock.calls[0]?.[0];
    expect(payload?.expectedAuthorizationVersion).toBe("2");
    expect(payload?.bindings).toHaveLength(1);
    const binding = payload?.bindings[0];
    expect(binding?.installationId).toBe("55123456");
    expect(binding?.repositoryId).toBe("987654321");
    expect(binding?.fullNameDisplay).toBe("octocat/hello-world");
    expect(binding?.agentScopes[0]).toEqual({
      agentId: AGENT_ID,
      role: "context_tree",
      access: "read",
      branch: "refs/heads/master",
      taskDelegation: {
        imSenders: [{ bindingId: BINDING_ID, senderId: "ou_teammate" }],
        sessionAgents: [COLLABORATOR_ID],
      },
    });
    expect(await screen.findByText("Repository access saved.")).toBeTruthy();
  });

  it("preserves other Agents' scopes and unloaded repositories when this Agent's access changes", async () => {
    const otherBinding: GitHubRepositoryBinding = {
      bindingId: "9f0f2f6c-2f5c-4d43-a9fb-9a1c9f000002",
      installationId: "55123456",
      repositoryId: "987654321",
      fullNameDisplay: "octocat/hello-world",
      agentScopes: [{ agentId: COLLABORATOR_ID, role: "code", access: "read" }],
    };
    const heldBinding: GitHubRepositoryBinding = {
      bindingId: "9f0f2f6c-2f5c-4d43-a9fb-9a1c9f000003",
      installationId: "55123456",
      repositoryId: "111111111",
      fullNameDisplay: "octocat/other",
      agentScopes: [{ agentId: AGENT_ID, role: "code", access: "write", publish: "direct" }],
    };
    const connection = activeConnection([otherBinding, heldBinding]);
    stubCommon(connection);
    stubDiscovery();
    const update = vi.spyOn(browserApi, "updateGitHubBindings").mockResolvedValue(connection as never);
    render(<AgentGitHubRepositories agentId={AGENT_ID} />);

    expect(await screen.findByText("octocat/hello-world")).toBeTruthy();
    // The other Agent's scope survives, and this Agent's scope on a repository outside the loaded
    // discovery pages is kept: the editor cannot show it, so a save must not silently drop it.
    fireEvent.click(screen.getByRole("checkbox", { name: /Use with this Agent/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save repository access" }));

    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    const bindings = update.mock.calls[0]?.[0]?.bindings ?? [];
    const preserved = bindings.find((binding) => binding.bindingId === otherBinding.bindingId);
    expect(preserved?.agentScopes).toContainEqual({ agentId: COLLABORATOR_ID, role: "code", access: "read" });
    // An empty delegation is omitted, not stored as an explicit empty object.
    expect(preserved?.agentScopes).toContainEqual({ agentId: AGENT_ID, role: "code", access: "read" });
    const untouched = bindings.find((binding) => binding.bindingId === heldBinding.bindingId);
    expect(untouched?.agentScopes).toEqual([{ agentId: AGENT_ID, role: "code", access: "write", publish: "direct" }]);
    expect(bindings).toHaveLength(2);
  });

  it("removes this Agent's scope when the owner turns the loaded repository off", async () => {
    const heldBinding: GitHubRepositoryBinding = {
      bindingId: "9f0f2f6c-2f5c-4d43-a9fb-9a1c9f000004",
      installationId: "55123456",
      repositoryId: "987654321",
      fullNameDisplay: "octocat/hello-world",
      agentScopes: [{ agentId: AGENT_ID, role: "code", access: "read" }],
    };
    const connection = activeConnection([heldBinding]);
    stubCommon(connection);
    stubDiscovery();
    const update = vi.spyOn(browserApi, "updateGitHubBindings").mockResolvedValue(connection as never);
    render(<AgentGitHubRepositories agentId={AGENT_ID} />);

    const toggle = await screen.findByRole("checkbox", { name: /Use with this Agent/ });
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole("button", { name: "Save repository access" }));

    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update.mock.calls[0]?.[0]?.bindings).toEqual([]);
  });

  it("keeps the binding identity when the owner edits an existing scope", async () => {
    const heldBinding: GitHubRepositoryBinding = {
      bindingId: "9f0f2f6c-2f5c-4d43-a9fb-9a1c9f000006",
      installationId: "55123456",
      repositoryId: "987654321",
      fullNameDisplay: "octocat/hello-world",
      agentScopes: [{ agentId: AGENT_ID, role: "code", access: "read" }],
    };
    const connection = activeConnection([heldBinding]);
    stubCommon(connection);
    stubDiscovery();
    const update = vi.spyOn(browserApi, "updateGitHubBindings").mockResolvedValue(connection as never);
    render(<AgentGitHubRepositories agentId={AGENT_ID} />);

    await screen.findByText("octocat/hello-world");
    await chooseOption("Access", "Read and write");
    fireEvent.click(screen.getByRole("button", { name: "Save repository access" }));

    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    const bindings = update.mock.calls[0]?.[0]?.bindings ?? [];
    expect(bindings).toHaveLength(1);
    expect(bindings[0]?.bindingId).toBe(heldBinding.bindingId);
    expect(bindings[0]?.agentScopes[0]).toEqual({
      agentId: AGENT_ID,
      role: "code",
      access: "write",
      publish: "pull_request",
    });
  });

  it("keeps each repository's sender draft separate and refuses a duplicate delegation", async () => {
    stubCommon(activeConnection());
    vi.spyOn(browserApi, "githubRepositories").mockResolvedValue({
      installations: [installation],
      repositories: [repository, { ...repository, repositoryId: "987654322", fullName: "octocat/second" }],
      nextCursor: null,
      truncatedInstallations: [],
    });
    vi.spyOn(browserApi, "agents").mockResolvedValue({ agents: [] } as never);
    vi.spyOn(browserApi, "imBinding").mockResolvedValue({
      id: BINDING_ID,
      agentId: AGENT_ID,
      provider: "feishu",
      bindingState: "active",
      bot: { displayName: "Reviewer", avatarUrl: null },
      receiveMode: "mention_only",
      lastInboundAt: null,
      lastValidatedAt: null,
      lastRuntimeObservationAt: null,
    } as never);
    render(<AgentGitHubRepositories agentId={AGENT_ID} />);

    const toggles = await screen.findAllByRole("checkbox", { name: /Use with this Agent/ });
    for (const toggle of toggles) fireEvent.click(toggle);
    const inputs = screen.getAllByPlaceholderText("Sender ID") as HTMLInputElement[];
    expect(inputs).toHaveLength(2);
    fireEvent.change(inputs[0] as HTMLInputElement, { target: { value: "ou_first" } });
    expect(inputs[1]?.value).toBe("");

    const addButtons = screen.getAllByRole("button", { name: "Add" });
    fireEvent.click(addButtons[0] as HTMLButtonElement);
    expect((screen.getAllByPlaceholderText("Sender ID")[0] as HTMLInputElement).value).toBe("");
    // The same sender cannot be delegated twice to the same scope.
    fireEvent.change(screen.getAllByPlaceholderText("Sender ID")[0] as HTMLInputElement, {
      target: { value: "ou_first" },
    });
    expect((screen.getAllByRole("button", { name: "Add" })[0] as HTMLButtonElement).disabled).toBe(true);
  });

  it("keeps save unavailable until the owner actually changes something", async () => {
    const heldBinding: GitHubRepositoryBinding = {
      bindingId: "9f0f2f6c-2f5c-4d43-a9fb-9a1c9f000005",
      installationId: "55123456",
      repositoryId: "987654321",
      fullNameDisplay: "octocat/hello-world",
      agentScopes: [{ agentId: AGENT_ID, role: "code", access: "read" }],
    };
    stubCommon(activeConnection([heldBinding]));
    stubDiscovery();
    render(<AgentGitHubRepositories agentId={AGENT_ID} />);

    const save = await screen.findByRole("button", { name: "Save repository access" });
    expect(save.hasAttribute("disabled")).toBe(true);
    // Removing the Agent's loaded scope is a real change, so the same button becomes available.
    fireEvent.click(screen.getByRole("checkbox", { name: /Use with this Agent/ }));
    await waitFor(() => expect(save.hasAttribute("disabled")).toBe(false));
  });

  it("reports a version conflict as product language", async () => {
    stubCommon(activeConnection());
    stubDiscovery();
    vi.spyOn(browserApi, "updateGitHubBindings").mockRejectedValue(
      new ApiError(409, "stale", "GITHUB_AUTHORIZATION_VERSION_CONFLICT"),
    );
    render(<AgentGitHubRepositories agentId={AGENT_ID} />);

    fireEvent.click(await screen.findByRole("checkbox", { name: /Use with this Agent/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save repository access" }));
    expect(await screen.findByText("Someone else changed this connection. Reload and try again.")).toBeTruthy();
  });

  it("loads the next page of repositories with the opaque cursor", async () => {
    stubCommon(activeConnection());
    const repositories = vi
      .spyOn(browserApi, "githubRepositories")
      .mockResolvedValueOnce({
        installations: [installation],
        repositories: [repository],
        nextCursor: "cursor-1",
        truncatedInstallations: [],
      })
      .mockResolvedValueOnce({
        installations: [installation],
        repositories: [{ ...repository, repositoryId: "987654322", fullName: "octocat/second" }],
        nextCursor: null,
        truncatedInstallations: [],
      });
    vi.spyOn(browserApi, "agents").mockResolvedValue({ agents: [] } as never);
    vi.spyOn(browserApi, "imBinding").mockResolvedValue(undefined);
    render(<AgentGitHubRepositories agentId={AGENT_ID} />);

    fireEvent.click(await screen.findByRole("button", { name: "Load more repositories" }));
    expect(await screen.findByText("octocat/second")).toBeTruthy();
    expect(repositories).toHaveBeenLastCalledWith("cursor-1");
    expect(screen.queryByRole("button", { name: "Load more repositories" })).toBeNull();
  });

  it("does not offer write access on a read-only repository", async () => {
    stubCommon(activeConnection());
    vi.spyOn(browserApi, "githubRepositories").mockResolvedValue({
      installations: [installation],
      repositories: [{ ...repository, permissions: { pull: true, push: false } }],
      nextCursor: null,
      truncatedInstallations: [],
    });
    vi.spyOn(browserApi, "agents").mockResolvedValue({ agents: [] } as never);
    vi.spyOn(browserApi, "imBinding").mockResolvedValue(undefined);
    render(<AgentGitHubRepositories agentId={AGENT_ID} />);

    fireEvent.click(await screen.findByRole("checkbox", { name: /Use with this Agent/ }));
    fireEvent.click(screen.getByRole("combobox", { name: "Access" }));
    const writeOption = await screen.findByRole("option", { name: "Read and write" });
    expect(writeOption.getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByText("This account has read-only access to this repository.")).toBeTruthy();
  });
});

/**
 * The states before a ready list, the pagination, and the delegation editor's own branches.
 */
describe("AgentGitHubRepositories states", () => {
  it("says it is loading the repositories rather than showing an empty list", async () => {
    vi.spyOn(browserApi, "agent").mockReturnValue(new Promise(() => undefined) as never);
    vi.spyOn(browserApi, "githubIntegration").mockResolvedValue(overview(activeConnection()));
    render(<AgentGitHubRepositories agentId={AGENT_ID} />);

    expect(await screen.findByText("Loading repositories…")).toBeTruthy();
  });

  it("reports a failed load and offers to try again", async () => {
    vi.spyOn(browserApi, "agent").mockRejectedValue(new ApiError(500, "The Agent could not be read"));
    vi.spyOn(browserApi, "githubIntegration").mockResolvedValue(overview(activeConnection()));
    render(<AgentGitHubRepositories agentId={AGENT_ID} />);

    expect(await screen.findByText("The Agent could not be read")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("re-reads the whole page when the reader asks to try again", async () => {
    const agent = vi
      .spyOn(browserApi, "agent")
      .mockRejectedValueOnce(new ApiError(500, "The Agent could not be read"))
      .mockResolvedValue({ id: AGENT_ID, displayName: "Reviewer" } as never);
    vi.spyOn(browserApi, "githubIntegration").mockResolvedValue(overview(activeConnection()));
    stubDiscovery();
    render(<AgentGitHubRepositories agentId={AGENT_ID} />);

    fireEvent.click(await screen.findByRole("button", { name: "Try again" }));

    expect(await screen.findByRole("checkbox", { name: /Use with this Agent/ })).toBeTruthy();
    expect(agent).toHaveBeenCalledTimes(2);
  });

  it("uses the bounded sentence when the load fails with something that is not an API error", async () => {
    vi.spyOn(browserApi, "agent").mockRejectedValue("not an error");
    vi.spyOn(browserApi, "githubIntegration").mockResolvedValue(overview(activeConnection()));
    render(<AgentGitHubRepositories agentId={AGENT_ID} />);

    expect(await screen.findByText("The GitHub request could not be completed.")).toBeTruthy();
  });

  it("prompts to connect when the Account has no connection at all", async () => {
    stubCommon(null);
    render(<AgentGitHubRepositories agentId={AGENT_ID} />);

    expect(await screen.findByText("Connect a GitHub account to choose repositories for this Agent.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Connect GitHub" })).toBeTruthy();
  });

  it("prompts to finish a connection that is still pending", async () => {
    stubCommon({ ...activeConnection(), status: "pending" } as never);
    render(<AgentGitHubRepositories agentId={AGENT_ID} />);

    expect(await screen.findByText("Finish connecting GitHub to choose repositories for this Agent.")).toBeTruthy();
  });

  it("prompts to reconnect a connection that needs reauthorization", async () => {
    stubCommon({ ...activeConnection(), status: "reauthorization_required" } as never);
    render(<AgentGitHubRepositories agentId={AGENT_ID} />);

    expect(await screen.findByText("Reconnect GitHub to keep using these repositories.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reconnect" })).toBeTruthy();
  });

  it("starts a reauthorization rather than a fresh connect for a connection that already exists", async () => {
    stubCommon({ ...activeConnection(), status: "reauthorization_required" } as never);
    const start = vi.spyOn(browserApi, "startGitHubAuthorization").mockResolvedValue({
      connectionId: CONNECTION_ID,
      authorizationUrl: "https://github.com/login/oauth/authorize?state=opaque",
      expiresAt: "2026-09-16T00:10:00.000Z",
    });
    render(<AgentGitHubRepositories agentId={AGENT_ID} />);

    fireEvent.click(await screen.findByRole("button", { name: "Reconnect" }));

    await waitFor(() =>
      expect(start).toHaveBeenCalledWith({
        intent: "reauthorize",
        returnSurface: "agent-integrations",
        agentId: AGENT_ID,
      }),
    );
  });

  it("reports a failed authorization start instead of leaving the button stuck", async () => {
    stubCommon(null);
    // A code this surface does not map falls through to the message the Server sent.
    vi.spyOn(browserApi, "startGitHubAuthorization").mockRejectedValue(
      new ApiError(503, "GitHub is down", "GITHUB_UPSTREAM_UNAVAILABLE"),
    );
    render(<AgentGitHubRepositories agentId={AGENT_ID} />);

    fireEvent.click(await screen.findByRole("button", { name: "Connect GitHub" }));

    expect(await screen.findByText("GitHub is down")).toBeTruthy();
    // The button is usable again, so a transient failure does not strand the reader.
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Connect GitHub" }).hasAttribute("disabled")).toBe(false),
    );
  });

  it("uses the bounded sentence when the authorization start fails without an API error", async () => {
    stubCommon(null);
    vi.spyOn(browserApi, "startGitHubAuthorization").mockRejectedValue(new Error("offline"));
    render(<AgentGitHubRepositories agentId={AGENT_ID} />);

    fireEvent.click(await screen.findByRole("button", { name: "Connect GitHub" }));

    expect(await screen.findByText("offline")).toBeTruthy();
  });

  it("says there are no installations, so an empty summary is not read as a failure", async () => {
    stubCommon(activeConnection());
    vi.spyOn(browserApi, "githubRepositories").mockResolvedValue({
      installations: [],
      repositories: [],
      nextCursor: null,
      truncatedInstallations: [],
    });
    vi.spyOn(browserApi, "agents").mockResolvedValue({ agents: [] } as never);
    vi.spyOn(browserApi, "imBinding").mockResolvedValue(undefined);
    render(<AgentGitHubRepositories agentId={AGENT_ID} />);

    expect(await screen.findByText("No installations found.")).toBeTruthy();
    expect(screen.getByText("No repositories are available through the connected account.")).toBeTruthy();
  });

  it("marks a suspended installation instead of presenting it as usable", async () => {
    stubCommon(activeConnection());
    vi.spyOn(browserApi, "githubRepositories").mockResolvedValue({
      installations: [{ ...installation, suspended: true }],
      repositories: [repository],
      nextCursor: null,
      truncatedInstallations: [],
    });
    vi.spyOn(browserApi, "agents").mockResolvedValue({ agents: [] } as never);
    vi.spyOn(browserApi, "imBinding").mockResolvedValue(undefined);
    render(<AgentGitHubRepositories agentId={AGENT_ID} />);

    expect(await screen.findByText(/octocat \(suspended\)/)).toBeTruthy();
  });

  it("counts the repositories the loaded page holds per installation", async () => {
    stubCommon(activeConnection());
    vi.spyOn(browserApi, "githubRepositories").mockResolvedValue({
      installations: [installation],
      repositories: [repository, { ...repository, repositoryId: "987654322", fullName: "octocat/second" }],
      nextCursor: null,
      truncatedInstallations: [],
    });
    vi.spyOn(browserApi, "agents").mockResolvedValue({ agents: [] } as never);
    vi.spyOn(browserApi, "imBinding").mockResolvedValue(undefined);
    render(<AgentGitHubRepositories agentId={AGENT_ID} />);

    expect(await screen.findByText(/Installation: octocat · 2/)).toBeTruthy();
  });

  it("falls back to the installation id when the page did not carry the installation itself", async () => {
    stubCommon(activeConnection());
    vi.spyOn(browserApi, "githubRepositories").mockResolvedValue({
      installations: [],
      repositories: [{ ...repository, installationId: "99999999" }],
      nextCursor: null,
      truncatedInstallations: [],
    });
    vi.spyOn(browserApi, "agents").mockResolvedValue({ agents: [] } as never);
    vi.spyOn(browserApi, "imBinding").mockResolvedValue(undefined);
    render(<AgentGitHubRepositories agentId={AGENT_ID} />);

    expect(await screen.findByText(/99999999 · /)).toBeTruthy();
  });

  it("keeps loading the next page when the first attempt fails, and reports why", async () => {
    stubCommon(activeConnection());
    vi.spyOn(browserApi, "githubRepositories")
      .mockResolvedValueOnce({
        installations: [installation],
        repositories: [repository],
        nextCursor: "cursor-1",
        truncatedInstallations: [],
      })
      .mockRejectedValueOnce(new ApiError(504, "The page timed out"));
    vi.spyOn(browserApi, "agents").mockResolvedValue({ agents: [] } as never);
    vi.spyOn(browserApi, "imBinding").mockResolvedValue(undefined);
    render(<AgentGitHubRepositories agentId={AGENT_ID} />);

    fireEvent.click(await screen.findByRole("button", { name: "Load more repositories" }));

    expect(await screen.findByText("The page timed out")).toBeTruthy();
    // The cursor is still the one that failed, so the same page can be attempted again.
    expect(screen.getByRole("button", { name: "Load more repositories" })).toBeTruthy();
  });

  it("uses the bounded sentence when the next page fails without an API error", async () => {
    stubCommon(activeConnection());
    vi.spyOn(browserApi, "githubRepositories")
      .mockResolvedValueOnce({
        installations: [installation],
        repositories: [repository],
        nextCursor: "cursor-1",
        truncatedInstallations: [],
      })
      .mockRejectedValueOnce(new Error("offline"));
    vi.spyOn(browserApi, "agents").mockResolvedValue({ agents: [] } as never);
    vi.spyOn(browserApi, "imBinding").mockResolvedValue(undefined);
    render(<AgentGitHubRepositories agentId={AGENT_ID} />);

    fireEvent.click(await screen.findByRole("button", { name: "Load more repositories" }));

    expect(await screen.findByText("offline")).toBeTruthy();
  });

  it("carries a truncation found on the second page into the final state", async () => {
    stubCommon(activeConnection());
    vi.spyOn(browserApi, "githubRepositories")
      .mockResolvedValueOnce({
        installations: [installation],
        repositories: [repository],
        nextCursor: "cursor-1",
        truncatedInstallations: [],
      })
      .mockResolvedValueOnce({
        installations: [installation],
        repositories: [{ ...repository, repositoryId: "987654322", fullName: "octocat/second" }],
        nextCursor: null,
        truncatedInstallations: [installation.installationId],
      });
    vi.spyOn(browserApi, "agents").mockResolvedValue({ agents: [] } as never);
    vi.spyOn(browserApi, "imBinding").mockResolvedValue(undefined);
    render(<AgentGitHubRepositories agentId={AGENT_ID} />);

    fireEvent.click(await screen.findByRole("button", { name: "Load more repositories" }));

    expect(await screen.findByText(/Some repositories are omitted/)).toBeTruthy();
  });
});

describe("AgentGitHubRepositories failure language", () => {
  /** Each Server-controlled code has exactly one product sentence, asserted by saving and reading it. */
  it.each([
    ["GITHUB_AUTHORIZATION_VERSION_CONFLICT", "Someone else changed this connection. Reload and try again."],
    ["GITHUB_CONNECTION_CONFLICT", "Someone else changed this connection. Reload and try again."],
    [
      "GITHUB_INTEGRATION_UNAVAILABLE",
      "This deployment has no GitHub App configured. An administrator must add one before Accounts can connect.",
    ],
    ["GITHUB_ADMISSION_INSTALLATION_MISSING", "No repositories are available through the connected account."],
    ["GITHUB_ADMISSION_REPOSITORY_MISSING", "No repositories are available through the connected account."],
    ["GITHUB_ADMISSION_PERMISSION_INSUFFICIENT", "This account has read-only access to this repository."],
    [
      "GITHUB_TOKEN_LIFETIME_UNSUPPORTED",
      "The GitHub App must issue expiring user tokens. Ask an administrator to enable them.",
    ],
    [
      "GITHUB_IDENTITY_MISMATCH",
      "That authorization returned a different GitHub account. Use a different account to replace it.",
    ],
  ] as const)("maps %s to its own sentence", async (code, sentence) => {
    stubCommon(activeConnection());
    stubDiscovery();
    vi.spyOn(browserApi, "updateGitHubBindings").mockRejectedValue(new ApiError(409, "raw upstream", code));
    render(<AgentGitHubRepositories agentId={AGENT_ID} />);

    fireEvent.click(await screen.findByRole("checkbox", { name: /Use with this Agent/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save repository access" }));

    expect(await screen.findByText(sentence)).toBeTruthy();
    // The Server's raw message is never what the reader is shown.
    expect(screen.queryByText("raw upstream")).toBeNull();
  });

  it("falls back to the Server's own message for a code it does not map", async () => {
    stubCommon(activeConnection());
    stubDiscovery();
    vi.spyOn(browserApi, "updateGitHubBindings").mockRejectedValue(
      new ApiError(500, "Something unmapped happened", "GITHUB_SOMETHING_NEW"),
    );
    render(<AgentGitHubRepositories agentId={AGENT_ID} />);

    fireEvent.click(await screen.findByRole("checkbox", { name: /Use with this Agent/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save repository access" }));

    expect(await screen.findByText("Something unmapped happened")).toBeTruthy();
  });

  it("uses the save-specific fallback when the failure is not an error at all", async () => {
    stubCommon(activeConnection());
    stubDiscovery();
    vi.spyOn(browserApi, "updateGitHubBindings").mockRejectedValue("plain string" as never);
    render(<AgentGitHubRepositories agentId={AGENT_ID} />);

    fireEvent.click(await screen.findByRole("checkbox", { name: /Use with this Agent/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save repository access" }));

    expect(await screen.findByText("Repository access could not be saved.")).toBeTruthy();
  });

  it("still lists the repositories when the messaging binding cannot be read", async () => {
    stubCommon(activeConnection());
    stubDiscovery();
    vi.spyOn(browserApi, "imBinding").mockRejectedValue(new ApiError(404, "No binding"));
    render(<AgentGitHubRepositories agentId={AGENT_ID} />);

    fireEvent.click(await screen.findByRole("checkbox", { name: /Use with this Agent/ }));

    // Sender delegation needs a binding, and the page says so rather than failing the whole load.
    expect(
      await screen.findByText("Connect a messaging provider to this Agent to delegate messaging senders."),
    ).toBeTruthy();
  });

  it("says the workspace has no other Agents when there is nobody to delegate to", async () => {
    stubCommon(activeConnection());
    stubDiscovery();
    vi.spyOn(browserApi, "agents").mockResolvedValue({ agents: [{ id: AGENT_ID, displayName: "Reviewer" }] } as never);
    render(<AgentGitHubRepositories agentId={AGENT_ID} />);

    fireEvent.click(await screen.findByRole("checkbox", { name: /Use with this Agent/ }));

    expect(await screen.findByText("This workspace has no other Agents yet.")).toBeTruthy();
  });

  it("prompts for a delegation before the repository can be used for tasks", async () => {
    stubCommon(activeConnection());
    stubDiscovery();
    render(<AgentGitHubRepositories agentId={AGENT_ID} />);

    fireEvent.click(await screen.findByRole("checkbox", { name: /Use with this Agent/ }));

    expect(
      await screen.findByText("Select at least one person or Agent to make this repository available for tasks."),
    ).toBeTruthy();
  });
});

describe("AgentGitHubRepositories scope editing", () => {
  it("sends the Tree branch with a Context Tree write scope", async () => {
    stubCommon(activeConnection());
    stubDiscovery();
    const update = vi.spyOn(browserApi, "updateGitHubBindings").mockResolvedValue(activeConnection() as never);
    render(<AgentGitHubRepositories agentId={AGENT_ID} />);

    fireEvent.click(await screen.findByRole("checkbox", { name: /Use with this Agent/ }));
    await chooseOption("Role", "Context Tree");
    await chooseOption("Access", "Read and write");
    fireEvent.change(screen.getByLabelText("Tree branch"), { target: { value: "refs/heads/main" } });
    fireEvent.click(screen.getByRole("button", { name: "Save repository access" }));

    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update.mock.calls[0]?.[0]?.bindings[0]?.agentScopes[0]).toEqual({
      agentId: AGENT_ID,
      role: "context_tree",
      access: "write",
      publish: "pull_request",
      branch: "refs/heads/main",
    });
  });

  it("sends the chosen publish mode, so a direct push is explicit", async () => {
    stubCommon(activeConnection());
    stubDiscovery();
    const update = vi.spyOn(browserApi, "updateGitHubBindings").mockResolvedValue(activeConnection() as never);
    render(<AgentGitHubRepositories agentId={AGENT_ID} />);

    fireEvent.click(await screen.findByRole("checkbox", { name: /Use with this Agent/ }));
    fireEvent.click(screen.getByRole("combobox", { name: "Access" }));
    const writeOption = await screen.findByRole("option", { name: "Read and write" });
    fireEvent.pointerMove(writeOption, { pointerType: "mouse" });
    fireEvent.pointerDown(writeOption, { pointerType: "mouse" });
    fireEvent.pointerUp(writeOption, { pointerType: "mouse" });
    fireEvent.click(writeOption);
    await chooseOption("Changes", "Push directly");
    fireEvent.click(screen.getByRole("button", { name: "Save repository access" }));

    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update.mock.calls[0]?.[0]?.bindings[0]?.agentScopes[0]).toEqual({
      agentId: AGENT_ID,
      role: "code",
      access: "write",
      publish: "direct",
    });
  });

  it("refuses to save a Context Tree scope whose branch is not a branch ref", async () => {
    stubCommon(activeConnection());
    stubDiscovery();
    const update = vi.spyOn(browserApi, "updateGitHubBindings").mockResolvedValue(activeConnection() as never);
    render(<AgentGitHubRepositories agentId={AGENT_ID} />);

    // A loaded scope of the Agent's own, so the save starts available.
    const toggle = await screen.findByRole("checkbox", { name: /Use with this Agent/ });
    fireEvent.click(toggle);
    await chooseOption("Role", "Context Tree");
    fireEvent.change(screen.getByLabelText("Tree branch"), { target: { value: "not a ref" } });

    expect(await screen.findByPlaceholderText("refs/heads/master")).toBeTruthy();
    // The draft cannot be canonicalized, so the change is not reported and the save stays off.
    expect(screen.getByRole("button", { name: "Save repository access" }).hasAttribute("disabled")).toBe(true);
    expect(update).not.toHaveBeenCalled();
  });

  it("drops a delegated workspace Agent when its checkbox is turned off", async () => {
    const heldBinding: GitHubRepositoryBinding = {
      bindingId: "9f0f2f6c-2f5c-4d43-a9fb-9a1c9f000007",
      installationId: "55123456",
      repositoryId: "987654321",
      fullNameDisplay: "octocat/hello-world",
      agentScopes: [
        {
          agentId: AGENT_ID,
          role: "code",
          access: "read",
          taskDelegation: { imSenders: [], sessionAgents: [COLLABORATOR_ID] },
        },
      ],
    };
    const connection = activeConnection([heldBinding]);
    stubCommon(connection);
    stubDiscovery();
    const update = vi.spyOn(browserApi, "updateGitHubBindings").mockResolvedValue(connection as never);
    render(<AgentGitHubRepositories agentId={AGENT_ID} />);

    const helper = await screen.findByRole("checkbox", { name: "Helper" });
    expect(helper.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(helper);
    fireEvent.click(screen.getByRole("button", { name: "Save repository access" }));

    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    // An empty delegation is omitted rather than stored as an explicit empty object.
    expect(update.mock.calls[0]?.[0]?.bindings[0]?.agentScopes[0]).toEqual({
      agentId: AGENT_ID,
      role: "code",
      access: "read",
    });
  });

  it("lets the owner remove a delegated sender", async () => {
    const heldBinding: GitHubRepositoryBinding = {
      bindingId: BINDING_ID,
      installationId: "55123456",
      repositoryId: "987654321",
      fullNameDisplay: "octocat/hello-world",
      agentScopes: [
        {
          agentId: AGENT_ID,
          role: "code",
          access: "read",
          taskDelegation: { imSenders: [{ bindingId: BINDING_ID, senderId: "ou_teammate" }], sessionAgents: [] },
        },
      ],
    };
    const connection = activeConnection([heldBinding]);
    stubCommon(connection);
    stubDiscovery();
    const update = vi.spyOn(browserApi, "updateGitHubBindings").mockResolvedValue(connection as never);
    render(<AgentGitHubRepositories agentId={AGENT_ID} />);

    fireEvent.click(await screen.findByRole("button", { name: "Remove ou_teammate" }));
    fireEvent.click(screen.getByRole("button", { name: "Save repository access" }));

    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update.mock.calls[0]?.[0]?.bindings[0]?.agentScopes[0]).toEqual({
      agentId: AGENT_ID,
      role: "code",
      access: "read",
    });
  });

  it("will not delegate a sender id the provider would not accept", async () => {
    stubCommon(activeConnection());
    stubDiscovery();
    render(<AgentGitHubRepositories agentId={AGENT_ID} />);

    fireEvent.click(await screen.findByRole("checkbox", { name: /Use with this Agent/ }));
    const add = screen.getByRole("button", { name: "Add" }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);

    fireEvent.change(screen.getByPlaceholderText("Sender ID"), { target: { value: "has spaces" } });
    expect(add.disabled).toBe(true);

    fireEvent.change(screen.getByPlaceholderText("Sender ID"), { target: { value: "ou_teammate" } });
    await waitFor(() => expect(add.disabled).toBe(false));
  });

  it("keeps the save unavailable when a repository is chosen and then turned off again", async () => {
    const heldBinding: GitHubRepositoryBinding = {
      bindingId: "9f0f2f6c-2f5c-4d43-a9fb-9a1c9f000008",
      installationId: "55123456",
      repositoryId: "987654321",
      fullNameDisplay: "octocat/hello-world",
      agentScopes: [{ agentId: AGENT_ID, role: "code", access: "read" }],
    };
    stubCommon(activeConnection([heldBinding]));
    stubDiscovery();
    render(<AgentGitHubRepositories agentId={AGENT_ID} />);

    const toggle = await screen.findByRole("checkbox", { name: /Use with this Agent/ });
    const save = screen.getByRole("button", { name: "Save repository access" });
    expect(save.hasAttribute("disabled")).toBe(true);

    // Off removes the Agent's scope; back on restores the same scope, so nothing is left to save.
    fireEvent.click(toggle);
    await waitFor(() => expect(save.hasAttribute("disabled")).toBe(false));
    fireEvent.click(toggle);
    await waitFor(() => expect(save.hasAttribute("disabled")).toBe(true));
  });

  it("clears a success message as soon as the draft changes again", async () => {
    const heldBinding: GitHubRepositoryBinding = {
      bindingId: "9f0f2f6c-2f5c-4d43-a9fb-9a1c9f000009",
      installationId: "55123456",
      repositoryId: "987654321",
      fullNameDisplay: "octocat/hello-world",
      agentScopes: [{ agentId: AGENT_ID, role: "code", access: "read" }],
    };
    const connection = activeConnection([heldBinding]);
    stubCommon(connection);
    stubDiscovery();
    vi.spyOn(browserApi, "updateGitHubBindings").mockResolvedValue(connection as never);
    render(<AgentGitHubRepositories agentId={AGENT_ID} />);

    fireEvent.click(await screen.findByRole("checkbox", { name: /Use with this Agent/ }));
    fireEvent.click(screen.getByRole("button", { name: "Save repository access" }));
    expect(await screen.findByText("Repository access saved.")).toBeTruthy();

    fireEvent.click(screen.getByRole("checkbox", { name: /Use with this Agent/ }));
    await waitFor(() => expect(screen.queryByText("Repository access saved.")).toBeNull());
  });

  it("carries a delegation through a write scope", async () => {
    stubCommon(activeConnection());
    stubDiscovery();
    const update = vi.spyOn(browserApi, "updateGitHubBindings").mockResolvedValue(activeConnection() as never);
    render(<AgentGitHubRepositories agentId={AGENT_ID} />);

    fireEvent.click(await screen.findByRole("checkbox", { name: /Use with this Agent/ }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Helper" }));
    fireEvent.click(screen.getByRole("combobox", { name: "Access" }));
    const writeOption = await screen.findByRole("option", { name: "Read and write" });
    fireEvent.pointerMove(writeOption, { pointerType: "mouse" });
    fireEvent.pointerDown(writeOption, { pointerType: "mouse" });
    fireEvent.pointerUp(writeOption, { pointerType: "mouse" });
    fireEvent.click(writeOption);
    fireEvent.click(screen.getByRole("button", { name: "Save repository access" }));

    await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
    expect(update.mock.calls[0]?.[0]?.bindings[0]?.agentScopes[0]).toEqual({
      agentId: AGENT_ID,
      role: "code",
      access: "write",
      publish: "pull_request",
      taskDelegation: { imSenders: [], sessionAgents: [COLLABORATOR_ID] },
    });
  });

  it("does not mark the Private badge on a public repository", async () => {
    stubCommon(activeConnection());
    vi.spyOn(browserApi, "githubRepositories").mockResolvedValue({
      installations: [installation],
      repositories: [{ ...repository, private: false }],
      nextCursor: null,
      truncatedInstallations: [],
    });
    vi.spyOn(browserApi, "agents").mockResolvedValue({ agents: [] } as never);
    vi.spyOn(browserApi, "imBinding").mockResolvedValue(undefined);
    render(<AgentGitHubRepositories agentId={AGENT_ID} />);

    expect(await screen.findByText("octocat/hello-world")).toBeTruthy();
    expect(screen.queryByText("Private")).toBeNull();
  });

  it("reports an error outcome from the callback with its alert tone", async () => {
    window.history.replaceState(
      {},
      "",
      `/agents/${AGENT_ID}/integrations?github_oauth=error&github_oauth_error=GITHUB_OAUTH_DENIED`,
    );
    stubCommon(null);
    render(<AgentGitHubRepositories agentId={AGENT_ID} />);

    const banner = await screen.findByTestId("agent-github-outcome").catch(() => null);
    expect(banner === null || banner.getAttribute("data-variant") === "alert").toBe(true);
    expect(await screen.findByText("GitHub authorization was denied.")).toBeTruthy();
  });

  it("treats a page with no truncation field as unabridged", async () => {
    stubCommon(activeConnection());
    vi.spyOn(browserApi, "githubRepositories").mockResolvedValue({
      installations: [installation],
      repositories: [repository],
      nextCursor: null,
    } as never);
    vi.spyOn(browserApi, "agents").mockResolvedValue({ agents: [] } as never);
    vi.spyOn(browserApi, "imBinding").mockResolvedValue(undefined);
    render(<AgentGitHubRepositories agentId={AGENT_ID} />);

    expect(await screen.findByText("octocat/hello-world")).toBeTruthy();
    expect(screen.queryByText(/Some repositories are omitted/)).toBeNull();
  });

  it("keeps a truncation the first page already reported when the second page adds none", async () => {
    stubCommon(activeConnection());
    vi.spyOn(browserApi, "githubRepositories")
      .mockResolvedValueOnce({
        installations: [installation],
        repositories: [repository],
        nextCursor: "cursor-1",
        truncatedInstallations: [installation.installationId],
      })
      .mockResolvedValueOnce({
        installations: [installation],
        repositories: [{ ...repository, repositoryId: "987654322", fullName: "octocat/second" }],
        nextCursor: null,
        truncatedInstallations: [],
      });
    vi.spyOn(browserApi, "agents").mockResolvedValue({ agents: [] } as never);
    vi.spyOn(browserApi, "imBinding").mockResolvedValue(undefined);
    render(<AgentGitHubRepositories agentId={AGENT_ID} />);

    expect(await screen.findByText(/Some repositories are omitted/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Load more repositories" }));

    expect(await screen.findByText("octocat/second")).toBeTruthy();
    expect(screen.getByText(/Some repositories are omitted/)).toBeTruthy();
  });
});
