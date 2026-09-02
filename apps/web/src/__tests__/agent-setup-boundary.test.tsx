import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../app.js";
import {
  agentCreationPosts,
  agentId,
  agentListItem,
  agentSummary,
  creationIntentKey,
  installApi,
  json,
  resetWebAppState,
  secondAgentId,
  secondAgentListItem,
  storeCreationIntent,
} from "./support/app-fixtures.js";

const missingAgentId = "00000000-0000-4000-8000-000000000099";
const savedCreationIntentId = "10000000-0000-4000-8000-000000000001";
const observedAt = "2026-08-20T00:00:00.000Z";

const savedCreationRequest = {
  displayName: "recovered-agent",
  name: "recovered-agent",
  runtimeProvider: "codex",
};

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

function installAgentSetupApi(options?: Parameters<typeof installApi>[0]) {
  installApi(options);
  const fallback = vi.mocked(fetch).getMockImplementation();
  if (!fallback) throw new Error("installApi did not install fetch");
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    const path = String(input);
    const match = /^\/api\/v1\/agents\/([^/]+)\/setup$/.exec(path);
    if (match && init?.method === undefined) {
      const snapshot = setupSnapshot(match[1] ?? "");
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

function installCreationIntentResult(response: Response) {
  const fallback = vi.mocked(fetch).getMockImplementation();
  if (!fallback) throw new Error("installAgentSetupApi did not install fetch");
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    if (input === `/api/v1/agents/creation-intents/${savedCreationIntentId}` && init?.method === undefined) {
      return response;
    }
    return fallback(input, init);
  });
}

function storeSavedCreationIntent() {
  storeCreationIntent({ creationIntentId: savedCreationIntentId, request: savedCreationRequest });
}

describe("Agent Setup route boundary", () => {
  beforeEach(resetWebAppState);

  it("renders the creation flow without creating anything when the Account has no Agent", async () => {
    installAgentSetupApi({ emptyAgents: true, setupCompletedAt: null });
    window.history.replaceState({}, "", "/agents/setup");
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Where should your agent run?" })).toBeTruthy();
    expect(window.location.pathname).toBe("/agents/setup");
    expect(window.location.search).not.toContain("agentId=");
    // Zero targets means the reader creates deliberately — never an automatic POST from a visit.
    expect(agentCreationPosts()).toHaveLength(0);
  });

  it("starts explicit creation without resolving existing Agents, then canonicalizes to the created Agent", async () => {
    installAgentSetupApi();
    window.history.replaceState({}, "", "/agents/setup?action=create");
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /Local computer/ }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(screen.getByRole("button", { name: /Codex/ }));
    fireEvent.click(screen.getByRole("button", { name: "Create Agent" }));

    await waitFor(() => expect(window.location.search).toContain(`agentId=${agentId}`));
    expect(window.location.pathname).toBe("/agents/setup");
    const posts = agentCreationPosts();
    expect(posts).toHaveLength(1);
    const body = JSON.parse(String(posts[0]?.[1]?.body)) as Record<string, unknown>;
    expect(body.runtimeProvider).toBe("codex");
    expect(body.creationIntentId).toEqual(expect.any(String));
    expect(body).not.toHaveProperty("computerId");
  });

  it("fails closed when action=create conflicts with an exact target", async () => {
    installAgentSetupApi();
    window.history.replaceState({}, "", `/agents/setup?action=create&agentId=${agentId}`);
    render(<App />);

    expect(await screen.findByRole("heading", { name: "This agent cannot be set up" })).toBeTruthy();
    expect(agentListReads()).toHaveLength(0);
    expect(agentCreationPosts()).toHaveLength(0);
  });

  it("keeps an uncertain creation explicit and retries only after the reader asks", async () => {
    installAgentSetupApi();
    const fallback = vi.mocked(fetch).getMockImplementation();
    if (!fallback) throw new Error("installAgentSetupApi did not install fetch");
    let firstCreate = true;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (input === "/api/v1/agents" && init?.method === "POST" && firstCreate) {
        firstCreate = false;
        throw new TypeError("Connection closed before the result arrived");
      }
      return fallback(input, init);
    });
    window.history.replaceState({}, "", "/agents/setup?action=create");
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /Local computer/ }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(screen.getByRole("button", { name: /Codex/ }));
    fireEvent.click(screen.getByRole("button", { name: "Create Agent" }));

    expect(await screen.findByRole("heading", { name: "Creation attempt interrupted" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Check result" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Discard and start over" })).toBeTruthy();
    expect(window.location.search).toBe("?action=create");
    fireEvent.click(screen.getByRole("button", { name: "Retry creation" }));

    await waitFor(() => expect(window.location.search).toContain(`agentId=${agentId}`));
    expect(agentCreationPosts()).toHaveLength(2);
  });

  it("recovers a saved creation result at mount and canonicalizes to the exact Agent", async () => {
    installAgentSetupApi({ setupCompletedAt: null });
    installCreationIntentResult(json({ kind: "found", agentId }));
    storeSavedCreationIntent();
    window.history.replaceState({}, "", "/agents/setup?action=create");
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Creation attempt interrupted" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry creation" }).hasAttribute("disabled")).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Check result" }));

    await waitFor(() => expect(window.location.search).toBe(`?agentId=${agentId}`));
    expect(window.localStorage.getItem(creationIntentKey)).toBeNull();
    expect(await screen.findByRole("heading", { name: "Set up Reviewer" })).toBeTruthy();
  });

  it("keeps a saved creation intent when the exact result is absent or cannot be checked", async () => {
    installAgentSetupApi({ emptyAgents: true, setupCompletedAt: null });
    installCreationIntentResult(json({ kind: "not-found" }));
    storeSavedCreationIntent();
    window.history.replaceState({}, "", "/agents/setup?action=create");
    const view = render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Check result" }));
    expect(await screen.findByText(/No active Agent named @recovered-agent exists yet/)).toBeTruthy();
    expect(window.localStorage.getItem(creationIntentKey)).not.toBeNull();
    expect(window.location.search).toBe("?action=create");

    view.unmount();
    installAgentSetupApi({ emptyAgents: true, setupCompletedAt: null });
    installCreationIntentResult(
      json(
        {
          error: {
            code: "SERVICE_UNAVAILABLE",
            category: "transient",
            message: "Creation status unavailable",
          },
        },
        503,
      ),
    );
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Check result" }));

    expect(await screen.findByText("Creation status unavailable")).toBeTruthy();
    expect(window.localStorage.getItem(creationIntentKey)).not.toBeNull();
    expect(window.location.search).toBe("?action=create");
  });

  it("discards a saved creation intent and resets the thin creation flow", async () => {
    installAgentSetupApi({ emptyAgents: true, setupCompletedAt: null });
    storeSavedCreationIntent();
    window.history.replaceState({}, "", "/agents/setup?action=create");
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /Local computer/ }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect((screen.getByLabelText("Agent name") as HTMLInputElement).value).toBe("recovered-agent");
    fireEvent.click(screen.getByRole("button", { name: "Discard and start over" }));

    await waitFor(() => expect(screen.queryByRole("heading", { name: "Creation attempt interrupted" })).toBeNull());
    expect(window.localStorage.getItem(creationIntentKey)).toBeNull();
    expect(screen.getByRole("heading", { name: "Where should your agent run?" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Local computer/ }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect((screen.getByLabelText("Agent name") as HTMLInputElement).value).toBe("opentag");
  });

  it("prunes a superseded v3 creation intent instead of resuming an incompatible request", async () => {
    installAgentSetupApi({ emptyAgents: true, setupCompletedAt: null });
    window.localStorage.setItem(
      creationIntentKey,
      JSON.stringify({
        version: 3,
        accountId: "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e",
        records: [
          {
            version: 3,
            accountId: "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e",
            creationIntentId: savedCreationIntentId,
            request: {
              ...savedCreationRequest,
              computerId: "85fe9af3-d1c6-472b-b78c-8a7ccf512750",
            },
          },
        ],
      }),
    );
    window.history.replaceState({}, "", "/agents/setup?action=create");
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Where should your agent run?" })).toBeTruthy();
    await waitFor(() => expect(window.localStorage.getItem(creationIntentKey)).toBeNull());
    expect(screen.queryByRole("heading", { name: "Creation attempt interrupted" })).toBeNull();
  });

  it("redirects an un-targeted visit to the canonical exact URL when the Account has one active Agent", async () => {
    installAgentSetupApi({ setupCompletedAt: null });
    window.history.replaceState({}, "", "/agents/setup");
    render(<App />);

    await waitFor(() => expect(window.location.search).toContain(`agentId=${agentId}`));
    expect(window.location.pathname).toBe("/agents/setup");
    expect(await screen.findByRole("heading", { name: "Set up Reviewer" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Connect your messaging app" })).toBeTruthy();
    const completions = vi
      .mocked(fetch)
      .mock.calls.filter(([path, init]) => path === "/api/v1/me/setup/complete" && init?.method === "POST");
    expect(completions).toHaveLength(1);
    expect(completions[0]?.[1]?.body).toBe(JSON.stringify({ agentId }));
  });

  it("surfaces and then removes a Slack callback error on the canonical setup URL", async () => {
    installAgentSetupApi({ setupCompletedAt: null });
    window.history.replaceState(
      {},
      "",
      `/agents/setup?agentId=${agentId}&slack_oauth_error=SLACK_UPSTREAM_UNAVAILABLE`,
    );
    render(<App />);

    expect(await screen.findByText("Slack is unavailable right now. Check the connection and try again.")).toBeTruthy();
    await waitFor(() => expect(window.location.search).toBe(`?agentId=${agentId}`));
    expect(screen.getByText("Slack is unavailable right now. Check the connection and try again.")).toBeTruthy();
  });

  it("asks for an explicit choice when the Account has several active Agents", async () => {
    installAgentSetupApi({ agentList: [agentListItem, secondAgentListItem], setupCompletedAt: null });
    window.history.replaceState({}, "", "/agents/setup");
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Choose an agent to set up" })).toBeTruthy();
    // Nothing is picked for the reader: no canonical redirect and no creation happens on its own.
    expect(window.location.search).not.toContain("agentId=");
    expect(agentCreationPosts()).toHaveLength(0);
    expect(screen.getByRole("link", { name: "Reviewer" })).toBeTruthy();

    fireEvent.click(screen.getByRole("link", { name: "Helper" }));

    await waitFor(() => expect(window.location.search).toContain(`agentId=${secondAgentId}`));
    expect(window.location.pathname).toBe("/agents/setup");
    expect(await screen.findByRole("heading", { name: "Set up Helper" })).toBeTruthy();
  });

  it("fails closed on a malformed exact id without reading or listing anything", async () => {
    installAgentSetupApi({ setupCompletedAt: null });
    window.history.replaceState({}, "", "/agents/setup?agentId=not-a-uuid");
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
    installAgentSetupApi({ setupCompletedAt: null });
    window.history.replaceState({}, "", `/agents/setup?agentId=${missingAgentId}`);
    render(<App />);

    expect(await screen.findByRole("heading", { name: "This agent cannot be set up" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Choose an agent to set up" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Reviewer" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Where should your agent run?" })).toBeNull();
    expect(agentCreationPosts()).toHaveLength(0);
  });

  it("fails closed on an inactive exact id even when the Account owns it", async () => {
    installAgentSetupApi({ initialStatus: "suspended", setupCompletedAt: null });
    window.history.replaceState({}, "", `/agents/setup?agentId=${agentId}`);
    render(<App />);

    expect(await screen.findByRole("heading", { name: "This agent cannot be set up" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Where should your agent run?" })).toBeNull();
    expect(agentCreationPosts()).toHaveLength(0);
  });

  it("treats an Account with no active Agent as having zero targets", async () => {
    installAgentSetupApi({ initialStatus: "suspended", setupCompletedAt: null });
    window.history.replaceState({}, "", "/agents/setup");
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Where should your agent run?" })).toBeTruthy();
    expect(window.location.search).not.toContain("agentId=");
  });

  it("fails closed on a foreign exact id for a completed Account instead of entering the app", async () => {
    installAgentSetupApi();
    window.history.replaceState({}, "", `/agents/setup?agentId=${missingAgentId}`);
    render(<App />);

    expect(await screen.findByRole("heading", { name: "This agent cannot be set up" })).toBeTruthy();
    expect(window.location.pathname).toBe("/agents/setup");
    expect(screen.queryByRole("heading", { name: "Agents" })).toBeNull();
  });

  it("retries Account admission explicitly without starting Agent setup before access opens", async () => {
    installAgentSetupApi({ setupCompletedAt: null });
    const fallback = vi.mocked(fetch).getMockImplementation();
    if (!fallback) throw new Error("installAgentSetupApi did not install fetch");
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
    window.history.replaceState({}, "", `/agents/setup?agentId=${agentId}`);
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
    installAgentSetupApi({ setupCompletedAt: null });
    const fallback = vi.mocked(fetch).getMockImplementation();
    if (!fallback) throw new Error("installAgentSetupApi did not install fetch");
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
    window.history.replaceState({}, "", `/agents/setup?agentId=${agentId}`);
    render(<App />);

    expect(await screen.findByRole("heading", { name: "This agent cannot be set up" })).toBeTruthy();
    expect(agentListReads()).toHaveLength(2);
    expect(screen.queryByRole("heading", { name: "Could not open app access" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("keeps exact setup accessible for a completed Account without adopting again", async () => {
    installAgentSetupApi();
    window.history.replaceState({}, "", `/agents/setup?agentId=${agentId}`);
    render(<App />);

    // The flow renders in place — no bounce to /agents — and a mere visit reports no completion.
    expect(await screen.findByRole("heading", { name: "Set up Reviewer" })).toBeTruthy();
    expect(window.location.pathname).toBe("/agents/setup");
    expect(window.location.search).toContain(`agentId=${agentId}`);
    expect(screen.queryByRole("heading", { name: "Agents" })).toBeNull();
    expect(
      vi
        .mocked(fetch)
        .mock.calls.some(([path, init]) => path === "/api/v1/me/setup/complete" && init?.method === "POST"),
    ).toBe(false);
  });

  it("offers creation to a completed Account with no target and no active Agents", async () => {
    installAgentSetupApi({ emptyAgents: true });
    window.history.replaceState({}, "", "/agents/setup");
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Where should your agent run?" })).toBeTruthy();
    expect(window.location.pathname).toBe("/agents/setup");
  });

  it("fails closed when the Agent list cannot be read, and recovers only through an explicit retry", async () => {
    let listStatus: number | undefined = 503;
    installAgentSetupApi({ agentListStatus: () => listStatus, setupCompletedAt: null });
    window.history.replaceState({}, "", "/agents/setup");
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
