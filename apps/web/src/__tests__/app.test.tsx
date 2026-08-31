import type { AgentUsageDetail } from "@opentag/shared/browser";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../app.js";
import { PasswordSignInForm } from "../features/auth/password-sign-in-form.js";

const userId = "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e";
const memberUserId = "63e2babe-e4ac-4e2c-b7d1-d092d5a4568e";
const agentId = "1a63a21e-f6c7-4474-91ea-4dabf0566a24";
const computerId = "85fe9af3-d1c6-472b-b78c-8a7ccf512750";
const taskSessionId = "11111111-1111-4111-8111-111111111111";
const secondComputerId = "95fe9af3-d1c6-472b-b78c-8a7ccf512750";
const creationIntentKey = `opentag.agent-creation.intent:${userId}`;

/** Two Computers an Agent could run on, so a reader has something to choose between. */
const twoReadyComputers = [
  {
    id: computerId,
    displayName: "Ada's Mac",
    platform: "darwin",
    connectionStatus: "online",
    providerReadiness: [{ provider: "codex", status: "ready", observedAt: "2026-08-20T00:00:00.000Z" }],
    connectedAt: "2026-08-20T00:00:00.000Z",
    lastSeenAt: "2026-08-20T00:00:00.000Z",
  },
  {
    id: secondComputerId,
    displayName: "Zulu Tower",
    platform: "linux",
    connectionStatus: "online",
    providerReadiness: [{ provider: "codex", status: "ready", observedAt: "2026-08-20T00:00:01.000Z" }],
    connectedAt: "2026-08-20T00:00:01.000Z",
    lastSeenAt: "2026-08-20T00:00:01.000Z",
  },
];

/** Writes one version-3 creation intent, the shape a previous visit would have left behind. */
function storeCreationIntent(record: { creationIntentId: string; request: Record<string, unknown> }) {
  const stored = { version: 3, accountId: userId, ...record };
  window.localStorage.setItem(creationIntentKey, JSON.stringify({ version: 3, accountId: userId, records: [stored] }));
  return stored;
}

function agentCreationPosts() {
  return vi.mocked(fetch).mock.calls.filter(([path, init]) => path === "/api/v1/agents" && init?.method === "POST");
}

const agentSummary = {
  id: agentId,
  name: "reviewer",
  displayName: "Reviewer",
  createdBy: { userId, displayName: "Ada" },
  computer: {
    computerId,
    displayName: "Ada's Mac",
    platform: "darwin",
  },
  runtimeProvider: "codex",
  receiveMode: "mention_only",
  status: "active",
  createdAt: "2026-08-20T00:00:00.000Z",
  updatedAt: "2026-08-20T00:00:00.000Z",
};
const agentListItem = {
  ...agentSummary,
  activity: { state: "idle" as const },
  usage: { windowDays: 30 as const, tasks: 32, failed: 0, tokens: 428_000 },
};
const taskSummary = {
  id: taskSessionId,
  agent: { id: agentId, name: "reviewer", displayName: "Reviewer", runtimeProvider: "codex" },
  source: { provider: "feishu", conversationKind: "dm", channelId: "oc_debug", threadKey: null },
  sessionKind: "channel",
  title: "Investigate the failed deployment",
  status: "completed",
  createdAt: "2026-08-20T00:00:00.000Z",
  endedAt: null,
  lastActivityAt: "2026-08-20T00:02:00.000Z",
};

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function installApi(
  options: {
    agentCreator?: { userId: string; displayName: string };
    agentRead?: () => Promise<void> | void;
    agentReadStatus?: () => number | undefined;
    agentUsage?: Omit<AgentUsageDetail, "endedAt" | "startedAt" | "windowDays">;
    agentListStatus?: () => number | undefined;
    agentActivity?: { state: "idle" } | { state: "working"; startedAt: string };
    emptyAgents?: boolean;
    agentCreate?: (input: Record<string, unknown>) => Promise<void> | void;
    multipleMemberships?: boolean;
    agentCreateError?: "conflict" | "generic" | "name";
    authProviders?: readonly { enabled: boolean; id: string; startUrl: string | null }[];
    passwordSignInFails?: boolean;
    bindingReauth?: boolean;
    bindingEvidenceFails?: boolean;
    bindingState?: "provisioning" | "active";
    bound?: boolean;
    computers?:
      | readonly Record<string, unknown>[]
      | ((connected: boolean) => Promise<readonly Record<string, unknown>[]> | readonly Record<string, unknown>[]);
    computerEvidenceFails?: boolean;
    computerProviderReadiness?: readonly {
      observedAt: string | null;
      provider: "codex" | "claude-code";
      status: "checking" | "install" | "sign-in" | "ready" | "unavailable";
    }[];
    computerStatus?: () => "online" | "offline";
    computerReadStatus?: (connected: boolean) => number | undefined;
    handoffReady?: boolean;
    /** Fails only the handoff read, so the binding stays readable and `handoff_unconfirmed` is reachable. */
    handoffEvidenceFails?: boolean;
    initialStatus?: "active" | "suspended";
    provider?: "feishu" | "slack";
    runtimeProvider?: "codex" | "claude-code";
    meDelayMsAfterProfileUpdate?: number;
    meFailuresAfterProfileUpdate?: number;
    /** Answers the `/me` refresh a profile save starts, so a test can hold it across a sign-out. */
    meAfterProfileUpdate?: () => Promise<Response> | Response;
    profileUpdate?: (displayName: string) => Promise<Response> | Response;
    profileUpdateFails?: boolean;
    setupFailureCode?: string;
    setupCompletedAt?: string | null;
    unauthenticated?: boolean;
    meAfterLogout?: () => Promise<Response> | Response;
    workspaceless?: boolean;
  } = {},
) {
  let lifecycleStatus = options.initialStatus ?? "active";
  let revision = lifecycleStatus === "active" ? 1 : 2;
  const adminConfig = () => ({
    id: agentId,
    name: agentSummary.name,
    displayName: agentSummary.displayName,
    runtimeProvider: options.runtimeProvider ?? agentSummary.runtimeProvider,
    receiveMode: agentSummary.receiveMode,
    status: lifecycleStatus,
    createdAt: agentSummary.createdAt,
    updatedAt: agentSummary.updatedAt,
    createdByUserId: options.agentCreator?.userId ?? userId,
    computerId,
    revision,
    runtimeConfig: {
      revision: 1,
      model: null,
      reasoningEffort: null,
      instructions: "",
      maxDurationMs: null,
    },
  });
  let setupCompletedAt = options.setupCompletedAt === undefined ? "2026-08-20T00:00:00.000Z" : options.setupCompletedAt;
  let currentDisplayName = "Ada";
  let profileUpdated = false;
  let loggedOut = false;
  let meFailuresRemaining = options.meFailuresAfterProfileUpdate ?? 0;
  let computerConnectCodeIssued = false;
  const connectCodeId = "7a1c9e52-9a8b-4c7d-8e1f-2a3b4c5d6e7f";
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    const path = String(input);
    if (path === "/api/v1/auth/providers") {
      return json({
        providers: options.authProviders ?? [{ id: "dev", enabled: true, startUrl: "/api/v1/auth/dev/callback" }],
      });
    }
    if (path === "/api/v1/auth/email/sign-in" || path === "/api/v1/auth/email/sign-up") {
      return options.passwordSignInFails
        ? json(
            {
              error: {
                code: "AUTH_INVALID_TOKEN",
                category: "credential",
                message: "The email address or password is incorrect",
              },
            },
            401,
          )
        : new Response(null, { status: 204 });
    }
    if (path === "/api/v1/me" && init?.method === "PATCH") {
      const body = JSON.parse(String(init.body)) as { displayName: string };
      const response = options.profileUpdate
        ? await options.profileUpdate(body.displayName)
        : options.profileUpdateFails
          ? json(
              {
                error: {
                  code: "VALIDATION_ERROR",
                  category: "validation",
                  message: "Display name update failed",
                },
              },
              400,
            )
          : json({ id: userId, email: "ada@example.com", displayName: body.displayName.trim() });
      if (response.ok) {
        currentDisplayName = body.displayName.trim();
        profileUpdated = true;
      }
      return response;
    }
    if (path === "/api/v1/me") {
      if (loggedOut && options.meAfterLogout) return options.meAfterLogout();
      if (options.unauthenticated) return json({ error: { message: "Sign in required" } }, 401);
      if (profileUpdated && options.meAfterProfileUpdate) return options.meAfterProfileUpdate();
      if (profileUpdated && options.meDelayMsAfterProfileUpdate) {
        await new Promise((resolve) => setTimeout(resolve, options.meDelayMsAfterProfileUpdate));
      }
      if (profileUpdated && meFailuresRemaining > 0) {
        meFailuresRemaining -= 1;
        return json(
          { error: { code: "SERVICE_UNAVAILABLE", category: "transient", message: "Account state unavailable" } },
          503,
        );
      }
      return json({
        user: { id: userId, email: "ada@example.com", displayName: currentDisplayName },
        setupCompletedAt: options.workspaceless ? null : setupCompletedAt,
      });
    }
    if (path === "/api/v1/me/setup/complete" && init?.method === "POST") {
      setupCompletedAt = "2026-08-20T00:10:00.000Z";
      return json({ setupCompletedAt });
    }
    if (path === "/api/v1/sessions" || path.startsWith("/api/v1/sessions?")) {
      return json({ tasks: [taskSummary], nextCursor: null });
    }
    if (path === `/api/v1/sessions/${taskSessionId}`) {
      return json({
        task: taskSummary,
        turns: [
          {
            deliveryId: "33333333-3333-4333-8333-333333333333",
            attention: "direct",
            delivery: {
              state: "accepted",
              attemptCount: 1,
              acceptedAt: "2026-08-20T00:01:00.000Z",
              steeredAt: null,
              expiresAt: "2026-08-21T00:00:00.000Z",
              reason: null,
              lastErrorCode: null,
            },
            message: {
              id: "44444444-4444-4444-8444-444444444444",
              externalMessageId: "om_debug",
              operation: "created",
              authorKind: "human",
              authorDisplayName: "Mia",
              fallbackText: "Please investigate the failed deployment.",
              truncated: false,
              occurredAt: "2026-08-20T00:00:00.000Z",
            },
            absorbedBy: null,
            report: {
              turnId: "turn-debug",
              outcome: "completed",
              executionEffects: "completed",
              finalText: "Stored runtime output",
              errorReason: null,
              usage: null,
              traceSummary: { lastSequence: 2, droppedEvents: 0 },
              reportedAt: "2026-08-20T00:02:00.000Z",
            },
          },
        ],
        internalSessions: [],
        collaborationMessages: [],
        nextCursor: null,
      });
    }
    if (path === "/api/v1/agents" && init?.method === "POST") {
      if (options.agentCreateError) {
        if (options.agentCreateError === "conflict") {
          return json(
            {
              error: {
                code: "AGENT_NAME_CONFLICT",
                category: "deterministic",
                message: "An active Agent with this name already exists in the Workspace",
              },
            },
            409,
          );
        }
        return json(
          {
            error: {
              code: "VALIDATION_ERROR",
              category: "validation",
              message: "The request payload is invalid",
              ...(options.agentCreateError === "name"
                ? { issues: [{ path: ["name"], code: "invalid_format", message: "Use a lowercase Agent name" }] }
                : {}),
            },
          },
          400,
        );
      }
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      await options.agentCreate?.(body);
      return json(adminConfig(), 201);
    }
    if (path === "/api/v1/agents" && init?.method === undefined) {
      const failureStatus = options.agentListStatus?.();
      if (failureStatus) return json({ error: { message: "Agent list unavailable" } }, failureStatus);
      return json({
        agents: options.emptyAgents
          ? []
          : [
              {
                ...agentListItem,
                createdBy: options.agentCreator ?? agentListItem.createdBy,
                activity: options.agentActivity ?? agentListItem.activity,
                status: lifecycleStatus,
                runtimeProvider: options.runtimeProvider ?? agentListItem.runtimeProvider,
              },
            ],
      });
    }
    const normalizeComputer = (computer: Record<string, unknown>) => ({
      computerId: computer.computerId ?? computer.id,
      displayName: computer.displayName,
      platform: computer.platform,
      connectionStatus: computer.connectionStatus,
      providerReadiness: computer.providerReadiness,
      connectedAt: computer.connectedAt ?? null,
      lastSeenAt: computer.lastSeenAt ?? null,
      observedAt: computer.observedAt ?? computer.lastSeenAt ?? computer.connectedAt ?? "2026-08-20T00:00:00.000Z",
      enrolledAt: computer.enrolledAt ?? "2026-08-20T00:00:00.000Z",
      agentIds: computer.agentIds ?? [agentId],
    });
    const listComputers = async (connected: boolean) => {
      const configured =
        typeof options.computers === "function" ? await options.computers(connected) : options.computers;
      return (
        configured?.map(normalizeComputer) ?? [
          normalizeComputer({
            id: computerId,
            displayName: "Ada's Mac",
            platform: "darwin",
            connectionStatus: options.computerStatus?.() ?? "online",
            providerReadiness: options.computerProviderReadiness ?? [
              { provider: "codex", status: "ready", observedAt: "2026-08-20T00:00:00.000Z" },
            ],
            connectedAt: "2026-08-20T00:00:00.000Z",
            lastSeenAt: "2026-08-20T00:00:00.000Z",
          }),
        ]
      );
    };
    if (path === "/api/v1/computers") {
      const failureStatus = options.computerReadStatus?.(computerConnectCodeIssued);
      if (failureStatus) return json({ error: { message: "Computer readiness unavailable" } }, failureStatus);
      if (options.computerEvidenceFails) return json({ error: { message: "Computer evidence unavailable" } }, 503);
      return json({ computers: await listComputers(computerConnectCodeIssued) });
    }
    if (path === "/api/v1/computer-connect-codes" && init?.method === "POST") {
      computerConnectCodeIssued = true;
      return json(
        {
          connectCodeId,
          bootstrapCommand: "opentag computer connect --server https://opentag.example.com -- example",
          expiresIn: 900,
          issuedAt: "2026-08-20T00:00:00.000Z",
        },
        201,
      );
    }
    if (path === `/api/v1/computer-connect-codes/${connectCodeId}`) {
      // The mock Server's own verdict: pending until the issued code is redeemed, then the exact
      // Computer — the one the post-issuance Computers list gained or saw reconnect. Never the raw
      // code, and never a machine that was simply already there.
      if (!computerConnectCodeIssued) {
        return json({ connectCodeId, state: "pending", computerId: null, redeemedAt: null });
      }
      const before = await listComputers(false);
      const after = await listComputers(true);
      const baseline = new Map(before.map((computer) => [computer.computerId, computer.connectedAt]));
      const arrived = after.find(
        (computer) =>
          computer.connectionStatus === "online" &&
          typeof computer.computerId === "string" &&
          (!baseline.has(computer.computerId) || baseline.get(computer.computerId) !== computer.connectedAt),
      );
      if (!arrived || typeof arrived.computerId !== "string") {
        return json({ connectCodeId, state: "pending", computerId: null, redeemedAt: null });
      }
      return json({
        connectCodeId,
        state: "redeemed",
        computerId: arrived.computerId,
        redeemedAt: typeof arrived.connectedAt === "string" ? arrived.connectedAt : "2026-08-20T00:00:00.000Z",
      });
    }
    if (path.startsWith(`/api/v1/agents/${agentId}/usage?`)) {
      const days = Number(new URL(path, "https://opentag.test").searchParams.get("days"));
      return json({
        windowDays: days,
        startedAt: "2026-07-25T12:00:00.000Z",
        endedAt: "2026-08-24T12:00:00.000Z",
        ...(options.agentUsage ?? {
          tasks: 32,
          measuredTasks: 31,
          failed: 0,
          inputTokens: 360_000,
          cachedInputTokens: 120_000,
          outputTokens: 68_000,
          tokens: 428_000,
          daily: [
            {
              date: "2026-08-20",
              tasks: 15,
              measuredTasks: 15,
              inputTokens: 160_000,
              cachedInputTokens: 50_000,
              outputTokens: 30_000,
              tokens: 190_000,
            },
            {
              date: "2026-08-22",
              tasks: 0,
              measuredTasks: 0,
              inputTokens: 0,
              cachedInputTokens: 0,
              outputTokens: 0,
              tokens: 0,
            },
            {
              date: "2026-08-24",
              tasks: 17,
              measuredTasks: 16,
              inputTokens: 200_000,
              cachedInputTokens: 70_000,
              outputTokens: 38_000,
              tokens: 238_000,
            },
          ],
        }),
      });
    }
    if (path === `/api/v1/agents/${agentId}`) {
      if (init?.method === "PATCH") return json(adminConfig());
      if (init?.method === "DELETE") return new Response(null, { status: 204 });
      await options.agentRead?.();
      const failureStatus = options.agentReadStatus?.();
      if (failureStatus) {
        return json(
          { error: { code: "RESOURCE_NOT_FOUND", category: "deterministic", message: "Agent unavailable" } },
          failureStatus,
        );
      }
      return json({
        ...agentSummary,
        createdBy: options.agentCreator ?? agentSummary.createdBy,
        runtimeProvider: options.runtimeProvider ?? agentSummary.runtimeProvider,
        status: lifecycleStatus,
        activity: options.agentActivity ?? { state: "idle" },
      });
    }
    if (path === `/api/v1/agents/${agentId}/config`) {
      return json(adminConfig());
    }
    if (path === `/api/v1/agents/${agentId}/suspend` && init?.method === "POST") {
      lifecycleStatus = "suspended";
      revision += 1;
      return json(adminConfig());
    }
    if (path === `/api/v1/agents/${agentId}/reactivate` && init?.method === "POST") {
      lifecycleStatus = "active";
      revision += 1;
      return json(adminConfig());
    }
    if (path === `/api/v1/agents/${agentId}/im-binding/handoff`) {
      if (options.bindingEvidenceFails || options.handoffEvidenceFails) {
        return json(
          {
            error: {
              code: "SERVICE_UNAVAILABLE",
              category: "transient",
              message: "Handoff evidence unavailable",
            },
          },
          503,
        );
      }
      if (!options.bound) return new Response(null, { status: 204 });
      const bindingState = options.bindingReauth ? "reauthorization_required" : "active";
      return json({ bindingState, handoffReady: options.handoffReady ?? bindingState === "active" });
    }
    if (path === `/api/v1/agents/${agentId}/im-binding`) {
      if (options.bindingEvidenceFails) {
        return json(
          {
            error: {
              code: "SERVICE_UNAVAILABLE",
              category: "transient",
              message: "Binding evidence unavailable",
            },
          },
          503,
        );
      }
      if (!options.bound) return new Response(null, { status: 204 });
      return json({
        id: crypto.randomUUID(),
        agentId,
        provider: options.provider ?? "feishu",
        bindingState: options.bindingState ?? (options.bindingReauth ? "reauthorization_required" : "active"),
        bot: { displayName: "Reviewer", avatarUrl: null },
        receiveMode: "mention_only",
        lastInboundAt: null,
        lastValidatedAt: "2026-08-20T00:00:00.000Z",
        lastRuntimeObservationAt: null,
      });
    }
    if (path === `/api/v1/agents/${agentId}/im-binding/feishu/setup-attempts` && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { intent: "create" | "reauthorize" | "replace" };
      return json(
        {
          id: crypto.randomUUID(),
          agentId,
          intent: body.intent,
          state: options.setupFailureCode ? "failed" : "awaiting_user",
          qrUrl: options.setupFailureCode ? null : "https://open.feishu.cn/setup",
          expiresAt: "2026-08-20T00:15:00.000Z",
          errorCode: options.setupFailureCode ?? null,
          completedAt: options.setupFailureCode ? "2026-08-20T00:01:00.000Z" : null,
          createdAt: "2026-08-20T00:00:00.000Z",
        },
        201,
      );
    }
    if (path === `/api/v1/agents/${agentId}/im-binding/slack/oauth/start` && init?.method === "POST") {
      return json({
        authorizationUrl: "https://slack.com/oauth/v2/authorize?client_id=client&state=signed-state",
        expiresAt: "2026-08-20T00:10:00.000Z",
      });
    }
    if (path === "/api/v1/auth/browser/logout" && init?.method === "POST") {
      loggedOut = true;
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${path}`);
  });
}

/**
 * Opens the account menu and waits for the menu this trigger owns.
 *
 * A press is one `click`. Base UI opens the trigger from `mousedown` when a pointer sequence
 * precedes it and from `click` otherwise, and dispatching both halves in jsdom toggles the menu
 * twice — open, then closed — so the sequence a real browser produces is not the one to imitate
 * here.
 */
async function openAccountMenu(): Promise<{ menu: HTMLElement; trigger: HTMLElement }> {
  const trigger = await screen.findByRole("button", { name: "Account menu" });
  fireEvent.click(trigger);
  // The menu this trigger owns, not whichever menu happens to be in the document: a menu the
  // previous press opened can still be leaving while this one opens, and reading that one is how an
  // assertion passes against a menu the test never opened. Callers read through the returned menu
  // so that guarantee reaches their assertions too.
  let menu: HTMLElement | null = null;
  await waitFor(() => {
    const owned = trigger.getAttribute("aria-controls");
    menu = owned ? document.getElementById(owned) : null;
    if (trigger.getAttribute("aria-expanded") !== "true" || !menu) {
      throw new Error(`The account menu did not open (aria-expanded=${trigger.getAttribute("aria-expanded")}).`);
    }
    if (within(menu).queryAllByRole("menuitem").length === 0) {
      throw new Error(
        `The account menu opened with no reachable item (${menu.querySelectorAll('[role="menuitem"]').length} in the DOM).`,
      );
    }
  });
  if (!menu) throw new Error("The account menu did not open.");
  return { menu, trigger };
}

describe("OpenTag Web App Shell", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    window.history.replaceState({}, "", "/agents");
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
  });

  it("uses the same Agents-first shell for admins", async () => {
    installApi();
    render(<App />);
    const pageHeading = await screen.findByRole("heading", { level: 1, name: "Agents" });
    expect(pageHeading.classList.contains("text-xl")).toBe(true);
    expect(window.location.pathname).toBe("/agents");
    expect(screen.queryByText("Infrastructure")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Agent runtime" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Computers" })).toBeNull();
    expect(screen.getByRole("main").classList.contains("decorative-page")).toBe(false);
    expect(screen.getByRole("link", { name: "Agents" })).toBeTruthy();
    const sidebarToggle = screen.getByRole("button", { name: "Collapse sidebar" });
    expect(sidebarToggle.closest('[data-sidebar="footer"]')).toBeTruthy();
    fireEvent.click(sidebarToggle);
    expect(screen.getByRole("button", { name: "Expand sidebar" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Agents" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Expand sidebar" }));
    expect(screen.getByRole("button", { name: "Collapse sidebar" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Settings" })).toBeNull();
    expect(screen.queryByText("Example")).toBeNull();
    const agentLink = await screen.findByRole("link", { name: "Open Reviewer" });
    const createAgent = screen.getByRole("button", { name: "New Agent" });
    expect(createAgent.closest('[data-ui="page-header"]')).toBeNull();
    expect(createAgent.closest('[data-ui="agents-page-action"]')).toBeTruthy();
    const agentCard = agentLink.closest('[data-ui="agent-card"]');
    expect(agentCard).toBeTruthy();
    expect(screen.queryByText(/Monitor availability/)).toBeNull();
    // One window statement for the pair of numbers, instead of repeating it on each of them.
    expect(screen.getByText("Usage · last 30 days")).toBeTruthy();
    expect(within(agentCard as HTMLElement).queryByText("@reviewer")).toBeNull();
    expect(within(agentCard as HTMLElement).getByText("Tasks")).toBeTruthy();
    expect(within(agentCard as HTMLElement).getByText("Tokens")).toBeTruthy();
    expect(within(agentCard as HTMLElement).getByText("428K")).toBeTruthy();
    const cardState = (agentCard as HTMLElement).querySelector('[data-ui="agent-card-state"]');
    expect(cardState).toBeTruthy();
    expect(within(cardState as HTMLElement).getByText("Messaging disconnected")).toBeTruthy();
    expect(within(cardState as HTMLElement).getByText("Cannot receive new work")).toBeTruthy();
    // The card reports the failure and nothing else; opening the Agent is its only follow-up.
    expect(within(agentCard as HTMLElement).queryByRole("link", { name: "Connect messaging" })).toBeNull();
    expect(
      within(agentCard as HTMLElement)
        .getAllByRole("link")
        .map((item) => item.getAttribute("href")),
    ).toEqual([`/agents/${agentId}`]);
    expect(
      (agentCard as HTMLElement).querySelector('[data-ui="agent-card-identity-copy"] [data-ui="agent-card-state"]'),
    ).toBe(cardState);
    expect(screen.queryByText("Ada's Mac · macOS")).toBeNull();
    expect(screen.queryByText("Mentions only")).toBeNull();
    const workspaceNavigation = screen.getByRole("navigation", { name: "Product" });
    expect(
      within(workspaceNavigation)
        .getAllByRole("link")
        .map((item) => item.textContent),
    ).toEqual(["Agents", "Tasks", "Skills", "Integrations"]);
    const navigationIcons = workspaceNavigation.querySelectorAll("svg");
    expect(navigationIcons).toHaveLength(4);
    expect(Array.from(navigationIcons).every((icon) => icon.getAttribute("aria-hidden") === "true")).toBe(true);
  });

  it("shows elapsed time without exposing conversation content for a working Agent", async () => {
    installApi({
      agentActivity: {
        state: "working",
        startedAt: new Date(Date.now() - 8 * 60_000).toISOString(),
      },
      bound: true,
      handoffReady: true,
    });
    render(<App />);

    const agentCard = (await screen.findByRole("link", { name: "Open Reviewer" })).closest('[data-ui="agent-card"]');
    expect(agentCard).toBeTruthy();
    const status = within(agentCard as HTMLElement)
      .getByText("Working")
      .closest("[data-state]");
    expect(status).toBeTruthy();
    expect(within(status as HTMLElement).getByText("Started 8m ago")).toBeTruthy();
  });

  it("states an offline reason under the Agent name and carries no exit of its own", async () => {
    installApi({
      bound: true,
      computerStatus: () => "offline",
      handoffReady: true,
    });
    render(<App />);

    const open = await screen.findByRole("link", { name: "Open Reviewer" });
    const agentCard = open.closest('[data-ui="agent-card"]');
    expect(agentCard).toBeTruthy();
    const status = within(agentCard as HTMLElement)
      .getByText("Computer offline")
      .closest("[data-state]");
    expect(status).toBeTruthy();
    expect(within(status as HTMLElement).getByText("Cannot receive new work")).toBeTruthy();
    // The status reads directly under the name it belongs to, inside the card's identity block.
    expect((status as HTMLElement).closest('[data-ui="agent-card-identity-copy"]')).toBeTruthy();
    /*
     * No recovery exit beside the reason. Which page repairs an offline Computer is the Agent's
     * business, so the card states the problem and the row link is the single way to follow it.
     */
    expect(within(status as HTMLElement).queryByRole("link")).toBeNull();
    expect(within(agentCard as HTMLElement).getAllByRole("link")).toEqual([open]);
  });

  it("opens the Agent from the row itself rather than from a trailing affordance", async () => {
    installApi();
    render(<App />);

    // The row itself is the target: one link covers the card and carries its accessible name, while
    // the name renders as text so the two are not announced twice.
    const open = await screen.findByRole("link", { name: "Open Reviewer" });
    expect(open.className).toContain("absolute inset-0");
    expect(open.getAttribute("href")).toBe(`/agents/${agentId}`);
    const card = open.closest('[data-ui="agent-card"]');
    expect(card).toBeTruthy();
    expect((card as HTMLElement).querySelector('[data-ui="agent-card-action"]')).toBeNull();
    /*
     * Even a card reporting a broken dependency carries no second link. Where the repair lives
     * depends on which dependency failed, so the row link is the whole answer: open the Agent.
     */
    expect(within(card as HTMLElement).getAllByRole("link")).toEqual([open]);
  });

  it.each(["/", "/agents"])("redirects unauthenticated protected path %s to login", async (path) => {
    installApi({ unauthenticated: true });
    window.history.replaceState({}, "", path);
    render(<App />);
    const heading = await screen.findByRole("heading", { name: "Welcome back" });
    expect(heading.closest("main")?.getAttribute("data-ui")).toBe("login-page");
    expect(screen.getByText("OpenTag").closest('[data-ui="login-brand-lockup"]')).toBeTruthy();
    expect(screen.getByText("Sign in to continue to OpenTag.")).toBeTruthy();
    expect(screen.queryByText(/Permissions are checked/)).toBeNull();
    const expectedNext = path === "/" ? "/agents" : path;
    expect(window.location.search).toBe(`?next=${encodeURIComponent(expectedNext)}`);
  });

  it("renders the Google provider with its branded sign-in treatment", async () => {
    installApi({
      authProviders: [{ id: "google", enabled: true, startUrl: "/api/v1/auth/google/start" }],
      unauthenticated: true,
    });
    window.history.replaceState({}, "", "/agents");
    render(<App />);

    const signIn = await screen.findByRole("link", { name: "Sign in with Google" });
    expect(signIn.getAttribute("data-ui")).toBe("login-provider-google");
    expect(signIn.querySelector('img[alt="Sign in with Google"]')).toBeTruthy();
    expect(new URL(signIn.getAttribute("href") ?? "", window.location.origin).searchParams.get("next")).toBe("/agents");
    expect(screen.getByText("Sign in to manage your Agents and Computers.")).toBeTruthy();
  });

  it("offers the password form only where the server enabled it", async () => {
    installApi({
      authProviders: [{ id: "password", enabled: false, startUrl: null }],
      unauthenticated: true,
    });
    window.history.replaceState({}, "", "/agents");
    render(<App />);

    // Disabled with nothing else available, so the page says so rather than showing an inert form.
    expect(await screen.findByText("No sign-in methods are currently available.")).toBeTruthy();
    expect(screen.queryByLabelText("Password")).toBeNull();
  });

  it("signs in with an email address and password", async () => {
    installApi({
      authProviders: [{ id: "password", enabled: true, startUrl: null }],
      unauthenticated: true,
    });
    window.history.replaceState({}, "", "/agents");
    render(<App />);

    fireEvent.change(await screen.findByLabelText("Email"), { target: { value: "ada@example.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "correct-horse-battery" } });
    // Registration is the only mode that asks for a name, so sign-in must not be showing that field.
    expect(screen.queryByLabelText("Name")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => {
      const call = vi.mocked(fetch).mock.calls.find(([input]) => String(input) === "/api/v1/auth/email/sign-in");
      expect(call).toBeTruthy();
      expect(JSON.parse(String(call?.[1]?.body))).toEqual({
        email: "ada@example.com",
        password: "correct-horse-battery",
      });
    });
  });

  it("asks for a name when registering, and posts it with the credential", async () => {
    installApi({
      authProviders: [{ id: "password", enabled: true, startUrl: null }],
      unauthenticated: true,
    });
    window.history.replaceState({}, "", "/agents");
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Create one" }));
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "new@example.com" } });
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "New Account" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "correct-horse-battery" } });
    fireEvent.click(screen.getByRole("button", { name: "Create account" }));

    await waitFor(() => {
      const call = vi.mocked(fetch).mock.calls.find(([input]) => String(input) === "/api/v1/auth/email/sign-up");
      expect(call).toBeTruthy();
      expect(JSON.parse(String(call?.[1]?.body))).toEqual({
        displayName: "New Account",
        email: "new@example.com",
        password: "correct-horse-battery",
      });
    });
  });

  it.each([["https://evil.example"], ["//evil.example"], ["/\\evil.example"], ["/api/v1/me"], ["/agents#/../evil"]])(
    "refuses to land a password sign-in on %s",
    async (next) => {
      const navigate = vi.fn();
      installApi({
        authProviders: [{ id: "password", enabled: true, startUrl: null }],
        unauthenticated: true,
      });
      render(<PasswordSignInForm navigate={navigate} next={next} />);

      fireEvent.change(screen.getByLabelText("Email"), { target: { value: "ada@example.com" } });
      fireEvent.change(screen.getByLabelText("Password"), { target: { value: "correct-horse-battery" } });
      fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

      /*
       * This is the one sign-in method that navigates the browser itself rather than handing its destination to a
       * server route, so it has to apply the same allowlist the redirect providers have always been given.
       */
      await waitFor(() => expect(navigate).toHaveBeenCalled());
      expect(navigate).toHaveBeenCalledWith("/agents");
    },
  );

  it("lands a password sign-in on an allowed destination it was asked for", async () => {
    const navigate = vi.fn();
    installApi({
      authProviders: [{ id: "password", enabled: true, startUrl: null }],
      unauthenticated: true,
    });
    render(<PasswordSignInForm navigate={navigate} next="/settings/profile" />);

    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "ada@example.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "correct-horse-battery" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await waitFor(() => expect(navigate).toHaveBeenCalledWith("/settings/profile"));
  });

  it("does not navigate when the credential was refused", async () => {
    const navigate = vi.fn();
    installApi({
      authProviders: [{ id: "password", enabled: true, startUrl: null }],
      passwordSignInFails: true,
      unauthenticated: true,
    });
    render(<PasswordSignInForm navigate={navigate} next="/agents" />);

    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "ada@example.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "wrong-password-here" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await screen.findByRole("alert");
    expect(navigate).not.toHaveBeenCalled();
  });

  it("shows the server's reason for a rejected sign-in rather than restating it", async () => {
    installApi({
      authProviders: [{ id: "password", enabled: true, startUrl: null }],
      passwordSignInFails: true,
      unauthenticated: true,
    });
    window.history.replaceState({}, "", "/agents");
    render(<App />);

    fireEvent.change(await screen.findByLabelText("Email"), { target: { value: "ada@example.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "wrong-password-here" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    // Uniform by design: the server will not say which of the address or the password was wrong.
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe("The email address or password is incorrect");
  });

  it("keeps authenticated invalid Agent tabs on the plain workspace canvas", async () => {
    installApi();
    window.history.replaceState({}, "", `/agents/${agentId}/unknown`);
    render(<App />);

    const heading = await screen.findByRole("heading", { name: "Page not found" });
    expect(heading.closest('[data-ui="not-found"]')).toBeTruthy();
    expect(screen.getByRole("main").getAttribute("data-ui")).not.toBe("not-found");
  });

  it("keeps the standalone not-found route on the decorative canvas", async () => {
    window.history.replaceState({}, "", "/unknown");
    render(<App />);

    const heading = await screen.findByRole("heading", { name: "Page not found" });
    expect(heading.closest("main")?.getAttribute("data-ui")).toBe("not-found");
  });

  it("keeps New Agent under the page title as the Account owner's sole empty-state action", async () => {
    installApi({ emptyAgents: true });
    render(<App />);

    expect(await screen.findByRole("heading", { name: "No Agents yet" })).toBeTruthy();
    expect(screen.getByText("Create your first shared AI teammate with New Agent.")).toBeTruthy();
    const createAgent = screen.getByRole("button", { name: "New Agent" });
    expect(createAgent.closest('[data-ui="page-header"]')).toBeNull();
    expect(createAgent.closest('[data-ui="agents-page-action"]')).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Agents" })).toBeNull();
  });

  it("opens the complete New Agent form in a dialog and returns focus when cancelled", async () => {
    installApi();
    render(<App />);
    const trigger = await screen.findByRole("button", { name: "New Agent" });

    fireEvent.click(trigger);

    const dialog = await screen.findByRole("dialog", { name: "New Agent" });
    expect(within(dialog).queryByText("Create")).toBeNull();
    expect(window.location.pathname).toBe("/agents");
    await waitFor(() => expect(within(dialog).getByLabelText("Display name")).toBe(document.activeElement));
    expect(within(dialog).queryByLabelText("Agent name")).toBeNull();
    expect(within(dialog).getByRole("button", { name: "Edit Agent name" })).toBeTruthy();
    expect(within(dialog).getByRole("heading", { name: "Where it runs" })).toBeTruthy();
    expect(within(dialog).getByText("Ready to run")).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Create Agent" })).toBeTruthy();

    fireEvent.change(within(dialog).getByLabelText("Display name"), { target: { value: "Research Assistant" } });
    expect(within(dialog).getByText("@research-assistant")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Edit Agent name" }));
    const name = within(dialog).getByLabelText("Agent name") as HTMLInputElement;
    expect(name.value).toBe("research-assistant");
    await waitFor(() => expect(name).toBe(document.activeElement));
    fireEvent.change(name, { target: { value: "custom-researcher" } });
    fireEvent.change(within(dialog).getByLabelText("Display name"), { target: { value: "Research Partner" } });
    expect(name.value).toBe("custom-researcher");

    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "New Agent" })).toBeNull());
    expect(trigger).toBe(document.activeElement);
  });

  it("lets the Account owner connect another Computer from New Agent", async () => {
    installApi();
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "New Agent" }));

    const dialog = await screen.findByRole("dialog", { name: "New Agent" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Change Computer" }));
    const trigger = within(dialog).getByRole("button", { name: "Connect another Computer" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(trigger);

    expect(within(dialog).getByRole("heading", { name: "Connect a Local Computer" })).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Generate connection command" })).toBeTruthy();
    expect(
      within(dialog).getByRole("button", { name: "Cancel Computer connection" }).getAttribute("aria-expanded"),
    ).toBe("true");
    expect(within(dialog).getByRole("heading", { name: "Where it runs" })).toBeTruthy();
    expect(within(dialog).getByText("Ready to run")).toBeTruthy();
  });

  it("binds the Agent to the Computer the reader selected, not the default one", async () => {
    installApi({ computers: twoReadyComputers });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "New Agent" }));
    const dialog = await screen.findByRole("dialog", { name: "New Agent" });

    // The Account has both; the form defaults to one and the reader picks the other. What the
    // request binds to has to be the choice, not the default.
    expect(within(dialog).getByText("Ada's Mac")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Change Computer" }));
    fireEvent.click(within(dialog).getByRole("button", { name: /Zulu Tower/ }));
    fireEvent.change(within(dialog).getByLabelText("Display name"), { target: { value: "Research Assistant" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Create Agent" }));

    await waitFor(() =>
      expect(
        vi.mocked(fetch).mock.calls.filter(([path, init]) => path === "/api/v1/agents" && init?.method === "POST"),
      ).toHaveLength(1),
    );
    const created = vi
      .mocked(fetch)
      .mock.calls.find(([path, init]) => path === "/api/v1/agents" && init?.method === "POST");
    expect(JSON.parse(String(created?.[1]?.body))).toMatchObject({ computerId: secondComputerId });
  });

  it("lists every Computer the Account has and still offers another", async () => {
    installApi({
      computers: [
        ...twoReadyComputers,
        {
          id: "a5fe9af3-d1c6-472b-b78c-8a7ccf512750",
          displayName: "Ada's Retired Mac",
          platform: "darwin",
          connectionStatus: "offline",
          connectedAt: "2026-08-20T00:00:00.000Z",
          lastSeenAt: "2026-08-20T00:00:00.000Z",
        },
      ],
    });
    window.history.replaceState({}, "", "/agents/computers");
    render(<App />);

    const listed = await screen.findByRole("region", { name: "Enrolled Computers" });
    // An Account may hold several, so the page shows all of them and adding one stays available
    // rather than disappearing once the first exists.
    expect(within(listed).getAllByRole("listitem")).toHaveLength(3);
    for (const name of ["Ada's Mac", "Zulu Tower", "Ada's Retired Mac"]) {
      expect(within(listed).getByText(name)).toBeTruthy();
    }
    expect(screen.getByRole("heading", { name: "Connect a Local Computer" })).toBeTruthy();
  });

  it("does not resume a stored creation intent onto a Computer the reader moved away from", async () => {
    // The reader's own selection is the divergence: the intent names a machine that cannot run an
    // Agent, so nothing is sent, the reader picks another — and then the abandoned machine comes
    // back. "Is that route ready anywhere" is true again at that moment, and it is the wrong
    // question, because the reader is looking at a different Computer.
    let abandonedIsReady = false;
    storeCreationIntent({
      creationIntentId: "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e77",
      request: { name: "abandoned-agent", displayName: "Abandoned Agent", runtimeProvider: "codex", computerId },
    });
    installApi({
      computers: () => [
        {
          ...(twoReadyComputers[0] as Record<string, unknown>),
          connectionStatus: abandonedIsReady ? "online" : "offline",
        },
        twoReadyComputers[1] as Record<string, unknown>,
      ],
    });
    window.history.replaceState({}, "", "/agents/new");
    render(<App />);

    expect(await screen.findByText("Ada's Mac")).toBeTruthy();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(agentCreationPosts()).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Change Computer" }));
    fireEvent.click(screen.getByRole("button", { name: /Zulu Tower/ }));
    expect(screen.getByText("Zulu Tower")).toBeTruthy();

    abandonedIsReady = true;
    fireEvent(window, new Event("focus"));
    // Wait for the refetch to actually land, so the assertion below is about the gate and not about
    // a Computer list that never changed. The picker is where the machine's own state is legible.
    fireEvent.click(screen.getByRole("button", { name: "Change Computer" }));
    await waitFor(() => {
      const option = screen.getByRole("button", { name: /Ada's Mac/ });
      expect(option.textContent).toContain("Online");
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(agentCreationPosts()).toHaveLength(0);
    expect(screen.getByRole("button", { name: /Zulu Tower/ }).getAttribute("aria-pressed")).toBe("true");
  });

  it("does not resume a stored creation intent onto a Runtime the form is not offering", async () => {
    storeCreationIntent({
      creationIntentId: "0a2f7d19-8b44-4d2e-8c31-5f6a7b8c9d01",
      request: { name: "claude-agent", displayName: "Claude Agent", runtimeProvider: "claude-code", computerId },
    });
    // The Computer matches; only the Runtime makes this a different route from the one on screen.
    installApi({ computerProviderReadiness: [{ provider: "codex", status: "ready", observedAt: null }] });
    window.history.replaceState({}, "", "/agents/new");
    render(<App />);

    expect(await screen.findByText("Ada's Mac")).toBeTruthy();
    expect(screen.getByText("Codex")).toBeTruthy();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    expect(agentCreationPosts()).toHaveLength(0);
    expect((screen.getByLabelText("Display name") as HTMLInputElement).value).toBe("Claude Agent");
  });

  it("resumes a stored creation intent that names the selected route", async () => {
    // The control: the gate has to refuse an unselected route without disabling resume, which is
    // the whole reason a creation intent is persisted.
    const record = storeCreationIntent({
      creationIntentId: "4d3c2b1a-9e8f-4a7b-8c6d-5e4f3a2b1c00",
      request: { name: "resumed-agent", displayName: "Resumed Agent", runtimeProvider: "codex", computerId },
    });
    installApi();
    window.history.replaceState({}, "", "/agents/new");
    render(<App />);

    await waitFor(() => expect(agentCreationPosts()).toHaveLength(1));
    expect(JSON.parse(String(agentCreationPosts()[0]?.[1]?.body))).toMatchObject({
      computerId,
      creationIntentId: record.creationIntentId,
      runtimeProvider: "codex",
    });
  });

  it("retires an abandoned intent once an explicit creation supersedes it", async () => {
    // The abandoned intent names a Computer that is not a route today, so it does not resume and
    // the reader carries on against a machine that is. Its record has to go with the creation:
    // left behind, it resumes the moment its machine is a ready route again.
    storeCreationIntent({
      creationIntentId: "8f1e2d3c-4b5a-4c6d-9e8f-1a2b3c4d5e66",
      request: {
        name: "zulu-agent",
        displayName: "Zulu Agent",
        runtimeProvider: "codex",
        computerId: secondComputerId,
      },
    });
    const offlineSecond = { ...(twoReadyComputers[1] as Record<string, unknown>), connectionStatus: "offline" };
    installApi({ computers: [twoReadyComputers[0] as Record<string, unknown>, offlineSecond] });
    window.history.replaceState({}, "", "/agents/new");
    const first = render(<App />);

    // The stored intent selects its own machine, and that machine cannot run an Agent, so nothing
    // is sent and the reader is left to choose another.
    expect(await screen.findByText("Zulu Tower")).toBeTruthy();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(agentCreationPosts()).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Change Computer" }));
    fireEvent.click(screen.getByRole("button", { name: /Ada's Mac/ }));
    fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Visible Agent" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Agent" }));
    await waitFor(() => expect(agentCreationPosts()).toHaveLength(1));
    // The act these records exist to survive is over, so they are marked spent — not deleted, since
    // a page still waiting on one needs its key to retry under. Marking is what stops the resume
    // effect sending it once its machine becomes the selected one again.
    await waitFor(() => {
      const stored = window.localStorage.getItem(creationIntentKey);
      const records = stored ? (JSON.parse(stored) as { records: { supersededAt?: string }[] }).records : [];
      expect(records.length).toBeGreaterThan(0);
      expect(records.every((record) => record.supersededAt !== undefined)).toBe(true);
    });

    // Prove it rather than infer it from an empty store: come back with that machine online, which
    // is exactly the state that would have resumed the abandoned record. `installApi` swaps the
    // implementation and keeps the call history, so this is measured as growth.
    const postsBeforeReturning = agentCreationPosts().length;
    first.unmount();
    installApi({ computers: [twoReadyComputers[1] as Record<string, unknown>] });
    window.history.replaceState({}, "", "/agents/new");
    render(<App />);

    expect(await screen.findByText("Zulu Tower")).toBeTruthy();
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(agentCreationPosts()).toHaveLength(postsBeforeReturning);
  });

  it("refreshes and selects a newly connected Computer in New Agent", async () => {
    const connectedComputerId = "95fe9af3-d1c6-472b-b78c-8a7ccf512750";
    const existingComputer = {
      id: computerId,
      displayName: "Ada's Mac",
      platform: "darwin",
      arch: "arm64",
      clientVersion: "0.0.1",
      connectionStatus: "online",
      providerReadiness: [{ provider: "codex", status: "ready", observedAt: "2026-08-20T00:00:00.000Z" }],
      connectedAt: "2026-08-20T00:00:00.000Z",
      lastSeenAt: "2026-08-20T00:00:01.000Z",
    };
    const connectedComputer = {
      ...existingComputer,
      id: connectedComputerId,
      displayName: "Ada's Linux Computer",
      platform: "linux",
      connectedAt: "2026-08-20T00:00:02.000Z",
    };
    let finishRefresh: (() => void) | undefined;
    const refreshPending = new Promise<void>((resolve) => {
      finishRefresh = resolve;
    });
    installApi({
      computers: async (connected) => {
        if (connected) await refreshPending;
        return connected ? [existingComputer, connectedComputer] : [existingComputer];
      },
    });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "New Agent" }));
    const dialog = await screen.findByRole("dialog", { name: "New Agent" });
    fireEvent.change(within(dialog).getByLabelText("Display name"), {
      target: { value: "Research Assistant" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Edit Agent name" }));
    fireEvent.change(within(dialog).getByLabelText("Agent name"), {
      target: { value: "research-assistant" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Change Computer" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Connect another Computer" }));

    vi.useFakeTimers();
    vi.setSystemTime("2026-08-20T00:00:00.000Z");
    try {
      const generateButton = within(dialog).getByRole("button", { name: "Generate connection command" });
      generateButton.focus();
      await act(async () => {
        fireEvent.click(generateButton);
      });
      await act(async () => {
        vi.advanceTimersByTime(1_500);
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(dialog.contains(document.activeElement)).toBe(true);
      await act(async () => {
        finishRefresh?.();
        // The refresh now invalidates a cache entry rather than swapping a key, so the refetch it
        // starts settles across several microtask turns; drain them rather than counting them.
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(within(dialog).getByText("Ada's Linux Computer")).toBeTruthy();
      expect(within(dialog).getByText("Codex")).toBeTruthy();
      expect((within(dialog).getByLabelText("Display name") as HTMLInputElement).value).toBe("Research Assistant");
      expect((within(dialog).getByLabelText("Agent name") as HTMLInputElement).value).toBe("research-assistant");
      expect(within(dialog).queryByRole("heading", { name: "Connect a Local Computer" })).toBeNull();
      expect(within(dialog).getByRole("button", { name: "Change Computer" })).toBe(document.activeElement);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a connection attempt visible when a Computer refresh fails", async () => {
    const connectedComputer = {
      id: "95fe9af3-d1c6-472b-b78c-8a7ccf512750",
      displayName: "Ada's Linux Computer",
      platform: "linux",
      arch: "arm64",
      clientVersion: "0.0.1",
      connectionStatus: "online",
      providerReadiness: [{ provider: "codex", status: "ready", observedAt: "2026-08-20T00:00:02.000Z" }],
      connectedAt: "2026-08-20T00:00:02.000Z",
      lastSeenAt: "2026-08-20T00:00:02.000Z",
    };
    installApi({
      computers: (connected) => (connected ? [connectedComputer] : []),
      computerReadStatus: (connected) => (connected ? 404 : undefined),
    });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "New Agent" }));
    const dialog = await screen.findByRole("dialog", { name: "New Agent" });

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-20T00:00:00.000Z");
    try {
      const generateButton = within(dialog).getByRole("button", { name: "Generate connection command" });
      generateButton.focus();
      await act(async () => {
        fireEvent.click(generateButton);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3_000);
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(within(dialog).getByRole("alert").textContent).toContain("Request failed");
      const refreshStatus = within(dialog).getByRole("status");
      expect(refreshStatus.textContent).toContain("Waiting for the Computer to connect");
      expect(dialog.contains(document.activeElement)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("completes an existing Computer reconnection in New Agent", async () => {
    const disconnectedAt = "2026-08-20T00:00:00.000Z";
    const reconnectedAt = "2026-08-20T00:00:02.000Z";
    const existingComputer = {
      id: computerId,
      displayName: "Ada's Mac",
      platform: "darwin",
      arch: "arm64",
      clientVersion: "0.0.1",
      connectionStatus: "online",
      providerReadiness: [{ provider: "codex", status: "ready", observedAt: disconnectedAt }],
      connectedAt: disconnectedAt,
      lastSeenAt: "2026-08-20T00:00:01.000Z",
    };
    installApi({
      computers: (connected) =>
        connected ? [{ ...existingComputer, connectedAt: reconnectedAt }] : [existingComputer],
    });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "New Agent" }));
    const dialog = await screen.findByRole("dialog", { name: "New Agent" });
    fireEvent.change(within(dialog).getByLabelText("Display name"), {
      target: { value: "Research Assistant" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Edit Agent name" }));
    fireEvent.change(within(dialog).getByLabelText("Agent name"), {
      target: { value: "research-assistant" },
    });
    fireEvent.click(within(dialog).getByRole("button", { name: "Change Computer" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Connect another Computer" }));

    vi.useFakeTimers();
    vi.setSystemTime(disconnectedAt);
    try {
      const generateButton = within(dialog).getByRole("button", { name: "Generate connection command" });
      generateButton.focus();
      await act(async () => {
        fireEvent.click(generateButton);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_500);
      });

      expect(within(dialog).getByText("Ada's Mac")).toBeTruthy();
      expect(within(dialog).getByText("Codex")).toBeTruthy();
      expect((within(dialog).getByLabelText("Display name") as HTMLInputElement).value).toBe("Research Assistant");
      expect((within(dialog).getByLabelText("Agent name") as HTMLInputElement).value).toBe("research-assistant");
      expect(within(dialog).queryByRole("heading", { name: "Connect a Local Computer" })).toBeNull();
      expect(within(dialog).getByRole("button", { name: "Change Computer" })).toBe(document.activeElement);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps Computer connection inside the New Agent dialog when no runtime is available", async () => {
    const connectedComputer = {
      id: computerId,
      displayName: "Ada's Mac",
      platform: "darwin",
      arch: "arm64",
      clientVersion: "0.0.1",
      connectionStatus: "online",
      providerReadiness: [{ provider: "codex", status: "ready", observedAt: "2026-08-20T00:00:02.000Z" }],
      connectedAt: "2026-08-20T00:00:02.000Z",
      lastSeenAt: "2026-08-20T00:00:02.000Z",
    };
    let finishRefresh: (() => void) | undefined;
    const refreshPending = new Promise<void>((resolve) => {
      finishRefresh = resolve;
    });
    installApi({
      computers: async (connected) => {
        if (connected) await refreshPending;
        return connected ? [connectedComputer] : [];
      },
    });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "New Agent" }));

    const dialog = await screen.findByRole("dialog", { name: "New Agent" });
    expect(within(dialog).getByRole("heading", { name: "Connect a Local Computer" })).toBeTruthy();
    const generateButton = within(dialog).getByRole("button", { name: "Generate connection command" });
    expect(within(dialog).queryByRole("link", { name: "Agent runtime" })).toBeNull();

    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-20T00:00:00.000Z");
    try {
      generateButton.focus();
      await act(async () => {
        fireEvent.click(generateButton);
      });
      await act(async () => {
        vi.advanceTimersByTime(1_500);
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(dialog.contains(document.activeElement)).toBe(true);
      await act(async () => {
        finishRefresh?.();
        // The refresh now invalidates a cache entry rather than swapping a key, so the refetch it
        // starts settles across several microtask turns; drain them rather than counting them.
        await vi.advanceTimersByTimeAsync(0);
      });

      expect(within(dialog).getByText("Ada's Mac")).toBeTruthy();
      expect(within(dialog).getByText("Codex")).toBeTruthy();
      expect(within(dialog).getByRole("button", { name: "Change Computer" })).toBe(document.activeElement);
    } finally {
      vi.useRealTimers();
    }
  });

  it("creates an Agent from the dialog without a second creation screen", async () => {
    installApi();
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "New Agent" }));
    const dialog = await screen.findByRole("dialog", { name: "New Agent" });

    fireEvent.change(within(dialog).getByLabelText("Display name"), { target: { value: "Research Assistant" } });
    expect(within(dialog).queryByLabelText("Agent name")).toBeNull();
    fireEvent.click(within(dialog).getByRole("button", { name: "Create Agent" }));

    expect(await within(dialog).findByRole("heading", { name: "Connect messaging" })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Set up later" }));
    await waitFor(() => expect(window.location.pathname).toBe(`/agents/${agentId}`));
    const createCall = vi
      .mocked(fetch)
      .mock.calls.find(([input, init]) => String(input) === "/api/v1/agents" && init?.method === "POST");
    expect(createCall).toBeTruthy();
    expect(JSON.parse(String(createCall?.[1]?.body))).toEqual({
      creationIntentId: expect.any(String),
      name: "research-assistant",
      displayName: "Research Assistant",
      runtimeProvider: "codex",
      computerId,
    });
  });

  it("blocks duplicate Agent submissions synchronously and repairs focus while creation is pending", async () => {
    let resolveCreate: () => void = () => undefined;
    const pendingCreate = new Promise<void>((resolve) => {
      resolveCreate = resolve;
    });
    installApi({ agentCreate: () => pendingCreate });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "New Agent" }));
    const dialog = await screen.findByRole("dialog", { name: "New Agent" });
    fireEvent.change(within(dialog).getByLabelText("Display name"), { target: { value: "Research Assistant" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Edit Agent name" }));
    fireEvent.change(within(dialog).getByLabelText("Agent name"), { target: { value: "research-assistant" } });
    const form = within(dialog).getByRole("button", { name: "Create Agent" }).closest("form");
    const submitButton = within(dialog).getByRole("button", { name: "Create Agent" });
    submitButton.focus();

    if (!form) throw new Error("Expected the New Agent form");
    fireEvent.submit(form);
    fireEvent.submit(form);

    await waitFor(() =>
      expect(
        vi
          .mocked(fetch)
          .mock.calls.filter(([input, init]) => String(input) === "/api/v1/agents" && init?.method === "POST"),
      ).toHaveLength(1),
    );
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    expect((within(dialog).getByLabelText("Display name") as HTMLInputElement).disabled).toBe(true);
    expect((within(dialog).getByLabelText("Agent name") as HTMLInputElement).disabled).toBe(true);
    expect(within(dialog).getByRole("status").textContent).toContain("Ready to run");
    expect(within(dialog).getByRole("button", { name: "Creating…" }).hasAttribute("disabled")).toBe(true);
    expect(within(dialog).getByRole("button", { name: "Cancel" }).hasAttribute("disabled")).toBe(true);
    expect(within(dialog).getByRole("button", { name: "Close new Agent dialog" }).hasAttribute("disabled")).toBe(true);
    fireEvent.keyDown(document.activeElement ?? dialog, { key: "Escape" });
    expect(screen.getByRole("dialog", { name: "New Agent" })).toBe(dialog);

    resolveCreate();
    expect(await within(dialog).findByRole("heading", { name: "Connect messaging" })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Set up later" }));
    await waitFor(() => expect(window.location.pathname).toBe(`/agents/${agentId}`));
  });

  it("reuses one creation intent when an unchanged Agent request is retried", async () => {
    const attempts: Record<string, unknown>[] = [];
    installApi({
      agentCreate: (input) => {
        attempts.push(input);
        if (attempts.length === 1) throw new Error("Connection lost after creation");
      },
    });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "New Agent" }));
    const dialog = await screen.findByRole("dialog", { name: "New Agent" });
    fireEvent.change(within(dialog).getByLabelText("Display name"), { target: { value: "Research Assistant" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Edit Agent name" }));
    fireEvent.change(within(dialog).getByLabelText("Agent name"), { target: { value: "research-assistant" } });

    fireEvent.click(within(dialog).getByRole("button", { name: "Create Agent" }));
    expect((await within(dialog).findByRole("alert")).textContent).toContain("Connection lost after creation");
    fireEvent.click(within(dialog).getByRole("button", { name: "Create Agent" }));

    expect(await within(dialog).findByRole("heading", { name: "Connect messaging" })).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Set up later" }));
    await waitFor(() => expect(window.location.pathname).toBe(`/agents/${agentId}`));
    expect(attempts).toHaveLength(2);
    expect(attempts[0]?.creationIntentId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(attempts[1]?.creationIntentId).toBe(attempts[0]?.creationIntentId);
  });

  it("lets an Account update its global display name", async () => {
    installApi();
    window.history.replaceState({}, "", "/account");
    render(<App />);

    const email = (await screen.findByLabelText("Email")) as HTMLInputElement;
    const displayName = screen.getByLabelText("Display name") as HTMLInputElement;
    expect(email.value).toBe("ada@example.com");
    expect(email.readOnly).toBe(true);
    expect(email.closest('[data-ui="field"]')).toBeTruthy();
    expect(displayName.closest('[data-ui="field"]')).toBeTruthy();
    fireEvent.change(displayName, { target: { value: "  Ada Lovelace  " } });
    fireEvent.click(await screen.findByRole("button", { name: "Save account profile" }));

    await waitFor(() =>
      expect(vi.mocked(fetch).mock.calls.filter(([input]) => String(input) === "/api/v1/me")).toHaveLength(3),
    );
    expect(await screen.findByText("Ada Lovelace")).toBeTruthy();
    expect((screen.getByLabelText("Display name") as HTMLInputElement).value).toBe("Ada Lovelace");
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      "/api/v1/me",
      expect.objectContaining({ method: "PATCH", body: JSON.stringify({ displayName: "  Ada Lovelace  " }) }),
    );
  });

  it("prevents duplicate account saves while a profile update is pending", async () => {
    let resolveUpdate: (response: Response) => void = () => undefined;
    const update = new Promise<Response>((resolve) => {
      resolveUpdate = resolve;
    });
    installApi({ profileUpdate: () => update });
    window.history.replaceState({}, "", "/account");
    render(<App />);

    const displayName = (await screen.findByLabelText("Display name")) as HTMLInputElement;
    const form = displayName.closest("form");
    if (!form) throw new Error("Account form was not rendered");
    fireEvent.change(displayName, { target: { value: "Pending Name" } });
    fireEvent.click(await screen.findByRole("button", { name: "Save account profile" }));
    fireEvent.submit(form);

    expect(((await screen.findByRole("button", { name: "Saving…" })) as HTMLButtonElement).disabled).toBe(true);
    expect(
      vi.mocked(fetch).mock.calls.filter(([input, init]) => String(input) === "/api/v1/me" && init?.method === "PATCH"),
    ).toHaveLength(1);
    resolveUpdate(json({ id: userId, email: "ada@example.com", displayName: "Pending Name" }));
    await waitFor(() => expect(screen.getByText("Pending Name")).toBeTruthy());
  });

  it("treats a saved name whose refresh failed as needing synchronization, not as unsaved data", async () => {
    installApi({ meFailuresAfterProfileUpdate: 1 });
    window.history.replaceState({}, "", "/account");
    render(<App />);

    const displayName = (await screen.findByLabelText("Display name")) as HTMLInputElement;
    fireEvent.change(displayName, { target: { value: "Ada Lovelace" } });
    fireEvent.click(await screen.findByRole("button", { name: "Save account profile" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(
      "Your display name was saved. OpenTag could not refresh the account, so the rest of the page still shows the previous name.",
    );
    // The write committed, so the page must not offer to repeat it, must not offer to discard it,
    // and must not describe the saved value as unsaved.
    expect(screen.queryByText("Unsaved changes")).toBeNull();
    expect(screen.queryByRole("button", { name: "Save account profile" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Discard" })).toBeNull();
    expect(screen.queryByText("Account profile saved.")).toBeNull();
    expect(screen.getByText("Account not refreshed")).toBeTruthy();
    expect(displayName.value).toBe("Ada Lovelace");

    // Retry re-runs only the refresh; one PATCH was ever sent.
    fireEvent.click(screen.getByRole("button", { name: "Retry refresh" }));

    expect(await screen.findByText("Account profile saved.")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.queryByText("Account not refreshed")).toBeNull();
    expect(await screen.findByText("Ada Lovelace")).toBeTruthy();
    expect(
      vi.mocked(fetch).mock.calls.filter(([input, init]) => String(input) === "/api/v1/me" && init?.method === "PATCH"),
    ).toHaveLength(1);
  });

  it("cannot repeat a committed save by submitting the form while its refresh is outstanding", async () => {
    installApi({ meFailuresAfterProfileUpdate: 99 });
    window.history.replaceState({}, "", "/account");
    render(<App />);

    const displayName = (await screen.findByLabelText("Display name")) as HTMLInputElement;
    const form = displayName.closest("form");
    if (!form) throw new Error("Account form was not rendered");
    fireEvent.change(displayName, { target: { value: "Ada Lovelace" } });
    fireEvent.click(await screen.findByRole("button", { name: "Save account profile" }));
    await screen.findByText("Account not refreshed");

    // Save is hidden in this state, but the field still sits in an active form, so Enter would
    // submit it. The guard has to hold at the submit boundary, not only in the rendered controls.
    fireEvent.submit(form);
    fireEvent.submit(form);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(
      vi.mocked(fetch).mock.calls.filter(([input, init]) => String(input) === "/api/v1/me" && init?.method === "PATCH"),
    ).toHaveLength(1);
    expect(screen.getByText("Account not refreshed")).toBeTruthy();
  });

  it("lets no new save race an in-flight refresh retry", async () => {
    installApi({ meFailuresAfterProfileUpdate: 1, meDelayMsAfterProfileUpdate: 40 });
    window.history.replaceState({}, "", "/account");
    render(<App />);

    const displayName = (await screen.findByLabelText("Display name")) as HTMLInputElement;
    const form = displayName.closest("form");
    if (!form) throw new Error("Account form was not rendered");
    fireEvent.change(displayName, { target: { value: "Ada Lovelace" } });
    fireEvent.click(await screen.findByRole("button", { name: "Save account profile" }));
    await screen.findByText("Account not refreshed");

    const refreshesBeforeRetry = vi
      .mocked(fetch)
      .mock.calls.filter(([input, init]) => String(input) === "/api/v1/me" && init?.method !== "PATCH").length;
    fireEvent.click(screen.getByRole("button", { name: "Retry refresh" }));

    // While the retry is in flight the field cannot be edited into a dirty state, a second retry
    // cannot start, and a submit cannot slip a competing write past it.
    expect(await screen.findByRole("button", { name: "Refreshing…" })).toBeTruthy();
    expect(displayName.disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Refreshing…" }));
    fireEvent.submit(form);

    expect(await screen.findByText("Account profile saved.")).toBeTruthy();
    expect(
      vi.mocked(fetch).mock.calls.filter(([input, init]) => String(input) === "/api/v1/me" && init?.method === "PATCH"),
    ).toHaveLength(1);
    // Exactly one refresh was added by the retry: the second click never started another.
    expect(
      vi.mocked(fetch).mock.calls.filter(([input, init]) => String(input) === "/api/v1/me" && init?.method !== "PATCH"),
    ).toHaveLength(refreshesBeforeRetry + 1);
    expect(await screen.findByText("Ada Lovelace")).toBeTruthy();
  });

  it("discards back to the saved name, never the stale one, while a refresh is outstanding", async () => {
    installApi({ meFailuresAfterProfileUpdate: 99 });
    window.history.replaceState({}, "", "/account");
    render(<App />);

    const displayName = (await screen.findByLabelText("Display name")) as HTMLInputElement;
    fireEvent.change(displayName, { target: { value: "Ada Lovelace" } });
    fireEvent.click(await screen.findByRole("button", { name: "Save account profile" }));
    await screen.findByText("Account not refreshed");

    // Editing again reopens the unsaved-changes bar, and Discard must return to the saved value.
    fireEvent.change(displayName, { target: { value: "Third Name" } });
    expect(await screen.findByText("Unsaved changes")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));

    expect(displayName.value).toBe("Ada Lovelace");
    expect(await screen.findByText("Account not refreshed")).toBeTruthy();
  });

  it("restores the confirmed server name and shows the error when an account update fails", async () => {
    installApi({ profileUpdateFails: true });
    window.history.replaceState({}, "", "/account");
    render(<App />);

    const displayName = (await screen.findByLabelText("Display name")) as HTMLInputElement;
    fireEvent.change(displayName, { target: { value: "Rejected Name" } });
    fireEvent.click(await screen.findByRole("button", { name: "Save account profile" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Display name update failed");
    expect(displayName.value).toBe("Ada");
    expect(screen.getByText("Ada")).toBeTruthy();
  });

  it.each(["/workspace", "/admins", `/invites/${"A".repeat(43)}`])(
    "does not preserve retired Workspace product route %s",
    async (path) => {
      window.history.replaceState({}, "", path);
      render(<App />);
      expect(await screen.findByRole("heading", { name: "Page not found" })).toBeTruthy();
      expect(window.location.pathname).toBe(path);
      expect(vi.mocked(fetch)).not.toHaveBeenCalled();
    },
  );

  it("keeps the Agent home focused on status, usage, and Tasks", async () => {
    installApi({ bound: true });
    window.history.replaceState({}, "", `/agents/${agentId}`);
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Reviewer" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Usage" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Tasks" })).toBeTruthy();
    expect(await screen.findByRole("link", { name: "Investigate the failed deployment" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "View Details" }).getAttribute("href")).toBe(`/agents/${agentId}/usage`);
    /*
     * Connection sits beside Usage and names the channel, so the header carries no messaging
     * control of its own -- Settings is its only trailing link.
     */
    expect(screen.getByRole("heading", { name: "Connection" })).toBeTruthy();
    const connection = screen.getByRole("region", { name: "Connection" });
    expect(within(connection).getByText("Feishu · @reviewer")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Feishu · @reviewer" })).toBeNull();
    const header = screen.getByRole("heading", { name: "Reviewer" }).closest("header");
    expect(
      within(header as HTMLElement)
        .getAllByRole("link")
        .map((item) => item.textContent?.trim()),
    ).toEqual(["Agents", "Settings"]);
    expect(screen.getByRole("link", { name: "Settings" }).getAttribute("href")).toBe(`/agents/${agentId}/settings`);
    expect(screen.queryByRole("heading", { name: "Current work" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Messaging" })).toBeNull();
    expect(screen.queryByLabelText("More Agent actions")).toBeNull();
    expect(screen.queryByRole("navigation", { name: "Agent sections" })).toBeNull();
    expect(screen.queryByText("Runtime")).toBeNull();
  });

  it("shows another Admin's creation identity as audit information, not management ownership", async () => {
    installApi({ agentCreator: { userId: memberUserId, displayName: "Grace" }, bound: true });
    window.history.replaceState({}, "", `/agents/${agentId}`);
    render(<App />);

    expect(await screen.findByText("Created by Grace")).toBeTruthy();
    expect(screen.queryByText(/Managed by/)).toBeNull();
  });

  it.each([
    ["View Details", "Usage"],
    ["Settings", "Agent settings"],
  ])("keeps Agent context visible while opening %s", async (linkName, destinationHeading) => {
    let agentReads = 0;
    let releaseAgentRead = () => {};
    const pendingAgentRead = new Promise<void>((resolve) => {
      releaseAgentRead = resolve;
    });
    installApi({
      agentRead: () => {
        agentReads += 1;
        return agentReads === 1 ? undefined : pendingAgentRead;
      },
      bound: true,
    });
    window.history.replaceState({}, "", `/agents/${agentId}`);
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Reviewer" })).toBeTruthy();
    fireEvent.click(screen.getByRole("link", { name: linkName }));

    expect(await screen.findByRole("heading", { name: destinationHeading })).toBeTruthy();
    await waitFor(() => expect(agentReads).toBe(2));
    expect(screen.queryByLabelText("Loading current server state")).toBeNull();
    await act(async () => releaseAgentRead());
  });

  // Route state cannot mask the response here — this navigation warms the Agent's detail read
  // first, so the cache is what the terminal response has to outrank. The route-state window,
  // where the read has never held data, is covered in `agent-queries.test.tsx`.
  it.each([403, 404])("replaces a cached Agent with a terminal detail response (%d)", async (status) => {
    let agentReads = 0;
    installApi({
      agentRead: () => {
        agentReads += 1;
      },
      agentReadStatus: () => (agentReads > 1 ? status : undefined),
      bound: true,
    });
    window.history.replaceState({}, "", `/agents/${agentId}`);
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Reviewer" })).toBeTruthy();
    fireEvent.click(screen.getByRole("link", { name: "View Details" }));
    expect(await screen.findByRole("heading", { name: "Usage" })).toBeTruthy();
    await waitFor(() => expect(agentReads).toBe(2));
    expect((await screen.findByRole("alert")).textContent).toContain("Agent unavailable");
    expect(screen.queryByRole("heading", { name: "Reviewer" })).toBeNull();
  });

  it("shows confirmed active work without exposing conversation content", async () => {
    installApi({
      bound: true,
      agentActivity: { state: "working", startedAt: "2026-08-24T09:00:00.000Z" },
    });
    window.history.replaceState({}, "", `/agents/${agentId}`);
    render(<App />);

    expect((await screen.findAllByText("Working")).length).toBeGreaterThan(0);
    expect(await screen.findByRole("link", { name: "Investigate the failed deployment" })).toBeTruthy();
    expect(document.body.textContent).not.toContain("Private conversation content");
  });

  it("groups all admin-only controls in a lightweight Settings directory", async () => {
    installApi();
    window.history.replaceState({}, "", `/agents/${agentId}/settings`);
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Agent settings" })).toBeTruthy();
    expect(screen.queryByRole("navigation", { name: "Agent settings" })).toBeNull();
    // One list in the order a viewer thinks about an Agent, with the irreversible actions held apart.
    const setup = await screen.findByRole("region", { name: "Agent setup" });
    expect(
      [...setup.querySelectorAll('[data-ui="agent-settings-entry"] strong')].map((entry) => entry.textContent),
    ).toEqual(["Name", "Messaging", "Computer", "Instructions", "Model & reasoning"]);
    expect(screen.getByRole("heading", { name: "Danger zone" })).toBeTruthy();
    expect(screen.getByRole("link", { name: /^Pause or delete/ })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "How it works" })).toBeNull();
    expect(screen.getByRole("link", { name: /^Instructions / })).toBeTruthy();
    expect(screen.getByRole("link", { name: /Model & reasoning/ })).toBeTruthy();
    expect(screen.getByRole("link", { name: /Messaging/ })).toBeTruthy();
    expect(screen.getByRole("link", { name: /^Name Reviewer$/ })).toBeTruthy();
    expect(screen.getByText("Computer")).toBeTruthy();
    // Every row in the list opens; a row that is a link only sometimes cannot be predicted.
    expect(screen.getByRole("link", { name: /^Computer / })).toBeTruthy();
    expect(screen.getByRole("link", { name: /Pause or delete/ })).toBeTruthy();
    expect(screen.getByText("Not configured")).toBeTruthy();
    expect(screen.getByText("Codex · Provider defaults")).toBeTruthy();
    expect(screen.getByText("Reviewer")).toBeTruthy();
    expect(screen.getByText("Ada's Mac · macOS · Online")).toBeTruthy();
    expect(screen.queryByText("Runtime")).toBeNull();
  });

  it("returns to the Agent home when Messaging was opened from its Manage shortcut", async () => {
    installApi({ bound: true });
    window.history.replaceState({}, "", `/agents/${agentId}`);
    render(<App />);

    const connection = await screen.findByRole("region", { name: "Connection" });
    fireEvent.click(within(connection).getByRole("link", { name: "View messaging" }));
    expect(await screen.findByRole("heading", { name: "Messaging" })).toBeTruthy();
    const backLink = screen.getByRole("link", { name: "Back to Reviewer" });
    expect(backLink.getAttribute("href")).toBe(`/agents/${agentId}`);
    fireEvent.click(backLink);
    expect(await screen.findByRole("heading", { name: "Reviewer" })).toBeTruthy();
  });

  it("opens Connected computer recovery only when the Computer needs attention", async () => {
    installApi({ computerStatus: () => "offline" });
    window.history.replaceState({}, "", `/agents/${agentId}/settings`);
    render(<App />);

    const computerLabel = await screen.findByText("Computer");
    const computerLink = computerLabel.closest("a");
    expect(screen.getByText("Ada's Mac · macOS · Offline")).toBeTruthy();
    expect(screen.getByText("Review")).toBeTruthy();
    if (!(computerLink instanceof HTMLAnchorElement)) {
      throw new Error("Expected the Connected computer recovery row to be a link");
    }
    expect(computerLink.getAttribute("href")).toBe(`/agents/${agentId}/settings/computer`);
  });

  it("edits the Agent display name without exposing its permanent handle", async () => {
    installApi();
    window.history.replaceState({}, "", `/agents/${agentId}/settings/identity`);
    render(<App />);

    const displayName = (await screen.findByLabelText("Display name")) as HTMLInputElement;
    expect(screen.getByRole("heading", { name: "Name" })).toBeTruthy();
    expect(screen.queryByText("Choose the name teammates see.")).toBeNull();
    expect(screen.queryByLabelText("Handle")).toBeNull();
    expect(screen.queryByText(/handle cannot be changed/i)).toBeNull();
    expect(screen.queryByRole("button", { name: "Save changes" })).toBeNull();

    fireEvent.change(displayName, { target: { value: "Research Reviewer" } });
    expect(screen.getByText("Unsaved changes")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(displayName.value).toBe("Reviewer");
    expect(screen.queryByText("Unsaved changes")).toBeNull();
  });

  it("pauses and deletes an Agent from Manage with destructive confirmation", async () => {
    installApi();
    window.history.replaceState({}, "", `/agents/${agentId}/settings/manage`);
    render(<App />);

    const unavailableDeleteButton = await screen.findByRole("button", { name: "Delete permanently" });
    expect(unavailableDeleteButton.hasAttribute("disabled")).toBe(true);
    expect(screen.getByText("Pause this Agent before deleting it permanently.")).toBeTruthy();
    fireEvent.click(unavailableDeleteButton);
    expect(screen.queryByRole("dialog", { name: "Delete Reviewer?" })).toBeNull();

    fireEvent.click(await screen.findByRole("button", { name: "Pause" }));
    expect(await screen.findByRole("button", { name: "Reactivate" })).toBeTruthy();
    const deleteButton = screen.getByRole("button", { name: "Delete permanently" });
    expect(deleteButton.hasAttribute("disabled")).toBe(false);
    fireEvent.click(deleteButton);
    const dialog = await screen.findByRole("dialog", { name: "Delete Reviewer?" });
    expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
    const confirmedDeleteButton = within(dialog).getByRole("button", { name: "Delete permanently" });
    expect(confirmedDeleteButton.hasAttribute("disabled")).toBe(true);
    fireEvent.change(within(dialog).getByLabelText(/Type Reviewer to confirm/), { target: { value: "Reviewer" } });
    expect(confirmedDeleteButton.hasAttribute("disabled")).toBe(false);
    fireEvent.click(confirmedDeleteButton);
    await waitFor(() => expect(window.location.pathname).toBe("/agents"));
  });

  it("evicts a deleted Agent before a failed list refresh can retain it", async () => {
    let listReads = 0;
    installApi({
      agentListStatus: () => {
        listReads += 1;
        return listReads > 1 ? 503 : undefined;
      },
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("link", { name: "Open Reviewer" }));
    fireEvent.click(await screen.findByRole("link", { name: "Settings" }));
    fireEvent.click(await screen.findByRole("link", { name: /Pause or delete/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Pause" }));
    expect(await screen.findByRole("button", { name: "Reactivate" })).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Delete permanently" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete Reviewer?" });
    fireEvent.change(within(dialog).getByLabelText(/Type Reviewer to confirm/), { target: { value: "Reviewer" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete permanently" }));

    expect(await screen.findByRole("heading", { name: "No Agents yet" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Open Reviewer" })).toBeNull();
    expect(listReads).toBe(2);
  });

  it("keeps lifecycle failures visible inside the confirmation dialog and allows retry", async () => {
    installApi({
      agentActivity: { state: "working", startedAt: "2026-08-24T12:00:00.000Z" },
    });
    const baseFetch = vi.mocked(fetch).getMockImplementation();
    if (!baseFetch) throw new Error("Expected the test API to be installed");
    let failSuspend = true;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input) === `/api/v1/agents/${agentId}/suspend` && init?.method === "POST" && failSuspend) {
        failSuspend = false;
        return json(
          { error: { code: "SERVICE_UNAVAILABLE", category: "transient", message: "Unable to pause right now" } },
          503,
        );
      }
      return baseFetch(input, init);
    });
    window.history.replaceState({}, "", `/agents/${agentId}/settings/manage`);
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Pause" }));
    const dialog = await screen.findByRole("dialog", { name: "Pause Reviewer?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Pause Agent" }));
    expect((await within(dialog).findByRole("alert")).textContent).toContain("Unable to pause right now");

    fireEvent.click(within(dialog).getByRole("button", { name: "Pause Agent" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Pause Reviewer?" })).toBeNull());
    const reactivateButton = await screen.findByRole("button", { name: "Reactivate" });
    await waitFor(() => expect(document.activeElement).toBe(reactivateButton));
  });

  it("keeps delete failures visible inside the confirmation dialog and clears them after retry", async () => {
    installApi({ initialStatus: "suspended" });
    const baseFetch = vi.mocked(fetch).getMockImplementation();
    if (!baseFetch) throw new Error("Expected the test API to be installed");
    let failDelete = true;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input) === `/api/v1/agents/${agentId}` && init?.method === "DELETE" && failDelete) {
        failDelete = false;
        return json(
          { error: { code: "SERVICE_UNAVAILABLE", category: "transient", message: "Unable to delete right now" } },
          503,
        );
      }
      return baseFetch(input, init);
    });
    window.history.replaceState({}, "", `/agents/${agentId}/settings/manage`);
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Delete permanently" }));
    const dialog = await screen.findByRole("dialog", { name: "Delete Reviewer?" });
    fireEvent.change(within(dialog).getByLabelText(/Type Reviewer to confirm/), { target: { value: "Reviewer" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete permanently" }));
    expect((await within(dialog).findByRole("alert")).textContent).toContain("Unable to delete right now");

    fireEvent.click(within(dialog).getByRole("button", { name: "Delete permanently" }));
    await waitFor(() => expect(window.location.pathname).toBe("/agents"));
    expect(screen.queryByText("Unable to delete right now")).toBeNull();
  });

  it("shows detailed Agent Token usage and changes the selected period", async () => {
    installApi();
    window.history.replaceState({}, "", `/agents/${agentId}/usage`);
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Usage" })).toBeTruthy();
    expect(await screen.findByRole("img", { name: /428K Tokens used · Last 30 days/ })).toBeTruthy();
    expect(screen.getByText("Tokens")).toBeTruthy();
    expect(screen.queryByText("Failed Tasks")).toBeNull();
    expect(screen.queryByText("Average per measured Task")).toBeNull();
    expect(screen.getByText("Partial data.")).toBeTruthy();
    expect(screen.getByRole("status").textContent).toBe(
      "Partial data. Token data is available for 31 of 32 tasks. Token totals and charts are partial.",
    );
    expect(screen.getByRole("heading", { name: "Token usage over time" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Token breakdown" })).toBeTruthy();
    expect(screen.getAllByText(/0 Tokens$/).length).toBeGreaterThan(0);
    expect(screen.getByText("Input")).toBeTruthy();
    expect(screen.getByText("Output")).toBeTruthy();
    expect(screen.getByText("Cached input")).toBeTruthy();
    expect(screen.queryByText("Turns")).toBeNull();

    fireEvent.click(screen.getByRole("combobox", { name: "Usage period" }));
    const sevenDayOption = await screen.findByRole("option", { name: "Last 7 days" });
    fireEvent.pointerMove(sevenDayOption, { pointerType: "mouse" });
    fireEvent.pointerDown(sevenDayOption, { pointerType: "mouse" });
    fireEvent.pointerUp(sevenDayOption, { pointerType: "mouse" });
    fireEvent.click(sevenDayOption);
    await waitFor(() =>
      expect(
        vi.mocked(fetch).mock.calls.some(([input]) => String(input) === `/api/v1/agents/${agentId}/usage?days=7`),
      ).toBe(true),
    );
    expect(await screen.findByRole("img", { name: /428K Tokens used · Last 7 days/ })).toBeTruthy();
  });

  it("explains when no Tasks report Token usage", async () => {
    installApi({
      agentUsage: {
        tasks: 4,
        measuredTasks: 0,
        failed: 0,
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        tokens: 0,
        daily: [],
      },
    });
    window.history.replaceState({}, "", `/agents/${agentId}/usage`);
    render(<App />);

    expect((await screen.findByText("Token data unavailable.")).closest("[role='status']")?.textContent).toBe(
      "Token data unavailable. None of the 4 tasks reported token usage. Token totals and charts may be empty.",
    );
  });

  it("keeps the Usage loading skeleton aligned with the two summary metrics", async () => {
    installApi();
    const baseFetch = vi.mocked(fetch).getMockImplementation();
    let releaseUsage = () => {};
    const pendingUsage = new Promise<void>((resolve) => {
      releaseUsage = resolve;
    });
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input).startsWith(`/api/v1/agents/${agentId}/usage?`)) await pendingUsage;
      if (!baseFetch) throw new Error("Expected the base fetch implementation");
      return baseFetch(input, init);
    });
    window.history.replaceState({}, "", `/agents/${agentId}/usage`);
    render(<App />);

    const loading = await screen.findByLabelText("Loading Agent usage");
    expect(loading.children).toHaveLength(2);
    releaseUsage();
    expect(await screen.findByText("Partial data.")).toBeTruthy();
  });

  it("redirects legacy Agent URLs without keeping the old UI", async () => {
    installApi();
    window.history.replaceState({}, "", `/agents/${agentId}/runtime`);
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Model & reasoning" })).toBeTruthy();
    expect(window.location.pathname).toBe(`/agents/${agentId}/settings/execution`);
    expect(screen.queryByText("Runtime")).toBeNull();
  });

  it.each([
    ["integrations", "Agent integrations are not available here", "Browse integrations"],
    ["skills", "Agent skills are not available here", "Browse skills"],
  ])("keeps legacy Agent %s URLs inside an explicit Agent-scoped boundary", async (section, heading, action) => {
    installApi();
    window.history.replaceState({}, "", `/agents/${agentId}/${section}`);
    render(<App />);

    expect(await screen.findByRole("heading", { name: heading })).toBeTruthy();
    expect(window.location.pathname).toBe(`/agents/${agentId}/${section}`);
    expect(screen.getByText(/assigned to Reviewer.*shared catalog is separate/)).toBeTruthy();
    expect(screen.getByRole("link", { name: action }).getAttribute("href")).toBe(`/${section}`);
  });

  it("does not preserve the removed Agent Access surface", async () => {
    installApi();
    window.history.replaceState({}, "", `/agents/${agentId}/access`);
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Page not found" })).toBeTruthy();
    expect(window.location.pathname).toBe(`/agents/${agentId}/access`);
  });

  it("keeps assigned Computer details in its own Settings page", async () => {
    installApi({ bound: true });
    window.history.replaceState({}, "", `/agents/${agentId}/settings/computer`);
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Ada's Mac · macOS" })).toBeTruthy();
    expect(screen.getByText("Online")).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Reviewer" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Execution" })).toBeNull();
    expect(screen.queryByText(/Turn timeout/i)).toBeNull();
    expect(screen.queryByText(/Last seen/i)).toBeNull();
  });

  it("names the machine-level recovery for an offline Computer instead of offering a dead retry", async () => {
    installApi({ bound: true, computerStatus: () => "offline" });
    window.history.replaceState({}, "", `/agents/${agentId}/settings/computer`);
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Ada's Mac · macOS" })).toBeTruthy();
    expect(screen.getByText("Offline")).toBeTruthy();
    expect(screen.getByText(/Last seen/)).toBeTruthy();
    expect(
      screen.getByText("OpenTag is not running on Ada's Mac. Start it there to bring it back online."),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Check again" })).toBeNull();
  });

  it("offers machine recovery on the Connected computer page when the Computer is offline", async () => {
    installApi({ bound: true, computerStatus: () => "offline" });
    window.history.replaceState({}, "", `/agents/${agentId}/settings/computer`);
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Ada's Mac · macOS" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reconnect this Computer" })).toBeTruthy();
  });

  it("withholds machine recovery when the Computer is reachable but its Provider is not", async () => {
    installApi({
      bound: true,
      computerProviderReadiness: [{ provider: "codex", status: "install", observedAt: "2026-08-20T00:00:00.000Z" }],
    });
    window.history.replaceState({}, "", `/agents/${agentId}/settings/computer`);
    render(<App />);

    expect(await screen.findByText("Codex is not installed on Ada's Mac.")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Reconnect this Computer" })).toBeNull();
  });

  it("generates a command naming the assigned Computer without leaving the Agent", async () => {
    installApi({ bound: true, computerStatus: () => "offline" });
    window.history.replaceState({}, "", `/agents/${agentId}/settings/computer`);
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Reconnect this Computer" }));

    expect(screen.getByRole("heading", { name: "Reconnect Ada's Mac" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Generate connection command" })).toBeTruthy();
    expect(window.location.pathname).toBe(`/agents/${agentId}/settings/computer`);
  });

  it("observes a Computer coming back online from the recovery page itself", async () => {
    let computerStatus: "online" | "offline" = "offline";
    installApi({ bound: true, computerStatus: () => computerStatus });
    window.history.replaceState({}, "", `/agents/${agentId}/settings/computer`);
    render(<App />);

    expect(await screen.findByText("Offline")).toBeTruthy();
    expect(
      screen.getByText("OpenTag is not running on Ada's Mac. Start it there to bring it back online."),
    ).toBeTruthy();

    computerStatus = "online";
    fireEvent(window, new Event("focus"));

    expect(await screen.findByText("Online")).toBeTruthy();
    await waitFor(() => expect(screen.queryByText(/Start it there/)).toBeNull());
  });

  it("explains an unready Provider on the Computer page instead of the model settings", async () => {
    installApi({
      bound: true,
      runtimeProvider: "claude-code",
      computerProviderReadiness: [
        { provider: "codex", status: "ready", observedAt: "2026-08-20T00:00:00.000Z" },
        { provider: "claude-code", status: "sign-in", observedAt: "2026-08-20T00:00:00.000Z" },
      ],
    });
    window.history.replaceState({}, "", `/agents/${agentId}/settings/computer`);
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Ada's Mac · macOS" })).toBeTruthy();
    expect(screen.getByText("Not ready")).toBeTruthy();
    expect(screen.getByText("Claude Code is not signed in on Ada's Mac.")).toBeTruthy();
  });

  it("refreshes Agent availability when the page regains focus", async () => {
    let computerStatus: "online" | "offline" = "online";
    installApi({ bound: true, computerStatus: () => computerStatus });
    window.history.replaceState({}, "", `/agents/${agentId}`);
    render(<App />);
    expect((await screen.findAllByText("Ready")).length).toBeGreaterThan(0);

    computerStatus = "offline";
    fireEvent(window, new Event("focus"));
    const offlineReason = await screen.findByText(
      "OpenTag is not running on this Computer. Start it there to bring it back online.",
    );
    const computerRow = offlineReason.closest('[data-ui="connection-computer"]') as HTMLElement;
    expect(computerRow).toBeTruthy();
    expect(within(computerRow).getByText("Offline")).toBeTruthy();
    expect(within(computerRow).getByRole("link", { name: "View Computer" })).toBeTruthy();
  });

  it("keeps Agent cards useful when Computer status cannot be confirmed", async () => {
    installApi({ bound: true, computerEvidenceFails: true });
    window.history.replaceState({}, "", "/agents");
    render(<App />);

    expect(await screen.findByText("Reviewer")).toBeTruthy();
    expect(screen.getByText("Computer unknown")).toBeTruthy();
    expect(screen.getByText("Unable to confirm readiness")).toBeTruthy();
    expect(screen.queryByText("Ada's Mac · macOS")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).includes("/computers"))).toBe(true);
    expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).includes(`/agents/${agentId}/im-binding`))).toBe(
      false,
    );
  });

  it("requires the selected runtime Provider to be ready before an Agent card is Available", async () => {
    installApi({
      bound: true,
      runtimeProvider: "claude-code",
      computerProviderReadiness: [
        { provider: "codex", status: "ready", observedAt: "2026-08-20T00:00:00.000Z" },
        { provider: "claude-code", status: "sign-in", observedAt: "2026-08-20T00:00:00.000Z" },
      ],
    });
    window.history.replaceState({}, "", "/agents");
    render(<App />);

    expect(await screen.findByText("Claude Code sign-in required")).toBeTruthy();
    expect(screen.getByText("Cannot receive new work")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "View Computer" })).toBeNull();
    expect(screen.queryByText("Available")).toBeNull();
  });

  it("shows a user-facing recovery without readiness implementation details", async () => {
    installApi({ bound: true, handoffReady: false });
    window.history.replaceState({}, "", `/agents/${agentId}`);
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Reviewer" })).toBeTruthy();
    // The detail status names the same state as the Agent list, so one failure has one name.
    // The channel is connected here; only delivery is not, and the label has to say which.
    expect(screen.getAllByText("Cannot receive messages").length).toBeGreaterThan(0);
    expect(screen.queryByText("Messaging disconnected")).toBeNull();
    expect(screen.queryByText("Needs attention")).toBeNull();
    expect(screen.queryByText("Action required")).toBeNull();
    const messagingRow = screen
      .getByRole("region", { name: "Connection" })
      .querySelector('[data-ui="connection-messaging"]') as HTMLElement;
    expect(within(messagingRow).getByText("Messages cannot be delivered to this Agent right now.")).toBeTruthy();
    expect(within(messagingRow).getByRole("link", { name: "View messaging" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Usage" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Tasks" })).toBeTruthy();
    expect(screen.queryByText("Handoff")).toBeNull();
    expect(screen.queryByText("Ada's Mac")).toBeNull();
    expect(screen.queryByText("Runtime")).toBeNull();
  });

  it("does not infer an empty contact when messaging evidence cannot be confirmed", async () => {
    installApi({ bound: true, bindingEvidenceFails: true });
    window.history.replaceState({}, "", `/agents/${agentId}`);
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Reviewer" })).toBeTruthy();
    const messagingRow = screen
      .getByRole("region", { name: "Connection" })
      .querySelector('[data-ui="connection-messaging"]') as HTMLElement;
    // Unreadable evidence says so; it must not be reported as "no channel connected".
    expect(within(messagingRow).getByText("Unknown")).toBeTruthy();
    expect(within(messagingRow).getByText("OpenTag could not read this Agent's messaging connection.")).toBeTruthy();
    expect(within(messagingRow).getByRole("link", { name: "View messaging" }).getAttribute("href")).toBe(
      `/agents/${agentId}/settings/messaging`,
    );
    expect(screen.queryByText("Not connected")).toBeNull();
    expect(screen.queryByRole("link", { name: "Connect messaging" })).toBeNull();
    expect(screen.queryByText("Handoff")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("still names a paused Agent and its resume exit on the Agent home", async () => {
    /*
     * A pause is not a dependency failure, so no Connection row speaks for it: a suspended Agent
     * can have a healthy Computer and a live channel, and `projectAgentAvailability` ranks the
     * pause first while still filling both dependencies. Without an Agent-level notice the home
     * reads Online / Connected and never says the Agent is off.
     */
    installApi({ bound: true, initialStatus: "suspended" });
    window.history.replaceState({}, "", `/agents/${agentId}`);
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Reviewer" })).toBeTruthy();
    const notice = screen.getByRole("region", { name: "Agent status: Suspended" });
    expect(within(notice).getByText("Suspended")).toBeTruthy();
    expect(within(notice).getByText("This Agent is paused. Resume it to start receiving messages again.")).toBeTruthy();
    expect(within(notice).getByRole("link", { name: "Manage Agent" }).getAttribute("href")).toBe(
      `/agents/${agentId}/settings/manage`,
    );
  });

  it("keeps unreadable Computer and Messaging evidence out of the success states", async () => {
    /*
     * Both rows used to fall through to Online / Connected when the evidence behind them could not
     * be read -- a reachable Computer with no Provider readiness, and an active binding whose
     * delivery could not be confirmed. Missing evidence is not a working Agent.
     */
    installApi({ bound: true, computerProviderReadiness: [] });
    window.history.replaceState({}, "", `/agents/${agentId}`);
    const unconfirmedRuntime = render(<App />);

    expect(await screen.findByRole("heading", { name: "Reviewer" })).toBeTruthy();
    const computerRow = screen
      .getByRole("region", { name: "Connection" })
      .querySelector('[data-ui="connection-computer"]') as HTMLElement;
    expect(within(computerRow).queryByText("Online")).toBeNull();
    expect(within(computerRow).getByText("Unknown")).toBeTruthy();
    expect(within(computerRow).getByText("OpenTag could not confirm Codex on this Computer.")).toBeTruthy();
    unconfirmedRuntime.unmount();

    installApi({ bound: true, handoffEvidenceFails: true });
    window.history.replaceState({}, "", `/agents/${agentId}`);
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Reviewer" })).toBeTruthy();
    const messagingRow = screen
      .getByRole("region", { name: "Connection" })
      .querySelector('[data-ui="connection-messaging"]') as HTMLElement;
    expect(within(messagingRow).queryByText("Connected")).toBeNull();
    expect(within(messagingRow).getByText("Unknown")).toBeTruthy();
    expect(within(messagingRow).getByText("OpenTag could not confirm whether messages reach this Agent.")).toBeTruthy();
  });

  it("keeps a repair exit in every Computer state", async () => {
    /*
     * The mirror of the messaging case below, and the assertion whose absence let `Checking` ship
     * without an exit. This card is the only Computer recovery surface on the Agent home, so a
     * state that drops the link leaves no route to the Computer from this page at all.
     *
     * Each row's sentence is asserted with its label because the two are derived from different
     * places: the label from the per-dependency `runtime.status`, the sentence previously from the
     * Agent-wide reason, which let a paused Agent label a Provider "Checking" while claiming the
     * connection was unconfirmed about a Computer that was online.
     */
    const readiness = (status: "checking" | "install" | "sign-in" | "unavailable" | "ready") =>
      [{ observedAt: "2026-08-20T00:00:00.000Z", provider: "codex" as const, status }] as const;
    const states = [
      {
        detail: "OpenTag could not confirm this Computer's current connection.",
        label: "Unknown",
        options: { computerEvidenceFails: true },
      },
      {
        detail: "OpenTag is not running on this Computer. Start it there to bring it back online.",
        label: "Offline",
        options: { computerStatus: () => "offline" as const },
      },
      {
        detail: "OpenTag is still checking Codex on this Computer.",
        label: "Checking Codex",
        options: { computerProviderReadiness: readiness("checking") },
      },
      {
        detail: "Codex is not installed on this Computer.",
        label: "Codex not installed",
        options: { computerProviderReadiness: readiness("install") },
      },
      {
        detail: "Codex is not signed in on this Computer.",
        label: "Codex sign-in required",
        options: { computerProviderReadiness: readiness("sign-in") },
      },
      {
        detail: "Codex is unavailable on this Computer.",
        label: "Codex unavailable",
        options: { computerProviderReadiness: readiness("unavailable") },
      },
      { detail: undefined, label: "Online", options: { computerProviderReadiness: readiness("ready") } },
    ];
    for (const state of states) {
      installApi({ bound: true, ...state.options });
      window.history.replaceState({}, "", `/agents/${agentId}`);
      const rendered = render(<App />);

      expect(await screen.findByRole("heading", { name: "Reviewer" })).toBeTruthy();
      const row = screen
        .getByRole("region", { name: "Connection" })
        .querySelector('[data-ui="connection-computer"]') as HTMLElement;
      expect(row).toBeTruthy();
      expect(within(row).getByText(state.label)).toBeTruthy();
      if (state.detail) expect(within(row).getByText(state.detail)).toBeTruthy();
      expect(within(row).getByRole("link", { name: "View Computer" }).getAttribute("href")).toBe(
        `/agents/${agentId}/settings/computer`,
      );
      rendered.unmount();
    }
  });

  it("does not let a paused Agent make the Computer row contradict itself", async () => {
    /*
     * `agent_suspended` outranks every dependency reason, so a row deriving its sentence from the
     * Agent-wide reason described a masked state: "Checking Codex" beside "could not confirm this
     * Computer's current connection", about a Computer that was online and confirmed.
     */
    installApi({
      bound: true,
      initialStatus: "suspended",
      computerProviderReadiness: [{ observedAt: "2026-08-20T00:00:00.000Z", provider: "codex", status: "checking" }],
    });
    window.history.replaceState({}, "", `/agents/${agentId}`);
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Reviewer" })).toBeTruthy();
    const row = screen
      .getByRole("region", { name: "Connection" })
      .querySelector('[data-ui="connection-computer"]') as HTMLElement;
    expect(within(row).getByText("Checking Codex")).toBeTruthy();
    expect(within(row).getByText("OpenTag is still checking Codex on this Computer.")).toBeTruthy();
    expect(within(row).queryByText(/could not confirm this Computer's current connection/)).toBeNull();
  });

  it("names the channel and keeps a repair exit in every messaging state", async () => {
    /*
     * Messaging is what makes an Agent reachable, and this card replaced the header control that
     * used to carry it. Every state has to name what is true and still offer the way to change it:
     * dropping the exit on a healthy channel would leave rebinding reachable only by hunting.
     */
    const states = [
      {
        detail: "Slack · Reviewer",
        label: "Connected",
        exit: "View messaging",
        options: { bound: true, provider: "slack" as const },
      },
      {
        detail: "Connect a chat app so teammates can send this Agent work.",
        label: "Not connected",
        exit: "Connect messaging",
        options: { bound: false },
      },
      {
        detail: "OpenTag could not read this Agent's messaging connection.",
        label: "Unknown",
        exit: "View messaging",
        options: { bound: true, bindingEvidenceFails: true },
      },
    ];
    for (const state of states) {
      installApi(state.options);
      window.history.replaceState({}, "", `/agents/${agentId}`);
      const rendered = render(<App />);

      expect(await screen.findByRole("heading", { name: "Reviewer" })).toBeTruthy();
      const row = screen
        .getByRole("region", { name: "Connection" })
        .querySelector('[data-ui="connection-messaging"]') as HTMLElement;
      expect(row).toBeTruthy();
      expect(within(row).getByText(state.label)).toBeTruthy();
      expect(within(row).getByText(state.detail)).toBeTruthy();
      expect(within(row).getByRole("link", { name: state.exit }).getAttribute("href")).toBe(
        `/agents/${agentId}/settings/messaging`,
      );
      rendered.unmount();
    }
  });

  it("offers messaging setup only when the missing binding is confirmed", async () => {
    installApi({ bound: false });
    window.history.replaceState({}, "", `/agents/${agentId}/settings/messaging`);
    render(<App />);

    // The section names the state it is in, rather than carrying one name when a channel exists and
    // another when it does not.
    expect(await screen.findByRole("heading", { name: "No channel connected" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Contact channel" })).toBeNull();
    expect(screen.getByText(/cannot contact this Agent/)).toBeTruthy();
  });

  it("separates the connected channel from the trigger mode that acts on it", async () => {
    installApi({ bound: true });
    window.history.replaceState({}, "", `/agents/${agentId}/settings/messaging`);
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Connected channel" })).toBeTruthy();
    expect(screen.getByText("Feishu · @reviewer")).toBeTruthy();
    expect(screen.getByText("Connected")).toBeTruthy();
    expect(screen.getByText(/Validated/)).toBeTruthy();
    // The channel identity is reported, not edited, so it carries no fields of its own.
    expect(screen.queryByText("Contact")).toBeNull();
    expect(screen.queryByText("How to use")).toBeNull();
    expect(screen.getByRole("heading", { name: "Group chat trigger mode" })).toBeTruthy();
    expect(
      screen.getByText(
        "Every message in connected group chats is kept as conversation history either way. This setting decides which of them wake this Agent up to act.",
      ),
    ).toBeTruthy();
    // A direct message is always delivered, so the row that only ever said so is gone.
    expect(screen.queryByText("Direct messages")).toBeNull();
    expect(screen.getByRole("group", { name: "Group chat trigger mode" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Change Feishu Bot" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Disconnect Feishu" })).toBeTruthy();
  });

  it("names a Slack channel by its verified Bot rather than by an invented Agent handle", async () => {
    installApi({ bound: true, handoffReady: true, provider: "slack" });
    window.history.replaceState({}, "", `/agents/${agentId}/settings/messaging`);
    const messaging = render(<App />);

    expect(await screen.findByRole("heading", { name: "Connected channel" })).toBeTruthy();
    expect(screen.getByText("Slack")).toBeTruthy();
    expect(screen.getAllByText("Reviewer").length).toBeGreaterThan(0);
    expect(screen.queryByText(/Slack · @/)).toBeNull();
    expect(screen.queryByText("@reviewer")).toBeNull();
    messaging.unmount();

    window.history.replaceState({}, "", `/agents/${agentId}`);
    render(<App />);
    const connection = await screen.findByRole("region", { name: "Connection" });
    expect(within(connection).getByText("Slack · Reviewer")).toBeTruthy();
    expect(within(connection).queryByText(/Slack · @reviewer/)).toBeNull();
  });

  it("keeps the loaded Tasks when loading the next page fails", async () => {
    installApi({ bound: true });
    const baseFetch = vi.mocked(fetch).getMockImplementation();
    if (!baseFetch) throw new Error("Expected the test API to be installed");
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input).startsWith("/api/v1/sessions?") && String(input).includes("cursor=")) {
        return json({ error: { code: "INTERNAL_ERROR", category: "transient", message: "Paging failed" } }, 500);
      }
      if (String(input) === "/api/v1/sessions" || String(input).startsWith("/api/v1/sessions?")) {
        return json({ tasks: [taskSummary], nextCursor: "cursor-2" });
      }
      return baseFetch(input, init);
    });
    window.history.replaceState({}, "", `/agents/${agentId}`);
    render(<App />);

    const task = await screen.findByRole("link", { name: "Investigate the failed deployment" });
    fireEvent.click(screen.getByRole("button", { name: "Load more" }));

    // A failed append reports itself; it does not throw away the rows the viewer already has.
    expect(await screen.findByText("Could not load more Tasks.")).toBeTruthy();
    expect(task.isConnected).toBe(true);
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(screen.queryByText("Tasks are temporarily unavailable.")).toBeNull();
  });

  it("does not blame an online Computer when the Provider is what is not ready", async () => {
    installApi({
      bound: true,
      handoffReady: false,
      computerProviderReadiness: [{ provider: "codex", status: "sign-in", observedAt: "2026-08-20T00:00:00.000Z" }],
    });
    window.history.replaceState({}, "", `/agents/${agentId}/settings/messaging`);
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Connected channel" })).toBeTruthy();
    expect(screen.getByText(/Messages wait until Codex is ready on this agent's computer\./)).toBeTruthy();
    expect(screen.queryByText(/until this agent's computer is online/)).toBeNull();
  });

  it("keeps the delivery explanation neutral when no blocker is observable", async () => {
    installApi({ bound: true, handoffReady: false });
    window.history.replaceState({}, "", `/agents/${agentId}/settings/messaging`);
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Connected channel" })).toBeTruthy();
    expect(
      screen.getByText(
        "The channel itself is connected, but messages cannot be delivered yet. Retrying automatically.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/Computer is online/)).toBeNull();
  });

  it("points at the Computer only when the Computer is the blocker", async () => {
    installApi({ bound: true, handoffReady: false, computerStatus: () => "offline" });
    window.history.replaceState({}, "", `/agents/${agentId}/settings/messaging`);
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Connected channel" })).toBeTruthy();
    expect(screen.getByText(/Messages wait until this agent's computer is online\./)).toBeTruthy();
  });

  it("shows a Messaging error instead of inferring an empty channel", async () => {
    installApi({ bindingEvidenceFails: true });
    window.history.replaceState({}, "", `/agents/${agentId}/settings/messaging`);
    render(<App />);

    expect((await screen.findByRole("alert")).textContent).toContain("Binding evidence unavailable");
    expect(screen.queryByRole("heading", { name: "No messaging channel" })).toBeNull();
  });

  it("does not overlap focus refreshes while an Agent read is still pending", async () => {
    let agentReads = 0;
    let computerStatus: "online" | "offline" = "online";
    let releaseAgentRead = () => {};
    const pendingAgentRead = new Promise<void>((resolve) => {
      releaseAgentRead = resolve;
    });
    installApi({
      agentRead: () => {
        agentReads += 1;
        return agentReads === 1 ? undefined : pendingAgentRead;
      },
      bound: true,
      computerStatus: () => computerStatus,
    });
    window.history.replaceState({}, "", `/agents/${agentId}`);
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Reviewer" })).toBeTruthy();

    computerStatus = "offline";
    fireEvent(window, new Event("focus"));
    fireEvent(window, new Event("focus"));
    await waitFor(() => expect(agentReads).toBe(2));
    expect(agentReads).toBe(2);

    releaseAgentRead();
    expect(
      await screen.findByText("OpenTag is not running on this Computer. Start it there to bring it back online."),
    ).toBeTruthy();
  });

  it("invalidates a stale Agent detail after a background not-found response", async () => {
    let agentReadStatus: number | undefined;
    installApi({ agentReadStatus: () => agentReadStatus, bound: true });
    window.history.replaceState({}, "", `/agents/${agentId}`);
    render(<App />);
    expect((await screen.findAllByText("Ready")).length).toBeGreaterThan(0);

    agentReadStatus = 404;
    fireEvent(window, new Event("focus"));
    expect((await screen.findByRole("alert")).textContent).toContain("Agent unavailable");
    expect(screen.queryByText("Ready")).toBeNull();
  });

  it("marks retained Agent rows unconfirmed after a transient primary refresh failure", async () => {
    let agentListStatus: number | undefined;
    installApi({ agentListStatus: () => agentListStatus, bound: true });
    window.history.replaceState({}, "", "/agents");
    render(<App />);
    expect(await screen.findByText("Ready")).toBeTruthy();

    agentListStatus = 503;
    fireEvent(window, new Event("focus"));
    expect(await screen.findByText("Unconfirmed")).toBeTruthy();
    expect(screen.getByText("Reviewer")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("changes Slack receive mode locally without opening Slack configuration", async () => {
    installApi({ bound: true, provider: "slack" });
    window.history.replaceState({}, "", `/agents/${agentId}/settings/messaging`);
    render(<App />);
    // Widening changes what the runtime is woken for, so it takes a deliberate second click -- but
    // not a modal: the control itself asks.
    fireEvent.click(await screen.findByRole("button", { name: "Every message" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(await screen.findByText(/raises Token spend/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Confirm every message" }));
    await waitFor(() =>
      expect(
        vi
          .mocked(fetch)
          .mock.calls.filter(
            ([input, init]) => String(input) === `/api/v1/agents/${agentId}` && init?.method === "PATCH",
          ),
      ).toHaveLength(1),
    );
    expect(
      vi
        .mocked(fetch)
        .mock.calls.filter(
          ([input, init]) => String(input).endsWith("/im-binding/slack/oauth/start") && init?.method === "POST",
        ),
    ).toHaveLength(0);
    await waitFor(() =>
      expect(
        vi
          .mocked(fetch)
          .mock.calls.filter(
            ([input, init]) => String(input) === `/api/v1/agents/${agentId}` && (init?.method ?? "GET") === "GET",
          ),
      ).toHaveLength(2),
    );
  });

  it("reports a failed trigger-mode change on the page and clears it before retry", async () => {
    installApi({ bound: true });
    const baseFetch = vi.mocked(fetch).getMockImplementation();
    if (!baseFetch) throw new Error("Expected the test API to be installed");
    let failReceiveMode = true;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input) === `/api/v1/agents/${agentId}` && init?.method === "PATCH" && failReceiveMode) {
        failReceiveMode = false;
        return json(
          {
            error: {
              code: "SERVICE_UNAVAILABLE",
              category: "transient",
              message: "Unable to update message access",
            },
          },
          503,
        );
      }
      return baseFetch(input, init);
    });
    window.history.replaceState({}, "", `/agents/${agentId}/settings/messaging`);
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Every message" }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm every message" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Unable to update message access");

    fireEvent.click(screen.getByRole("button", { name: "Every message" }));
    fireEvent.click(await screen.findByRole("button", { name: "Confirm every message" }));
    await waitFor(() => expect(screen.queryByText("Unable to update message access")).toBeNull());
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Group chat trigger mode" })),
    );
  });

  it("keeps disconnect failures inside the active dialog and allows retry", async () => {
    installApi({ bound: true });
    const baseFetch = vi.mocked(fetch).getMockImplementation();
    if (!baseFetch) throw new Error("Expected the test API to be installed");
    let failDisconnect = true;
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      if (String(input).endsWith("/disable") && init?.method === "POST") {
        if (failDisconnect) {
          failDisconnect = false;
          return json(
            {
              error: {
                code: "SERVICE_UNAVAILABLE",
                category: "transient",
                message: "Unable to disconnect messaging",
              },
            },
            503,
          );
        }
        return new Response(null, { status: 204 });
      }
      return baseFetch(input, init);
    });
    window.history.replaceState({}, "", `/agents/${agentId}/settings/messaging`);
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Disconnect Feishu" }));
    const dialog = await screen.findByRole("dialog", { name: "Disconnect messaging?" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Disconnect" }));
    expect((await within(dialog).findByRole("alert")).textContent).toContain("Unable to disconnect messaging");

    fireEvent.click(within(dialog).getByRole("button", { name: "Disconnect" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Disconnect messaging?" })).toBeNull());
    expect(screen.queryByText("Unable to disconnect messaging")).toBeNull();
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole("heading", { name: "Messaging" })));
  });

  it("shows stored Tasks and opens a Task detail", async () => {
    installApi();
    window.history.replaceState({}, "", "/tasks");
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Tasks" })).toBeTruthy();
    expect(screen.queryByText("Read-only debug view")).toBeNull();
    const task = await screen.findByRole("link", {
      name: "Investigate the failed deployment",
    });
    fireEvent.click(task);
    expect(await screen.findByText("Stored runtime output")).toBeTruthy();
    expect(screen.getByLabelText("Task details").textContent).toContain("Reviewer");
    expect(screen.getByRole("heading", { name: "Activity" })).toBeTruthy();
    expect(window.location.pathname).toBe(`/tasks/${taskSessionId}`);
  });

  it("opens a Task detail as a read-only activity record", async () => {
    installApi();
    window.history.replaceState({}, "", `/tasks/${taskSessionId}`);
    render(<App />);

    expect(await screen.findByText("Stored runtime output")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Activity" })).toBeTruthy();
    expect(screen.queryByText("Read-only debug view")).toBeNull();
    expect(screen.queryByText("Runtime details")).toBeNull();
  });

  it.each(["/settings", "/settings/members", "/members", "/teams"])(
    "does not preserve removed Team/member settings route %s",
    async (path) => {
      installApi();
      window.history.replaceState({}, "", path);
      render(<App />);

      expect(await screen.findByRole("heading", { name: "Page not found" })).toBeTruthy();
      expect(window.location.pathname).toBe(path);
    },
  );

  it("keeps Skills and Integrations reachable from the object navigation", async () => {
    installApi();
    window.history.replaceState({}, "", "/skills");
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Skills" })).toBeTruthy();
    fireEvent.click(screen.getByRole("link", { name: "Integrations" }));
    expect(await screen.findByRole("heading", { name: "Integrations" })).toBeTruthy();
    expect(screen.getByRole("table", { name: "Demo Integrations" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Settings" })).toBeNull();
  });

  it("sends no management scope even when the Account holds several memberships", async () => {
    installApi({ multipleMemberships: true });
    window.history.replaceState({}, "", "/agents");
    const getItem = vi.spyOn(Storage.prototype, "getItem");
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Agents" })).toBeTruthy();
    expect(getItem).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(vi.mocked(fetch).mock.calls.some(([path]) => String(path) === "/api/v1/agents")).toBe(true),
    );
    expect(vi.mocked(fetch).mock.calls.some(([path]) => String(path).includes("/api/v1/workspaces/"))).toBe(false);
    getItem.mockRestore();
  });

  it("keeps Workspace management and switching out of the account menu", async () => {
    installApi({ multipleMemberships: true });
    render(<App />);
    const { menu } = await openAccountMenu();

    // The absence checks only mean something once the menu itself is on screen.
    expect(within(menu).getByRole("menuitem", { name: "Account" })).toBeTruthy();
    expect(within(menu).queryByRole("group", { name: "Workspaces" })).toBeNull();
    expect(within(menu).queryByRole("menuitem", { name: "Workspace" })).toBeNull();
    expect(within(menu).queryByText("Secondary")).toBeNull();
    expect(within(menu).getByRole("menuitem", { name: "Computers" })).toBeTruthy();
    expect(within(menu).queryByRole("menuitem", { name: "Admins" })).toBeNull();
  });

  it("does not create an IM setup attempt while rendering Agent detail", async () => {
    installApi();
    window.history.replaceState({}, "", `/agents/${agentId}/settings/messaging`);
    render(<App />);
    expect(await screen.findByRole("button", { name: "Connect a Feishu Bot" })).toBeTruthy();
    expect(vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
  });

  it("creates a Feishu setup attempt only after an explicit admin click", async () => {
    installApi();
    window.history.replaceState({}, "", `/agents/${agentId}/settings/messaging`);
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Connect a Feishu Bot" }));
    expect(await screen.findByText("Feishu setup started")).toBeTruthy();
    expect(await screen.findByText(/Choose an existing Feishu Bot or create a new one/)).toBeTruthy();
    expect(await screen.findByRole("img", { name: "Scan this QR code in Feishu" })).toBeTruthy();
    await waitFor(() =>
      expect(
        vi
          .mocked(fetch)
          .mock.calls.some(
            ([input, init]) => String(input).endsWith("/im-binding/feishu/setup-attempts") && init?.method === "POST",
          ),
      ).toBe(true),
    );
  });

  it("offers a legacy Feishu Bot permission update without claiming live connectivity", async () => {
    installApi({ bindingReauth: true, bound: true });
    window.history.replaceState({}, "", `/agents/${agentId}/settings/messaging`);
    render(<App />);
    expect(await screen.findByText(/Permissions update required/)).toBeTruthy();
    expect(screen.queryByText(/Online/)).toBeNull();
    expect(screen.getByRole("button", { name: "Reauthorize Feishu" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Change Feishu Bot" }));
    expect(await screen.findByText(/Choose an existing Feishu Bot or create a new one/)).toBeTruthy();
    const request = vi
      .mocked(fetch)
      .mock.calls.find(
        ([input, init]) => String(input).endsWith("/im-binding/feishu/setup-attempts") && init?.method === "POST",
      );
    expect(JSON.parse(String(request?.[1]?.body))).toEqual({ intent: "replace" });
  });

  it("separates an active channel from an Agent that cannot receive messages", async () => {
    installApi({ bound: true, handoffReady: false });
    window.history.replaceState({}, "", `/agents/${agentId}/settings/messaging`);
    render(<App />);

    expect(await screen.findByText("Feishu · @reviewer")).toBeTruthy();
    expect(
      screen.getByText(
        "The channel itself is connected, but messages cannot be delivered yet. Retrying automatically.",
      ),
    ).toBeTruthy();
    expect(screen.queryByText(/Needs attention/)).toBeNull();
    expect(screen.queryByText(/Online/)).toBeNull();
  });

  it("shows the selected runtime state beside a connected Slack channel", async () => {
    installApi({
      bound: true,
      provider: "slack",
      runtimeProvider: "codex",
      computerProviderReadiness: [{ provider: "codex", status: "checking", observedAt: "2026-08-20T00:00:00.000Z" }],
      handoffReady: false,
    });
    window.history.replaceState({}, "", `/agents/${agentId}/settings/messaging`);
    render(<App />);

    expect(await screen.findByText("Slack")).toBeTruthy();
    expect(screen.getByText(/Messages wait until Codex is ready on this agent's computer\./)).toBeTruthy();
    expect(screen.getByRole("link", { name: "View Computer" }).getAttribute("href")).toBe(
      `/agents/${agentId}/settings/computer`,
    );
  });

  it("shows a safe occupied-App recovery and retries the original replacement intent", async () => {
    installApi({ bound: true, setupFailureCode: "FEISHU_APP_ALREADY_BOUND" });
    window.history.replaceState({}, "", `/agents/${agentId}/settings/messaging`);
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Change Feishu Bot" }));
    const setupNotice = (await screen.findByText("Feishu setup started")).parentElement;
    expect(setupNotice?.textContent).toContain(
      "This Feishu Bot is already connected to another Agent. Choose a different Bot or disable its current binding first.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry Feishu setup" }));
    await waitFor(() => {
      const requests = vi
        .mocked(fetch)
        .mock.calls.filter(
          ([input, init]) => String(input).endsWith("/im-binding/feishu/setup-attempts") && init?.method === "POST",
        );
      expect(requests).toHaveLength(2);
      expect(requests.map(([, init]) => JSON.parse(String(init?.body)))).toEqual([
        { intent: "replace" },
        { intent: "replace" },
      ]);
    });
  });

  it("starts first-party OpenTag Slack OAuth from the Agent IM tab", async () => {
    installApi();
    window.history.replaceState({}, "", `/agents/${agentId}/settings/messaging`);
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Add OpenTag to Slack" }));
    await waitFor(() =>
      expect(
        vi
          .mocked(fetch)
          .mock.calls.filter(
            ([input, init]) => String(input).endsWith("/im-binding/slack/oauth/start") && init?.method === "POST",
          ),
      ).toHaveLength(1),
    );
    expect(
      JSON.parse(
        String(
          vi
            .mocked(fetch)
            .mock.calls.find(
              ([input, init]) => String(input).endsWith("/im-binding/slack/oauth/start") && init?.method === "POST",
            )?.[1]?.body,
        ),
      ),
    ).toEqual({ intent: "create" });
    expect(screen.queryByRole("button", { name: "Connect Slack App" })).toBeNull();
    expect(screen.queryByLabelText("Slack App ID")).toBeNull();
    expect(screen.queryByLabelText("Bot User OAuth Token")).toBeNull();
    expect(screen.queryByLabelText("Signing Secret")).toBeNull();
  });

  it("creates a Computer connection command only after an explicit admin click", async () => {
    installApi({ computers: [] });
    window.history.replaceState({}, "", "/agents/new");
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Connect a Local Computer" })).toBeTruthy();
    expect(window.location.pathname).toBe("/agents/new");
    const button = await screen.findByRole("button", { name: "Generate connection command" });
    expect(vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
    fireEvent.click(button);
    expect(
      await screen.findByText(/opentag computer connect --server https:\/\/opentag\.example\.com -- example/),
    ).toBeTruthy();
  });

  it("guides Agent creation to Computer setup when none is connected", async () => {
    installApi({ computers: [] });
    window.history.replaceState({}, "", "/agents/new");
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Connect a Local Computer" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Generate connection command" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Agent runtime" })).toBeNull();
  });

  it("validates Agent name locally with an accessible field error before sending a request", async () => {
    installApi();
    window.history.replaceState({}, "", "/agents/new");
    render(<App />);
    await screen.findByLabelText("Display name");
    fireEvent.click(screen.getByRole("button", { name: "Edit Agent name" }));
    const name = screen.getByLabelText("Agent name");
    fireEvent.change(name, { target: { value: "Bestony" } });
    fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Bestony" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Agent" }));
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toBe(
      "Agent name must start with a lowercase letter or number and contain only lowercase letters, numbers, and hyphens",
    );
    expect(name.getAttribute("aria-invalid")).toBe("true");
    expect(name.getAttribute("aria-describedby")?.split(" ")).toContain(alert.id);
    expect(
      vi
        .mocked(fetch)
        .mock.calls.filter(([input, init]) => String(input) === "/api/v1/agents" && init?.method === "POST"),
    ).toHaveLength(0);
  });

  it("asks for an explicit Agent name when the display name cannot produce an ASCII name", async () => {
    installApi();
    window.history.replaceState({}, "", "/agents/new");
    render(<App />);
    fireEvent.change(await screen.findByLabelText("Display name"), { target: { value: "研究助手" } });
    expect(screen.getByRole("button", { name: "Edit Agent name" }).textContent).toBe("Set Agent name");
    expect(screen.queryByLabelText("Agent name")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Create Agent" }));

    const alert = await screen.findByRole("alert");
    const name = screen.getByLabelText("Agent name");
    expect(alert.textContent).toBe("Agent name is required");
    await waitFor(() => expect(name).toBe(document.activeElement));
    expect(
      vi
        .mocked(fetch)
        .mock.calls.filter(([input, init]) => String(input) === "/api/v1/agents" && init?.method === "POST"),
    ).toHaveLength(0);
  });

  it("creates an Agent with a valid canonical name and keeps the existing payload", async () => {
    installApi();
    window.history.replaceState({}, "", "/agents/new");
    render(<App />);
    fireEvent.change(await screen.findByLabelText("Display name"), { target: { value: "Bestony" } });
    expect(screen.queryByLabelText("Agent name")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Create Agent" }));
    expect(await screen.findByRole("heading", { name: "Connect messaging" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Set up later" }));
    await waitFor(() => expect(window.location.pathname).toBe(`/agents/${agentId}`));
    const createCall = vi
      .mocked(fetch)
      .mock.calls.find(([input, init]) => String(input) === "/api/v1/agents" && init?.method === "POST");
    expect(JSON.parse(String(createCall?.[1]?.body))).toEqual({
      creationIntentId: expect.any(String),
      name: "bestony",
      displayName: "Bestony",
      runtimeProvider: "codex",
      computerId,
    });
  });

  it("maps a Server name issue back to the Agent name field", async () => {
    installApi({ agentCreateError: "name" });
    window.history.replaceState({}, "", "/agents/new");
    render(<App />);
    fireEvent.change(await screen.findByLabelText("Display name"), { target: { value: "Bestony" } });
    expect(screen.queryByLabelText("Agent name")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Create Agent" }));
    const alert = await screen.findByRole("alert");
    const name = screen.getByLabelText("Agent name");
    expect(alert.textContent).toBe("Use a lowercase Agent name");
    expect(name.getAttribute("aria-describedby")?.split(" ")).toContain(alert.id);
    await waitFor(() => expect(name).toBe(document.activeElement));
    expect(window.location.pathname).toBe("/agents/new");
  });

  it("reveals the Agent name editor when the Server reports a Workspace name conflict", async () => {
    installApi({ agentCreateError: "conflict" });
    window.history.replaceState({}, "", "/agents/new");
    render(<App />);
    fireEvent.change(await screen.findByLabelText("Display name"), { target: { value: "Bestony" } });
    expect(screen.queryByLabelText("Agent name")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Create Agent" }));

    const alert = await screen.findByRole("alert");
    const name = screen.getByLabelText("Agent name");
    expect(alert.textContent).toBe("An active Agent with this name already exists in the Workspace");
    expect(name.getAttribute("aria-invalid")).toBe("true");
    await waitFor(() => expect(name).toBe(document.activeElement));
  });

  it("keeps an unmapped Server validation error at form level", async () => {
    installApi({ agentCreateError: "generic" });
    window.history.replaceState({}, "", "/agents/new");
    render(<App />);
    fireEvent.change(await screen.findByLabelText("Display name"), { target: { value: "Bestony" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Agent" }));
    expect((await screen.findByRole("alert")).textContent).toBe("The request payload is invalid");
    expect(screen.queryByLabelText("Agent name")).toBeNull();
  });

  it("uses only a confirmed ready Computer and Provider route", async () => {
    installApi({
      computers: [
        {
          id: computerId,
          displayName: "Ada's Mac",
          platform: "darwin",
          arch: "arm64",
          clientVersion: "0.0.1",
          connectionStatus: "online",
          providerReadiness: [
            { provider: "codex", status: "ready", observedAt: "2026-08-20T00:00:00.000Z" },
            { provider: "claude-code", status: "sign-in", observedAt: "2026-08-20T00:00:00.000Z" },
          ],
          connectedAt: "2026-08-20T00:00:00.000Z",
          lastSeenAt: "2026-08-20T00:00:00.000Z",
        },
      ],
    });
    window.history.replaceState({}, "", "/agents/new");
    render(<App />);
    expect(await screen.findByText("Ada's Mac")).toBeTruthy();
    expect(screen.getByText("Codex")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Change Runtime" }));
    const claudeCode = screen.getByRole("button", { name: /Claude Code Sign-in required/ });
    expect(claudeCode.hasAttribute("disabled")).toBe(true);
    expect(screen.getByRole("button", { name: "Create Agent" }).hasAttribute("disabled")).toBe(false);
    fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Codex Reviewer" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Agent" }));
    await waitFor(() => {
      const request = vi
        .mocked(fetch)
        .mock.calls.find(([path, init]) => path === "/api/v1/agents" && init?.method === "POST");
      expect(JSON.parse(String(request?.[1]?.body))).toEqual({
        creationIntentId: expect.any(String),
        name: "codex-reviewer",
        displayName: "Codex Reviewer",
        runtimeProvider: "codex",
        computerId,
      });
    });
  });

  it("revalidates ready routes and disables creation when readiness becomes unavailable", async () => {
    const claudeReadiness: {
      observedAt: string;
      provider: "claude-code";
      status: "ready" | "unavailable";
    } = {
      provider: "claude-code",
      status: "unavailable",
      observedAt: "2026-08-20T00:00:00.000Z",
    };
    let computerReadStatus: number | undefined;
    installApi({
      computers: [
        {
          id: computerId,
          displayName: "Ada's Mac",
          platform: "darwin",
          arch: "arm64",
          clientVersion: "0.0.1",
          connectionStatus: "online",
          providerReadiness: [
            { provider: "codex", status: "ready", observedAt: "2026-08-20T00:00:00.000Z" },
            claudeReadiness,
          ],
          connectedAt: "2026-08-20T00:00:00.000Z",
          lastSeenAt: "2026-08-20T00:00:00.000Z",
        },
      ],
      computerReadStatus: () => computerReadStatus,
    });
    window.history.replaceState({}, "", "/agents");
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "New Agent" }));
    const dialog = await screen.findByRole("dialog", { name: "New Agent" });
    await within(dialog).findByText("Ada's Mac");
    expect(within(dialog).getByText("Codex")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Change Runtime" }));
    expect(
      within(dialog)
        .getByRole("button", { name: /Claude Code Unavailable/ })
        .hasAttribute("disabled"),
    ).toBe(true);

    claudeReadiness.status = "ready";
    window.dispatchEvent(new Event("focus"));
    fireEvent.click(await within(dialog).findByRole("button", { name: /Claude Code Ready/ }));
    expect(await within(dialog).findByText("Claude Code")).toBeTruthy();

    claudeReadiness.status = "unavailable";
    window.dispatchEvent(new Event("focus"));
    expect(await within(dialog).findByText("Codex")).toBeTruthy();

    computerReadStatus = 503;
    window.dispatchEvent(new Event("focus"));
    expect(await within(dialog).findByText("Readiness unconfirmed")).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Create Agent" }).hasAttribute("disabled")).toBe(true);
  });

  it("reports a failed Check again instead of announcing a Computer update", async () => {
    let computerReadStatus: number | undefined;
    installApi({
      computerProviderReadiness: [{ provider: "codex", status: "sign-in", observedAt: "2026-08-20T00:00:00.000Z" }],
      computerReadStatus: () => computerReadStatus,
    });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "New Agent" }));
    const dialog = await screen.findByRole("dialog", { name: "New Agent" });
    expect(await within(dialog).findByText("Sign in to Codex")).toBeTruthy();

    // The Account asked a question by pressing the button. A 503 is the answer "I could not check",
    // and the cached Computer is not a substitute for it.
    computerReadStatus = 503;
    fireEvent.click(within(dialog).getByRole("button", { name: "Check again" }));

    expect((await within(dialog).findByRole("alert")).textContent).toContain("Request failed");
    // Not the degraded state a background re-read would have left: that reads as an answer about
    // the Computer, when what happened is that the check did not complete.
    expect(within(dialog).queryByText("Readiness unconfirmed")).toBeNull();
    expect(within(dialog).queryByText("Computer connection updated")).toBeNull();
  });

  it("keeps a background Computer refresh failure on the retained Computers", async () => {
    let computerReadStatus: number | undefined;
    installApi({
      computerProviderReadiness: [{ provider: "codex", status: "sign-in", observedAt: "2026-08-20T00:00:00.000Z" }],
      computerReadStatus: () => computerReadStatus,
    });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "New Agent" }));
    const dialog = await screen.findByRole("dialog", { name: "New Agent" });
    expect(await within(dialog).findByText("Sign in to Codex")).toBeTruthy();

    // The control: revalidation nobody asked for still degrades rather than replacing the dialog.
    computerReadStatus = 503;
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    expect(await within(dialog).findByText("Readiness unconfirmed")).toBeTruthy();
    expect(within(dialog).queryByRole("alert")).toBeNull();
  });

  it("removes a retained creation route after a terminal Computer refresh error", async () => {
    let computerReadStatus: number | undefined;
    installApi({ computerReadStatus: () => computerReadStatus });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "New Agent" }));
    const dialog = await screen.findByRole("dialog", { name: "New Agent" });
    expect(await within(dialog).findByText("Ready to run")).toBeTruthy();

    computerReadStatus = 404;
    window.dispatchEvent(new Event("focus"));

    expect((await within(dialog).findByRole("alert")).textContent).toContain("Request failed");
    expect(within(dialog).queryByRole("button", { name: "Create Agent" })).toBeNull();
  });

  it("routes an Account with incomplete setup into onboarding without a Workspace grant", async () => {
    installApi({ workspaceless: true });
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Where should your agent run?" })).toBeTruthy();
    expect(window.location.pathname).toBe("/onboarding");
    expect(screen.queryByRole("heading", { name: "OpenTag is not ready for this account" })).toBeNull();
    expect(
      vi.mocked(fetch).mock.calls.some(([path, init]) => path === "/api/v1/workspaces" && init?.method === "POST"),
    ).toBe(false);
  });

  it("keeps standalone onboarding reachable without a management Workspace", async () => {
    installApi({ workspaceless: true });
    window.history.replaceState({}, "", "/onboarding");
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Where should your agent run?" })).toBeTruthy();
    expect(window.location.pathname).toBe("/onboarding");
    expect(
      vi.mocked(fetch).mock.calls.some(([path, init]) => path === "/api/v1/workspaces" && init?.method === "POST"),
    ).toBe(false);
  });

  it("routes an Account with incomplete setup into onboarding", async () => {
    installApi({ setupCompletedAt: null });
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Where should your agent run?" })).toBeTruthy();
    expect(window.location.pathname).toBe("/onboarding");
  });

  it("renders onboarding without the application navigation", async () => {
    installApi({ setupCompletedAt: null });
    render(<App />);
    await screen.findByRole("heading", { name: "Where should your agent run?" });

    // The Account has not entered the application yet. Every destination the primary navigation
    // offers is behind the setup gate, which sends them all straight back here, and the shell
    // brand would stand beside the one onboarding renders itself.
    // The sidebar is an <aside>, so it is `complementary`; asking for `navigation` here matched
    // nothing whether or not the shell rendered.
    expect(screen.queryByRole("complementary", { name: "Primary navigation" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Agents" })).toBeNull();
    expect(screen.queryAllByRole("link", { name: "OpenTag" })).toHaveLength(0);
  });

  it("keeps completed Accounts out of onboarding even when it is requested directly", async () => {
    installApi();
    window.history.replaceState({}, "", "/onboarding");
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Agents" })).toBeTruthy();
    expect(window.location.pathname).toBe("/agents");
  });

  it("does not preserve the retired self-serve Workspace creation route", async () => {
    installApi();
    window.history.replaceState({}, "", "/workspaces/new");
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Page not found" })).toBeTruthy();
    expect(
      vi.mocked(fetch).mock.calls.some(([path, init]) => path === "/api/v1/workspaces" && init?.method === "POST"),
    ).toBe(false);
  });

  it("keeps account controls personal and signs out from the account menu", async () => {
    installApi();
    render(<App />);
    const { menu } = await openAccountMenu();
    expect(within(menu).queryByRole("group", { name: "Workspaces" })).toBeNull();
    expect(within(menu).queryByRole("menuitem", { name: "Workspace management" })).toBeNull();
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Account" }));
    expect(await screen.findByRole("heading", { name: "Account" })).toBeTruthy();
    expect(window.location.pathname).toBe("/account");
    const displayName = screen.getByLabelText("Display name") as HTMLInputElement;
    expect(displayName.readOnly).toBe(false);
    fireEvent.change(displayName, { target: { value: "Account Menu" } });
    expect(await screen.findByRole("button", { name: "Save account profile" })).toBeTruthy();
    const { menu: accountMenu } = await openAccountMenu();
    fireEvent.click(within(accountMenu).getByRole("menuitem", { name: "Sign out" }));
    expect(await screen.findByRole("heading", { name: "Welcome back" })).toBeTruthy();
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      "/api/v1/auth/browser/logout",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("does not expose the previous Account while a post-logout route re-entry is loading", async () => {
    let releaseMe: (response: Response) => void = () => undefined;
    const pendingMe = new Promise<Response>((resolve) => {
      releaseMe = resolve;
    });
    installApi({ meAfterLogout: () => pendingMe });
    render(<App />);

    expect(await screen.findByRole("link", { name: "Open Reviewer" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Account menu" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Sign out" }));
    expect(await screen.findByRole("heading", { name: "Welcome back" })).toBeTruthy();

    await act(async () => {
      window.history.pushState({}, "", "/agents");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(await screen.findByLabelText("Loading current server state")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Open Reviewer" })).toBeNull();

    await act(async () => {
      releaseMe(json({ error: { message: "Sign in required" } }, 401));
    });
    expect(await screen.findByRole("heading", { name: "Welcome back" })).toBeTruthy();
  });

  it("discards an Account refresh that outlived the session that started it", async () => {
    let releaseRefresh: (response: Response) => void = () => undefined;
    const pendingRefresh = new Promise<Response>((resolve) => {
      releaseRefresh = resolve;
    });
    let releaseMe: (response: Response) => void = () => undefined;
    const pendingMe = new Promise<Response>((resolve) => {
      releaseMe = resolve;
    });
    installApi({ meAfterProfileUpdate: () => pendingRefresh, meAfterLogout: () => pendingMe });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Account menu" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Account" }));
    expect(await screen.findByRole("heading", { name: "Account" })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Display name"), { target: { value: "Ada Renamed" } });
    fireEvent.click(screen.getByRole("button", { name: "Save account profile" }));

    // Sign out while the refresh that save started is still in flight. Clearing the cache cannot
    // retire that read, because the cache never started it.
    fireEvent.click(await screen.findByRole("button", { name: "Account menu" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Sign out" }));
    expect(await screen.findByRole("heading", { name: "Welcome back" })).toBeTruthy();

    // It left with a cookie that was still valid, so it answers for the Account that just left.
    await act(async () => {
      releaseRefresh(
        json({
          user: { id: userId, email: "ada@example.com", displayName: "Ada Renamed" },
          setupCompletedAt: "2026-08-20T00:00:00.000Z",
        }),
      );
    });

    await act(async () => {
      window.history.pushState({}, "", "/agents");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    expect(await screen.findByLabelText("Loading current server state")).toBeTruthy();
    expect(document.body.textContent).not.toContain("Ada Renamed");
    expect(screen.queryByRole("button", { name: "Account menu" })).toBeNull();

    await act(async () => {
      releaseMe(json({ error: { message: "Sign in required" } }, 401));
    });
    expect(await screen.findByRole("heading", { name: "Welcome back" })).toBeTruthy();
  });

  it("opens the Computers page from the account menu", async () => {
    installApi();
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Account menu" }));
    const computers = screen.getByRole("menuitem", { name: "Computers" });
    expect(computers.getAttribute("href")).toBe("/agents/computers");
    fireEvent.click(computers);
    expect(await screen.findByRole("heading", { level: 1, name: "Computers" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Enrolled Computers" })).toBeTruthy();
    expect(screen.getByText("Ada's Mac")).toBeTruthy();
    expect(screen.getByText("Online")).toBeTruthy();
    expect(window.location.pathname).toBe("/agents/computers");
    expect(screen.queryByRole("menu", { name: "Account" })).toBeNull();
  });

  it("moves focus into account actions and returns it to the trigger on Escape", async () => {
    installApi({ multipleMemberships: true });
    render(<App />);
    const { menu, trigger } = await openAccountMenu();
    const account = within(menu).getByRole("menuitem", { name: "Account" });
    account.focus();
    fireEvent.keyDown(account, { key: "Escape" });

    /*
     * Closing is asynchronous: the menu is still in the document on the tick after Escape and
     * leaves a frame or two later. This waits for it rather than asserting immediately, which also
     * means the close finishes inside the test instead of racing whatever runs next.
     *
     * The old assertion asked for a menu accessibly named "Account" and got null at every moment,
     * open or closed — so it passed with the Escape line deleted entirely, and never checked the
     * focus return its name promises.
     */
    await waitFor(() => {
      expect(screen.queryByRole("menu")).toBeNull();
    });
    expect(document.activeElement).toBe(trigger);
  });

  it("supports arrow-key navigation and focus return in the account menu", async () => {
    installApi();
    render(<App />);
    const { menu, trigger } = await openAccountMenu();
    const account = within(menu).getByRole("menuitem", { name: "Account" });
    const signOut = within(menu).getByRole("menuitem", { name: "Sign out" });
    account.focus();
    fireEvent.keyDown(account, { key: "ArrowDown" });
    expect(document.activeElement).toBe(signOut);
    fireEvent.keyDown(signOut, { key: "ArrowDown" });
    fireEvent.keyDown(account, { key: "End" });
    fireEvent.keyDown(signOut, { key: "Escape" });
    // Same as above: closing is asynchronous, and a menu named "Account" never existed to be null.
    await waitFor(() => {
      expect(screen.queryByRole("menu")).toBeNull();
    });
    expect(document.activeElement).toBe(trigger);
  });

  it("removes the old admin product shell without a redirect", async () => {
    window.history.replaceState({}, "", "/admin");
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Page not found" })).toBeTruthy();
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
});
