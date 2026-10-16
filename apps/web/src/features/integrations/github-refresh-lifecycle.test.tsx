import type { GitHubConnectionStatus } from "@opentag/shared/browser";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { browserApi } from "../../api.js";
import { GitHubIntegrationSettings } from "../account/github-integration-settings.js";

const AGENT_ID = "1a63a21e-f6c7-4474-91ea-4dabf0566a24";
const connection: GitHubConnectionStatus = {
  id: "3c63a21e-f6c7-4474-91ea-4dabf0566a24",
  accountId: "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e",
  githubHost: "github.com",
  appId: "871235",
  githubUserId: "42",
  githubLogin: "octocat",
  status: "active",
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
}

afterEach(() => vi.restoreAllMocks());

describe("Account GitHub refresh lifecycle", () => {
  function mount() {
    return render(<GitHubIntegrationSettings />);
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
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("status")));
    expect(screen.getByRole("link", { name: "Install GitHub App" })).toBeTruthy();
  });
});
