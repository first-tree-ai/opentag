import {
  AGENT_SETUP_REQUIRED_IM_CLI_PROVIDERS,
  type AgentSetupComputerState,
  type AgentSetupMessagingState,
  type AgentSetupRuntimeState,
  projectAgentSetupComponents,
} from "@opentag/shared/browser";
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
  const identity = summary.computer;
  if (!identity) throw new Error("A setup snapshot requires the exact Agent's Computer identity");
  const computer: AgentSetupComputerState = {
    kind: "bound",
    ...identity,
    connectionStatus: "online",
    imCliReadiness: [
      { provider: "feishu", status: "ready", observedAt },
      { provider: "slack", status: "ready", observedAt },
    ],
    lastSeenAt: observedAt,
    observedAt,
  };
  const runtime: AgentSetupRuntimeState = {
    kind: "observed",
    provider: summary.runtimeProvider,
    status: "ready",
    observedAt,
  };
  const messaging: AgentSetupMessagingState = { kind: "not-configured" };
  const requiredImCliProviders = [...AGENT_SETUP_REQUIRED_IM_CLI_PROVIDERS];
  return {
    agent: summary,
    stage: "needs-messaging",
    computer,
    runtime,
    messaging,
    requiredImCliProviders,
    components: projectAgentSetupComponents({ computer, runtime, messaging, requiredImCliProviders }),
    blockers: [{ code: "messaging-not-configured" }],
    actions: [
      { kind: "start-messaging", provider: "slack" },
      { kind: "start-messaging", provider: "feishu" },
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

describe("Agent Setup route boundary", () => {
  beforeEach(resetWebAppState);

  it("renders the creation flow without creating anything when the Account has no Agent", async () => {
    installAgentSetupApi({ emptyAgents: true, setupCompletedAt: null });
    const fallback = vi.mocked(fetch).getMockImplementation();
    if (!fallback) throw new Error("installAgentSetupApi did not install fetch");
    let listReads = 0;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (input === "/api/v1/agents" && init?.method === undefined) {
        listReads += 1;
        return listReads === 1 ? json({ agents: [] }) : json({ agents: [agentListItem, secondAgentListItem] });
      }
      return fallback(input, init);
    });
    window.history.replaceState({}, "", "/agents/setup");
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Where should your agent run?" })).toBeTruthy();
    await waitFor(() => expect(listReads).toBe(1));
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
    expect(body).not.toHaveProperty("creationIntentId");
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

  it("reports a creation whose answer never arrived and leaves the reader on the form", async () => {
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

    /*
     * The failure is stated and nothing is saved. Whether that request reached the Server is
     * answered by the Agent list, which this Account passes through on every visit — so pressing
     * Create again is a decision the reader makes there, with the Agents in front of them, rather
     * than one this page reconstructs from a record of its own.
     */
    expect(await screen.findByText("Connection closed before the result arrived")).toBeTruthy();
    expect(window.location.search).toBe("?action=create");
    expect(screen.getByRole("button", { name: "Create Agent" }).hasAttribute("disabled")).toBe(false);
    // Nothing was refused by name, so there is no Agent to offer and nothing was saved either.
    expect(screen.queryByRole("link", { name: /^Open @/ })).toBeNull();
    expect(window.localStorage.length).toBe(0);

    fireEvent.click(screen.getByRole("button", { name: "Create Agent" }));
    await waitFor(() => expect(window.location.search).toContain(`agentId=${agentId}`));
    expect(agentCreationPosts()).toHaveLength(2);
  });

  it("names the Agent a refused name already belongs to, and offers it", async () => {
    /*
     * The refusal covers two situations the Server cannot tell apart: a name the reader has already
     * used, and a request that reached the Server without its answer reaching the browser. Naming
     * the Agent answers both — it is either the one they meant, or the one their own press made —
     * and on this route, where an Account with no proved Agent has no other exit, it is the way out.
     */
    installAgentSetupApi({ emptyAgents: true, setupCompletedAt: null });
    const fallback = vi.mocked(fetch).getMockImplementation();
    if (!fallback) throw new Error("installAgentSetupApi did not install fetch");
    let agentExists = false;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (input === "/api/v1/agents" && init?.method === "POST") {
        agentExists = true;
        return json(
          {
            error: {
              code: "AGENT_NAME_CONFLICT",
              category: "deterministic",
              message: "An active Agent with this name already exists for this Account",
            },
          },
          409,
        );
      }
      if (input === "/api/v1/agents" && init?.method === undefined && agentExists) {
        return json({ agents: [agentListItem] });
      }
      return fallback(input, init);
    });
    window.history.replaceState({}, "", "/agents/setup");
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /Local computer/ }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(screen.getByRole("button", { name: /Codex/ }));
    fireEvent.change(screen.getByLabelText("Agent name"), { target: { value: "reviewer" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Agent" }));

    const open = await screen.findByRole("link", { name: "Open @reviewer" });
    expect(open.getAttribute("href")).toBe(`/agents/${agentId}`);
    expect(screen.getByText("An active Agent with this name already exists for this Account")).toBeTruthy();
    // Nobody is moved: the reader chooses between the Agent that exists and a different name.
    expect(window.location.search).toBe("");
    expect(agentCreationPosts()).toHaveLength(1);

    fireEvent.change(screen.getByLabelText("Agent name"), { target: { value: "helper" } });
    expect(screen.queryByRole("link", { name: "Open @reviewer" })).toBeNull();
    expect(screen.queryByText("An active Agent with this name already exists for this Account")).toBeNull();
  });

  it("retires a refusal's offer with the refusal itself", async () => {
    /*
     * The offer belongs to the failure that produced it. A later failure of a different kind, on the
     * same name, is not answered by it — and an offer sitting under a banner that says the request
     * never reached the Server is the second, disagreeing account of one fact this flow exists to
     * be rid of.
     */
    installAgentSetupApi({ emptyAgents: true, setupCompletedAt: null });
    const fallback = vi.mocked(fetch).getMockImplementation();
    if (!fallback) throw new Error("installAgentSetupApi did not install fetch");
    let refused = false;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (input === "/api/v1/agents" && init?.method === "POST") {
        if (refused) throw new TypeError("Connection closed before the result arrived");
        refused = true;
        return json(
          {
            error: {
              code: "AGENT_NAME_CONFLICT",
              category: "deterministic",
              message: "An active Agent with this name already exists for this Account",
            },
          },
          409,
        );
      }
      if (input === "/api/v1/agents" && init?.method === undefined && refused) {
        return json({ agents: [agentListItem] });
      }
      return fallback(input, init);
    });
    window.history.replaceState({}, "", "/agents/setup");
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /Local computer/ }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(screen.getByRole("button", { name: /Codex/ }));
    fireEvent.change(screen.getByLabelText("Agent name"), { target: { value: "reviewer" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Agent" }));
    expect(await screen.findByRole("link", { name: "Open @reviewer" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Create Agent" }));

    expect(await screen.findByText("Connection closed before the result arrived")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Open @reviewer" })).toBeNull();
  });

  it("names a paused Agent, because a paused Agent is what refused the name", async () => {
    /*
     * The Server refuses a name that any Agent which is not deleted carries, so a paused one refuses
     * it too. Looking only for a working Agent would throw that answer away out of the very response
     * that carries it, and leave a refusal naming nothing.
     */
    installAgentSetupApi({ emptyAgents: true, setupCompletedAt: null });
    const fallback = vi.mocked(fetch).getMockImplementation();
    if (!fallback) throw new Error("installAgentSetupApi did not install fetch");
    let refused = false;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (input === "/api/v1/agents" && init?.method === "POST") {
        refused = true;
        return json(
          {
            error: {
              code: "AGENT_NAME_CONFLICT",
              category: "deterministic",
              message: "An active Agent with this name already exists for this Account",
            },
          },
          409,
        );
      }
      if (input === "/api/v1/agents" && init?.method === undefined && refused) {
        return json({ agents: [{ ...agentListItem, status: "suspended" }] });
      }
      return fallback(input, init);
    });
    window.history.replaceState({}, "", "/agents/setup");
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /Local computer/ }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(screen.getByRole("button", { name: /Codex/ }));
    fireEvent.change(screen.getByLabelText("Agent name"), { target: { value: "reviewer" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Agent" }));

    expect((await screen.findByRole("link", { name: "Open @reviewer" })).getAttribute("href")).toBe(
      `/agents/${agentId}`,
    );
  });

  it("still offers a way off the page when the refused name cannot be traced", async () => {
    /*
     * The offer is this route's only exit, and it asks for a second read straight after one request
     * has just failed — which is when that read is least likely to succeed. So a refusal that cannot
     * name the Agent still says where to look, rather than leaving a screen with no way out.
     */
    installAgentSetupApi({ emptyAgents: true, setupCompletedAt: null });
    const fallback = vi.mocked(fetch).getMockImplementation();
    if (!fallback) throw new Error("installAgentSetupApi did not install fetch");
    let refused = false;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (input === "/api/v1/agents" && init?.method === "POST") {
        refused = true;
        return json(
          {
            error: {
              code: "AGENT_NAME_CONFLICT",
              category: "deterministic",
              message: "An active Agent with this name already exists for this Account",
            },
          },
          409,
        );
      }
      if (input === "/api/v1/agents" && init?.method === undefined && refused) {
        throw new TypeError("Connection closed before the result arrived");
      }
      return fallback(input, init);
    });
    window.history.replaceState({}, "", "/agents/setup");
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /Local computer/ }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(screen.getByRole("button", { name: /Codex/ }));
    fireEvent.click(screen.getByRole("button", { name: "Create Agent" }));

    const exit = await screen.findByRole("link", { name: "Go to your Agents" });
    expect(exit.getAttribute("href")).toBe("/agents");
    expect(screen.getByText("An active Agent with this name already exists for this Account")).toBeTruthy();
  });

  it("does not repeat a way back the header already offers", async () => {
    /*
     * The bare fallback exists because this page can be the only one an Account can reach. An
     * admitted Account already has Back to agents in the header, so a second control to the same
     * destination, worded differently, would read as a different thing while doing the same one.
     */
    installAgentSetupApi();
    const fallback = vi.mocked(fetch).getMockImplementation();
    if (!fallback) throw new Error("installAgentSetupApi did not install fetch");
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (input === "/api/v1/agents" && init?.method === "POST") {
        return json(
          {
            error: {
              code: "AGENT_NAME_CONFLICT",
              category: "deterministic",
              message: "An active Agent with this name already exists for this Account",
            },
          },
          409,
        );
      }
      if (input === "/api/v1/agents" && init?.method === undefined) {
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

    expect(await screen.findByText("An active Agent with this name already exists for this Account")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Back to agents" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Go to your Agents" })).toBeNull();
  });

  it("offers the same Agent to an Account that asked for an extra one and reused a name", async () => {
    installAgentSetupApi();
    const fallback = vi.mocked(fetch).getMockImplementation();
    if (!fallback) throw new Error("installAgentSetupApi did not install fetch");
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (input === "/api/v1/agents" && init?.method === "POST") {
        return json(
          {
            error: {
              code: "AGENT_NAME_CONFLICT",
              category: "deterministic",
              message: "An active Agent with this name already exists for this Account",
            },
          },
          409,
        );
      }
      return fallback(input, init);
    });
    window.history.replaceState({}, "", "/agents/setup?action=create");
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /Local computer/ }));
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    fireEvent.click(screen.getByRole("button", { name: /Codex/ }));
    fireEvent.change(screen.getByLabelText("Agent name"), { target: { value: "reviewer" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Agent" }));

    // The Account that deliberately asked for another Agent gets the same two ways forward, and
    // keeps the exit it already had.
    expect((await screen.findByRole("link", { name: "Open @reviewer" })).getAttribute("href")).toBe(
      `/agents/${agentId}`,
    );
    expect(window.location.search).toBe("?action=create");
    expect(screen.getByRole("button", { name: "Back to agents" })).toBeTruthy();
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

  it.each(["agentId=123", `agentId=${agentId}&agentId=${secondAgentId}`])(
    "fails closed when an explicitly present exact id is parsed as a non-string: %s",
    async (search) => {
      installAgentSetupApi({ emptyAgents: true, setupCompletedAt: null });
      window.history.replaceState({}, "", `/agents/setup?${search}`);
      render(<App />);

      expect(await screen.findByRole("heading", { name: "This agent cannot be set up" })).toBeTruthy();
      expect(agentListReads()).toHaveLength(0);
      expect(screen.queryByRole("heading", { name: "Where should your agent run?" })).toBeNull();
      expect(agentCreationPosts()).toHaveLength(0);
    },
  );

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
