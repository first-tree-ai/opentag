import type {
  AgentAdminConfig,
  AgentSummary,
  Computer,
  CreateAgentRequest,
  ImBindingHandoffStatus,
  MeMembership,
  TeamComputerSummary,
  TeamMemberSummary,
  UserProfile,
} from "@opentag/shared/browser";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { browserApi } from "../api.js";
import { OnboardingPage } from "./page.js";
import type { RuntimeFactsAdapter, RuntimeFactsResult, RuntimeProviderStatus } from "./runtime-facts.js";

const teamId = "d3fda800-7ce2-4338-aae8-3d2120401ed6";
const userId = "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e";
const computerAId = "85fe9af3-d1c6-472b-b78c-8a7ccf512750";
const computerBId = "95fe9af3-d1c6-472b-b78c-8a7ccf512750";
const agentId = "1a63a21e-f6c7-4474-91ea-4dabf0566a24";

const user: UserProfile = { id: userId, email: "ada@example.com", displayName: "Ada" };
const admin: MeMembership = { teamId, teamName: "example", teamDisplayName: "Example", role: "admin" };
const member: MeMembership = { ...admin, role: "member" };
const computerA: TeamComputerSummary = {
  id: computerAId,
  ownerUserId: userId,
  ownerDisplayName: "Ada",
  displayName: "Ada's Mac",
  platform: "darwin",
  connectionStatus: "online",
  connectedAt: "2026-08-20T00:00:00.000Z",
  lastSeenAt: "2026-08-20T00:00:00.000Z",
  observedAt: "2026-08-20T00:00:00.000Z",
  agentIds: [],
};
const computerB: TeamComputerSummary = {
  ...computerA,
  id: computerBId,
  displayName: "Studio Mac",
};
const agent: AgentSummary = {
  id: agentId,
  teamId,
  name: "opentag",
  displayName: "OpenTag",
  manager: { userId, displayName: "Ada" },
  computer: { id: computerAId, displayName: computerA.displayName, platform: "darwin" },
  runtimeProvider: "codex",
  receiveMode: "mention_only",
  status: "active",
  createdAt: "2026-08-20T00:00:00.000Z",
  updatedAt: "2026-08-20T00:00:00.000Z",
};

function adminConfig(): AgentAdminConfig {
  return {
    id: agent.id,
    teamId,
    name: agent.name,
    displayName: agent.displayName,
    runtimeProvider: agent.runtimeProvider,
    receiveMode: "mention_only",
    status: "active",
    createdAt: agent.createdAt,
    updatedAt: agent.updatedAt,
    managerUserId: userId,
    computerId: computerAId,
    revision: 1,
    runtimeConfig: {
      revision: 1,
      model: null,
      reasoningEffort: null,
      instructions: "",
      maxDurationMs: null,
    },
  };
}

function runtimeFacts(
  providers: Array<{
    computerId: string;
    provider: "codex" | "claude-code";
    runtimeReady: boolean;
    status?: RuntimeProviderStatus;
  }>,
): RuntimeFactsAdapter {
  return { load: vi.fn().mockResolvedValue({ kind: "available", providers }) };
}

function unavailableRuntime(): RuntimeFactsAdapter {
  return { load: vi.fn().mockResolvedValue({ kind: "unavailable" }) };
}

function installFacts({
  agents = [],
  computers = [],
  handoff,
  members = [],
}: {
  agents?: AgentSummary[];
  computers?: TeamComputerSummary[];
  handoff?: ImBindingHandoffStatus;
  members?: TeamMemberSummary[];
} = {}) {
  vi.spyOn(browserApi, "computers").mockResolvedValue({ computers });
  vi.spyOn(browserApi, "agents").mockResolvedValue({ agents });
  vi.spyOn(browserApi, "imBindingHandoff").mockResolvedValue(handoff);
  vi.spyOn(browserApi, "members").mockResolvedValue({ members });
  vi.spyOn(browserApi, "logout").mockResolvedValue();
}

function teamAdmin(displayName: string, id: string): TeamMemberSummary {
  return { userId: id, displayName, role: "admin" };
}

function renderPage({
  membership = admin,
  runtime = unavailableRuntime(),
}: {
  membership?: MeMembership;
  runtime?: RuntimeFactsAdapter;
} = {}) {
  return render(<OnboardingPage membership={membership} runtimeFacts={runtime} user={user} />);
}

describe("OnboardingPage", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("renders the standalone Computer action without an application sidebar", async () => {
    installFacts();
    renderPage();
    expect(await screen.findByRole("heading", { name: "Connect a Local Computer" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Generate connection command" })).toBeTruthy();
    expect(screen.queryByRole("navigation", { name: "Workspace" })).toBeNull();
    expect(screen.queryByText("Create Team")).toBeNull();
  });

  it("asks for the existing Computer to be reconnected when every Computer is offline", async () => {
    installFacts({ computers: [{ ...computerA, connectionStatus: "offline" }] });
    renderPage();
    expect(await screen.findByRole("heading", { name: "Reconnect your Computer" })).toBeTruthy();
    expect(screen.getByText(/Ada's Mac/)).toBeTruthy();
  });

  it("asks only for real Computer ambiguity", async () => {
    installFacts({ computers: [computerA, computerB] });
    renderPage({
      runtime: runtimeFacts([
        { computerId: computerAId, provider: "codex", runtimeReady: true },
        { computerId: computerBId, provider: "codex", runtimeReady: true },
      ]),
    });
    expect(await screen.findByRole("heading", { name: "Choose a runnable Computer" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Ada's Mac/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Studio Mac/ })).toBeTruthy();
    expect(vi.spyOn(browserApi, "createAgent")).not.toHaveBeenCalled();
  });

  it("keeps an ambiguous Computer choice actionable before runtime facts arrive", async () => {
    installFacts({ computers: [computerA, computerB] });
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /Ada's Mac/ }));
    expect(await screen.findByRole("heading", { name: "Confirm the runtime route" })).toBeTruthy();
  });

  it("does not invent runtime readiness when the production fact seam is unavailable", async () => {
    installFacts({ computers: [computerA] });
    renderPage();
    expect(await screen.findByRole("heading", { name: "Confirm the runtime route" })).toBeTruthy();
    expect(screen.getByText(/cannot yet confirm an Agent-ready Provider/)).toBeTruthy();
    expect(screen.queryByText("Preparing OpenTag")).toBeNull();
  });

  it("shows the exact action from the production Provider readiness projection", async () => {
    installFacts({
      computers: [
        {
          ...computerA,
          providerReadiness: [{ provider: "codex", status: "install", observedAt: null }],
        },
      ],
    });
    render(<OnboardingPage membership={admin} user={user} />);
    expect(await screen.findByRole("heading", { name: "Install Codex" })).toBeTruthy();
    expect(screen.getByText("Install Codex on Ada's Mac, then check again.")).toBeTruthy();
  });

  it("reaches Ready from production runtime and authoritative handoff facts", async () => {
    installFacts({
      agents: [agent],
      computers: [
        {
          ...computerA,
          providerReadiness: [{ provider: "codex", status: "ready", observedAt: "2026-08-20T00:00:00.000Z" }],
        },
      ],
      handoff: { bindingState: "active", handoffReady: true },
    });
    render(<OnboardingPage membership={admin} user={user} />);
    expect(await screen.findByRole("heading", { name: "OpenTag is ready" })).toBeTruthy();
  });

  it("hands a completed setup over to the Agent it created", async () => {
    installFacts({
      agents: [agent],
      computers: [
        {
          ...computerA,
          providerReadiness: [{ provider: "codex", status: "ready", observedAt: "2026-08-20T00:00:00.000Z" }],
        },
      ],
      handoff: { bindingState: "active", handoffReady: true },
    });
    render(<OnboardingPage membership={admin} user={user} />);
    expect(await screen.findByRole("heading", { name: "OpenTag is ready" })).toBeTruthy();

    const manage = screen.getByRole("link", { name: "Manage this Agent" }) as HTMLAnchorElement;
    expect(new URL(manage.href).pathname).toBe(`/agents/${agentId}/general`);
    expect(screen.getByRole("link", { name: "Open Feishu" })).toBeTruthy();
  });

  it("leaves the application reachable from the page header", async () => {
    installFacts();
    renderPage();
    expect(await screen.findByRole("heading", { name: "Connect a Local Computer" })).toBeTruthy();

    const brand = screen.getByRole("link", { name: "OpenTag" }) as HTMLAnchorElement;
    expect(new URL(brand.href).pathname).toBe("/agents");
  });

  it("shows Provider recovery when authoritative facts say no route is runnable", async () => {
    installFacts({ computers: [computerA] });
    renderPage({ runtime: runtimeFacts([{ computerId: computerAId, provider: "codex", runtimeReady: false }]) });
    expect(await screen.findByRole("heading", { name: "Prepare Codex or Claude Code" })).toBeTruthy();
  });

  it("advances from Provider setup without asking the user to check again", async () => {
    vi.useFakeTimers();
    installFacts({ computers: [computerA] });
    const computers = vi.spyOn(browserApi, "computers");
    let runtimeReady = false;
    const runtime: RuntimeFactsAdapter = {
      load: vi.fn(
        async (): Promise<RuntimeFactsResult> => ({
          kind: "available",
          providers: [
            {
              computerId: computerAId,
              provider: "codex",
              runtimeReady,
              status: runtimeReady ? "ready" : "install",
            },
          ],
        }),
      ),
    };
    renderPage({ runtime });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByRole("heading", { name: "Install Codex" })).toBeTruthy();
    const loadsBeforePolling = computers.mock.calls.length;

    runtimeReady = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    expect(computers.mock.calls.length).toBeGreaterThan(loadsBeforePolling);
    expect(screen.getByRole("heading", { name: "Create your Agent" })).toBeTruthy();
  });

  it("leaves a state that waits on this user alone", async () => {
    vi.useFakeTimers();
    installFacts({ computers: [computerA] });
    const computers = vi.spyOn(browserApi, "computers");
    renderPage({ runtime: runtimeFacts([{ computerId: computerAId, provider: "codex", runtimeReady: true }]) });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByRole("heading", { name: "Create your Agent" })).toBeTruthy();
    const loads = computers.mock.calls.length;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });

    expect(computers.mock.calls.length).toBe(loads);
  });

  it("stops polling a page that nobody has acted on for ten minutes", async () => {
    vi.useFakeTimers();
    installFacts({ computers: [computerA] });
    const computers = vi.spyOn(browserApi, "computers");
    renderPage({ runtime: runtimeFacts([{ computerId: computerAId, provider: "codex", runtimeReady: false }]) });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByRole("heading", { name: "Prepare Codex or Claude Code" })).toBeTruthy();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10 * 60 * 1_000);
    });
    const loads = computers.mock.calls.length;
    expect(loads).toBeGreaterThan(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });

    expect(computers.mock.calls.length).toBe(loads);
    expect(screen.getByRole("button", { name: "Check again" })).toBeTruthy();
  });

  it("resumes polling when someone returns to a page that went quiet", async () => {
    vi.useFakeTimers();
    installFacts({ computers: [computerA] });
    const computers = vi.spyOn(browserApi, "computers");
    renderPage({ runtime: runtimeFacts([{ computerId: computerAId, provider: "codex", runtimeReady: false }]) });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(11 * 60 * 1_000);
    });
    const quiet = computers.mock.calls.length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(computers.mock.calls.length).toBe(quiet);

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await vi.advanceTimersByTimeAsync(0);
    });
    const attended = computers.mock.calls.length;
    expect(attended).toBeGreaterThan(quiet);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    expect(computers.mock.calls.length).toBeGreaterThan(attended);
  });

  it.each([
    ["checking", "Checking Codex", "OpenTag is checking Codex readiness on Ada's Mac."],
    ["install", "Install Codex", "Install Codex on Ada's Mac, then check again."],
    ["sign-in", "Sign in to Codex", "Sign in to Codex on Ada's Mac, then check again."],
    ["unavailable", "Restore Codex", "Codex is currently unavailable on Ada's Mac. Restore it, then check again."],
  ] as const)("shows the current %s Provider action", async (status, heading, description) => {
    installFacts({ computers: [computerA] });
    renderPage({
      runtime: runtimeFacts([{ computerId: computerAId, provider: "codex", runtimeReady: false, status }]),
    });
    expect(await screen.findByRole("heading", { name: heading })).toBeTruthy();
    expect(screen.getByText(description)).toBeTruthy();
  });

  it("preserves an existing Agent identity during runtime outage", async () => {
    installFacts({ agents: [agent], computers: [computerA], handoff: { bindingState: "active", handoffReady: true } });
    renderPage({ runtime: runtimeFacts([{ computerId: computerAId, provider: "codex", runtimeReady: false }]) });
    expect(await screen.findByRole("heading", { name: "OpenTag needs its runtime route" })).toBeTruthy();
    expect(screen.getByText(/identity and Feishu setup are unchanged/)).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Connect a Local Computer" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "OpenTag is ready" })).toBeNull();
  });

  it.each([
    [undefined, "Connect OpenTag to Feishu", "Connect existing or new Feishu Bot"],
    [
      { bindingState: "provisioning", handoffReady: false } as const,
      "Finish Feishu authorization",
      "Resume Feishu setup",
    ],
    [
      { bindingState: "reauthorization_required", handoffReady: false } as const,
      "Update Feishu permissions",
      "Reauthorize Feishu",
    ],
  ])("renders the authoritative handoff state", async (handoff, heading, action) => {
    installFacts({ agents: [agent], computers: [computerA], handoff });
    renderPage({ runtime: runtimeFacts([{ computerId: computerAId, provider: "codex", runtimeReady: true }]) });
    expect(await screen.findByRole("heading", { name: heading })).toBeTruthy();
    expect(screen.getByRole("button", { name: action })).toBeTruthy();
  });

  it("renders Ready only when runtime and authoritative handoff are both ready", async () => {
    installFacts({ agents: [agent], computers: [computerA], handoff: { bindingState: "active", handoffReady: true } });
    renderPage({ runtime: runtimeFacts([{ computerId: computerAId, provider: "codex", runtimeReady: true }]) });
    expect(await screen.findByRole("heading", { name: "OpenTag is ready" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open Feishu" })).toBeTruthy();
    expect(screen.getByText(/mention OpenTag with your first task/)).toBeTruthy();
  });

  it("shows members the same factual handoff progress without configuration controls", async () => {
    installFacts({ agents: [agent], computers: [computerA] });
    renderPage({
      membership: member,
      runtime: runtimeFacts([{ computerId: computerAId, provider: "codex", runtimeReady: true }]),
    });
    expect(await screen.findByRole("heading", { name: "Connect OpenTag to Feishu" })).toBeTruthy();
    expect(screen.getByText("Read only")).toBeTruthy();
    expect(screen.getByText(/A Team admin can complete this action/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Feishu/ })).toBeNull();
  });

  it.each([
    [["Ada"], "Ask a Team admin to continue: Ada."],
    [["Ada", "Grace"], "Ask a Team admin to continue: Ada or Grace."],
    [["Ada", "Grace", "Linus"], "Ask a Team admin to continue: Ada, Grace, or 1 more."],
    [["Ada", "Grace", "Linus", "Ken"], "Ask a Team admin to continue: Ada, Grace, or 2 more."],
  ])("names the admins a member can ask", async (names, expected) => {
    installFacts({
      agents: [agent],
      computers: [computerA],
      members: [
        ...names.map((name, index) => teamAdmin(name, `0000000${index}-0000-4000-8000-00000000000${index}`)),
        { userId, displayName: "Ada Member", role: "member" },
      ],
    });
    renderPage({
      membership: member,
      runtime: runtimeFacts([{ computerId: computerAId, provider: "codex", runtimeReady: true }]),
    });

    expect(await screen.findByRole("heading", { name: "Connect OpenTag to Feishu" })).toBeTruthy();
    expect(screen.getByText(`${expected} Your factual progress will update here.`)).toBeTruthy();
  });

  it("does not claim a named admin can finish a step tied to one Computer owner", async () => {
    const ownerAdminId = "00000001-0000-4000-8000-000000000001";
    installFacts({
      computers: [{ ...computerA, ownerUserId: ownerAdminId, ownerDisplayName: "Ada" }],
      members: [teamAdmin("Ada", ownerAdminId), teamAdmin("Grace", "00000002-0000-4000-8000-000000000002")],
    });
    renderPage({
      membership: member,
      runtime: runtimeFacts([{ computerId: computerAId, provider: "codex", runtimeReady: false }]),
    });

    expect(await screen.findByRole("heading", { name: "Prepare Codex or Claude Code" })).toBeTruthy();
    expect(screen.getByText(/Ask a Team admin to continue: Ada or Grace\./)).toBeTruthy();
    expect(screen.queryByText(/can complete this action/)).toBeNull();
  });

  it("keeps a member's facts readable when the member list is unavailable", async () => {
    installFacts({ agents: [agent], computers: [computerA] });
    vi.spyOn(browserApi, "members").mockRejectedValue(new Error("Members unavailable"));
    renderPage({
      membership: member,
      runtime: runtimeFacts([{ computerId: computerAId, provider: "codex", runtimeReady: true }]),
    });

    expect(await screen.findByRole("heading", { name: "Connect OpenTag to Feishu" })).toBeTruthy();
    expect(screen.getByText(/A Team admin can complete this action/)).toBeTruthy();
  });

  it("does not ask for the member list when the viewer manages the Team", async () => {
    installFacts({ agents: [agent], computers: [computerA] });
    const members = vi.spyOn(browserApi, "members");
    renderPage({ runtime: runtimeFacts([{ computerId: computerAId, provider: "codex", runtimeReady: true }]) });

    expect(await screen.findByRole("heading", { name: "Connect OpenTag to Feishu" })).toBeTruthy();
    expect(members).not.toHaveBeenCalled();
  });

  it("keeps OpenTag editable and waits for the explicit Agent creation action", async () => {
    installFacts({ computers: [computerA] });
    const create = vi.spyOn(browserApi, "createAgent").mockResolvedValue(adminConfig());
    renderPage({ runtime: runtimeFacts([{ computerId: computerAId, provider: "codex", runtimeReady: true }]) });

    const name = await screen.findByLabelText("Agent display name");
    expect(name).toHaveProperty("value", "OpenTag");
    expect(create).not.toHaveBeenCalled();
    fireEvent.change(name, { target: { value: "Research Partner" } });
    fireEvent.click(screen.getByRole("button", { name: "Create agent" }));

    await waitFor(() =>
      expect(create).toHaveBeenCalledWith(
        teamId,
        expect.objectContaining({ displayName: "Research Partner", name: "opentag" }),
      ),
    );
  });

  it("changes the default Codex route to Claude Code before explicit Agent creation", async () => {
    installFacts({ computers: [computerA] });
    const create = vi.spyOn(browserApi, "createAgent").mockResolvedValue(adminConfig());
    renderPage({
      runtime: runtimeFacts([
        { computerId: computerAId, provider: "codex", runtimeReady: true },
        { computerId: computerAId, provider: "claude-code", runtimeReady: true },
      ]),
    });

    expect(await screen.findByText("OpenTag will run with Codex on Ada's Mac.")).toBeTruthy();
    expect(create).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Change" }));
    fireEvent.click(screen.getByRole("button", { name: /Claude Code/ }));
    expect(await screen.findByText("OpenTag will run with Claude Code on Ada's Mac.")).toBeTruthy();
    expect(create).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Create agent" }));
    await waitFor(() =>
      expect(create).toHaveBeenCalledWith(
        teamId,
        expect.objectContaining({ computerId: computerAId, runtimeProvider: "claude-code" }),
      ),
    );
  });

  it("does not create on the stale route while an explicit Provider choice reloads", async () => {
    installFacts({ computers: [computerA] });
    const create = vi.spyOn(browserApi, "createAgent").mockResolvedValue(adminConfig());
    let finishReload: ((value: RuntimeFactsResult) => void) | undefined;
    const pendingReload = new Promise<RuntimeFactsResult>((resolve) => {
      finishReload = resolve;
    });
    const available = {
      kind: "available" as const,
      providers: [
        { computerId: computerAId, provider: "codex" as const, runtimeReady: true },
        { computerId: computerAId, provider: "claude-code" as const, runtimeReady: true },
      ],
    };
    const runtime: RuntimeFactsAdapter = {
      load: vi.fn().mockResolvedValue(available).mockResolvedValueOnce(available).mockReturnValueOnce(pendingReload),
    };
    renderPage({ runtime });

    await screen.findByText("OpenTag will run with Codex on Ada's Mac.");
    fireEvent.click(screen.getByRole("button", { name: "Change" }));
    fireEvent.click(screen.getByRole("button", { name: /Claude Code/ }));

    const createButton = screen.getByRole("button", { name: "Updating route…" });
    expect(createButton).toHaveProperty("disabled", true);
    expect(screen.getByRole("status").textContent).toBe("Confirming the selected runtime route…");
    fireEvent.click(createButton);
    expect(create).not.toHaveBeenCalled();

    await act(async () => {
      finishReload?.(available);
    });
    expect(await screen.findByText("OpenTag will run with Claude Code on Ada's Mac.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Create agent" }));
    await waitFor(() =>
      expect(create).toHaveBeenCalledWith(
        teamId,
        expect.objectContaining({ computerId: computerAId, runtimeProvider: "claude-code" }),
      ),
    );
  });

  it("replays a lost create response with the same creationIntentId", async () => {
    let serverAgents: AgentSummary[] = [];
    const agentReads = vi.spyOn(browserApi, "agents").mockImplementation(async () => ({ agents: serverAgents }));
    vi.spyOn(browserApi, "computers").mockResolvedValue({ computers: [computerA] });
    vi.spyOn(browserApi, "imBindingHandoff").mockResolvedValue(undefined);
    const requests: CreateAgentRequest[] = [];
    vi.spyOn(browserApi, "createAgent").mockImplementation(async (_teamId, request) => {
      requests.push(request);
      if (requests.length === 1) throw new Error("Response was lost");
      serverAgents = [agent];
      return adminConfig();
    });
    renderPage({ runtime: runtimeFacts([{ computerId: computerAId, provider: "codex", runtimeReady: true }]) });
    fireEvent.click(await screen.findByRole("button", { name: "Create agent" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Response was lost");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("heading", { name: "Connect OpenTag to Feishu" })).toBeTruthy();
    expect(requests).toHaveLength(2);
    expect(requests[0]?.creationIntentId).toBe(requests[1]?.creationIntentId);
    expect(requests[0]).not.toHaveProperty("receiveMode");
    expect(agentReads).toHaveBeenCalled();
  });

  it("recovers the durable create intent after the page remounts", async () => {
    let serverAgents: AgentSummary[] = [];
    vi.spyOn(browserApi, "agents").mockImplementation(async () => ({ agents: serverAgents }));
    vi.spyOn(browserApi, "computers").mockResolvedValue({ computers: [computerA] });
    vi.spyOn(browserApi, "imBindingHandoff").mockResolvedValue(undefined);
    const requests: CreateAgentRequest[] = [];
    const create = vi.spyOn(browserApi, "createAgent").mockImplementation(async (_teamId, request) => {
      requests.push(request);
      if (requests.length === 1) throw new Error("Connection closed before the response");
      serverAgents = [agent];
      return adminConfig();
    });
    const runtime = runtimeFacts([{ computerId: computerAId, provider: "codex", runtimeReady: true }]);
    const firstPage = renderPage({ runtime });
    fireEvent.click(await screen.findByRole("button", { name: "Create agent" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Connection closed before the response");
    const durableRecord = window.localStorage.getItem(`opentag.onboarding.creation-intent:${teamId}`);
    expect(durableRecord).toBeTruthy();

    firstPage.unmount();
    renderPage({ runtime });
    expect(await screen.findByRole("heading", { name: "Connect OpenTag to Feishu" })).toBeTruthy();
    expect(create).toHaveBeenCalledTimes(2);
    expect(requests[0]?.creationIntentId).toBe(requests[1]?.creationIntentId);
    expect(window.localStorage.getItem(`opentag.onboarding.creation-intent:${teamId}`)).toBeNull();
  });

  it("uses one logical create across parallel page controllers", async () => {
    let serverAgents: AgentSummary[] = [];
    vi.spyOn(browserApi, "agents").mockImplementation(async () => ({ agents: serverAgents }));
    vi.spyOn(browserApi, "computers").mockResolvedValue({ computers: [computerA] });
    vi.spyOn(browserApi, "imBindingHandoff").mockResolvedValue(undefined);
    const create = vi.spyOn(browserApi, "createAgent").mockImplementation(async () => {
      serverAgents = [agent];
      return adminConfig();
    });
    const runtime = runtimeFacts([{ computerId: computerAId, provider: "codex", runtimeReady: true }]);
    render(<OnboardingPage membership={admin} runtimeFacts={runtime} user={user} />);
    render(<OnboardingPage membership={admin} runtimeFacts={runtime} user={user} />);
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Create agent" })).toHaveLength(2));
    const actions = screen.getAllByRole("button", { name: "Create agent" });
    fireEvent.click(actions[0] as HTMLButtonElement);
    fireEvent.click(actions[1] as HTMLButtonElement);
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
  });

  it("reloads Server facts after Computer setup succeeds", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-20T00:00:00.000Z");
    const computers = vi.spyOn(browserApi, "computers").mockResolvedValue({ computers: [] });
    vi.spyOn(browserApi, "agents").mockResolvedValue({ agents: [] });
    vi.spyOn(browserApi, "imBindingHandoff").mockResolvedValue(undefined);
    const connectedComputer: Computer = {
      id: computerAId,
      ownerUserId: userId,
      displayName: computerA.displayName,
      platform: "darwin",
      arch: "arm64",
      clientVersion: "0.0.1",
      connectionStatus: "online",
      connectedAt: "2026-08-20T00:00:01.000Z",
      lastSeenAt: "2026-08-20T00:00:01.000Z",
    };
    vi.spyOn(browserApi, "ownComputers")
      .mockResolvedValueOnce({ computers: [] })
      .mockResolvedValue({ computers: [connectedComputer] });
    vi.spyOn(browserApi, "issueConnectCode").mockResolvedValue({
      bootstrapCommand: "opentag connect --code one-time-code",
      expiresIn: 900,
      issuedAt: "2026-08-20T00:00:00.000Z",
    });

    renderPage();
    await act(async () => {
      await Promise.resolve();
    });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Generate connection command" }));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByRole("status").textContent).toBe("Waiting for the Computer to connect…");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_500);
    });

    expect(computers.mock.calls.length).toBeGreaterThan(1);
  });

  it("reloads Server facts after Feishu setup succeeds", async () => {
    const computers = vi.spyOn(browserApi, "computers").mockResolvedValue({ computers: [computerA] });
    vi.spyOn(browserApi, "agents").mockResolvedValue({ agents: [agent] });
    vi.spyOn(browserApi, "imBindingHandoff").mockResolvedValue(undefined);
    vi.spyOn(browserApi, "createFeishuSetupAttempt").mockResolvedValue({
      id: "2a63a21e-f6c7-4474-91ea-4dabf0566a24",
      agentId,
      intent: "create",
      state: "succeeded",
      qrUrl: null,
      expiresAt: "2026-08-20T00:15:00.000Z",
      errorCode: null,
      completedAt: "2026-08-20T00:01:00.000Z",
      createdAt: "2026-08-20T00:00:00.000Z",
    });
    renderPage({ runtime: runtimeFacts([{ computerId: computerAId, provider: "codex", runtimeReady: true }]) });
    fireEvent.click(await screen.findByRole("button", { name: "Connect existing or new Feishu Bot" }));
    await waitFor(() => expect(computers.mock.calls.length).toBeGreaterThan(1));
  });

  it("deduplicates rapid fact refreshes and reports the pending state", async () => {
    let finishRefresh: ((value: { computers: TeamComputerSummary[] }) => void) | undefined;
    const pendingComputers = new Promise<{ computers: TeamComputerSummary[] }>((resolve) => {
      finishRefresh = resolve;
    });
    const computers = vi
      .spyOn(browserApi, "computers")
      .mockResolvedValueOnce({ computers: [computerA] })
      .mockReturnValueOnce(pendingComputers);
    const agents = vi.spyOn(browserApi, "agents").mockResolvedValue({ agents: [] });
    vi.spyOn(browserApi, "imBindingHandoff").mockResolvedValue(undefined);

    renderPage({
      runtime: runtimeFacts([{ computerId: computerAId, provider: "codex", runtimeReady: false, status: "install" }]),
    });
    const reload = await screen.findByRole("button", { name: "Check again" });
    act(() => {
      fireEvent.click(reload);
      fireEvent.click(reload);
    });

    expect(await screen.findByRole("button", { name: "Checking…" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("status").textContent).toBe("Refreshing Server facts…");
    expect(computers).toHaveBeenCalledTimes(2);
    expect(agents).toHaveBeenCalledTimes(2);

    finishRefresh?.({ computers: [computerA] });
    expect(await screen.findByRole("button", { name: "Check again" })).toHaveProperty("disabled", false);
  });

  it("keeps an explicit Computer choice in memory when localStorage throws", async () => {
    const storageTeamId = "a3fda800-7ce2-4338-aae8-3d2120401ed6";
    const storageAdmin = { ...admin, teamId: storageTeamId };
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("Storage unavailable");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("Storage unavailable");
    });
    installFacts({ computers: [computerA, computerB] });

    renderPage({ membership: storageAdmin });
    fireEvent.click(await screen.findByRole("button", { name: /Ada's Mac/ }));

    expect(await screen.findByRole("heading", { name: "Confirm the runtime route" })).toBeTruthy();
  });

  it("keeps an explicit Agent choice in memory when localStorage throws", async () => {
    const storageTeamId = "b3fda800-7ce2-4338-aae8-3d2120401ed6";
    const storageAdmin = { ...admin, teamId: storageTeamId };
    const researchAgent: AgentSummary = {
      ...agent,
      id: "2a63a21e-f6c7-4474-91ea-4dabf0566a24",
      teamId: storageTeamId,
      name: "research",
      displayName: "Research Agent",
    };
    const handoff = vi.spyOn(browserApi, "imBindingHandoff").mockResolvedValue(undefined);
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("Storage unavailable");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("Storage unavailable");
    });
    vi.spyOn(browserApi, "computers").mockResolvedValue({ computers: [computerA] });
    vi.spyOn(browserApi, "agents").mockResolvedValue({ agents: [{ ...agent, teamId: storageTeamId }, researchAgent] });
    vi.spyOn(browserApi, "logout").mockResolvedValue();

    renderPage({
      membership: storageAdmin,
      runtime: runtimeFacts([{ computerId: computerAId, provider: "codex", runtimeReady: true, status: "ready" }]),
    });
    fireEvent.click(await screen.findByRole("button", { name: /Research Agent/ }));

    expect(await screen.findByRole("heading", { name: "Connect OpenTag to Feishu" })).toBeTruthy();
    expect(handoff).toHaveBeenLastCalledWith(researchAgent.id);
  });
});
