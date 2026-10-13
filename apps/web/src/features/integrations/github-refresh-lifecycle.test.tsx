import type { GitHubConnectionStatus } from "@opentag/shared/browser";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { browserApi } from "../../api.js";
import { GitHubIntegrationSettings } from "../account/github-integration-settings.js";
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

describe.each(["Account", "Agent"] as const)("%s GitHub refresh lifecycle", (surface) => {
  function mount() {
    return render(
      surface === "Account" ? <GitHubIntegrationSettings /> : <AgentGitHubRepositories agentId={AGENT_ID} />,
    );
  }

  it.each([false, true])("keeps focus and announces a refresh (existing installation=%s)", async (existing) => {
    stubCommon();
    vi.mocked(browserApi.githubRepositories).mockResolvedValueOnce(
      existing ? page : { installations: [], repositories: [], nextCursor: null },
    );
    const pending = deferred<typeof page>();
    vi.mocked(browserApi.githubRepositories).mockReturnValueOnce(pending.promise);
    mount();
    const refresh = await screen.findByRole("button", { name: "Refresh installations" });
    const status = screen.getByRole("status");
    expect(status.textContent).toBe("");
    refresh.focus();
    fireEvent.click(refresh);

    expect(refresh.getAttribute("aria-disabled")).toBe("true");
    expect(document.activeElement).toBe(refresh);
    expect(status.textContent).toContain("Refreshing GitHub installations");
    expect(screen.queryByRole("button", { name: "Saving…" })).toBeNull();
    fireEvent.click(refresh);
    await waitFor(() => expect(browserApi.githubRepositories).toHaveBeenCalledTimes(2));

    pending.resolve(page);
    await waitFor(() => expect(status.textContent).toContain("refreshed"));
    expect(screen.getByRole("status")).toBe(status);
    expect(status.getAttribute("aria-live")).toBe("polite");
    expect(status.getAttribute("aria-atomic")).toBe("true");
    expect(document.activeElement).toBe(refresh);
    expect(screen.getByRole("button", { name: "Refresh installations" })).toBe(refresh);
    expect(browserApi.updateGitHubBindings).not.toHaveBeenCalled();

    const repeated = deferred<typeof page>();
    vi.mocked(browserApi.githubRepositories).mockReturnValueOnce(repeated.promise);
    fireEvent.click(refresh);
    expect(status.textContent).toContain("Refreshing GitHub installations");
    repeated.resolve(page);
    await waitFor(() => expect(status.textContent).toContain("refreshed"));
    expect(document.activeElement).toBe(refresh);
  });

  it("keeps a failed refresh usable and announces an empty retry", async () => {
    stubCommon();
    mount();
    const refresh = await screen.findByRole("button", { name: "Refresh installations" });
    refresh.focus();
    fireEvent.click(refresh);
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("refreshed"));
    vi.mocked(browserApi.githubRepositories).mockRejectedValueOnce(new Error("GitHub refresh failed"));
    fireEvent.click(refresh);
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "GitHub refresh failed");
    expect(document.activeElement).toBe(refresh);
    expect(screen.getByRole("link", { name: "Install GitHub App" })).toBeTruthy();
    expect(screen.queryByText("No installations found.")).toBeNull();
    expect(screen.getByRole("status").textContent).toBe("");

    vi.mocked(browserApi.githubRepositories).mockResolvedValueOnce({
      installations: [],
      repositories: [],
      nextCursor: null,
    });
    fireEvent.click(refresh);
    expect(await screen.findByText("No installations found.")).toBeTruthy();
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("0 installations"));
    expect(screen.queryByRole("alert")).toBeNull();
    expect(document.activeElement).toBe(refresh);
    expect(browserApi.updateGitHubBindings).not.toHaveBeenCalled();
  });

  it("does not steal focus when the user moves during refresh", async () => {
    stubCommon();
    mount();
    const refresh = await screen.findByRole("button", { name: "Refresh installations" });
    const pending = deferred<typeof page>();
    vi.mocked(browserApi.githubRepositories).mockReturnValueOnce(pending.promise);
    refresh.focus();
    fireEvent.click(refresh);
    const install = screen.getByRole("link", { name: "Install GitHub App" });
    install.focus();
    pending.resolve(page);
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("refreshed"));
    expect(document.activeElement).toBe(install);
  });

  it.each(["disconnected", "reauthorization_required", "unavailable"] as const)(
    "moves focus to the result when the connection becomes %s",
    async (state) => {
      stubCommon();
      mount();
      const refresh = await screen.findByRole("button", { name: "Refresh installations" });
      vi.mocked(browserApi.githubIntegration).mockResolvedValueOnce({
        availability: { available: state !== "unavailable", githubHost: "github.com", appId: "871235" },
        connection: state === "reauthorization_required" ? { ...connection, status: state } : null,
      });
      refresh.focus();
      fireEvent.click(refresh);
      await waitFor(() => expect(screen.queryByRole("link", { name: "Install GitHub App" })).toBeNull());
      await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("status")));
      expect(screen.getByRole("status").textContent).toBe("GitHub connection changed. Review its current status.");
    },
  );

  it("gives a completed retry a focus target after the initial load failed", async () => {
    stubCommon();
    vi.mocked(browserApi.githubRepositories).mockRejectedValueOnce(new Error("Initial discovery failed"));
    mount();
    const retry = await screen.findByRole("button", { name: "Try again" });
    retry.focus();
    fireEvent.click(retry);
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("refreshed"));
    expect(document.activeElement).toBe(screen.getByRole("status"));
    expect(screen.getByRole("link", { name: "Install GitHub App" })).toBeTruthy();
  });
});

describe("Agent GitHub action isolation", () => {
  it("blocks refresh and save during pagination and announces the last page with a focus target", async () => {
    stubCommon();
    vi.mocked(browserApi.githubRepositories).mockResolvedValueOnce({ ...page, nextCursor: "next-page" });
    const pending = deferred<typeof page>();
    vi.mocked(browserApi.githubRepositories).mockReturnValueOnce(pending.promise);
    render(<AgentGitHubRepositories agentId={AGENT_ID} />);
    const more = await screen.findByRole("button", { name: "Load more repositories" });
    fireEvent.click(screen.getByRole("checkbox", { name: "Use with this Agent" }));
    more.focus();
    fireEvent.click(more);
    const refresh = screen.getByRole("button", { name: "Refresh installations" });
    expect(refresh.getAttribute("aria-disabled")).toBe("true");
    expect((screen.getByRole("button", { name: "Save repository access" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(refresh);
    fireEvent.click(screen.getByRole("button", { name: "Save repository access" }));
    await waitFor(() => expect(browserApi.githubRepositories).toHaveBeenCalledTimes(2));
    expect(browserApi.updateGitHubBindings).not.toHaveBeenCalled();
    pending.resolve({
      ...page,
      repositories: [{ ...repository, repositoryId: "987654322", fullName: "octocat/second" }],
    });
    expect(await screen.findByText("octocat/second")).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("status")));
    expect(screen.getByRole("status").textContent).toBe("Repository list updated: 2 repositories shown.");
  });

  it("blocks pagination during refresh without showing a saving state", async () => {
    stubCommon();
    vi.mocked(browserApi.githubRepositories).mockResolvedValueOnce({ ...page, nextCursor: "next-page" });
    const pending = deferred<typeof page>();
    vi.mocked(browserApi.githubRepositories).mockReturnValueOnce(pending.promise);
    render(<AgentGitHubRepositories agentId={AGENT_ID} />);
    fireEvent.click(await screen.findByRole("button", { name: "Refresh installations" }));
    const more = screen.getByRole("button", { name: "Load more repositories" }) as HTMLButtonElement;
    expect(more.disabled).toBe(true);
    fireEvent.click(more);
    await waitFor(() => expect(browserApi.githubRepositories).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole("button", { name: "Saving…" })).toBeNull();
    pending.resolve(page);
    await waitFor(() => expect(screen.getByRole("status").textContent).toContain("refreshed"));
    expect(browserApi.updateGitHubBindings).not.toHaveBeenCalled();
  });

  it("shows Saving only for a grant write and blocks discovery while it is pending", async () => {
    stubCommon();
    vi.mocked(browserApi.githubRepositories).mockResolvedValueOnce({ ...page, nextCursor: "next-page" });
    const pending = deferred<GitHubConnectionStatus>();
    vi.mocked(browserApi.updateGitHubBindings).mockReturnValueOnce(pending.promise);
    render(<AgentGitHubRepositories agentId={AGENT_ID} />);
    fireEvent.click(await screen.findByRole("checkbox", { name: "Use with this Agent" }));
    const save = screen.getByRole("button", { name: "Save repository access" });
    save.focus();
    fireEvent.click(save);
    expect(screen.getByRole("button", { name: "Saving…" })).toBeTruthy();
    const refresh = screen.getByRole("button", { name: "Refresh installations" });
    expect(refresh.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(refresh);
    fireEvent.click(screen.getByRole("button", { name: "Load more repositories" }));
    expect(browserApi.githubRepositories).toHaveBeenCalledTimes(1);
    pending.resolve({
      ...connection,
      bindings: vi.mocked(browserApi.updateGitHubBindings).mock.calls[0]?.[0].bindings ?? [],
    });
    expect(await screen.findByText("Repository access saved.")).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("status")));
  });

  it("keeps a failed pagination cursor and restores the control's lost focus", async () => {
    stubCommon();
    vi.mocked(browserApi.githubRepositories).mockResolvedValueOnce({ ...page, nextCursor: "next-page" });
    const pending = deferred<typeof page>();
    vi.mocked(browserApi.githubRepositories).mockReturnValueOnce(pending.promise);
    render(<AgentGitHubRepositories agentId={AGENT_ID} />);
    const more = await screen.findByRole("button", { name: "Load more repositories" });
    more.focus();
    fireEvent.click(more);
    more.blur();
    pending.reject(new Error("Next page failed"));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Next page failed");
    await waitFor(() => expect(document.activeElement).toBe(more));
    expect(screen.getByRole("button", { name: "Load more repositories" })).toBe(more);
    expect(screen.getByRole("status").textContent).toBe("");
    expect(browserApi.updateGitHubBindings).not.toHaveBeenCalled();
  });
});
