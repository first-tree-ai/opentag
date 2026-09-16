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
      .mockResolvedValueOnce({ installations: [installation], repositories: [repository], nextCursor: "cursor-1" })
      .mockResolvedValueOnce({
        installations: [installation],
        repositories: [{ ...repository, repositoryId: "987654322", fullName: "octocat/second" }],
        nextCursor: null,
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
