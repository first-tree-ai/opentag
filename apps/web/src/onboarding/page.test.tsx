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
import { AgentCreationFlow } from "../agent-creation/agent-creation-flow.js";
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
    expect(screen.queryByText("Create Workspace")).toBeNull();
  });

  it("presents the conditional setup as two product-level steps", async () => {
    installFacts();
    renderPage();
    expect(await screen.findByRole("heading", { name: "Connect a Local Computer" })).toBeTruthy();

    const steps = screen.getByRole("navigation", { name: "Onboarding steps" });
    expect(steps.querySelectorAll("li")).toHaveLength(2);
    expect(steps.textContent).toContain("Prepare your Agent");
    expect(steps.textContent).toContain("Add to Feishu");
    expect(steps.textContent).toContain("In progress");
    expect(steps.textContent).toContain("Up next");

    const summary = screen.getByRole("region", { name: "Agent preparation summary" });
    expect(summary.textContent).toContain("ComputerNot connected");
    expect(summary.textContent).toContain("RuntimeWaiting");
    expect(summary.textContent).toContain("AgentName pending");
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("asks for the existing Computer to be reconnected when every Computer is offline", async () => {
    installFacts({ computers: [{ ...computerA, connectionStatus: "offline" }] });
    renderPage();
    const runtime = await screen.findByRole("region", { name: "Where it runs" });
    expect(runtime.textContent).toContain("Computer offline");
    expect(runtime.textContent).toContain("Reconnect one of your Computers to continue.");
    expect(screen.getByRole("button", { name: "Create Agent" })).toHaveProperty("disabled", true);
  });

  it("selects a ready route by default and progressively reveals alternatives", async () => {
    installFacts({ computers: [computerA, computerB] });
    renderPage({
      runtime: runtimeFacts([
        { computerId: computerAId, provider: "codex", runtimeReady: true },
        { computerId: computerBId, provider: "codex", runtimeReady: true },
      ]),
    });
    expect(await screen.findByText("Codex · Ada's Mac")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Change" }));
    expect(screen.getByRole("button", { name: /Ada's Mac/ })).toBeTruthy();
    expect(screen.getByRole("button", { name: /Studio Mac/ })).toBeTruthy();
    expect(vi.spyOn(browserApi, "createAgent")).not.toHaveBeenCalled();
  });

  it("updates the shared runtime summary when another ready Computer is selected", async () => {
    installFacts({ computers: [computerA, computerB] });
    renderPage({
      runtime: runtimeFacts([
        { computerId: computerAId, provider: "codex", runtimeReady: true },
        { computerId: computerBId, provider: "codex", runtimeReady: true },
      ]),
    });

    fireEvent.click(await screen.findByRole("button", { name: "Change" }));
    fireEvent.click(screen.getByRole("button", { name: /Studio Mac/ }));
    expect(await screen.findByText("Codex · Studio Mac")).toBeTruthy();
  });

  it("does not offer an unconfirmed Computer route before runtime facts arrive", async () => {
    installFacts({ computers: [computerA, computerB] });
    renderPage();
    expect(await screen.findByText("Readiness unconfirmed")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Change" })).toBeNull();
    expect(screen.getByRole("button", { name: "Create Agent" })).toHaveProperty("disabled", true);
  });

  it("does not invent runtime readiness when the production fact seam is unavailable", async () => {
    installFacts({ computers: [computerA] });
    renderPage();
    expect(await screen.findByText("Readiness unconfirmed")).toBeTruthy();
    expect(screen.getByText(/cannot confirm a ready Provider/)).toBeTruthy();
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
    expect(await screen.findByText("Install Codex")).toBeTruthy();
    expect(screen.getByText("Install Codex on Ada's Mac.")).toBeTruthy();
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
    expect(await screen.findByText("Provider unavailable")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create Agent" })).toHaveProperty("disabled", true);
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
    expect(screen.getByText("Install Codex")).toBeTruthy();
    const loadsBeforePolling = computers.mock.calls.length;

    runtimeReady = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });

    expect(computers.mock.calls.length).toBeGreaterThan(loadsBeforePolling);
    expect(screen.getByText("Ready to run")).toBeTruthy();
  });

  it("leaves a state that waits on this user alone", async () => {
    vi.useFakeTimers();
    installFacts({ computers: [computerA] });
    const computers = vi.spyOn(browserApi, "computers");
    renderPage({ runtime: runtimeFacts([{ computerId: computerAId, provider: "codex", runtimeReady: true }]) });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByText("Ready to run")).toBeTruthy();
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
    expect(screen.getByText("Provider unavailable")).toBeTruthy();

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
    ["checking", "Checking setup", "Codex readiness is still being checked."],
    ["install", "Install Codex", "Install Codex on Ada's Mac."],
    ["sign-in", "Sign in to Codex", "Finish sign-in on Ada's Mac."],
    ["unavailable", "Provider unavailable", "Prepare Codex or Claude Code on Ada's Mac."],
  ] as const)("shows the current %s Provider action", async (status, heading, description) => {
    installFacts({ computers: [computerA] });
    renderPage({
      runtime: runtimeFacts([{ computerId: computerAId, provider: "codex", runtimeReady: false, status }]),
    });
    expect(await screen.findByText(heading)).toBeTruthy();
    expect(await screen.findByText(description)).toBeTruthy();
  });

  it("preserves an existing Agent identity during runtime outage", async () => {
    installFacts({ agents: [agent], computers: [computerA], handoff: { bindingState: "active", handoffReady: true } });
    renderPage({ runtime: runtimeFacts([{ computerId: computerAId, provider: "codex", runtimeReady: false }]) });
    expect(await screen.findByRole("heading", { name: "OpenTag needs its runtime route" })).toBeTruthy();
    expect(screen.getByText(/identity and Feishu setup are unchanged/)).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Connect a Local Computer" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "OpenTag is ready" })).toBeNull();
  });

  it("shows the Agent-bound Computer as offline instead of substituting another online Computer", async () => {
    installFacts({
      agents: [agent],
      computers: [computerB, { ...computerA, connectionStatus: "offline" }],
    });
    renderPage({ runtime: runtimeFacts([{ computerId: computerBId, provider: "codex", runtimeReady: true }]) });

    expect(await screen.findByRole("heading", { name: "OpenTag needs its runtime route" })).toBeTruthy();
    const route = screen.getByText("Ada's Mac · Offline");
    expect(route.closest("div")?.dataset.status).toBe("attention");
    expect(screen.getByRole("region", { name: "Agent preparation summary" }).textContent).not.toContain("Studio Mac");
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
    expect(screen.getByRole("region", { name: /OpenTag Agent .* Feishu/ })).toBeTruthy();
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
    expect(screen.getByText(/An admin can complete this action/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Feishu/ })).toBeNull();
  });

  it("shows members the Team-wide runnable route in both the action and preparation summary", async () => {
    const ownerAdminId = "00000001-0000-4000-8000-000000000001";
    const adminComputer = {
      ...computerA,
      ownerUserId: ownerAdminId,
      ownerDisplayName: "Grace",
      displayName: "Grace's Mac",
    };
    installFacts({ computers: [adminComputer], members: [teamAdmin("Grace", ownerAdminId)] });
    renderPage({
      membership: member,
      runtime: runtimeFacts([{ computerId: computerAId, provider: "codex", runtimeReady: true }]),
    });

    expect(await screen.findByRole("heading", { name: "Create the Agent" })).toBeTruthy();
    expect(screen.getByText(/Codex on Grace's Mac/)).toBeTruthy();
    const summary = screen.getByRole("region", { name: "Agent preparation summary" });
    expect(summary.textContent).toContain("ComputerGrace's Mac");
    expect(summary.textContent).toContain("RuntimeCodex");
    expect(screen.getByText("Ready to create")).toBeTruthy();
  });

  it.each([
    [["Ada"], "Ask an admin to continue: Ada."],
    [["Ada", "Grace"], "Ask an admin to continue: Ada or Grace."],
    [["Ada", "Grace", "Linus"], "Ask an admin to continue: Ada, Grace, or 1 more."],
    [["Ada", "Grace", "Linus", "Ken"], "Ask an admin to continue: Ada, Grace, or 2 more."],
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
    expect(screen.getByText(/Ask an admin to continue: Ada or Grace\./)).toBeTruthy();
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
    expect(screen.getByText(/An admin can complete this action/)).toBeTruthy();
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

    const name = await screen.findByLabelText("Display name");
    expect(name).toHaveProperty("value", "OpenTag");
    expect(create).not.toHaveBeenCalled();
    fireEvent.change(name, { target: { value: "Research Partner" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Agent" }));

    await waitFor(() =>
      expect(create).toHaveBeenCalledWith(
        teamId,
        expect.objectContaining({ displayName: "Research Partner", name: "research-partner" }),
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

    expect(await screen.findByText("Codex · Ada's Mac")).toBeTruthy();
    expect(create).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Change" }));
    fireEvent.click(screen.getByRole("button", { name: /Claude Code/ }));
    expect(await screen.findByText("Claude Code · Ada's Mac")).toBeTruthy();
    expect(create).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Create Agent" }));
    await waitFor(() =>
      expect(create).toHaveBeenCalledWith(
        teamId,
        expect.objectContaining({ computerId: computerAId, runtimeProvider: "claude-code" }),
      ),
    );
  });

  it("changes a confirmed ready route locally without an intermediate reload", async () => {
    installFacts({ computers: [computerA] });
    const create = vi.spyOn(browserApi, "createAgent").mockResolvedValue(adminConfig());
    const available = {
      kind: "available" as const,
      providers: [
        { computerId: computerAId, provider: "codex" as const, runtimeReady: true },
        { computerId: computerAId, provider: "claude-code" as const, runtimeReady: true },
      ],
    };
    const runtime: RuntimeFactsAdapter = { load: vi.fn().mockResolvedValue(available) };
    renderPage({ runtime });

    await screen.findByText("Codex · Ada's Mac");
    fireEvent.click(screen.getByRole("button", { name: "Change" }));
    fireEvent.click(screen.getByRole("button", { name: /Claude Code/ }));
    expect(await screen.findByText("Claude Code · Ada's Mac")).toBeTruthy();
    expect(runtime.load).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Create Agent" }));
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
    fireEvent.click(await screen.findByRole("button", { name: "Create Agent" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Response was lost");
    fireEvent.click(screen.getByRole("button", { name: "Create Agent" }));
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
    fireEvent.click(await screen.findByRole("button", { name: "Create Agent" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Connection closed before the response");
    const durableRecord = window.localStorage.getItem(`opentag.agent-creation.intent:${teamId}`);
    expect(durableRecord).toBeTruthy();

    firstPage.unmount();
    renderPage({ runtime });
    expect(await screen.findByRole("heading", { name: "Connect OpenTag to Feishu" })).toBeTruthy();
    expect(create).toHaveBeenCalledTimes(2);
    expect(requests[0]?.creationIntentId).toBe(requests[1]?.creationIntentId);
    expect(window.localStorage.getItem(`opentag.agent-creation.intent:${teamId}`)).toBeNull();
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
    await waitFor(() => expect(screen.getAllByRole("button", { name: "Create Agent" })).toHaveLength(2));
    const actions = screen.getAllByRole("button", { name: "Create Agent" });
    fireEvent.click(actions[0] as HTMLButtonElement);
    fireEvent.click(actions[1] as HTMLButtonElement);
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
  });

  it("keeps distinct concurrent creation intents isolated", async () => {
    const requests: CreateAgentRequest[] = [];
    let betaAttempts = 0;
    vi.spyOn(browserApi, "createAgent").mockImplementation(async (_teamId, request) => {
      requests.push(request);
      if (request.displayName === "Beta" && betaAttempts++ === 0) throw new Error("Beta response was lost");
      return adminConfig();
    });
    const facts = {
      computers: [{ id: computerAId, displayName: computerA.displayName, connectionStatus: "online" as const }],
      providers: [{ computerId: computerAId, provider: "codex" as const, runtimeReady: true }],
      runtimeEvidenceAvailable: true,
    };
    const alphaCreated = vi.fn();
    const betaCreated = vi.fn();
    render(
      <>
        <AgentCreationFlow
          facts={facts}
          initialDisplayName="Alpha"
          teamId={teamId}
          onCreated={alphaCreated}
          onRefresh={() => undefined}
        />
        <AgentCreationFlow
          facts={facts}
          initialDisplayName="Beta"
          teamId={teamId}
          onCreated={betaCreated}
          onRefresh={() => undefined}
        />
      </>,
    );

    const actions = screen.getAllByRole("button", { name: "Create Agent" });
    const alphaAction = actions[0];
    const betaAction = actions[1];
    if (!alphaAction || !betaAction) throw new Error("Expected two Agent creation actions");
    fireEvent.click(alphaAction);
    fireEvent.click(betaAction);

    await waitFor(() => expect(alphaCreated).toHaveBeenCalledTimes(1));
    expect((await screen.findByRole("alert")).textContent).toContain("Beta response was lost");
    const betaRequest = requests.find((request) => request.displayName === "Beta");
    const stored = JSON.parse(String(window.localStorage.getItem(`opentag.agent-creation.intent:${teamId}`))) as {
      records: { creationIntentId: string }[];
    };
    expect(stored.records).toHaveLength(1);
    expect(stored.records[0]?.creationIntentId).toBe(betaRequest?.creationIntentId);

    fireEvent.click(betaAction);
    await waitFor(() => expect(betaCreated).toHaveBeenCalledTimes(1));
    const betaRequests = requests.filter((request) => request.displayName === "Beta");
    expect(betaRequests).toHaveLength(2);
    expect(betaRequests[1]?.creationIntentId).toBe(betaRequests[0]?.creationIntentId);
    expect(window.localStorage.getItem(`opentag.agent-creation.intent:${teamId}`)).toBeNull();
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
    expect(computers).toHaveBeenCalledTimes(2);
    expect(agents).toHaveBeenCalledTimes(2);

    finishRefresh?.({ computers: [computerA] });
    expect(await screen.findByRole("button", { name: "Check again" })).toHaveProperty("disabled", false);
  });

  it("keeps ready route selection usable when localStorage throws", async () => {
    const storageTeamId = "a3fda800-7ce2-4338-aae8-3d2120401ed6";
    const storageAdmin = { ...admin, teamId: storageTeamId };
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("Storage unavailable");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("Storage unavailable");
    });
    installFacts({ computers: [computerA, computerB] });

    renderPage({
      membership: storageAdmin,
      runtime: runtimeFacts([
        { computerId: computerAId, provider: "codex", runtimeReady: true },
        { computerId: computerBId, provider: "codex", runtimeReady: true },
      ]),
    });
    fireEvent.click(await screen.findByRole("button", { name: "Change" }));
    fireEvent.click(screen.getByRole("button", { name: /Studio Mac/ }));

    expect(await screen.findByText("Codex · Studio Mac")).toBeTruthy();
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
