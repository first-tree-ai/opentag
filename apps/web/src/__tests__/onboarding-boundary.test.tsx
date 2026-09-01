import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../app.js";
import {
  agentCreationPosts,
  agentId,
  agentListItem,
  installApi,
  resetWebAppState,
  secondAgentId,
  secondAgentListItem,
} from "./support/app-fixtures.js";

const missingAgentId = "00000000-0000-4000-8000-000000000099";

function agentListReads() {
  return vi.mocked(fetch).mock.calls.filter(([path, init]) => path === "/api/v1/agents" && init?.method === undefined);
}

describe("Onboarding exact-target route boundary", () => {
  beforeEach(resetWebAppState);

  it("renders the creation flow without creating anything when the Account has no Agent", async () => {
    installApi({ emptyAgents: true, setupCompletedAt: null });
    window.history.replaceState({}, "", "/onboarding");
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Where should your agent run?" })).toBeTruthy();
    expect(window.location.pathname).toBe("/onboarding");
    expect(window.location.search).not.toContain("agentId=");
    // Zero targets means the reader creates deliberately — never an automatic POST from a visit.
    expect(agentCreationPosts()).toHaveLength(0);
  });

  it("redirects an un-targeted visit to the canonical exact URL when the Account has one active Agent", async () => {
    installApi({ setupCompletedAt: null });
    window.history.replaceState({}, "", "/onboarding");
    render(<App />);

    await waitFor(() => expect(window.location.search).toContain(`agentId=${agentId}`));
    expect(window.location.pathname).toBe("/onboarding");
    expect(await screen.findByRole("heading", { name: "Where should your agent run?" })).toBeTruthy();
  });

  it("asks for an explicit choice when the Account has several active Agents", async () => {
    installApi({ agentList: [agentListItem, secondAgentListItem], setupCompletedAt: null });
    window.history.replaceState({}, "", "/onboarding");
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Choose an agent to set up" })).toBeTruthy();
    // Nothing is picked for the reader: no canonical redirect and no creation happens on its own.
    expect(window.location.search).not.toContain("agentId=");
    expect(agentCreationPosts()).toHaveLength(0);
    expect(screen.getByRole("link", { name: "Reviewer" })).toBeTruthy();

    fireEvent.click(screen.getByRole("link", { name: "Helper" }));

    await waitFor(() => expect(window.location.search).toContain(`agentId=${secondAgentId}`));
    expect(window.location.pathname).toBe("/onboarding");
    expect(screen.queryByRole("heading", { name: "Choose an agent to set up" })).toBeNull();
  });

  it("fails closed on a malformed exact id without reading or listing anything", async () => {
    installApi({ setupCompletedAt: null });
    window.history.replaceState({}, "", "/onboarding?agentId=not-a-uuid");
    render(<App />);

    expect(await screen.findByRole("heading", { name: "This agent cannot be set up" })).toBeTruthy();
    expect(screen.getByRole("alert")).toBeTruthy();
    // A malformed id can never name an Agent, so the Server is never asked and no fallback appears.
    expect(agentListReads()).toHaveLength(0);
    expect(screen.queryByRole("heading", { name: "Where should your agent run?" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Choose an agent to set up" })).toBeNull();
    expect(agentCreationPosts()).toHaveLength(0);
  });

  it("fails closed on a missing exact id and never falls back to the list", async () => {
    installApi({ setupCompletedAt: null });
    window.history.replaceState({}, "", `/onboarding?agentId=${missingAgentId}`);
    render(<App />);

    expect(await screen.findByRole("heading", { name: "This agent cannot be set up" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Choose an agent to set up" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Reviewer" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Where should your agent run?" })).toBeNull();
    expect(agentCreationPosts()).toHaveLength(0);
  });

  it("fails closed on an inactive exact id even when the Account owns it", async () => {
    installApi({ initialStatus: "suspended", setupCompletedAt: null });
    window.history.replaceState({}, "", `/onboarding?agentId=${agentId}`);
    render(<App />);

    expect(await screen.findByRole("heading", { name: "This agent cannot be set up" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Where should your agent run?" })).toBeNull();
    expect(agentCreationPosts()).toHaveLength(0);
  });

  it("treats an Account with no active Agent as having zero targets", async () => {
    installApi({ initialStatus: "suspended", setupCompletedAt: null });
    window.history.replaceState({}, "", "/onboarding");
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Where should your agent run?" })).toBeTruthy();
    expect(window.location.search).not.toContain("agentId=");
  });

  it("fails closed on a foreign exact id for a completed Account instead of entering the app", async () => {
    installApi();
    window.history.replaceState({}, "", `/onboarding?agentId=${missingAgentId}`);
    render(<App />);

    expect(await screen.findByRole("heading", { name: "This agent cannot be set up" })).toBeTruthy();
    expect(window.location.pathname).toBe("/onboarding");
    expect(screen.queryByRole("heading", { name: "Agents" })).toBeNull();
  });

  it("keeps exact onboarding accessible for a completed Account without adopting again", async () => {
    installApi();
    window.history.replaceState({}, "", `/onboarding?agentId=${agentId}`);
    render(<App />);

    // The flow renders in place — no bounce to /agents — and a mere visit reports no completion.
    expect(await screen.findByText("OpenTag")).toBeTruthy();
    expect(window.location.pathname).toBe("/onboarding");
    expect(window.location.search).toContain(`agentId=${agentId}`);
    expect(screen.queryByRole("heading", { name: "Agents" })).toBeNull();
    expect(
      vi
        .mocked(fetch)
        .mock.calls.some(([path, init]) => path === "/api/v1/me/setup/complete" && init?.method === "POST"),
    ).toBe(false);
  });

  it("sends a completed Account with no target and no Agents to the application", async () => {
    installApi({ emptyAgents: true });
    window.history.replaceState({}, "", "/onboarding");
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Agents" })).toBeTruthy();
    expect(window.location.pathname).toBe("/agents");
  });

  it("fails closed when the Agent list cannot be read, and recovers only through an explicit retry", async () => {
    let listStatus: number | undefined = 503;
    installApi({ agentListStatus: () => listStatus, setupCompletedAt: null });
    window.history.replaceState({}, "", "/onboarding");
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Could not read your agents" })).toBeTruthy();
    expect(screen.getByRole("alert")).toBeTruthy();
    // A failed read is not "you must be new": no creation form and no substitute list appears.
    expect(screen.queryByRole("heading", { name: "Where should your agent run?" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Choose an agent to set up" })).toBeNull();
    expect(agentCreationPosts()).toHaveLength(0);

    listStatus = undefined;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    await waitFor(() => expect(window.location.search).toContain(`agentId=${agentId}`));
    expect(await screen.findByRole("heading", { name: "Where should your agent run?" })).toBeTruthy();
  });
});
