import type { AgentUsageDetail } from "@opentag/shared/browser";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { vi } from "vitest";

export const userId = "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e";
export const memberUserId = "63e2babe-e4ac-4e2c-b7d1-d092d5a4568e";
export const agentId = "1a63a21e-f6c7-4474-91ea-4dabf0566a24";
export const secondAgentId = "2b74b32f-a7d8-4585-92fb-5ecbf1677b35";
export const computerId = "85fe9af3-d1c6-472b-b78c-8a7ccf512750";
export const taskSessionId = "11111111-1111-4111-8111-111111111111";
export const secondComputerId = "95fe9af3-d1c6-472b-b78c-8a7ccf512750";
export const creationIntentKey = `opentag.agent-creation.intent:${userId}`;

/** Two Computers an Agent could run on, so a reader has something to choose between. */
export const twoReadyComputers = [
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
export function storeCreationIntent(record: { creationIntentId: string; request: Record<string, unknown> }) {
  const stored = { version: 3, accountId: userId, ...record };
  window.localStorage.setItem(creationIntentKey, JSON.stringify({ version: 3, accountId: userId, records: [stored] }));
  return stored;
}

export function agentCreationPosts() {
  return vi.mocked(fetch).mock.calls.filter(([path, init]) => path === "/api/v1/agents" && init?.method === "POST");
}

export const agentSummary = {
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
export const agentListItem = {
  ...agentSummary,
  activity: { state: "idle" as const },
  usage: { windowDays: 30 as const, tasks: 32, failed: 0, tokens: 428_000 },
};
/** A second active Agent the Account could own, for surfaces that resolve cardinality. */
export const secondAgentListItem = {
  ...agentListItem,
  id: secondAgentId,
  name: "helper",
  displayName: "Helper",
};
export const taskSummary = {
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

export function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

const setupBindingId = "9d4e1378-8ff2-4e41-a6dd-e8bf59ed775b";

function setupTargetIdOrThrow(path: string, method: string | undefined): string {
  if (method !== undefined) throw new Error(`Unexpected request: ${method} ${path}`);
  const match = /^\/api\/v1\/agents\/([^/]+)\/setup$/.exec(path);
  if (!match) throw new Error(`Unexpected request: GET ${path}`);
  return match[1] as string;
}

function setupProjectionOrThrow(
  path: string,
  method: string | undefined,
  state: {
    readonly agentUnbound: boolean;
    readonly bindingReauth: boolean;
    readonly bindingState: "provisioning" | "active";
    readonly bound: boolean;
    readonly handoffReady: boolean;
    readonly provider: "feishu" | "slack";
    readonly runtimeProvider: "codex" | "claude-code";
  },
): Response {
  const targetAgentId = setupTargetIdOrThrow(path, method);
  if (targetAgentId !== agentId && targetAgentId !== secondAgentId) {
    return json({ error: { code: "RESOURCE_NOT_FOUND", category: "deterministic", message: "Not found" } }, 404);
  }
  const targetBase =
    targetAgentId === secondAgentId
      ? { ...agentSummary, id: secondAgentId, name: "helper", displayName: "Helper" }
      : agentSummary;
  const isUnbound = targetAgentId === agentId && state.agentUnbound;
  const target = {
    ...targetBase,
    runtimeProvider: state.runtimeProvider,
    ...(isUnbound ? { computer: null } : {}),
  };
  const observedAt = "2026-08-20T00:00:00.000Z";
  if (isUnbound) {
    return json({
      agent: target,
      stage: "needs-computer",
      computer: { kind: "not-bound" },
      runtime: { kind: "unavailable", provider: target.runtimeProvider, reason: "computer-not-bound" },
      messaging: { kind: "not-configured" },
      blockers: [{ code: "computer-not-bound" }],
      actions: [{ kind: "bind-computer" }],
      observedAt,
    });
  }
  const computer = {
    kind: "bound",
    ...targetBase.computer,
    connectionStatus: "online",
    lastSeenAt: observedAt,
    observedAt,
  };
  const runtime = { kind: "observed", provider: target.runtimeProvider, status: "ready", observedAt };
  if (state.bound && state.bindingReauth) {
    const replace =
      state.provider === "feishu"
        ? [{ kind: "replace-messaging" as const, provider: "feishu" as const, bindingId: setupBindingId }]
        : [];
    return json({
      agent: target,
      stage: "needs-messaging",
      computer,
      runtime,
      messaging: {
        kind: "blocked",
        provider: state.provider,
        bindingId: setupBindingId,
        code: "reauthorization-required",
        errorCode: null,
      },
      blockers: [
        {
          code: "messaging-not-ready",
          provider: state.provider,
          bindingId: setupBindingId,
          state: "blocked",
        },
      ],
      actions: [
        { kind: "reauthorize-messaging", provider: state.provider, bindingId: setupBindingId },
        ...replace,
        { kind: "unbind-messaging", provider: state.provider, bindingId: setupBindingId },
      ],
      observedAt,
    });
  }
  if (state.bound && state.bindingState === "active" && state.handoffReady) {
    return json({
      agent: target,
      stage: "ready",
      computer,
      runtime,
      messaging: { kind: "ready", provider: state.provider, bindingId: setupBindingId },
      blockers: [],
      actions: [
        { kind: "reauthorize-messaging", provider: state.provider, bindingId: setupBindingId },
        { kind: "unbind-messaging", provider: state.provider, bindingId: setupBindingId },
      ],
      observedAt,
    });
  }
  if (state.bound) {
    return json({
      agent: target,
      stage: "needs-messaging",
      computer,
      runtime,
      messaging: { kind: "waiting-handoff", provider: state.provider, bindingId: setupBindingId },
      blockers: [
        {
          code: "messaging-not-ready",
          provider: state.provider,
          bindingId: setupBindingId,
          state: "waiting-handoff",
        },
      ],
      actions: [
        { kind: "reauthorize-messaging", provider: state.provider, bindingId: setupBindingId },
        { kind: "unbind-messaging", provider: state.provider, bindingId: setupBindingId },
      ],
      observedAt,
    });
  }
  return json({
    agent: target,
    stage: "needs-messaging",
    computer,
    runtime,
    messaging: { kind: "not-configured" },
    blockers: [{ code: "messaging-not-configured" }],
    actions: [
      { kind: "start-messaging", provider: "feishu" },
      { kind: "start-messaging", provider: "slack" },
    ],
    observedAt,
  });
}

export function installApi(
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
    /** Exact members of the Account's Agent list, replacing the default single-Agent answer. */
    agentList?: readonly Record<string, unknown>[];
    /** Serves an Agent the Server says has no Computer, which is not the same as one it cannot read. */
    agentUnbound?: boolean;
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
    internalToolsOffered?: boolean;
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
  // Mutable, because binding a Computer is the thing under test: the Agent starts without one and
  // the Server answers differently once the reader has chosen.
  let agentUnbound = options.agentUnbound ?? false;
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
  /** The Account's Agents, in the Server's own order; an exact list installed by a test wins verbatim. */
  const serveAgentList = () => {
    const failureStatus = options.agentListStatus?.();
    if (failureStatus) return json({ error: { message: "Agent list unavailable" } }, failureStatus);
    if (options.agentList) return json({ agents: options.agentList });
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
              ...(agentUnbound ? { computer: null } : {}),
            },
          ],
    });
  };
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
    if (path === "/api/v1/me/setup/reset" && init?.method === undefined) {
      return options.internalToolsOffered ? new Response(null, { status: 204 }) : new Response(null, { status: 404 });
    }
    if (path === "/api/v1/me/setup/reset" && init?.method === "POST" && options.internalToolsOffered) {
      setupCompletedAt = null;
      return new Response(null, { status: 204 });
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
    if (path === "/api/v1/agents" && init?.method === undefined) return serveAgentList();
    const normalizeComputer = (computer: Record<string, unknown>) => ({
      computerId: computer.computerId ?? computer.id,
      displayName: computer.displayName,
      platform: computer.platform,
      connectionStatus: computer.connectionStatus,
      providerReadiness: computer.providerReadiness,
      connectedAt: computer.connectedAt ?? null,
      lastSeenAt: computer.lastSeenAt ?? null,
      observedAt: computer.observedAt ?? computer.lastSeenAt ?? computer.connectedAt ?? "2026-08-20T00:00:00.000Z",
      createdAt: computer.createdAt ?? "2026-08-20T00:00:00.000Z",
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
        ...(agentUnbound ? { computer: null } : {}),
      });
    }
    if (path === `/api/v1/agents/${agentId}/config`) {
      return json(adminConfig());
    }
    if (path === `/api/v1/agents/${agentId}/computer/rebind` && init?.method === "POST") {
      agentUnbound = false;
      revision += 1;
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
    return setupProjectionOrThrow(path, init?.method, {
      agentUnbound,
      bindingReauth: options.bindingReauth ?? false,
      bindingState: options.bindingState ?? (options.bindingReauth ? "provisioning" : "active"),
      bound: options.bound ?? false,
      handoffReady: options.handoffReady ?? !options.bindingReauth,
      provider: options.provider ?? "feishu",
      runtimeProvider: options.runtimeProvider ?? "codex",
    });
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
export async function openAccountMenu(): Promise<{ menu: HTMLElement; trigger: HTMLElement }> {
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

export function resetWebAppState() {
  window.localStorage.clear();
  window.sessionStorage.clear();
  window.history.replaceState({}, "", "/agents");
  Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
}
