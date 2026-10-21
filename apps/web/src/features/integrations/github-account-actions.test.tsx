import type { GitHubIntegrationOverview } from "@opentag/shared/browser";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { browserApi } from "../../api.js";
import { GitHubIntegrationSettings } from "../account/github-integration-settings.js";

const empty: GitHubIntegrationOverview = {
  availability: { available: true, githubHost: "github.com", appId: "871235" },
  connection: null,
};
afterEach(() => vi.restoreAllMocks());

describe("Account GitHub action lifecycle", () => {
  it("restores lost focus to the result after a successful initial-load retry", async () => {
    vi.spyOn(browserApi, "githubIntegration")
      .mockRejectedValueOnce(new Error("Overview unavailable"))
      .mockResolvedValue(empty);
    render(<GitHubIntegrationSettings />);
    const retry = await screen.findByRole("button", { name: "Try again" });
    retry.focus();
    fireEvent.click(retry);
    await screen.findByRole("button", { name: "Authorize GitHub account" });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("status")));
  });

  it("does not steal focus from a user who moved while a retry was pending", async () => {
    let complete!: (value: GitHubIntegrationOverview) => void;
    vi.spyOn(browserApi, "githubIntegration")
      .mockRejectedValueOnce(new Error("Overview unavailable"))
      .mockReturnValueOnce(
        new Promise((resolve) => {
          complete = resolve;
        }),
      );
    render(
      <>
        <GitHubIntegrationSettings />
        <button type="button">Other control</button>
      </>,
    );
    const retry = await screen.findByRole("button", { name: "Try again" });
    retry.focus();
    fireEvent.click(retry);
    screen.getByRole("button", { name: "Other control" }).focus();
    await act(async () => complete(empty));
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Other control" }));
  });

  it("fences duplicate authorization and checks the latest draft again before navigation", async () => {
    vi.spyOn(browserApi, "githubIntegration").mockResolvedValue(empty);
    let complete!: () => void;
    const start = vi.spyOn(browserApi, "startGitHubAuthorization").mockReturnValue(
      new Promise((resolve) => {
        complete = () =>
          resolve({
            connectionId: "id",
            authorizationUrl: "https://github.com/login/oauth/authorize",
            expiresAt: "2027-01-01T00:00:00Z",
          });
      }),
    );
    const guard = vi
      .fn()
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw new Error("New edit cannot be retained");
      });
    render(<GitHubIntegrationSettings beforeAuthorize={guard} />);
    const authorize = await screen.findByRole("button", { name: "Authorize GitHub account" });
    fireEvent.click(authorize);
    fireEvent.click(authorize);
    expect(start).toHaveBeenCalledTimes(1);
    await act(async () => complete());
    expect(await screen.findByText("New edit cannot be retained")).toBeTruthy();
    expect(guard).toHaveBeenCalledTimes(2);
    expect((authorize as HTMLButtonElement).disabled).toBe(false);
  });
});
