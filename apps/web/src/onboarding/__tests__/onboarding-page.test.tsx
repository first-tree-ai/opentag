import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../../app.js";

const teamId = "d3fda800-7ce2-4338-aae8-3d2120401ed6";
const userId = "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e";
const agentId = "1a63a21e-f6c7-4474-91ea-4dabf0566a24";
const computerId = "85fe9af3-d1c6-472b-b78c-8a7ccf512750";
const secondComputerId = "6f2a3d19-59ab-4f0a-9a3e-8f1d2c3b4a5e";

interface Scenario {
  role?: "admin" | "member";
  memberships?: boolean;
  computers?: "none" | "offline" | "one" | "two";
  agents?: boolean;
  binding?: "none" | "active" | "error";
  createAgent?: "ok" | "conflict";
  receiveMode?: "mention_only" | "all_message";
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function computerRecord(id: string, displayName: string, connectionStatus: "online" | "offline") {
  return {
    id,
    ownerUserId: userId,
    displayName,
    platform: "darwin",
    arch: "arm64",
    clientVersion: "0.0.1",
    connectionStatus,
    connectedAt: connectionStatus === "online" ? "2026-08-20T00:00:00.000Z" : null,
    lastSeenAt: "2026-08-20T00:00:00.000Z",
  };
}

const agentRecord = {
  id: agentId,
  teamId,
  name: "reviewer",
  displayName: "Reviewer",
  manager: { userId, displayName: "Ada" },
  computer: { id: computerId, displayName: "Ada's Mac", platform: "darwin" },
  runtimeProvider: "codex",
  receiveMode: "mention_only",
  createdAt: "2026-08-20T00:00:00.000Z",
  updatedAt: "2026-08-20T00:00:00.000Z",
};

const { manager: _manager, computer: _computer, ...agentIdentity } = agentRecord;

// AgentAdminConfig is strict and carries flat manager/computer IDs, not the
// nested summary objects.
const agentConfigRecord = {
  ...agentIdentity,
  managerUserId: userId,
  computerId,
  revision: 1,
  runtimeConfig: {
    revision: 1,
    model: null,
    reasoningEffort: null,
    instructions: "",
    allowedTools: [],
    maxDurationMs: null,
  },
};

function installApi(scenario: Scenario = {}) {
  const {
    role = "admin",
    memberships = true,
    computers = "one",
    agents = false,
    binding = "none",
    createAgent = "ok",
    receiveMode = "mention_only",
  } = scenario;
  const createdAgents: unknown[] = [];
  const calls = { createAgent: 0, connectCodes: 0 };
  let conflictObserved = false;
  const teamComputers =
    computers === "none"
      ? []
      : [computerRecord(computerId, "Ada's Mac", computers === "offline" ? "offline" : "online")];
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    const path = String(input);
    const method = init?.method ?? "GET";
    if (path === "/api/v1/me") {
      return json({
        user: { id: userId, email: "ada@example.com", displayName: "Ada" },
        memberships: memberships ? [{ teamId, teamName: "example", teamDisplayName: "Example", role }] : [],
      });
    }
    if (path === "/api/v1/me/computers") {
      if (computers === "none") return json({ computers: [] });
      if (computers === "offline") return json({ computers: [computerRecord(computerId, "Ada's Mac", "offline")] });
      if (computers === "two") {
        return json({
          computers: [
            computerRecord(computerId, "Ada's Mac", "online"),
            computerRecord(secondComputerId, "Build box", "online"),
          ],
        });
      }
      return json({ computers: [computerRecord(computerId, "Ada's Mac", "online")] });
    }
    if (path === "/api/v1/me/connect-codes" && method === "POST") {
      calls.connectCodes += 1;
      return json(
        {
          bootstrapCommand: "npm i -g @opentag/cli && opentag login --code example",
          expiresIn: 900,
          issuedAt: "2026-08-20T00:00:00.000Z",
        },
        201,
      );
    }
    if (path === `/api/v1/teams/${teamId}/computers`) {
      // TeamComputerSummary is strict: it has no arch/clientVersion.
      return json({
        computers: teamComputers.map(({ arch: _arch, clientVersion: _clientVersion, ...computer }) => ({
          ...computer,
          ownerDisplayName: "Ada",
          observedAt: computer.lastSeenAt,
          agentIds: [],
        })),
      });
    }
    if (path === `/api/v1/teams/${teamId}/agents`) {
      if (method === "POST") {
        calls.createAgent += 1;
        if (createAgent === "conflict") {
          conflictObserved = true;
          return json(
            {
              error: {
                code: "AGENT_NAME_CONFLICT",
                category: "deterministic",
                message: "An active Agent already uses this name",
              },
            },
            409,
          );
        }
        createdAgents.push(JSON.parse(String(init?.body)));
        return json(agentConfigRecord, 201);
      }
      const existing = agents || conflictObserved || createdAgents.length > 0 ? [{ ...agentRecord, receiveMode }] : [];
      return json({ agents: existing });
    }
    if (path === `/api/v1/agents/${agentId}/config`) return json(agentConfigRecord);
    if (path === `/api/v1/agents/${agentId}/im-binding`) {
      if (binding === "none") return new Response(null, { status: 204 });
      return json({
        id: "0b2e0f1e-2a1c-4a5d-9f0e-7c1a2b3c4d5e",
        agentId,
        provider: "feishu",
        bindingState: binding === "active" ? "active" : "error",
        bot: { displayName: "Reviewer", avatarUrl: null },
        receiveMode: "mention_only",
        lastInboundAt: null,
        lastOutboundAt: null,
        lastConfirmedAt: "2026-08-20T00:00:00.000Z",
      });
    }
    if (path === `/api/v1/agents/${agentId}/im-binding/feishu/setup-attempts` && method === "POST") {
      return json(
        {
          id: "c3a1f0d2-4b5e-4c6a-9d8f-0e1a2b3c4d5e",
          agentId,
          intent: "create",
          state: "awaiting_user",
          qrUrl: "https://open.feishu.cn/setup",
          expiresAt: "2026-08-20T00:15:00.000Z",
          errorCode: null,
          completedAt: null,
          createdAt: "2026-08-20T00:00:00.000Z",
        },
        201,
      );
    }
    throw new Error(`Unexpected request: ${method} ${path}`);
  });
  return { calls, createdAgents };
}

function renderOnboarding() {
  window.history.replaceState({}, "", "/onboarding");
  render(<App />);
}

describe("Onboarding flow", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.history.replaceState({}, "", "/onboarding");
  });

  it("routes a signed-in user with no Team to onboarding instead of a dead end", async () => {
    installApi({ memberships: false });
    window.history.replaceState({}, "", "/agents");
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Create or join a Team" })).toBeTruthy();
    expect(window.location.pathname).toBe("/onboarding");
    expect(screen.queryByText("No active Team")).toBeNull();
  });

  it("offers the same Team creation form in the first step as the standalone page", async () => {
    installApi({ memberships: false });
    renderOnboarding();
    expect(await screen.findByRole("heading", { name: "Create or join a Team" })).toBeTruthy();
    expect(screen.getByLabelText("Display name")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create Team" })).toBeTruthy();
  });

  it("starts at the Computer step for a Team with nothing connected", async () => {
    installApi({ computers: "none" });
    renderOnboarding();
    expect(await screen.findByRole("heading", { name: "Connect a Local Computer" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Generate connection command" })).toBeTruthy();
  });

  it("stays on the Computer step while the only Computer is offline", async () => {
    installApi({ computers: "offline" });
    renderOnboarding();
    expect(await screen.findByRole("heading", { name: "Connect a Local Computer" })).toBeTruthy();
  });

  it("issues a connection command only after an explicit click", async () => {
    const { calls } = installApi({ computers: "none" });
    renderOnboarding();
    const button = await screen.findByRole("button", { name: "Generate connection command" });
    expect(calls.connectCodes).toBe(0);
    fireEvent.click(button);
    await waitFor(() => expect(calls.connectCodes).toBe(1));
    expect(await screen.findByText(/opentag login --code example/)).toBeTruthy();
  });

  it("asks the admin to confirm Codex before creating an Agent", async () => {
    installApi();
    renderOnboarding();
    expect(await screen.findByRole("heading", { name: "Prepare the Codex CLI" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Codex is ready on Ada's Mac" }));
    expect(await screen.findByRole("heading", { name: "Create your Agent" })).toBeTruthy();
  });

  it("does not show a Computer or Provider selector when only one option is real", async () => {
    installApi();
    window.localStorage.setItem(`opentag.onboarding.providerReady:${computerId}`, "true");
    renderOnboarding();
    expect(await screen.findByRole("heading", { name: "Create your Agent" })).toBeTruthy();
    expect(screen.queryByLabelText("Computer")).toBeNull();
    expect(screen.queryByLabelText("Provider")).toBeNull();
    expect(screen.getByText("Runs Codex on Ada's Mac.")).toBeTruthy();
  });

  it("asks which Computer only when more than one is online", async () => {
    installApi({ computers: "two" });
    window.localStorage.setItem(`opentag.onboarding.providerReady:${computerId}`, "true");
    renderOnboarding();
    expect(await screen.findByRole("heading", { name: "Create your Agent" })).toBeTruthy();
    expect(screen.getByLabelText("Computer")).toBeTruthy();
  });

  it("creates the Agent with a derived name and the mention_only default", async () => {
    const { createdAgents } = installApi();
    window.localStorage.setItem(`opentag.onboarding.providerReady:${computerId}`, "true");
    renderOnboarding();
    const name = await screen.findByLabelText("Agent name");
    fireEvent.change(name, { target: { value: "Release Captain" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Agent" }));
    await waitFor(() => expect(createdAgents).toHaveLength(1));
    expect(createdAgents[0]).toEqual({
      name: "release-captain",
      displayName: "Release Captain",
      runtimeProvider: "codex",
      computerId,
    });
    expect(createdAgents[0]).not.toHaveProperty("receiveMode");
  });

  it("recovers the existing Agent instead of failing when the create response was lost", async () => {
    installApi({ createAgent: "conflict" });
    window.localStorage.setItem(`opentag.onboarding.providerReady:${computerId}`, "true");
    renderOnboarding();
    const name = await screen.findByLabelText("Agent name");
    fireEvent.change(name, { target: { value: "Reviewer" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Agent" }));
    expect(await screen.findByRole("heading", { name: "Connect Feishu" })).toBeTruthy();
    expect(screen.queryByText("An active Agent already uses this name")).toBeNull();
  });

  it("moves to Feishu once an Agent exists", async () => {
    installApi({ agents: true });
    renderOnboarding();
    expect(await screen.findByRole("heading", { name: "Connect Feishu" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Connect Feishu" })).toBeTruthy();
  });

  it("creates a Feishu setup attempt only after an explicit click", async () => {
    installApi({ agents: true });
    renderOnboarding();
    const connect = await screen.findByRole("button", { name: "Connect Feishu" });
    const attempts = () =>
      vi.mocked(fetch).mock.calls.filter(([path]) => String(path).includes("feishu/setup-attempts"));
    expect(attempts()).toHaveLength(0);
    fireEvent.click(connect);
    await waitFor(() => expect(attempts()).toHaveLength(1));
    expect(await screen.findByText(/Feishu setup started/)).toBeTruthy();
  });

  it("keeps the Agent ready and offers reauthorization when the binding is broken", async () => {
    installApi({ agents: true, binding: "error" });
    renderOnboarding();
    expect(await screen.findByRole("heading", { name: "Connect Feishu" })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain(
      "Reviewer is still ready for work that does not go through feishu",
    );
    expect(screen.getByRole("button", { name: "Reauthorize Feishu" })).toBeTruthy();
  });

  it("finishes with a ready Agent and a way into Feishu", async () => {
    installApi({ agents: true, binding: "active" });
    renderOnboarding();
    expect(await screen.findByRole("heading", { name: "Start working in Feishu" })).toBeTruthy();
    expect(screen.getByText("Reviewer is ready.")).toBeTruthy();
    expect(screen.getByText(/@ it/)).toBeTruthy();
    // The Server serves both Feishu and Lark tenants, so no IM host is hardcoded.
    expect(screen.queryByRole("link", { name: "Open Feishu" })).toBeNull();
    expect(document.body.innerHTML).not.toContain("feishu.cn");
    expect(screen.getByRole("link", { name: "Manage Reviewer" }).getAttribute("href")).toBe(
      `/agents/${agentId}/general`,
    );
  });

  it("describes the Admin's real progress to a member without their own Computers", async () => {
    // The member owns no Computer, so an own-scoped read would claim the Admin is
    // still on step 2 while the Team-scoped list shows the Computer is connected.
    installApi({ role: "member", computers: "one", agents: false });
    renderOnboarding();
    expect(await screen.findByRole("heading", { name: "A Team Admin is setting OpenTag up" })).toBeTruthy();
    const progress = screen.getByRole("list", { name: "Setup progress" });
    expect(progress.querySelector('[data-status="current"]')?.textContent).toContain("Create your Agent");
    expect(progress.querySelector('[data-status="done"]')?.textContent).toContain("Create or join a Team");
    expect(vi.mocked(fetch).mock.calls.some(([path]) => String(path) === "/api/v1/me/computers")).toBe(false);
  });

  it("reports the Agent's real receive mode in the completion state", async () => {
    installApi({ agents: true, binding: "active", receiveMode: "all_message" });
    renderOnboarding();
    expect(await screen.findByRole("heading", { name: "Start working in Feishu" })).toBeTruthy();
    expect(screen.getByText("Receives every message")).toBeTruthy();
    expect(screen.queryByText("Replies only when mentioned")).toBeNull();
  });

  it("shows members a read-only account of progress with no controls", async () => {
    installApi({ role: "member", agents: true });
    renderOnboarding();
    expect(await screen.findByRole("heading", { name: "A Team Admin is setting OpenTag up" })).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByLabelText("Agent name")).toBeNull();
    expect(screen.queryByRole("button", { name: "Connect Feishu" })).toBeNull();
  });

  it("re-derives the same step after a reload instead of replaying earlier steps", async () => {
    installApi({ agents: true });
    renderOnboarding();
    expect(await screen.findByRole("heading", { name: "Connect Feishu" })).toBeTruthy();
    const attemptsBefore = vi.mocked(fetch).mock.calls.filter(([path]) => String(path).includes("setup-attempts"));
    expect(attemptsBefore).toHaveLength(0);
  });
});

describe("Onboarding IM recovery", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.history.replaceState({}, "", "/onboarding");
  });

  it("hands a degraded Slack binding to the Agent IM tab instead of a Feishu attempt", async () => {
    vi.mocked(fetch).mockImplementation(async (input) => {
      const path = String(input);
      if (path === "/api/v1/me") {
        return json({
          user: { id: userId, email: "ada@example.com", displayName: "Ada" },
          memberships: [{ teamId, teamName: "example", teamDisplayName: "Example", role: "admin" }],
        });
      }
      if (path === "/api/v1/me/computers") {
        return json({ computers: [computerRecord(computerId, "Ada's Mac", "online")] });
      }
      if (path === `/api/v1/teams/${teamId}/agents`) return json({ agents: [agentRecord] });
      if (path === `/api/v1/agents/${agentId}/im-binding`) {
        return json({
          id: "0b2e0f1e-2a1c-4a5d-9f0e-7c1a2b3c4d5e",
          agentId,
          provider: "slack",
          bindingState: "error",
          bot: { displayName: "Reviewer", avatarUrl: null },
          receiveMode: "mention_only",
          lastInboundAt: null,
          lastOutboundAt: null,
          lastConfirmedAt: null,
        });
      }
      throw new Error(`Unexpected request: ${path}`);
    });
    renderOnboarding();
    expect(await screen.findByRole("heading", { name: "Connect Feishu" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Review the IM binding for Reviewer" }).getAttribute("href")).toBe(
      `/agents/${agentId}/im`,
    );
    expect(screen.queryByRole("button", { name: "Reauthorize Feishu" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Connect Feishu" })).toBeNull();
  });
});

describe("Onboarding provider confirmation", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.history.replaceState({}, "", "/onboarding");
  });

  it("requires confirming the picked Computer when more than one is online", async () => {
    const { createdAgents } = installApi({ computers: "two" });
    renderOnboarding();
    const name = await screen.findByLabelText("Agent name");
    fireEvent.change(name, { target: { value: "Reviewer" } });
    const confirm = screen.getByLabelText("Codex is installed and signed in on that Computer") as HTMLInputElement;
    expect(confirm.required).toBe(true);
    fireEvent.click(confirm);
    fireEvent.change(screen.getByLabelText("Computer"), { target: { value: secondComputerId } });
    fireEvent.click(screen.getByRole("button", { name: "Create Agent" }));
    await waitFor(() => expect(createdAgents).toHaveLength(1));
    // The confirmation is recorded against the Computer that was actually chosen.
    expect(createdAgents[0]).toMatchObject({ computerId: secondComputerId });
    expect(window.localStorage.getItem(`opentag.onboarding.providerReady:${secondComputerId}`)).toBe("true");
    expect(window.localStorage.getItem(`opentag.onboarding.providerReady:${computerId}`)).toBeNull();
  });

  it("names the Computer it is asking about when only one is online", async () => {
    installApi();
    renderOnboarding();
    expect(await screen.findByRole("heading", { name: "Prepare the Codex CLI" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Codex is ready on Ada's Mac" }));
    expect(await screen.findByRole("heading", { name: "Create your Agent" })).toBeTruthy();
    expect(window.localStorage.getItem(`opentag.onboarding.providerReady:${computerId}`)).toBe("true");
  });
});
