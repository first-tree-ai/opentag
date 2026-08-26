import type {
  AgentAdminConfig,
  AgentListItem,
  CreateAgentRequest,
  ImBindingHandoffStatus,
  MeWorkspace,
  UserProfile,
  WorkspaceComputerSummary,
} from "@opentag/shared/browser";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentCreationFlow } from "../agent-creation/agent-creation-flow.js";
import { browserApi } from "../api.js";
import { OnboardingPage } from "./page.js";
import type { RuntimeFactsAdapter, RuntimeFactsResult, RuntimeProviderStatus } from "./runtime-facts.js";

const workspaceId = "d3fda800-7ce2-4338-aae8-3d2120401ed6";
const userId = "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e";
const computerAId = "85fe9af3-d1c6-472b-b78c-8a7ccf512750";
const computerBId = "95fe9af3-d1c6-472b-b78c-8a7ccf512750";
const agentId = "1a63a21e-f6c7-4474-91ea-4dabf0566a24";

const user: UserProfile = { id: userId, email: "ada@example.com", displayName: "Ada" };
const admin: MeWorkspace = {
  id: workspaceId,
  name: "example",
  displayName: "Example",
  setupCompletedAt: null,
  grantedAt: "2026-08-20T00:00:00.000Z",
};
const computerA: WorkspaceComputerSummary = {
  computerId: computerAId,
  displayName: "Ada's Mac",
  platform: "darwin",
  connectionStatus: "online",
  connectedAt: "2026-08-20T00:00:00.000Z",
  lastSeenAt: "2026-08-20T00:00:00.000Z",
  observedAt: "2026-08-20T00:00:00.000Z",
  enrolledAt: "2026-08-20T00:00:00.000Z",
  agentIds: [],
};
const computerB: WorkspaceComputerSummary = {
  ...computerA,
  computerId: computerBId,
  displayName: "Studio Mac",
};
const agent: AgentListItem = {
  id: agentId,
  workspaceId,
  name: "opentag",
  displayName: "OpenTag",
  createdBy: { userId, displayName: "Ada" },
  computer: {
    computerId: computerAId,
    displayName: computerA.displayName,
    platform: "darwin",
  },
  runtimeProvider: "codex",
  receiveMode: "mention_only",
  status: "active",
  activity: { state: "idle" },
  usage: { windowDays: 30, tasks: 0, failed: 0, tokens: 0 },
  createdAt: "2026-08-20T00:00:00.000Z",
  updatedAt: "2026-08-20T00:00:00.000Z",
};

function adminConfig(): AgentAdminConfig {
  return {
    id: agent.id,
    workspaceId,
    name: agent.name,
    displayName: agent.displayName,
    runtimeProvider: agent.runtimeProvider,
    receiveMode: "mention_only",
    status: "active",
    createdAt: agent.createdAt,
    updatedAt: agent.updatedAt,
    createdByUserId: userId,
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
}: {
  agents?: AgentListItem[];
  computers?: WorkspaceComputerSummary[];
  handoff?: ImBindingHandoffStatus;
} = {}) {
  vi.spyOn(browserApi, "computers").mockResolvedValue({ computers });
  vi.spyOn(browserApi, "agents").mockResolvedValue({ agents });
  vi.spyOn(browserApi, "imBindingHandoff").mockResolvedValue(handoff);
  vi.spyOn(browserApi, "logout").mockResolvedValue();
}

function renderPage({
  membership = admin,
  runtime = unavailableRuntime(),
}: {
  membership?: MeWorkspace;
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
    const runtime = await screen.findByRole("region", { name: "Where it runs" });
    expect(within(runtime).getByText("Ada's Mac")).toBeTruthy();
    expect(within(runtime).getByText("Codex")).toBeTruthy();
    fireEvent.click(within(runtime).getByRole("button", { name: "Change Computer" }));
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

    const runtime = await screen.findByRole("region", { name: "Where it runs" });
    fireEvent.click(within(runtime).getByRole("button", { name: "Change Computer" }));
    fireEvent.click(screen.getByRole("button", { name: /Studio Mac/ }));
    expect(within(runtime).getByText("Studio Mac")).toBeTruthy();
    expect(within(runtime).getByText("Codex")).toBeTruthy();
  });

  it("shows unavailable Runtime states after selecting a Computer without a ready route", async () => {
    installFacts({ computers: [computerA, computerB] });
    renderPage({
      runtime: runtimeFacts([
        { computerId: computerAId, provider: "codex", runtimeReady: true, status: "ready" },
        { computerId: computerBId, provider: "claude-code", runtimeReady: false, status: "sign-in" },
      ]),
    });

    const runtime = await screen.findByRole("region", { name: "Where it runs" });
    expect(within(runtime).getByText("Ada's Mac")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create Agent" })).toHaveProperty("disabled", false);

    fireEvent.click(within(runtime).getByRole("button", { name: "Change Computer" }));
    const unavailableComputer = within(runtime).getByRole("button", { name: /Studio Mac/ });
    expect(unavailableComputer).toHaveProperty("disabled", false);
    fireEvent.click(unavailableComputer);

    expect(within(runtime).getByText("Studio Mac")).toBeTruthy();
    expect(within(runtime).getByText("Claude Code")).toBeTruthy();
    expect(within(runtime).getByText("Sign-in required")).toBeTruthy();
    expect(within(runtime).getByText("Finish sign-in on Studio Mac.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create Agent" })).toHaveProperty("disabled", true);
  });

  it("allows inspecting an unconfirmed Computer before runtime facts arrive", async () => {
    installFacts({ computers: [computerA, computerB] });
    renderPage();
    const runtime = await screen.findByRole("region", { name: "Where it runs" });
    expect(within(runtime).getByText("Readiness unconfirmed")).toBeTruthy();
    fireEvent.click(within(runtime).getByRole("button", { name: "Change Computer" }));
    const studioMac = within(runtime).getByRole("button", { name: /Studio Mac/ });
    expect(studioMac).toHaveProperty("disabled", false);
    fireEvent.click(studioMac);
    expect(within(runtime).getByText("Studio Mac")).toBeTruthy();
    expect(within(runtime).getByText("Readiness unconfirmed")).toBeTruthy();
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

  it("asks the Server to complete setup as soon as the verified handoff is ready", async () => {
    const onSetupReady = vi.fn().mockResolvedValue(undefined);
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
    render(<OnboardingPage membership={admin} onSetupReady={onSetupReady} user={user} />);

    await waitFor(() => expect(onSetupReady).toHaveBeenCalledWith(agentId));
    expect(screen.getByRole("heading", { name: "Finishing OpenTag setup" })).toBeTruthy();
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
    expect(new URL(manage.href).pathname).toBe(`/agents/${agentId}`);
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
        workspaceId,
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

    const runtime = await screen.findByRole("region", { name: "Where it runs" });
    expect(within(runtime).getByText("Codex")).toBeTruthy();
    expect(create).not.toHaveBeenCalled();
    fireEvent.click(within(runtime).getByRole("button", { name: "Change Runtime" }));
    fireEvent.click(within(runtime).getByRole("button", { name: /Claude Code/ }));
    expect(within(runtime).getByText("Claude Code")).toBeTruthy();
    expect(create).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Create Agent" }));
    await waitFor(() =>
      expect(create).toHaveBeenCalledWith(
        workspaceId,
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

    const runtimeRegion = await screen.findByRole("region", { name: "Where it runs" });
    expect(within(runtimeRegion).getByText("Codex")).toBeTruthy();
    fireEvent.click(within(runtimeRegion).getByRole("button", { name: "Change Runtime" }));
    fireEvent.click(within(runtimeRegion).getByRole("button", { name: /Claude Code/ }));
    expect(within(runtimeRegion).getByText("Claude Code")).toBeTruthy();
    expect(runtime.load).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Create Agent" }));
    await waitFor(() =>
      expect(create).toHaveBeenCalledWith(
        workspaceId,
        expect.objectContaining({ computerId: computerAId, runtimeProvider: "claude-code" }),
      ),
    );
  });

  it("replays a lost create response with the same creationIntentId", async () => {
    let serverAgents: AgentListItem[] = [];
    const agentReads = vi.spyOn(browserApi, "agents").mockImplementation(async () => ({ agents: serverAgents }));
    vi.spyOn(browserApi, "computers").mockResolvedValue({ computers: [computerA] });
    vi.spyOn(browserApi, "imBindingHandoff").mockResolvedValue(undefined);
    const requests: CreateAgentRequest[] = [];
    vi.spyOn(browserApi, "createAgent").mockImplementation(async (_workspaceId, request) => {
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
    let serverAgents: AgentListItem[] = [];
    vi.spyOn(browserApi, "agents").mockImplementation(async () => ({ agents: serverAgents }));
    vi.spyOn(browserApi, "computers").mockResolvedValue({ computers: [computerA] });
    vi.spyOn(browserApi, "imBindingHandoff").mockResolvedValue(undefined);
    const requests: CreateAgentRequest[] = [];
    const create = vi.spyOn(browserApi, "createAgent").mockImplementation(async (_workspaceId, request) => {
      requests.push(request);
      if (requests.length === 1) throw new Error("Connection closed before the response");
      serverAgents = [agent];
      return adminConfig();
    });
    const runtime = runtimeFacts([{ computerId: computerAId, provider: "codex", runtimeReady: true }]);
    const firstPage = renderPage({ runtime });
    fireEvent.click(await screen.findByRole("button", { name: "Create Agent" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Connection closed before the response");
    const durableRecord = window.localStorage.getItem(`opentag.agent-creation.intent:${workspaceId}`);
    expect(durableRecord).toBeTruthy();

    firstPage.unmount();
    renderPage({ runtime });
    expect(await screen.findByRole("heading", { name: "Connect OpenTag to Feishu" })).toBeTruthy();
    expect(create).toHaveBeenCalledTimes(2);
    expect(requests[0]?.creationIntentId).toBe(requests[1]?.creationIntentId);
    expect(window.localStorage.getItem(`opentag.agent-creation.intent:${workspaceId}`)).toBeNull();
  });

  it("uses one logical create across parallel page controllers", async () => {
    let serverAgents: AgentListItem[] = [];
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
    vi.spyOn(browserApi, "createAgent").mockImplementation(async (_workspaceId, request) => {
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
          workspaceId={workspaceId}
          onCreated={alphaCreated}
          onRefresh={() => undefined}
        />
        <AgentCreationFlow
          facts={facts}
          initialDisplayName="Beta"
          workspaceId={workspaceId}
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
    const stored = JSON.parse(String(window.localStorage.getItem(`opentag.agent-creation.intent:${workspaceId}`))) as {
      records: { creationIntentId: string }[];
    };
    expect(stored.records).toHaveLength(1);
    expect(stored.records[0]?.creationIntentId).toBe(betaRequest?.creationIntentId);

    fireEvent.click(betaAction);
    await waitFor(() => expect(betaCreated).toHaveBeenCalledTimes(1));
    const betaRequests = requests.filter((request) => request.displayName === "Beta");
    expect(betaRequests).toHaveLength(2);
    expect(betaRequests[1]?.creationIntentId).toBe(betaRequests[0]?.creationIntentId);
    expect(window.localStorage.getItem(`opentag.agent-creation.intent:${workspaceId}`)).toBeNull();
  });

  it("reloads Server facts after Computer setup succeeds", async () => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-20T00:00:00.000Z");
    const computers = vi.spyOn(browserApi, "computers");
    vi.spyOn(browserApi, "agents").mockResolvedValue({ agents: [] });
    vi.spyOn(browserApi, "imBindingHandoff").mockResolvedValue(undefined);
    const connectedComputer: WorkspaceComputerSummary = {
      ...computerA,
      connectedAt: "2026-08-20T00:00:01.000Z",
      lastSeenAt: "2026-08-20T00:00:01.000Z",
      observedAt: "2026-08-20T00:00:01.000Z",
    };
    computers
      .mockResolvedValueOnce({ computers: [] })
      .mockResolvedValueOnce({ computers: [] })
      .mockResolvedValue({ computers: [connectedComputer] });
    vi.spyOn(browserApi, "issueComputerConnectCode").mockResolvedValue({
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

    expect(computers.mock.calls.length).toBeGreaterThanOrEqual(4);
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
    let finishRefresh: ((value: { computers: WorkspaceComputerSummary[] }) => void) | undefined;
    const pendingComputers = new Promise<{ computers: WorkspaceComputerSummary[] }>((resolve) => {
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
    const storageWorkspaceId = "a3fda800-7ce2-4338-aae8-3d2120401ed6";
    const storageAdmin = { ...admin, id: storageWorkspaceId };
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
    const runtime = await screen.findByRole("region", { name: "Where it runs" });
    fireEvent.click(within(runtime).getByRole("button", { name: "Change Computer" }));
    fireEvent.click(screen.getByRole("button", { name: /Studio Mac/ }));

    expect(within(runtime).getByText("Studio Mac")).toBeTruthy();
    expect(within(runtime).getByText("Codex")).toBeTruthy();
  });

  it("publishes an explicit Agent choice for the route URL anchor", async () => {
    const storageWorkspaceId = "b3fda800-7ce2-4338-aae8-3d2120401ed6";
    const storageAdmin = { ...admin, id: storageWorkspaceId };
    const researchAgent: AgentListItem = {
      ...agent,
      id: "2a63a21e-f6c7-4474-91ea-4dabf0566a24",
      workspaceId: storageWorkspaceId,
      name: "research",
      displayName: "Research Agent",
    };
    const handoff = vi.spyOn(browserApi, "imBindingHandoff").mockResolvedValue(undefined);
    const onTargetAgentChange = vi.fn();
    vi.spyOn(browserApi, "computers").mockResolvedValue({ computers: [computerA] });
    vi.spyOn(browserApi, "agents").mockResolvedValue({
      agents: [{ ...agent, workspaceId: storageWorkspaceId }, researchAgent],
    });
    vi.spyOn(browserApi, "logout").mockResolvedValue();

    render(
      <OnboardingPage
        membership={storageAdmin}
        onTargetAgentChange={onTargetAgentChange}
        runtimeFacts={runtimeFacts([
          { computerId: computerAId, provider: "codex", runtimeReady: true, status: "ready" },
        ])}
        user={user}
      />,
    );
    fireEvent.click(await screen.findByRole("button", { name: /Research Agent/ }));

    expect(await screen.findByRole("heading", { name: "Connect OpenTag to Feishu" })).toBeTruthy();
    expect(handoff).toHaveBeenLastCalledWith(researchAgent.id);
    expect(onTargetAgentChange).toHaveBeenCalledWith(researchAgent.id);
  });
});
