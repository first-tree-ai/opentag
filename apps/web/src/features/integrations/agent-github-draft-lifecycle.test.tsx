import type { GitHubConnectionStatus, GitHubRepositoryBinding } from "@opentag/shared/browser";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { browserApi } from "../../api.js";
import { AgentGitHubRepositories } from "./agent-github-repositories.js";

const AGENT_ID = "1a63a21e-f6c7-4474-91ea-4dabf0566a24";
const connection: GitHubConnectionStatus = {
  id: "3c63a21e-f6c7-4474-91ea-4dabf0566a24",
  accountId: "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e",
  githubHost: "github.com",
  appId: "871235",
  githubUserId: "42",
  githubLogin: "octocat",
  status: "active",
  bindingsSchemaVersion: 1,
  bindings: [],
  authorizationVersion: "2",
  credentialGeneration: "1",
  accessExpiresAt: "2026-10-13T16:00:00.000Z",
  refreshExpiresAt: "2027-03-16T00:00:00.000Z",
  recheckRequired: false,
  nextRecheckAt: null,
  lastVerifiedAt: "2026-10-13T00:00:00.000Z",
  lastErrorCode: null,
  createdAt: "2026-10-13T00:00:00.000Z",
  updatedAt: "2026-10-13T00:00:00.000Z",
};
const installation = {
  installationId: "55123456",
  accountLogin: "octocat",
  accountType: "Organization",
  repositorySelection: "selected",
  suspended: false,
} as const;
const repository = {
  installationId: installation.installationId,
  repositoryId: "987654321",
  fullName: "octocat/hello-world",
  private: true,
  defaultBranch: "main",
  permissions: { pull: true, push: true },
};
const page = { installations: [installation], repositories: [repository], nextCursor: null };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

function stubCommon() {
  vi.spyOn(browserApi, "githubIntegration").mockResolvedValue({
    availability: { available: true, githubHost: "github.com", appId: "871235" },
    connection,
  });
  vi.spyOn(browserApi, "agent").mockResolvedValue({ id: AGENT_ID, displayName: "Reviewer" } as never);
  vi.spyOn(browserApi, "agents").mockResolvedValue({ agents: [] } as never);
  vi.spyOn(browserApi, "imBinding").mockResolvedValue(undefined);
  vi.spyOn(browserApi, "githubRepositories").mockResolvedValue(page);
  vi.spyOn(browserApi, "updateGitHubBindings").mockResolvedValue(connection);
}

afterEach(() => vi.restoreAllMocks());

const HELPER_ID = "2b74b32f-a7d8-4585-92fb-5ecbf1677b35";
const IM_BINDING_ID = "9d4e1378-8ff2-4e41-a6dd-e8bf59ed775b";
const second = { ...repository, repositoryId: "987654322", fullName: "octocat/second" };
function held(repo = repository): GitHubRepositoryBinding {
  return {
    bindingId: "9f0f2f6c-2f5c-4d43-a9fb-9a1c9f000001",
    installationId: repo.installationId,
    repositoryId: repo.repositoryId,
    fullNameDisplay: repo.fullName,
    agentScopes: [
      { agentId: AGENT_ID, role: "context_tree", access: "write", publish: "direct", branch: "refs/heads/main" },
    ],
  };
}
function stubConnection(value: GitHubConnectionStatus) {
  vi.mocked(browserApi.githubIntegration).mockResolvedValue({
    availability: { available: true, githubHost: "github.com", appId: "871235" },
    connection: value,
  });
}
async function choose(name: string, optionName: string) {
  fireEvent.click(screen.getByRole("combobox", { name }));
  const option = await screen.findByRole("option", { name: optionName });
  fireEvent.pointerMove(option, { pointerType: "mouse" });
  fireEvent.pointerDown(option, { pointerType: "mouse" });
  fireEvent.pointerUp(option, { pointerType: "mouse" });
  fireEvent.click(option);
}
async function refresh() {
  fireEvent.click(screen.getByRole("button", { name: "Refresh installations" }));
  await waitFor(() => expect(screen.getByRole("status").textContent).toContain("refreshed"));
}
function checked(element: HTMLElement) {
  return element.getAttribute("aria-checked") === "true";
}
function saveButton() {
  return screen.getByRole("button", { name: "Save repository access" }) as HTMLButtonElement;
}

it("preserves a new selection while merging newly discovered repositories and the latest version", async () => {
  stubCommon();
  render(<AgentGitHubRepositories agentId={AGENT_ID} />);
  fireEvent.click(await screen.findByRole("checkbox", { name: "Use with this Agent" }));
  stubConnection({ ...connection, authorizationVersion: "3" });
  vi.mocked(browserApi.githubRepositories).mockResolvedValue({ ...page, repositories: [repository, second] });
  await refresh();
  const toggles = screen.getAllByRole("checkbox", { name: "Use with this Agent" });
  expect(toggles).toHaveLength(2);
  expect(checked(toggles[0] as HTMLElement)).toBe(true);
  expect(checked(toggles[1] as HTMLElement)).toBe(false);
  expect(browserApi.updateGitHubBindings).not.toHaveBeenCalled();
  fireEvent.click(saveButton());
  await waitFor(() => expect(browserApi.updateGitHubBindings).toHaveBeenCalledOnce());
  expect(vi.mocked(browserApi.updateGitHubBindings).mock.calls[0]?.[0]).toMatchObject({
    expectedAuthorizationVersion: "3",
    bindings: [{ repositoryId: repository.repositoryId }],
  });
});

it("preserves branch, delegation, and sender text edits across refresh", async () => {
  stubCommon();
  stubConnection({ ...connection, bindings: [held()] });
  vi.mocked(browserApi.agents).mockResolvedValue({ agents: [{ id: HELPER_ID, displayName: "Helper" }] } as never);
  vi.mocked(browserApi.imBinding).mockResolvedValue({ id: IM_BINDING_ID } as never);
  render(<AgentGitHubRepositories agentId={AGENT_ID} />);
  const branch = await screen.findByRole("textbox", { name: "Tree branch" });
  fireEvent.change(branch, { target: { value: "refs/heads/local" } });
  fireEvent.click(screen.getByRole("checkbox", { name: "Helper" }));
  fireEvent.change(screen.getByPlaceholderText("Sender ID"), { target: { value: "ou_pending" } });
  await refresh();
  expect((screen.getByRole("textbox", { name: "Tree branch" }) as HTMLInputElement).value).toBe("refs/heads/local");
  expect(checked(screen.getByRole("checkbox", { name: "Helper" }))).toBe(true);
  expect((screen.getByPlaceholderText("Sender ID") as HTMLInputElement).value).toBe("ou_pending");
  expect(saveButton().disabled).toBe(false);
  expect(browserApi.updateGitHubBindings).not.toHaveBeenCalled();
});

it("preserves an explicit unchecked grant across refresh", async () => {
  stubCommon();
  stubConnection({ ...connection, bindings: [held()] });
  render(<AgentGitHubRepositories agentId={AGENT_ID} />);
  fireEvent.click(await screen.findByRole("checkbox", { name: "Use with this Agent" }));
  await refresh();
  expect(checked(screen.getByRole("checkbox", { name: "Use with this Agent" }))).toBe(false);
  fireEvent.click(saveButton());
  await waitFor(() => expect(browserApi.updateGitHubBindings).toHaveBeenCalledOnce());
  expect(vi.mocked(browserApi.updateGitHubBindings).mock.calls[0]?.[0].bindings).toEqual([]);
});

it("initializes an existing grant discovered on a later page instead of silently removing it", async () => {
  stubCommon();
  stubConnection({ ...connection, bindings: [held(second)] });
  vi.mocked(browserApi.githubRepositories)
    .mockResolvedValueOnce({ ...page, nextCursor: "page-2" })
    .mockResolvedValueOnce({ ...page, repositories: [second] });
  render(<AgentGitHubRepositories agentId={AGENT_ID} />);
  fireEvent.click(await screen.findByRole("button", { name: "Load more repositories" }));
  expect(await screen.findByText(second.fullName)).toBeTruthy();
  expect(checked(screen.getAllByRole("checkbox", { name: "Use with this Agent" })[1] as HTMLElement)).toBe(true);
  expect(saveButton().disabled).toBe(true);
});

it("restores entered scope fields and pending sender text after off/on", async () => {
  stubCommon();
  stubConnection({ ...connection, bindings: [held()] });
  vi.mocked(browserApi.imBinding).mockResolvedValue({ id: IM_BINDING_ID } as never);
  render(<AgentGitHubRepositories agentId={AGENT_ID} />);
  const toggle = await screen.findByRole("checkbox", { name: "Use with this Agent" });
  fireEvent.change(screen.getByRole("textbox", { name: "Tree branch" }), { target: { value: "refs/heads/local" } });
  fireEvent.change(screen.getByPlaceholderText("Sender ID"), { target: { value: "ou_pending" } });
  fireEvent.click(toggle);
  fireEvent.click(toggle);
  expect((screen.getByRole("textbox", { name: "Tree branch" }) as HTMLInputElement).value).toBe("refs/heads/local");
  expect(screen.getByRole("combobox", { name: "Access" }).textContent).toContain("Read and write");
  expect((screen.getByPlaceholderText("Sender ID") as HTMLInputElement).value).toBe("ou_pending");
});

it("retains an edited later-page row until it is rediscovered by pagination", async () => {
  stubCommon();
  stubConnection({ ...connection, bindings: [held(second)] });
  vi.mocked(browserApi.githubRepositories)
    .mockResolvedValueOnce({ ...page, nextCursor: "page-2" })
    .mockResolvedValueOnce({ ...page, repositories: [second] })
    .mockResolvedValueOnce({ ...page, nextCursor: "page-2" })
    .mockResolvedValueOnce({ ...page, repositories: [second] });
  render(<AgentGitHubRepositories agentId={AGENT_ID} />);
  fireEvent.click(await screen.findByRole("button", { name: "Load more repositories" }));
  await screen.findByText(second.fullName);
  const toggle = screen.getAllByRole("checkbox", { name: "Use with this Agent" })[1] as HTMLElement;
  if (!checked(toggle)) fireEvent.click(toggle);
  await choose("Role", "Context Tree");
  fireEvent.change(screen.getByRole("textbox", { name: "Tree branch" }), { target: { value: "refs/heads/local" } });
  await refresh();
  expect(screen.getByText(second.fullName)).toBeTruthy();
  expect((screen.getByRole("textbox", { name: "Tree branch" }) as HTMLInputElement).value).toBe("refs/heads/local");
  expect(saveButton().disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Load more repositories" }));
  await waitFor(() => expect(saveButton().disabled).toBe(false));
  expect((screen.getByRole("textbox", { name: "Tree branch" }) as HTMLInputElement).value).toBe("refs/heads/local");
});

it("preserves edits made while refresh is in flight, including an invalid branch", async () => {
  stubCommon();
  stubConnection({ ...connection, bindings: [held()] });
  render(<AgentGitHubRepositories agentId={AGENT_ID} />);
  const branch = await screen.findByRole("textbox", { name: "Tree branch" });
  fireEvent.change(branch, { target: { value: "refs/heads/local" } });
  const pending = deferred<typeof page>();
  vi.mocked(browserApi.githubRepositories).mockReturnValueOnce(pending.promise);
  fireEvent.click(screen.getByRole("button", { name: "Refresh installations" }));
  fireEvent.change(branch, { target: { value: "still-typing" } });
  pending.resolve(page);
  await waitFor(() => expect(screen.getByRole("status").textContent).toContain("refreshed"));
  expect((screen.getByRole("textbox", { name: "Tree branch" }) as HTMLInputElement).value).toBe("still-typing");
  expect(saveButton().disabled).toBe(true);
  expect(browserApi.updateGitHubBindings).not.toHaveBeenCalled();
});

it.each(["write-permission", "suspension"])("keeps drafts but prevents saving after %s is lost", async (reason) => {
  stubCommon();
  stubConnection({ ...connection, bindings: [held()] });
  render(<AgentGitHubRepositories agentId={AGENT_ID} />);
  fireEvent.change(await screen.findByRole("textbox", { name: "Tree branch" }), {
    target: { value: "refs/heads/local" },
  });
  vi.mocked(browserApi.githubRepositories).mockResolvedValue({
    ...page,
    installations: [{ ...installation, suspended: reason === "suspension" }],
    repositories: [{ ...repository, permissions: { pull: true, push: reason !== "write-permission" } }],
  });
  await refresh();
  expect((screen.getByRole("textbox", { name: "Tree branch" }) as HTMLInputElement).value).toBe("refs/heads/local");
  expect(saveButton().disabled).toBe(true);
  expect(screen.getByRole("alert").textContent).toContain("Edits kept for octocat/hello-world");
  expect(browserApi.updateGitHubBindings).not.toHaveBeenCalled();
  if (reason === "write-permission") await choose("Access", "Read only");
  else {
    vi.mocked(browserApi.githubRepositories).mockResolvedValue(page);
    await refresh();
  }
  expect(saveButton().disabled).toBe(false);
});

it.each(["reauthorization_required", "disconnected", "unavailable"] as const)(
  "retains drafts through a temporary %s connection",
  async (status) => {
    stubCommon();
    stubConnection({ ...connection, bindings: [held()] });
    render(<AgentGitHubRepositories agentId={AGENT_ID} />);
    fireEvent.change(await screen.findByRole("textbox", { name: "Tree branch" }), {
      target: { value: "refs/heads/local" },
    });
    vi.mocked(browserApi.githubIntegration).mockResolvedValue({
      availability: { available: status !== "unavailable", githubHost: "github.com", appId: "871235" },
      connection: status === "reauthorization_required" ? { ...connection, status } : null,
    });
    fireEvent.click(screen.getByRole("button", { name: "Refresh installations" }));
    expect(
      await screen.findByText(
        "Your unsaved edits are kept while GitHub is unavailable. Refresh to check the connection again.",
      ),
    ).toBeTruthy();
    stubConnection({ ...connection, bindings: [held()] });
    fireEvent.click(screen.getByRole("button", { name: "Refresh installations" }));
    expect(await screen.findByRole("textbox", { name: "Tree branch" })).toHaveProperty("value", "refs/heads/local");
    expect(saveButton().disabled).toBe(false);
  },
);

it("keeps drafts separate from a replacement GitHub connection until explicitly discarded", async () => {
  stubCommon();
  stubConnection({ ...connection, bindings: [held()] });
  render(<AgentGitHubRepositories agentId={AGENT_ID} />);
  fireEvent.change(await screen.findByRole("textbox", { name: "Tree branch" }), {
    target: { value: "refs/heads/local" },
  });
  stubConnection({
    ...connection,
    id: "4c63a21e-f6c7-4474-91ea-4dabf0566a24",
    githubUserId: "43",
    githubLogin: "another-user",
  });
  vi.mocked(browserApi.githubRepositories).mockResolvedValue({ ...page, repositories: [second] });
  fireEvent.click(screen.getByRole("button", { name: "Refresh installations" }));
  const discard = await screen.findByRole("button", { name: "Discard drafts and switch connection" });
  expect((screen.getByRole("textbox", { name: "Tree branch" }) as HTMLInputElement).value).toBe("refs/heads/local");
  expect(saveButton().disabled).toBe(true);
  fireEvent.click(discard);
  expect(await screen.findByText(second.fullName)).toBeTruthy();
  expect(screen.queryByRole("textbox", { name: "Tree branch" })).toBeNull();
  expect(browserApi.updateGitHubBindings).not.toHaveBeenCalled();
  expect(document.activeElement).toBe(screen.getByRole("status"));
});

it("rebases untouched grants, keeps dirty grants, and exposes a conflicting server edit", async () => {
  stubCommon();
  stubConnection({ ...connection, bindings: [held()] });
  render(<AgentGitHubRepositories agentId={AGENT_ID} />);
  fireEvent.change(await screen.findByRole("textbox", { name: "Tree branch" }), {
    target: { value: "refs/heads/local" },
  });
  const updated = held();
  updated.agentScopes[0] = {
    agentId: AGENT_ID,
    role: "context_tree",
    access: "write",
    publish: "direct",
    branch: "refs/heads/server",
  };
  const other = { ...held(second), bindingId: "9f0f2f6c-2f5c-4d43-a9fb-9a1c9f000002" };
  stubConnection({ ...connection, authorizationVersion: "3", bindings: [updated, other] });
  vi.mocked(browserApi.githubRepositories).mockResolvedValue({ ...page, repositories: [repository, second] });
  await refresh();
  const branches = screen.getAllByRole("textbox", { name: "Tree branch" }) as HTMLInputElement[];
  expect(branches.map((input) => input.value)).toEqual(["refs/heads/local", "refs/heads/main"]);
  expect(screen.getByRole("alert").textContent).toContain("Saved access changed for octocat/hello-world");
  fireEvent.click(saveButton());
  await waitFor(() => expect(browserApi.updateGitHubBindings).toHaveBeenCalledOnce());
  expect(vi.mocked(browserApi.updateGitHubBindings).mock.calls[0]?.[0]).toMatchObject({
    expectedAuthorizationVersion: "3",
    bindings: expect.arrayContaining([
      expect.objectContaining({
        bindingId: updated.bindingId,
        agentScopes: [expect.objectContaining({ branch: "refs/heads/local" })],
      }),
      expect.objectContaining({
        bindingId: other.bindingId,
        agentScopes: [expect.objectContaining({ branch: "refs/heads/main" })],
      }),
    ]),
  });
});

it("keeps edits made during save and a later refresh instead of acknowledging them as saved", async () => {
  stubCommon();
  stubConnection({ ...connection, bindings: [held()] });
  render(<AgentGitHubRepositories agentId={AGENT_ID} />);
  const branch = await screen.findByRole("textbox", { name: "Tree branch" });
  fireEvent.change(branch, { target: { value: "refs/heads/submitted" } });
  const pending = deferred<GitHubConnectionStatus>();
  vi.mocked(browserApi.updateGitHubBindings).mockReturnValueOnce(pending.promise);
  fireEvent.click(saveButton());
  fireEvent.change(branch, { target: { value: "refs/heads/newer" } });
  const submitted = vi.mocked(browserApi.updateGitHubBindings).mock.calls[0]?.[0].bindings ?? [];
  const saved = { ...connection, authorizationVersion: "3", bindings: submitted };
  pending.resolve(saved);
  expect(await screen.findByText("Repository access saved. Unsaved edits remain.")).toBeTruthy();
  expect((screen.getByRole("textbox", { name: "Tree branch" }) as HTMLInputElement).value).toBe("refs/heads/newer");
  stubConnection(saved);
  await refresh();
  expect((screen.getByRole("textbox", { name: "Tree branch" }) as HTMLInputElement).value).toBe("refs/heads/newer");
  expect(saveButton().disabled).toBe(false);
});

it("keeps pending sender text on a retained row and through a save of other fields", async () => {
  stubCommon();
  stubConnection({ ...connection, bindings: [held()] });
  vi.mocked(browserApi.imBinding).mockResolvedValue({ id: IM_BINDING_ID } as never);
  render(<AgentGitHubRepositories agentId={AGENT_ID} />);
  fireEvent.change(await screen.findByPlaceholderText("Sender ID"), { target: { value: "ou_pending" } });
  vi.mocked(browserApi.githubRepositories)
    .mockResolvedValueOnce({ ...page, repositories: [], nextCursor: "page-2" })
    .mockResolvedValueOnce(page);
  await refresh();
  expect((screen.getByPlaceholderText("Sender ID") as HTMLInputElement).value).toBe("ou_pending");
  fireEvent.click(screen.getByRole("button", { name: "Load more repositories" }));
  await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  fireEvent.change(screen.getByRole("textbox", { name: "Tree branch" }), { target: { value: "refs/heads/local" } });
  vi.mocked(browserApi.updateGitHubBindings).mockImplementation(async (input) => ({
    ...connection,
    authorizationVersion: "3",
    bindings: input.bindings,
  }));
  fireEvent.click(saveButton());
  expect(await screen.findByText("Repository access saved. Unsaved edits remain.")).toBeTruthy();
  expect((screen.getByPlaceholderText("Sender ID") as HTMLInputElement).value).toBe("ou_pending");
});

it("uses fresh repository identity metadata without resetting editable fields or duplicating rows", async () => {
  stubCommon();
  const shared = held();
  shared.agentScopes.push({ agentId: HELPER_ID, role: "code", access: "read" });
  stubConnection({ ...connection, bindings: [shared] });
  render(<AgentGitHubRepositories agentId={AGENT_ID} />);
  fireEvent.change(await screen.findByRole("textbox", { name: "Tree branch" }), {
    target: { value: "refs/heads/local" },
  });
  const renamed = { ...repository, installationId: "55123457", fullName: "new-org/renamed" };
  vi.mocked(browserApi.githubRepositories).mockResolvedValue({
    ...page,
    installations: [{ ...installation, installationId: "55123457", accountLogin: "new-org" }],
    repositories: [renamed, renamed],
  });
  await refresh();
  expect(screen.getAllByRole("checkbox", { name: "Use with this Agent" })).toHaveLength(1);
  expect((screen.getByRole("textbox", { name: "Tree branch" }) as HTMLInputElement).value).toBe("refs/heads/local");
  fireEvent.click(saveButton());
  await waitFor(() => expect(browserApi.updateGitHubBindings).toHaveBeenCalledOnce());
  const bindings = vi.mocked(browserApi.updateGitHubBindings).mock.calls[0]?.[0].bindings ?? [];
  expect(bindings).toHaveLength(2);
  expect(bindings.find((binding) => binding.bindingId === held().bindingId)).toMatchObject({
    installationId: installation.installationId,
    agentScopes: [{ agentId: HELPER_ID, role: "code", access: "read" }],
  });
  const moved = bindings.find((binding) => binding.installationId === "55123457");
  expect(moved?.bindingId).not.toBe(held().bindingId);
  expect(moved).toMatchObject({
    installationId: "55123457",
    fullNameDisplay: "new-org/renamed",
    agentScopes: expect.arrayContaining([expect.objectContaining({ agentId: AGENT_ID, branch: "refs/heads/local" })]),
  });
});

it("does not apply a previous Agent's late refresh response to a different Agent", async () => {
  stubCommon();
  stubConnection({ ...connection, bindings: [held()] });
  const mounted = render(<AgentGitHubRepositories agentId={AGENT_ID} />);
  fireEvent.change(await screen.findByRole("textbox", { name: "Tree branch" }), {
    target: { value: "refs/heads/old-agent" },
  });
  const pending = deferred<typeof page>();
  vi.mocked(browserApi.githubRepositories).mockReturnValueOnce(pending.promise);
  fireEvent.click(screen.getByRole("button", { name: "Refresh installations" }));
  await waitFor(() => expect(browserApi.githubRepositories).toHaveBeenCalledTimes(2));
  vi.mocked(browserApi.githubRepositories).mockResolvedValue({ ...page, repositories: [second] });
  mounted.rerender(<AgentGitHubRepositories agentId={HELPER_ID} />);
  expect(await screen.findByText(second.fullName)).toBeTruthy();
  pending.resolve(page);
  await waitFor(() => expect(screen.queryByText(repository.fullName)).toBeNull());
  expect(checked(screen.getByRole("checkbox", { name: "Use with this Agent" }))).toBe(false);
  expect(screen.queryByRole("textbox", { name: "Tree branch" })).toBeNull();
  expect(browserApi.updateGitHubBindings).not.toHaveBeenCalled();
});

it("keeps removed delegation targets visible so they can be explicitly removed", async () => {
  stubCommon();
  const binding = held();
  binding.agentScopes[0] = {
    agentId: AGENT_ID,
    role: "context_tree",
    access: "write",
    publish: "direct",
    branch: "refs/heads/main",
    taskDelegation: { sessionAgents: [HELPER_ID], imSenders: [{ bindingId: IM_BINDING_ID, senderId: "ou_previous" }] },
  };
  stubConnection({ ...connection, bindings: [binding] });
  vi.mocked(browserApi.agents).mockResolvedValue({ agents: [{ id: HELPER_ID, displayName: "Helper" }] } as never);
  vi.mocked(browserApi.imBinding).mockResolvedValue({ id: IM_BINDING_ID } as never);
  render(<AgentGitHubRepositories agentId={AGENT_ID} />);
  fireEvent.change(await screen.findByPlaceholderText("Sender ID"), { target: { value: "ou_pending" } });
  vi.mocked(browserApi.agents).mockResolvedValue({ agents: [] } as never);
  vi.mocked(browserApi.imBinding).mockResolvedValue(undefined);
  await refresh();
  const removed = screen.getByRole("checkbox", { name: `Unavailable Agent (${HELPER_ID})` });
  expect(checked(removed)).toBe(true);
  expect((screen.getByPlaceholderText("Sender ID") as HTMLInputElement).value).toBe("ou_pending");
  expect((screen.getByRole("button", { name: "Add" }) as HTMLButtonElement).disabled).toBe(true);
  removed.focus();
  fireEvent.click(removed);
  expect(document.activeElement).toBe(screen.getByRole("combobox", { name: "Role" }));
  fireEvent.click(screen.getByRole("button", { name: "Remove ou_previous" }));
  expect(document.activeElement).toBe(screen.getByPlaceholderText("Sender ID"));
  fireEvent.click(saveButton());
  await waitFor(() => expect(browserApi.updateGitHubBindings).toHaveBeenCalledOnce());
  expect(
    vi.mocked(browserApi.updateGitHubBindings).mock.calls[0]?.[0].bindings[0]?.agentScopes[0]?.taskDelegation,
  ).toBeUndefined();
});

it.each([false, true])(
  "can save multiple new repository selections with distinct IDs (existing placeholder collision=%s)",
  async (collision) => {
    stubCommon();
    const previous = {
      ...held({ ...repository, repositoryId: "987654399", fullName: "octocat/unloaded" }),
      bindingId: "00000000-0000-4000-8000-000000000001",
      agentScopes: [{ agentId: HELPER_ID, role: "code" as const, access: "read" as const }],
    };
    stubConnection({ ...connection, bindings: collision ? [previous] : [] });
    vi.mocked(browserApi.githubRepositories).mockResolvedValue({ ...page, repositories: [repository, second] });
    render(<AgentGitHubRepositories agentId={AGENT_ID} />);
    const toggles = await screen.findAllByRole("checkbox", { name: "Use with this Agent" });
    for (const toggle of toggles) fireEvent.click(toggle);
    expect(saveButton().disabled).toBe(false);
    await refresh();
    expect(screen.getAllByRole("checkbox", { name: "Use with this Agent" }).every((toggle) => checked(toggle))).toBe(
      true,
    );
    expect(saveButton().disabled).toBe(false);
    fireEvent.click(saveButton());
    await waitFor(() => expect(browserApi.updateGitHubBindings).toHaveBeenCalledOnce());
    const bindings = vi.mocked(browserApi.updateGitHubBindings).mock.calls[0]?.[0].bindings ?? [];
    expect(bindings).toHaveLength(collision ? 3 : 2);
    expect(new Set(bindings.map((binding) => binding.bindingId)).size).toBe(bindings.length);
    if (collision) expect(bindings.find((binding) => binding.bindingId === previous.bindingId)).toEqual(previous);
  },
);

it("preserves additional roles on a repository when saving an edited scope or another repository", async () => {
  stubCommon();
  vi.mocked(browserApi.updateGitHubBindings).mockImplementation(async (input) => ({
    ...connection,
    authorizationVersion: "3",
    bindings: input.bindings,
  }));
  const binding = held();
  binding.agentScopes.push({ agentId: AGENT_ID, role: "code", access: "read" });
  stubConnection({ ...connection, bindings: [binding] });
  vi.mocked(browserApi.imBinding).mockResolvedValue({ id: IM_BINDING_ID } as never);
  vi.mocked(browserApi.githubRepositories).mockResolvedValue({ ...page, repositories: [repository, second] });
  render(<AgentGitHubRepositories agentId={AGENT_ID} />);
  const toggles = await screen.findAllByRole("checkbox", { name: "Use with this Agent" });
  expect(saveButton().disabled).toBe(true);
  fireEvent.change(screen.getByPlaceholderText("Sender ID"), { target: { value: "ou_not_added" } });
  expect(saveButton().disabled).toBe(true);
  fireEvent.click(toggles[1] as HTMLElement);
  fireEvent.change(screen.getByRole("textbox", { name: "Tree branch" }), { target: { value: "refs/heads/local" } });
  fireEvent.click(saveButton());
  await waitFor(() => expect(browserApi.updateGitHubBindings).toHaveBeenCalledOnce());
  const bindings = vi.mocked(browserApi.updateGitHubBindings).mock.calls[0]?.[0].bindings ?? [];
  expect(bindings.find((entry) => entry.repositoryId === repository.repositoryId)?.agentScopes).toEqual(
    expect.arrayContaining([
      { agentId: AGENT_ID, role: "code", access: "read" },
      { agentId: AGENT_ID, role: "context_tree", access: "write", publish: "direct", branch: "refs/heads/local" },
    ]),
  );
  expect(bindings.find((entry) => entry.repositoryId === second.repositoryId)?.agentScopes).toEqual([
    { agentId: AGENT_ID, role: "code", access: "read" },
  ]);
  await waitFor(() => expect(saveButton().disabled).toBe(true));
});
