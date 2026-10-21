import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../app.js";
import { preserveProfileNavigationDraft } from "../features/account/profile-navigation-draft.js";
import {
  agentId,
  agentListItem,
  installApi,
  json,
  resetWebAppState,
  secondAgentListItem,
} from "./support/app-fixtures.js";

const missingAgentId = "00000000-0000-4000-8000-000000000099";
const profileDraftKey = "opentag.account-profile-navigation-draft";

function logoutCalls() {
  return vi
    .mocked(fetch)
    .mock.calls.filter(([path, init]) => path === "/api/v1/auth/browser/logout" && init?.method === "POST");
}

function region(selector: string): HTMLElement {
  const found = document.querySelector<HTMLElement>(selector);
  if (!found) throw new Error(`${selector} is not on the page`);
  return found;
}

async function signOutFrom(container: HTMLElement, fromMenu = false) {
  if (fromMenu) {
    fireEvent.click(within(container).getByRole("button", { name: "Account menu" }));
    container = await within(container).findByRole("menu");
  }
  preserveProfileNavigationDraft("account", "Ada", "Unsaved name");
  fireEvent.click(within(container).getByRole(fromMenu ? "menuitem" : "button", { name: "Sign out" }));
  expect(await screen.findByRole("heading", { name: "Sign in to openTag" })).toBeTruthy();
  expect(logoutCalls()).toHaveLength(1);
  expect(window.location.pathname).toBe("/login");
  expect(window.sessionStorage.getItem(profileDraftKey)).toBeNull();
}

async function findGate(): Promise<HTMLElement> {
  return waitFor(() => region('[data-ui="account-gate-error"]'));
}

/** An Account that has not finished setup is shown only full-screen pages, so each must offer a way out. */
describe("sign-out from full-screen states of an Account that has not finished setup", () => {
  beforeEach(resetWebAppState);

  it("offers it when the exact target is unavailable", async () => {
    installApi({ setupCompletedAt: null });
    window.history.replaceState({}, "", `/agents/setup?agentId=${missingAgentId}`);
    render(<App />);

    await screen.findByRole("heading", { name: "This agent cannot be set up" });
    await signOutFrom(region('[data-ui="agent-setup-target-unavailable"]'));
  });

  it("offers it when the Agent list cannot be read", async () => {
    installApi({ agentListStatus: () => 503, setupCompletedAt: null });
    window.history.replaceState({}, "", "/agents/setup");
    render(<App />);

    await screen.findByRole("heading", { name: "Could not read your agents" });
    await signOutFrom(region('[data-ui="agent-setup-target-read-failed"]'));
  });

  it("offers it when app access cannot be opened", async () => {
    installApi({ setupCompletedAt: null });
    const fallback = vi.mocked(fetch).getMockImplementation();
    if (!fallback) throw new Error("installApi did not install fetch");
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input) === "/api/v1/me/setup/complete" && init?.method === "POST") {
        return json({ error: { code: "SERVICE_UNAVAILABLE", category: "transient", message: "Unavailable" } }, 503);
      }
      return fallback(input, init);
    });
    window.history.replaceState({}, "", `/agents/setup?agentId=${agentId}`);
    render(<App />);

    await screen.findByRole("heading", { name: "Could not open app access" });
    await signOutFrom(region('[data-ui="agent-setup-target-adoption-failed"]'));
  });

  it("offers it when the reader must choose among several Agents", async () => {
    installApi({ agentList: [agentListItem, secondAgentListItem], setupCompletedAt: null });
    window.history.replaceState({}, "", "/agents/setup");
    render(<App />);

    await screen.findByRole("heading", { name: "Choose an agent to set up" });
    await signOutFrom(region('[data-ui="agent-setup-target-choice"]'));
  });

  it("offers it in the header of the creation flow", async () => {
    installApi({ emptyAgents: true, setupCompletedAt: null });
    window.history.replaceState({}, "", "/agents/setup");
    render(<App />);

    await screen.findByRole("heading", { name: "Where should your agent run?" });
    await signOutFrom(region('[data-ui="agent-create"] header'), true);
  });

  it.each([
    { setupCompletedAt: null, items: ["Sign out"] },
    {
      setupCompletedAt: "2026-08-20T00:00:00.000Z",
      items: ["Computer", "Account", "Internal tools", "Sign out"],
    },
  ])(
    "offers only reachable creation-menu actions with setupCompletedAt=$setupCompletedAt",
    async ({ setupCompletedAt, items }) => {
      installApi({ emptyAgents: true, setupCompletedAt, internalToolsOffered: true });
      window.history.replaceState({}, "", "/agents/setup?action=create");
      render(<App />);

      await screen.findByRole("heading", { name: "Where should your agent run?" });
      const header = region('[data-ui="agent-create"] header');
      fireEvent.click(within(header).getByRole("button", { name: "Account menu" }));
      const menu = await within(header).findByRole("menu");
      await waitFor(() =>
        expect(
          within(menu)
            .getAllByRole("menuitem")
            .map((item) => item.textContent?.trim()),
        ).toEqual(items),
      );
    },
  );

  it("offers it in the header of the exact setup page, next to the Account name", async () => {
    installApi({ setupCompletedAt: null });
    window.history.replaceState({}, "", `/agents/setup?agentId=${agentId}`);
    render(<App />);

    await screen.findByRole("heading", { name: "Prepare this computer" });
    const header = region('[data-ui="agent-setup"] header');
    expect(within(header).getByText("Ada")).toBeTruthy();
    await signOutFrom(header, true);
  });

  it("keeps the visitor on the page and says why when the Server refuses the logout", async () => {
    installApi({ logoutFails: true, setupCompletedAt: null });
    window.history.replaceState({}, "", `/agents/setup?agentId=${missingAgentId}`);
    render(<App />);

    await screen.findByRole("heading", { name: "This agent cannot be set up" });
    const page = region('[data-ui="agent-setup-target-unavailable"]');
    preserveProfileNavigationDraft("account", "Ada", "Unsaved name");
    fireEvent.click(within(page).getByRole("button", { name: "Sign out" }));

    // The page already carries its own alert, so wait for the one the failed sign-out adds.
    await waitFor(() => expect(within(page).getAllByRole("alert")).toHaveLength(2));
    expect(window.location.pathname).toBe("/agents/setup");
    // The failure is retryable: the control is enabled again once the attempt has ended.
    await waitFor(() =>
      expect((within(page).getByRole("button", { name: "Sign out" }) as HTMLButtonElement).disabled).toBe(false),
    );
    expect(logoutCalls()).toHaveLength(1);
    expect(window.sessionStorage.getItem(profileDraftKey)).toContain("Unsaved name");
  });
});

describe("the Account gate when the Account cannot be read", () => {
  beforeEach(resetWebAppState);

  it("offers retry and sign-out instead of a dead end", async () => {
    let status: number | undefined = 503;
    installApi({ meStatus: () => status });
    window.history.replaceState({}, "", "/agents");
    render(<App />);

    const gate = await findGate();
    expect(within(gate).getByRole("button", { name: "Sign out" })).toBeTruthy();

    status = undefined;
    fireEvent.click(within(gate).getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(document.querySelector('[data-ui="account-gate-error"]')).toBeNull());
  });

  it("signs out from the gate without an Account session", async () => {
    installApi({ meStatus: () => 503 });
    window.history.replaceState({}, "", "/agents");
    render(<App />);

    const gate = await findGate();
    preserveProfileNavigationDraft("account", "Ada", "Unsaved name");
    fireEvent.click(within(gate).getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(window.location.pathname).toBe("/login"));
    expect(logoutCalls()).toHaveLength(1);
    expect(window.sessionStorage.getItem(profileDraftKey)).toBeNull();
  });

  it("reports a refused logout on the gate and stays", async () => {
    installApi({ logoutFails: true, meStatus: () => 503 });
    window.history.replaceState({}, "", "/agents");
    render(<App />);

    const gate = await findGate();
    fireEvent.click(within(gate).getByRole("button", { name: "Sign out" }));
    await waitFor(() => expect(within(gate).getAllByRole("alert").length).toBeGreaterThan(1));
    expect(window.location.pathname).toBe("/agents");
  });
});
