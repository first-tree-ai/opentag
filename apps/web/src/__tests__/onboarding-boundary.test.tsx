import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../app.js";
import {
  agentCreationPosts,
  agentId,
  agentListItem,
  agentSummary,
  installApi,
  json,
  resetWebAppState,
  secondAgentId,
  secondAgentListItem,
} from "./support/app-fixtures.js";

const missingAgentId = "00000000-0000-4000-8000-000000000099";
const observedAt = "2026-08-20T00:00:00.000Z";

function setupSnapshot(targetAgentId: string) {
  const summary =
    targetAgentId === secondAgentId
      ? { ...agentSummary, id: secondAgentId, name: "helper", displayName: "Helper" }
      : agentSummary;
  if (targetAgentId !== agentId && targetAgentId !== secondAgentId) return undefined;
  return {
    agent: summary,
    stage: "needs-messaging",
    computer: {
      kind: "bound",
      ...summary.computer,
      connectionStatus: "online",
      lastSeenAt: observedAt,
      observedAt,
    },
    runtime: { kind: "observed", provider: summary.runtimeProvider, status: "ready", observedAt },
    messaging: { kind: "not-configured" },
    blockers: [{ code: "messaging-not-configured" }],
    actions: [
      { kind: "start-messaging", provider: "feishu" },
      { kind: "start-messaging", provider: "slack" },
    ],
    observedAt,
  };
}

function installOnboardingApi(
  options?: Parameters<typeof installApi>[0],
  resolveSetup: (targetAgentId: string) => ReturnType<typeof setupSnapshot> = setupSnapshot,
) {
  installApi(options);
  const fallback = vi.mocked(fetch).getMockImplementation();
  if (!fallback) throw new Error("installApi did not install fetch");
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    const path = String(input);
    const match = /^\/api\/v1\/agents\/([^/]+)\/setup$/.exec(path);
    if (match && init?.method === undefined) {
      const snapshot = resolveSetup(match[1] ?? "");
      return snapshot
        ? json(snapshot)
        : json({ error: { code: "RESOURCE_NOT_FOUND", category: "deterministic", message: "Not found" } }, 404);
    }
    return fallback(input, init);
  });
}

function agentListReads() {
  return vi.mocked(fetch).mock.calls.filter(([path, init]) => path === "/api/v1/agents" && init?.method === undefined);
}

describe("Onboarding exact-target route boundary", () => {
  beforeEach(resetWebAppState);

  it("renders the creation flow without creating anything when the Account has no Agent", async () => {
    installOnboardingApi({ emptyAgents: true, setupCompletedAt: null });
    window.history.replaceState({}, "", "/onboarding");
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Where should your agent run?" })).toBeTruthy();
    expect(window.location.pathname).toBe("/onboarding");
    expect(window.location.search).not.toContain("agentId=");
    // Zero targets means the reader creates deliberately — never an automatic POST from a visit.
    expect(agentCreationPosts()).toHaveLength(0);
  });

  it("does not re-resolve or mutate a target after the route boundary resolved zero Agents", async () => {
    installOnboardingApi({ emptyAgents: true, setupCompletedAt: null });
    const fallback = vi.mocked(fetch).getMockImplementation();
    if (!fallback) throw new Error("installOnboardingApi did not install fetch");
    let listReads = 0;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input) === "/api/v1/agents" && init?.method === undefined) {
        listReads += 1;
        return listReads === 1 ? json({ agents: [] }) : json({ agents: [agentListItem, secondAgentListItem] });
      }
      return fallback(input, init);
    });
    window.history.replaceState({}, "", "/onboarding");
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Where should your agent run?" })).toBeTruthy();
    await waitFor(() => expect(listReads).toBe(1));
    expect(window.location.search).not.toContain("agentId=");
    expect(agentCreationPosts()).toHaveLength(0);
    expect(
      vi
        .mocked(fetch)
        .mock.calls.filter(([path, init]) => String(path).endsWith("/computer/rebind") && init?.method === "POST"),
    ).toHaveLength(0);
  });

  it("redirects an un-targeted visit to the canonical exact URL when the Account has one active Agent", async () => {
    installOnboardingApi({ setupCompletedAt: null });
    window.history.replaceState({}, "", "/onboarding");
    render(<App />);

    await waitFor(() => expect(window.location.search).toContain(`agentId=${agentId}`));
    expect(window.location.pathname).toBe("/onboarding");
    expect(await screen.findByRole("heading", { name: "Set up Reviewer" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Connect your messaging app" })).toBeTruthy();
    const completions = vi
      .mocked(fetch)
      .mock.calls.filter(([path, init]) => path === "/api/v1/me/setup/complete" && init?.method === "POST");
    expect(completions).toHaveLength(1);
    expect(completions[0]?.[1]?.body).toBe(JSON.stringify({ agentId }));
  });

  it("opens the normal application once the exact Agent snapshot is ready", async () => {
    const bindingId = "7ec801ba-cb88-4b1d-8be8-5eb9eb9de06e";
    installOnboardingApi({ setupCompletedAt: null }, (targetAgentId) => {
      const base = setupSnapshot(targetAgentId);
      return base
        ? {
            ...base,
            stage: "ready",
            messaging: { kind: "ready", provider: "slack", bindingId, credentialGeneration: 1 },
            blockers: [],
            actions: [
              { kind: "reauthorize-messaging", provider: "slack", bindingId, credentialGeneration: 1 },
              { kind: "unbind-messaging", provider: "slack", bindingId },
            ],
          }
        : undefined;
    });
    window.history.replaceState({}, "", `/onboarding?agentId=${agentId}`);
    render(<App />);

    await waitFor(() => expect(window.location.pathname).toBe("/agents"));
    expect(await screen.findByRole("heading", { name: "Agents" })).toBeTruthy();
  });

  it("surfaces and then removes a Slack callback error on the canonical setup URL", async () => {
    installOnboardingApi({ setupCompletedAt: null });
    window.history.replaceState({}, "", `/onboarding?agentId=${agentId}&slack_oauth_error=SLACK_UPSTREAM_UNAVAILABLE`);
    render(<App />);

    expect(await screen.findByText("Slack is unavailable right now. Check the connection and try again.")).toBeTruthy();
    await waitFor(() => expect(window.location.search).toBe(`?agentId=${agentId}`));
    // Cleaning the one-shot callback parameters must not erase the feedback the reader needs.
    expect(screen.getByText("Slack is unavailable right now. Check the connection and try again.")).toBeTruthy();
  });

  it("asks for an explicit choice when the Account has several active Agents", async () => {
    installOnboardingApi({ agentList: [agentListItem, secondAgentListItem], setupCompletedAt: null });
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
    expect(await screen.findByRole("heading", { name: "Set up Helper" })).toBeTruthy();
  });

  it("fails closed on a malformed exact id without reading or listing anything", async () => {
    installOnboardingApi({ setupCompletedAt: null });
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
    installOnboardingApi({ setupCompletedAt: null });
    window.history.replaceState({}, "", `/onboarding?agentId=${missingAgentId}`);
    render(<App />);

    expect(await screen.findByRole("heading", { name: "This agent cannot be set up" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Choose an agent to set up" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Reviewer" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Where should your agent run?" })).toBeNull();
    expect(agentCreationPosts()).toHaveLength(0);
  });

  it("fails closed on an inactive exact id even when the Account owns it", async () => {
    installOnboardingApi({ initialStatus: "suspended", setupCompletedAt: null });
    window.history.replaceState({}, "", `/onboarding?agentId=${agentId}`);
    render(<App />);

    expect(await screen.findByRole("heading", { name: "This agent cannot be set up" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Where should your agent run?" })).toBeNull();
    expect(agentCreationPosts()).toHaveLength(0);
  });

  it("treats an Account with no active Agent as having zero targets", async () => {
    installOnboardingApi({ initialStatus: "suspended", setupCompletedAt: null });
    window.history.replaceState({}, "", "/onboarding");
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Where should your agent run?" })).toBeTruthy();
    expect(window.location.search).not.toContain("agentId=");
  });

  it("fails closed on a foreign exact id for a completed Account instead of entering the app", async () => {
    installOnboardingApi();
    window.history.replaceState({}, "", `/onboarding?agentId=${missingAgentId}`);
    render(<App />);

    expect(await screen.findByRole("heading", { name: "This agent cannot be set up" })).toBeTruthy();
    expect(window.location.pathname).toBe("/onboarding");
    expect(screen.queryByRole("heading", { name: "Agents" })).toBeNull();
  });

  it("retries Account admission explicitly without starting Agent setup before access opens", async () => {
    installOnboardingApi({ setupCompletedAt: null });
    const fallback = vi.mocked(fetch).getMockImplementation();
    if (!fallback) throw new Error("installOnboardingApi did not install fetch");
    let admissionUnavailable = true;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input) === "/api/v1/me/setup/complete" && init?.method === "POST" && admissionUnavailable) {
        return json(
          { error: { code: "SERVICE_UNAVAILABLE", category: "transient", message: "Admission unavailable" } },
          503,
        );
      }
      return fallback(input, init);
    });
    window.history.replaceState({}, "", `/onboarding?agentId=${agentId}`);
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Could not open app access" })).toBeTruthy();
    expect(
      vi.mocked(fetch).mock.calls.filter(([path, init]) => path === `/api/v1/agents/${agentId}/setup` && !init?.method),
    ).toHaveLength(0);

    admissionUnavailable = false;
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByRole("heading", { name: "Set up Reviewer" })).toBeTruthy();
    expect(
      vi
        .mocked(fetch)
        .mock.calls.filter(([path, init]) => path === "/api/v1/me/setup/complete" && init?.method === "POST"),
    ).toHaveLength(2);
  });

  it("re-resolves the exact target after a deterministic admission refusal", async () => {
    installOnboardingApi({ setupCompletedAt: null });
    const fallback = vi.mocked(fetch).getMockImplementation();
    if (!fallback) throw new Error("installOnboardingApi did not install fetch");
    let targetInvalidated = false;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input) === "/api/v1/me/setup/complete" && init?.method === "POST") {
        targetInvalidated = true;
        return json(
          {
            error: {
              code: "ACCOUNT_SETUP_AGENT_NOT_FOUND",
              category: "deterministic",
              message: "Agent not found",
            },
          },
          404,
        );
      }
      if (String(input) === "/api/v1/agents" && init?.method === undefined && targetInvalidated) {
        return json({ agents: [] });
      }
      return fallback(input, init);
    });
    window.history.replaceState({}, "", `/onboarding?agentId=${agentId}`);
    render(<App />);

    expect(await screen.findByRole("heading", { name: "This agent cannot be set up" })).toBeTruthy();
    expect(agentListReads()).toHaveLength(2);
    expect(screen.queryByRole("heading", { name: "Could not open app access" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("keeps exact onboarding accessible for a completed Account without adopting again", async () => {
    installOnboardingApi();
    window.history.replaceState({}, "", `/onboarding?agentId=${agentId}`);
    render(<App />);

    // The flow renders in place — no bounce to /agents — and a mere visit reports no completion.
    expect(await screen.findByRole("heading", { name: "Set up Reviewer" })).toBeTruthy();
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
    installOnboardingApi({ emptyAgents: true });
    window.history.replaceState({}, "", "/onboarding");
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Agents" })).toBeTruthy();
    expect(window.location.pathname).toBe("/agents");
  });

  it("fails closed when the Agent list cannot be read, and recovers only through an explicit retry", async () => {
    let listStatus: number | undefined = 503;
    installOnboardingApi({ agentListStatus: () => listStatus, setupCompletedAt: null });
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
    expect(await screen.findByRole("heading", { name: "Set up Reviewer" })).toBeTruthy();
  });
});
