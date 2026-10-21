import type { GitHubConnectionStatus, GitHubRepositoryDiscoveryPage } from "@opentag/shared/browser";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { browserApi } from "../../api.js";
import { GitHubRepositoryAccess } from "./github-repository-access.js";

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
  accessExpiresAt: "2027-10-19T08:00:00.000Z",
  refreshExpiresAt: "2028-10-19T00:00:00.000Z",
  recheckRequired: false,
  nextRecheckAt: null,
  lastVerifiedAt: "2026-10-19T00:00:00.000Z",
  lastErrorCode: null,
  createdAt: "2026-10-18T00:00:00.000Z",
  updatedAt: "2026-10-19T00:00:00.000Z",
};
const installation = {
  installationId: "77",
  accountLogin: "acme",
  accountType: "Organization" as const,
  repositorySelection: "selected" as const,
  suspended: false,
};
function page(ids: number[], overrides: Partial<GitHubRepositoryDiscoveryPage> = {}): GitHubRepositoryDiscoveryPage {
  return {
    installations: [installation],
    repositories: ids.map((id) => ({
      repositoryId: String(id),
      installationId: "77",
      fullName: `acme/repo-${id}`,
      private: true,
      defaultBranch: "main",
      permissions: { pull: true, push: false },
    })),
    nextCursor: null,
    truncatedInstallations: [],
    installationsTruncated: false,
    ...overrides,
  };
}
async function open() {
  render(<GitHubRepositoryAccess connection={connection} busy={false} />);
  fireEvent.click(screen.getByRole("button", { name: "View repositories" }));
  return screen.findByRole("dialog", { name: "Accessible repositories" });
}
afterEach(() => vi.restoreAllMocks());

describe("GitHub repository access", () => {
  it("does not query before opening and does not expose the viewer before account authorization", () => {
    const discover = vi.spyOn(browserApi, "githubRepositories");
    const view = render(<GitHubRepositoryAccess connection={connection} busy={false} />);
    expect(discover).not.toHaveBeenCalled();
    view.rerender(<GitHubRepositoryAccess busy={false} />);
    expect(screen.queryByRole("button", { name: "View repositories" })).toBeNull();
    expect(screen.getByRole("link", { name: "Configure on GitHub" })).toBeTruthy();
  });

  it.each([false, true])(
    "shows one compact empty paragraph with an installation-aware next step (%s)",
    async (installed) => {
      vi.spyOn(browserApi, "githubRepositories").mockResolvedValue(
        page([], { installations: installed ? [installation] : [] }),
      );
      const dialog = await open();
      const text = installed
        ? "No accessible repositories found. Check repository access on GitHub and make sure your account has access."
        : "No accessible repositories found. Install or configure the openTag App on GitHub and select the repositories you need.";
      expect(await within(dialog).findByText(text)).toBeTruthy();
      expect(within(dialog).getAllByRole("heading")).toHaveLength(1);
      expect(within(dialog).queryByText("@octocat")).toBeNull();
      expect(within(dialog).queryByRole("searchbox")).toBeNull();
      expect(within(dialog).getByText(/If you can't configure access to organization repositories/)).toBeTruthy();
      const configure = within(dialog).getByRole("link", { name: "Configure on GitHub" });
      expect(configure.getAttribute("href")).toBe("/api/v1/integrations/github/installation");
      expect(configure.getAttribute("rel")).toBe("noopener noreferrer");
    },
  );

  it("offers retry for failed reads without guessing an installation or authorization problem", async () => {
    const discover = vi
      .spyOn(browserApi, "githubRepositories")
      .mockRejectedValueOnce(new Error("upstream"))
      .mockResolvedValueOnce(page([1]));
    const dialog = await open();
    expect(await within(dialog).findByText("Couldn't load repositories. Try again.")).toBeTruthy();
    expect(within(dialog).queryByText(/Install or configure the openTag App/)).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Try again" }));
    expect(await within(dialog).findByText("acme/repo-1")).toBeTruthy();
    expect(discover).toHaveBeenCalledTimes(2);
  });

  it("keeps successful results after refresh failure and replaces them after retry", async () => {
    vi.spyOn(browserApi, "githubRepositories")
      .mockResolvedValueOnce(page([1]))
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(page([2]));
    const dialog = await open();
    await within(dialog).findByText("acme/repo-1");
    fireEvent.click(within(dialog).getByRole("button", { name: "Refresh repositories" }));
    expect(await within(dialog).findByText(/The previous results are still shown/)).toBeTruthy();
    expect(within(dialog).getByText("acme/repo-1")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Try again" }));
    await within(dialog).findByText("acme/repo-2");
    expect(within(dialog).queryByText("acme/repo-1")).toBeNull();
  });

  it("preserves earlier pages after continuation fails and retries from the failed cursor", async () => {
    const discover = vi
      .spyOn(browserApi, "githubRepositories")
      .mockResolvedValueOnce(page([1], { nextCursor: "next" }))
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(page([2]));
    const dialog = await open();
    expect(await within(dialog).findByText("Some repositories couldn't be loaded. Try again.")).toBeTruthy();
    expect(within(dialog).getByText("acme/repo-1")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Try again" }));
    expect(await within(dialog).findByText("acme/repo-2")).toBeTruthy();
    expect(discover.mock.calls.map(([cursor]) => cursor)).toEqual([undefined, "next", "next"]);
  });

  it("shows 100 rows first and scopes filtering to the visible loaded list", async () => {
    const discover = vi
      .spyOn(browserApi, "githubRepositories")
      .mockResolvedValueOnce(
        page(
          Array.from({ length: 100 }, (_, i) => i + 1),
          { nextCursor: "last" },
        ),
      )
      .mockResolvedValueOnce(page([101]));
    const dialog = await open();
    await within(dialog).findByRole("button", { name: "Load more" });
    await waitFor(() => expect(within(dialog).getAllByRole("listitem")).toHaveLength(100));
    fireEvent.change(within(dialog).getByRole("searchbox"), { target: { value: "repo-101" } });
    expect(within(dialog).getByText("No matches in the loaded repositories.")).toBeTruthy();
    expect(within(dialog).queryByText(/No accessible repositories found/)).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Load more" }));
    expect(await within(dialog).findByText("acme/repo-101")).toBeTruthy();
    expect(discover).toHaveBeenCalledTimes(2);
  });

  it("aborts on closure, ignores late results, and rereads on reopening", async () => {
    let resolve: (value: GitHubRepositoryDiscoveryPage) => void = () => undefined;
    let signal: AbortSignal | undefined;
    const discover = vi
      .spyOn(browserApi, "githubRepositories")
      .mockImplementationOnce((_cursor, active) => {
        signal = active;
        return new Promise((done) => {
          resolve = done;
        });
      })
      .mockResolvedValueOnce(page([2]));
    const dialog = await open();
    fireEvent.click(within(dialog).getByRole("button", { name: "Close repository list" }));
    await waitFor(() => expect(signal?.aborted).toBe(true));
    resolve(page([1]));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    const trigger = screen.getByRole("button", { name: "View repositories" });
    expect(document.activeElement).toBe(trigger);
    fireEvent.click(trigger);
    expect(await screen.findByText("acme/repo-2")).toBeTruthy();
    expect(screen.queryByText("acme/repo-1")).toBeNull();
    expect(discover).toHaveBeenCalledTimes(2);
  });

  it("refreshes once after leaving for GitHub and returning to an open viewer", async () => {
    vi.spyOn(document, "hasFocus").mockReturnValue(true);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    const discover = vi
      .spyOn(browserApi, "githubRepositories")
      .mockResolvedValueOnce(page([1]))
      .mockResolvedValueOnce(page([2]));
    const dialog = await open();
    await within(dialog).findByText("acme/repo-1");
    const configure = within(dialog).getByRole("link", { name: "Configure on GitHub" });
    configure.addEventListener("click", (event) => event.preventDefault());
    fireEvent.click(configure);
    fireEvent.focus(window);
    expect(discover).toHaveBeenCalledTimes(1);
    fireEvent.blur(window);
    fireEvent.focus(window);
    await within(dialog).findByText("acme/repo-2");
    fireEvent.focus(window);
    fireEvent(document, new Event("visibilitychange"));
    expect(discover).toHaveBeenCalledTimes(2);
  });

  it.each(["suspended", "truncated"] as const)(
    "does not present %s discovery as a complete empty list",
    async (reason) => {
      vi.spyOn(browserApi, "githubRepositories").mockResolvedValue(
        page([], {
          installations: [{ ...installation, suspended: reason === "suspended" }],
          installationsTruncated: reason === "truncated",
        }),
      );
      const dialog = await open();
      expect(
        await within(dialog).findByText(
          reason === "suspended" ? /Some openTag App installations are suspended/ : /The repository list is incomplete/,
        ),
      ).toBeTruthy();
      expect(within(dialog).queryByText(/No accessible repositories found/)).toBeNull();
    },
  );
});
