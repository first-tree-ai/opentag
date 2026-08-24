import type { AgentUsageDetail } from "@opentag/shared/browser";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../app.js";

const teamId = "d3fda800-7ce2-4338-aae8-3d2120401ed6";
const invitedTeamId = "3928e3dc-99b0-4a79-97c8-bf9c26b91add";
const userId = "53e2babe-e4ac-4e2c-b7d1-d092d5a4568e";
const memberUserId = "63e2babe-e4ac-4e2c-b7d1-d092d5a4568e";
const otherMemberUserId = "73e2babe-e4ac-4e2c-b7d1-d092d5a4568e";
const agentId = "1a63a21e-f6c7-4474-91ea-4dabf0566a24";
const computerId = "85fe9af3-d1c6-472b-b78c-8a7ccf512750";
const createdTeamId = "6b1f0c9a-2d4e-4a77-9c31-8f0c5b2ad741";
const invitationToken = "A".repeat(43);

const agentSummary = {
  id: agentId,
  teamId,
  name: "reviewer",
  displayName: "Reviewer",
  manager: { userId, displayName: "Ada" },
  computer: { id: computerId, displayName: "Ada's Mac", platform: "darwin" },
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

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function installApi(
  role: "admin" | "member",
  options: {
    agentRead?: () => Promise<void> | void;
    agentReadStatus?: () => number | undefined;
    agentUsage?: Omit<AgentUsageDetail, "endedAt" | "startedAt" | "windowDays">;
    agentListStatus?: () => number | undefined;
    agentActivity?: { state: "idle" } | { state: "working"; startedAt: string };
    emptyAgents?: boolean;
    agentCreate?: (input: Record<string, unknown>) => Promise<void> | void;
    alreadyJoinedInvitation?: boolean;
    agentCreateError?: "conflict" | "generic" | "name";
    authProviders?: readonly { enabled: boolean; id: string; startUrl: string | null }[];
    bindingReauth?: boolean;
    bindingEvidenceFails?: boolean;
    bindingState?: "provisioning" | "active";
    bound?: boolean;
    computers?:
      | readonly Record<string, unknown>[]
      | (() => Promise<readonly Record<string, unknown>[]> | readonly Record<string, unknown>[]);
    computerEvidenceFails?: boolean;
    computerProviderReadiness?: readonly {
      observedAt: string | null;
      provider: "codex" | "claude-code";
      status: "checking" | "install" | "sign-in" | "ready" | "unavailable";
    }[];
    computerStatus?: () => "online" | "offline";
    ownComputerReadStatus?: () => number | undefined;
    handoffReady?: boolean;
    initialStatus?: "active" | "suspended";
    invitationCreate?: () => Promise<Response> | Response;
    invitationExists?: boolean;
    invitationRotate?: () => Promise<Response> | Response;
    ownComputer?: boolean;
    provider?: "feishu" | "slack";
    runtimeProvider?: "codex" | "claude-code";
    profileUpdate?: (displayName: string) => Promise<Response> | Response;
    profileUpdateFails?: boolean;
    redeemFails?: boolean;
    roleUpdate?: (targetUserId: string, role: "admin" | "member") => Promise<Response> | Response;
    roleUpdateFails?: boolean;
    setupFailureCode?: string;
    slackSetupState?: "awaiting_credentials" | "awaiting_verification";
    setupCompletedAt?: string | null;
    scopeReauth?: boolean;
    unauthenticated?: boolean;
    teamless?: boolean;
    teamNameConflict?: boolean;
    teamNameConflicts?: number;
  } = {},
) {
  const teamProfile = { name: "example", displayName: "Example" };
  let lifecycleStatus = options.initialStatus ?? "active";
  let revision = lifecycleStatus === "active" ? 1 : 2;
  const adminConfig = () => ({
    id: agentId,
    teamId,
    name: agentSummary.name,
    displayName: agentSummary.displayName,
    runtimeProvider: options.runtimeProvider ?? agentSummary.runtimeProvider,
    receiveMode: agentSummary.receiveMode,
    status: lifecycleStatus,
    createdAt: agentSummary.createdAt,
    updatedAt: agentSummary.updatedAt,
    managerUserId: userId,
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
  const createdMemberships: {
    teamId: string;
    teamName: string;
    teamDisplayName: string;
    role: "admin";
    setupCompletedAt: string | null;
  }[] = [];
  let setupCompletedAt = options.setupCompletedAt === undefined ? "2026-08-20T00:00:00.000Z" : options.setupCompletedAt;
  let currentRole = role;
  let currentDisplayName = "Ada";
  let memberRole: "admin" | "member" = "member";
  let otherMemberRole: "admin" | "member" = "member";
  let invitationExists = options.invitationExists ?? false;
  let invitationVersion: "A" | "B" | "C" = "A";
  let joinedInvitation = options.alreadyJoinedInvitation ?? false;
  let teamNameConflicts = options.teamNameConflicts ?? (options.teamNameConflict ? 1 : 0);
  const invitation = () => ({
    token: invitationVersion.repeat(43),
    inviteUrl: `https://opentag.example.com/invites/${invitationVersion.repeat(43)}`,
    role: "member" as const,
    expiresAt: "2026-08-27T00:00:00.000Z",
  });
  vi.mocked(fetch).mockImplementation(async (input, init) => {
    const path = String(input);
    if (path === "/api/v1/auth/providers") {
      return json({
        providers: options.authProviders ?? [{ id: "dev", enabled: true, startUrl: "/api/v1/auth/dev/callback" }],
      });
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
      if (response.ok) currentDisplayName = body.displayName.trim();
      return response;
    }
    if (path === "/api/v1/me") {
      if (options.unauthenticated) return json({ error: { message: "Sign in required" } }, 401);
      const existing = options.teamless
        ? []
        : [
            {
              teamId,
              teamName: teamProfile.name,
              teamDisplayName: teamProfile.displayName,
              role: currentRole,
              setupCompletedAt,
            },
          ];
      return json({
        user: { id: userId, email: "ada@example.com", displayName: currentDisplayName },
        memberships: [
          ...existing,
          ...(joinedInvitation
            ? [
                {
                  teamId: invitedTeamId,
                  teamName: "invited-team",
                  teamDisplayName: "Invited Team",
                  role: "member" as const,
                  setupCompletedAt: "2026-08-20T00:00:00.000Z",
                },
              ]
            : []),
          ...createdMemberships,
        ],
      });
    }
    if (path === "/api/v1/teams" && init?.method === "POST") {
      if (teamNameConflicts > 0) {
        teamNameConflicts -= 1;
        return json(
          {
            error: {
              code: "TEAM_NAME_CONFLICT",
              category: "deterministic",
              message: "Another Team already uses this canonical name",
            },
          },
          409,
        );
      }
      const body = JSON.parse(String(init.body)) as { displayName: string; name: string };
      createdMemberships.push({
        teamId: createdTeamId,
        teamName: body.name,
        teamDisplayName: body.displayName,
        role: "admin",
        setupCompletedAt: null,
      });
      return json(
        {
          id: createdTeamId,
          name: body.name,
          displayName: body.displayName,
          role: "admin",
          createdAt: "2026-08-20T00:00:00.000Z",
          updatedAt: "2026-08-20T00:00:00.000Z",
        },
        201,
      );
    }
    if (path === `/api/v1/teams/${teamId}/setup/complete` && init?.method === "POST") {
      setupCompletedAt = "2026-08-20T00:10:00.000Z";
      return json({ setupCompletedAt });
    }
    if (path === `/api/v1/teams/${teamId}` && init?.method === "PATCH") {
      const body = JSON.parse(String(init.body)) as { displayName?: string; name?: string };
      if (body.name !== undefined) teamProfile.name = body.name.trim().toLowerCase();
      if (body.displayName !== undefined) teamProfile.displayName = body.displayName.trim();
      return json({
        id: teamId,
        name: teamProfile.name,
        displayName: teamProfile.displayName,
        updatedAt: "2026-08-20T00:01:00.000Z",
      });
    }
    if (/^\/api\/v1\/teams\/[^/]+\/agents$/.test(path) && init?.method === "POST") {
      if (options.agentCreateError) {
        if (options.agentCreateError === "conflict") {
          return json(
            {
              error: {
                code: "AGENT_NAME_CONFLICT",
                category: "deterministic",
                message: "An active Agent with this name already exists in the Team",
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
    // Any Team id, so a Team created during the test is served like the seeded and invited ones.
    if (/^\/api\/v1\/teams\/[^/]+\/agents$/.test(path) && init?.method === undefined) {
      const failureStatus = options.agentListStatus?.();
      if (failureStatus) return json({ error: { message: "Agent list unavailable" } }, failureStatus);
      return json({
        agents: options.emptyAgents
          ? []
          : [
              path.includes(invitedTeamId)
                ? {
                    ...agentListItem,
                    activity: options.agentActivity ?? agentListItem.activity,
                    teamId: invitedTeamId,
                    status: lifecycleStatus,
                    runtimeProvider: options.runtimeProvider ?? agentListItem.runtimeProvider,
                  }
                : {
                    ...agentListItem,
                    activity: options.agentActivity ?? agentListItem.activity,
                    status: lifecycleStatus,
                    runtimeProvider: options.runtimeProvider ?? agentListItem.runtimeProvider,
                  },
            ],
      });
    }
    if (path === `/api/v1/teams/${teamId}/members`) {
      return json({
        members: [
          { userId, displayName: currentDisplayName, role: currentRole },
          { userId: memberUserId, displayName: "Grace", role: memberRole },
          { userId: otherMemberUserId, displayName: "Lin", role: otherMemberRole },
        ],
      });
    }
    if (path.startsWith(`/api/v1/teams/${teamId}/members/`) && init?.method === "PATCH") {
      const targetUserId = path.slice(path.lastIndexOf("/") + 1);
      const body = JSON.parse(String(init.body)) as { role: "admin" | "member" };
      const response = options.roleUpdate
        ? await options.roleUpdate(targetUserId, body.role)
        : options.roleUpdateFails
          ? json(
              {
                error: {
                  code: "MEMBERSHIP_LAST_ADMIN",
                  category: "deterministic",
                  message: "The last active Team admin cannot be demoted",
                },
              },
              409,
            )
          : json({
              teamId,
              userId: targetUserId,
              email:
                targetUserId === userId
                  ? "ada@example.com"
                  : targetUserId === memberUserId
                    ? "grace@example.com"
                    : "lin@example.com",
              displayName: targetUserId === userId ? "Ada" : targetUserId === memberUserId ? "Grace" : "Lin",
              role: body.role,
              status: "active",
              createdAt: "2026-08-20T00:00:00.000Z",
              updatedAt: "2026-08-20T00:01:00.000Z",
            });
      if (!response.ok) return response;
      if (targetUserId === userId) currentRole = body.role;
      if (targetUserId === memberUserId) memberRole = body.role;
      if (targetUserId === otherMemberUserId) otherMemberRole = body.role;
      return response;
    }
    if (path === `/api/v1/teams/${teamId}/invitation` && init?.method === undefined) {
      return invitationExists ? json(invitation()) : new Response(null, { status: 204 });
    }
    if (path === `/api/v1/teams/${teamId}/invitation` && init?.method === "POST") {
      if (options.invitationCreate) {
        const response = await options.invitationCreate();
        if (response.ok) invitationExists = true;
        return response;
      }
      invitationExists = true;
      return json(invitation(), 201);
    }
    if (path === `/api/v1/teams/${teamId}/invitation/rotate` && init?.method === "POST") {
      if (options.invitationRotate) {
        const response = await options.invitationRotate();
        if (response.ok) invitationVersion = "B";
        return response;
      }
      invitationVersion = "B";
      return json(invitation());
    }
    if (path === `/api/v1/invitations/${invitationToken}/preview`) {
      return json({ teamDisplayName: "Invited Team", role: "member", expiresAt: "2026-08-27T00:00:00.000Z" });
    }
    if (path === `/api/v1/invitations/${invitationToken}/redeem` && init?.method === "POST") {
      if (options.unauthenticated) return json({ error: { message: "Sign in required" } }, 401);
      if (options.redeemFails) return json({ error: { message: "The invitation is invalid or expired" } }, 404);
      joinedInvitation = true;
      return json({
        membership: {
          teamId: invitedTeamId,
          teamName: "invited-team",
          teamDisplayName: "Invited Team",
          role: "member",
        },
      });
    }
    if (/^\/api\/v1\/teams\/[^/]+\/computers$/.test(path)) {
      if (options.computerEvidenceFails) return json({ error: { message: "Computer evidence unavailable" } }, 503);
      return json({
        computers: [
          {
            id: computerId,
            ownerUserId: userId,
            ownerDisplayName: "Ada",
            displayName: "Ada's Mac",
            platform: "darwin",
            connectionStatus: options.computerStatus?.() ?? "online",
            providerReadiness: options.computerProviderReadiness ?? [
              { provider: "codex", status: "ready", observedAt: "2026-08-20T00:00:00.000Z" },
            ],
            connectedAt: "2026-08-20T00:00:00.000Z",
            lastSeenAt: "2026-08-20T00:00:00.000Z",
            observedAt: "2026-08-20T00:00:00.000Z",
            agentIds: [agentId],
          },
        ],
      });
    }
    if (path === "/api/v1/me/computers") {
      const failureStatus = options.ownComputerReadStatus?.();
      if (failureStatus) return json({ error: { message: "Computer readiness unavailable" } }, failureStatus);
      const computers = typeof options.computers === "function" ? await options.computers() : options.computers;
      return json({
        computers:
          computers ??
          (options.ownComputer
            ? [
                {
                  id: computerId,
                  ownerUserId: userId,
                  displayName: "Ada's Mac",
                  platform: "darwin",
                  arch: "arm64",
                  clientVersion: "0.0.1",
                  connectionStatus: "online",
                  providerReadiness: [{ provider: "codex", status: "ready", observedAt: "2026-08-20T00:00:00.000Z" }],
                  connectedAt: "2026-08-20T00:00:00.000Z",
                  lastSeenAt: "2026-08-20T00:00:01.000Z",
                },
              ]
            : []),
      });
    }
    if (path === "/api/v1/me/connect-codes" && init?.method === "POST") {
      return json(
        {
          bootstrapCommand: "npm i -g @opentag/cli && opentag login --server https://opentag.example.com -- example",
          expiresIn: 900,
          issuedAt: "2026-08-20T00:00:00.000Z",
        },
        201,
      );
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
      if (init?.method === "PATCH" && options.scopeReauth) {
        return json(
          {
            error: {
              code: "IM_BINDING_SCOPE_REAUTH_REQUIRED",
              category: "deterministic",
              message: "Additional IM scopes are required",
            },
          },
          409,
        );
      }
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
        runtimeProvider: options.runtimeProvider ?? agentSummary.runtimeProvider,
        status: lifecycleStatus,
        activity: options.agentActivity ?? { state: "idle" },
        viewerCapabilities: { canManage: currentRole === "admin" },
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
      if (options.bindingEvidenceFails) {
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
        pendingReceiveMode: null,
        lastInboundAt: null,
        lastConfirmedAt: "2026-08-20T00:00:00.000Z",
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
    const slackAttemptId = "f645f26d-9184-4f2f-98a1-4ee83ae6a604";
    const slackAttempt = (intent: "create" | "reauthorize" | "replace", state = options.slackSetupState) => ({
      id: slackAttemptId,
      agentId,
      intent,
      state: state ?? "awaiting_credentials",
      manifest: { display_information: { name: "Reviewer - OpenTag" } },
      manifestUrl: "https://api.slack.com/apps?new_app=1&manifest_json=example",
      eventsUrl: `https://opentag.example.com/api/v1/agents/${agentId}/im-binding/slack/events`,
      requiredBotScopes: ["app_mentions:read", "chat:write", "files:read", "im:history"],
      currentAppId: null,
      identity:
        state === "awaiting_verification" ? { appId: null, teamId: "T1", enterpriseId: null, botUserId: "U1" } : null,
      challengeVerified: false,
      lastVerificationErrorCode: null,
      lastVerificationAt: null,
      expiresAt: "2026-08-20T00:30:00.000Z",
      errorCode: null,
      completedAt: null,
      createdAt: "2026-08-20T00:00:00.000Z",
    });
    if (path === `/api/v1/agents/${agentId}/im-binding/slack/setup-attempts` && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as { intent: "create" | "reauthorize" | "replace" };
      return json(slackAttempt(body.intent), 201);
    }
    if (path === `/api/v1/im-bindings/slack/setup-attempts/${slackAttemptId}` && (init?.method ?? "GET") === "GET") {
      return json(slackAttempt("create"));
    }
    if (path === `/api/v1/im-bindings/slack/setup-attempts/${slackAttemptId}/cancel` && init?.method === "POST") {
      return json({
        ...slackAttempt("create", "awaiting_credentials"),
        state: "canceled",
        errorCode: "SLACK_SETUP_CANCELED",
      });
    }
    if (path === "/api/v1/auth/browser/logout" && init?.method === "POST") return new Response(null, { status: 204 });
    throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${path}`);
  });
  return {
    setInvitationVersion(value: "A" | "B" | "C") {
      invitationVersion = value;
    },
  };
}

describe("OpenTag Web App Shell", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    window.history.replaceState({}, "", "/agents");
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() });
  });

  it("uses the same Agents-first shell for admins", async () => {
    installApi("admin");
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Agents" })).toBeTruthy();
    expect(window.location.pathname).toBe("/agents");
    expect(screen.queryByText("Infrastructure")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Agent runtime" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Computers" })).toBeNull();
    expect(screen.getByRole("main").classList.contains("decorative-page")).toBe(false);
    expect(screen.getByRole("link", { name: "Agents" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Settings" })).toBeNull();
    expect(screen.queryByText("Example")).toBeNull();
    const agentLink = await screen.findByRole("link", { name: "Open Reviewer" });
    const createAgent = screen.getByRole("button", { name: "New Agent" });
    expect(createAgent.closest(".page-header")).toBeTruthy();
    const agentCard = agentLink.closest(".agent-card");
    expect(agentCard).toBeTruthy();
    expect(screen.getByText("Monitor availability and 30-day usage across your AI teammates.")).toBeTruthy();
    expect(screen.queryByText("Usage · Last 30 days")).toBeNull();
    expect(within(agentCard as HTMLElement).getByText("Tasks")).toBeTruthy();
    expect(within(agentCard as HTMLElement).getByText("Tokens")).toBeTruthy();
    expect(within(agentCard as HTMLElement).getByText("428K")).toBeTruthy();
    expect(within(agentCard as HTMLElement).getByText("Not connected")).toBeTruthy();
    expect(screen.queryByText("Ada's Mac · macOS")).toBeNull();
    expect(screen.queryByText("Mentions only")).toBeNull();
    const workspaceNavigation = screen.getByRole("navigation", { name: "Product" });
    expect(
      within(workspaceNavigation)
        .getAllByRole("link")
        .map((item) => item.textContent),
    ).toEqual(["Agents", "Tasks", "Integrations", "Skills"]);
    const navigationIcons = workspaceNavigation.querySelectorAll(".primary-nav-icon");
    expect(navigationIcons).toHaveLength(4);
    expect(Array.from(navigationIcons).every((icon) => icon.getAttribute("aria-hidden") === "true")).toBe(true);
  });

  it("shows elapsed time without exposing conversation content for a working Agent", async () => {
    installApi("admin", {
      agentActivity: {
        state: "working",
        startedAt: new Date(Date.now() - 8 * 60_000).toISOString(),
      },
      bound: true,
      handoffReady: true,
    });
    render(<App />);

    const agentCard = (await screen.findByRole("link", { name: "Open Reviewer" })).closest(".agent-card");
    expect(agentCard).toBeTruthy();
    const status = within(agentCard as HTMLElement)
      .getByText("Working")
      .closest(".ds-status");
    expect(status).toBeTruthy();
    expect(within(status as HTMLElement).getByText("Started 8m ago")).toBeTruthy();
  });

  it("keeps an offline reason and reconnect action together in the Agent status", async () => {
    installApi("admin", {
      bound: true,
      computerStatus: () => "offline",
      handoffReady: true,
    });
    render(<App />);

    const agentCard = (await screen.findByRole("link", { name: "Open Reviewer" })).closest(".agent-card");
    expect(agentCard).toBeTruthy();
    const status = within(agentCard as HTMLElement)
      .getByText("Needs attention")
      .closest(".ds-status");
    expect(status).toBeTruthy();
    expect(within(status as HTMLElement).getByText("Computer offline")).toBeTruthy();
    const reconnect = within(status as HTMLElement).getByRole("link", { name: "Reconnect" });
    expect(reconnect.classList.contains("ds-button--inline")).toBe(true);
    expect(reconnect.classList.contains("ds-button--outline")).toBe(false);
  });

  it.each(["/", "/agents"])("redirects unauthenticated protected path %s to login", async (path) => {
    installApi("member", { unauthenticated: true });
    window.history.replaceState({}, "", path);
    render(<App />);
    const heading = await screen.findByRole("heading", { name: "Welcome back" });
    expect(heading.closest("main")?.classList.contains("decorative-page")).toBe(true);
    expect(screen.getByText("OpenTag").closest(".login-brand-lockup")).toBeTruthy();
    expect(screen.getByText("Sign in to continue to OpenTag.")).toBeTruthy();
    expect(screen.queryByText(/Permissions are checked/)).toBeNull();
    const expectedNext = path === "/" ? "/agents" : path;
    expect(window.location.search).toBe(`?next=${encodeURIComponent(expectedNext)}`);
  });

  it("renders the Google provider with its branded sign-in treatment", async () => {
    installApi("member", {
      authProviders: [{ id: "google", enabled: true, startUrl: "/api/v1/auth/google/start" }],
      unauthenticated: true,
    });
    window.history.replaceState({}, "", "/agents");
    render(<App />);

    const signIn = await screen.findByRole("link", { name: "Sign in with Google" });
    expect(signIn.classList.contains("login-provider-button--google")).toBe(true);
    expect(signIn.querySelector('img[alt="Sign in with Google"]')).toBeTruthy();
    expect(new URL(signIn.getAttribute("href") ?? "", window.location.origin).searchParams.get("next")).toBe("/agents");
    expect(screen.getByText("Access is managed by your workspace.")).toBeTruthy();
  });

  it("keeps authenticated invalid Agent tabs on the plain workspace canvas", async () => {
    installApi("admin");
    window.history.replaceState({}, "", `/agents/${agentId}/unknown`);
    render(<App />);

    const heading = await screen.findByRole("heading", { name: "Page not found" });
    expect(heading.closest(".center-card")?.classList.contains("decorative-page")).toBe(false);
    expect(screen.getByRole("main").classList.contains("decorative-page")).toBe(false);
  });

  it("keeps the standalone not-found route on the decorative canvas", async () => {
    window.history.replaceState({}, "", "/unknown");
    render(<App />);

    const heading = await screen.findByRole("heading", { name: "Page not found" });
    expect(heading.closest("main")?.classList.contains("decorative-page")).toBe(true);
  });

  it("lets members enter the same shell without admin controls", async () => {
    installApi("member");
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Agents" })).toBeTruthy();
    expect(screen.queryByText("ada@example.com")).toBeNull();
    expect(await screen.findByText("Reviewer")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "New Agent" })).toBeNull();
  });

  it("uses the page header as the sole empty-state action for admins", async () => {
    installApi("admin", { emptyAgents: true });
    render(<App />);

    expect(await screen.findByRole("heading", { name: "No Agents yet" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "New Agent" }).closest(".page-header")).toBeTruthy();
    expect(screen.queryByRole("region", { name: "Agents" })).toBeNull();
  });

  it("opens the complete New Agent form in a dialog and returns focus when cancelled", async () => {
    installApi("admin", { ownComputer: true });
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
    expect(screen.queryByRole("dialog", { name: "New Agent" })).toBeNull();
    expect(trigger).toBe(document.activeElement);
  });

  it("lets an existing Computer owner connect another Computer from New Agent", async () => {
    installApi("admin", { ownComputer: true });
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

  it("refreshes and selects a newly connected Computer in New Agent", async () => {
    const connectedComputerId = "95fe9af3-d1c6-472b-b78c-8a7ccf512750";
    const existingComputer = {
      id: computerId,
      ownerUserId: userId,
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
    let ownComputerReads = 0;
    let finishRefresh: (() => void) | undefined;
    const refreshPending = new Promise<void>((resolve) => {
      finishRefresh = resolve;
    });
    installApi("admin", {
      computers: async () => {
        ownComputerReads += 1;
        if (ownComputerReads === 4) await refreshPending;
        return ownComputerReads >= 3 ? [existingComputer, connectedComputer] : [existingComputer];
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
        await Promise.resolve();
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

  it("keeps dialog focus when a post-connection Computer refresh fails terminally", async () => {
    const connectedComputer = {
      id: "95fe9af3-d1c6-472b-b78c-8a7ccf512750",
      ownerUserId: userId,
      displayName: "Ada's Linux Computer",
      platform: "linux",
      arch: "arm64",
      clientVersion: "0.0.1",
      connectionStatus: "online",
      providerReadiness: [{ provider: "codex", status: "ready", observedAt: "2026-08-20T00:00:02.000Z" }],
      connectedAt: "2026-08-20T00:00:02.000Z",
      lastSeenAt: "2026-08-20T00:00:02.000Z",
    };
    let ownComputerReads = 0;
    installApi("admin", {
      computers: () => (ownComputerReads >= 3 ? [connectedComputer] : []),
      ownComputerReadStatus: () => {
        ownComputerReads += 1;
        return ownComputerReads >= 4 ? 404 : undefined;
      },
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
        await vi.advanceTimersByTimeAsync(1_500);
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(within(dialog).getByRole("alert").textContent).toContain("Request failed");
      const refreshStatus = within(dialog).getByRole("status");
      expect(refreshStatus.textContent).toContain("Computer refresh failed");
      expect(refreshStatus).toBe(document.activeElement);
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
      ownerUserId: userId,
      displayName: "Ada's Mac",
      platform: "darwin",
      arch: "arm64",
      clientVersion: "0.0.1",
      connectionStatus: "online",
      providerReadiness: [{ provider: "codex", status: "ready", observedAt: disconnectedAt }],
      connectedAt: disconnectedAt,
      lastSeenAt: "2026-08-20T00:00:01.000Z",
    };
    let ownComputerReads = 0;
    installApi("admin", {
      computers: () => {
        ownComputerReads += 1;
        return ownComputerReads >= 3 ? [{ ...existingComputer, connectedAt: reconnectedAt }] : [existingComputer];
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
      ownerUserId: userId,
      displayName: "Ada's Mac",
      platform: "darwin",
      arch: "arm64",
      clientVersion: "0.0.1",
      connectionStatus: "online",
      providerReadiness: [{ provider: "codex", status: "ready", observedAt: "2026-08-20T00:00:02.000Z" }],
      connectedAt: "2026-08-20T00:00:02.000Z",
      lastSeenAt: "2026-08-20T00:00:02.000Z",
    };
    let ownComputerReads = 0;
    let finishRefresh: (() => void) | undefined;
    const refreshPending = new Promise<void>((resolve) => {
      finishRefresh = resolve;
    });
    installApi("admin", {
      computers: async () => {
        ownComputerReads += 1;
        if (ownComputerReads === 4) await refreshPending;
        return ownComputerReads >= 3 ? [connectedComputer] : [];
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
        await Promise.resolve();
      });

      expect(within(dialog).getByText("Ada's Mac")).toBeTruthy();
      expect(within(dialog).getByText("Codex")).toBeTruthy();
      expect(within(dialog).getByRole("button", { name: "Change Computer" })).toBe(document.activeElement);
    } finally {
      vi.useRealTimers();
    }
  });

  it("creates an Agent from the dialog without a second creation screen", async () => {
    installApi("admin", { ownComputer: true });
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
      .mock.calls.find(
        ([input, init]) => String(input) === `/api/v1/teams/${teamId}/agents` && init?.method === "POST",
      );
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
    installApi("admin", { ownComputer: true, agentCreate: () => pendingCreate });
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
          .mock.calls.filter(
            ([input, init]) => String(input) === `/api/v1/teams/${teamId}/agents` && init?.method === "POST",
          ),
      ).toHaveLength(1),
    );
    await waitFor(() => expect(dialog).toBe(document.activeElement));
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
    installApi("admin", {
      ownComputer: true,
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

  it.each(["admin", "member"] as const)("lets a %s update their global account display name", async (role) => {
    installApi(role);
    window.history.replaceState({}, "", "/account");
    render(<App />);

    const email = (await screen.findByLabelText("Email")) as HTMLInputElement;
    const displayName = screen.getByLabelText("Display name") as HTMLInputElement;
    expect(email.value).toBe("ada@example.com");
    expect(email.readOnly).toBe(true);
    expect(email.closest(".ds-field")).toBeTruthy();
    expect(displayName.closest(".ds-field")).toBeTruthy();
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
    installApi("member", { profileUpdate: () => update });
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

  it("restores the confirmed server name and shows the error when an account update fails", async () => {
    installApi("member", { profileUpdateFails: true });
    window.history.replaceState({}, "", "/account");
    render(<App />);

    const displayName = (await screen.findByLabelText("Display name")) as HTMLInputElement;
    fireEvent.change(displayName, { target: { value: "Rejected Name" } });
    fireEvent.click(await screen.findByRole("button", { name: "Save account profile" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Display name update failed");
    expect(displayName.value).toBe("Ada");
    expect(screen.getByText("Ada")).toBeTruthy();
  });

  it("keeps account editing separate from Workspace settings", async () => {
    installApi("admin");
    window.history.replaceState({}, "", "/workspace");
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Workspace" })).toBeTruthy();
    expect(screen.getByLabelText("Workspace name")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Save account profile" })).toBeNull();
  });

  it("keeps suspended lifecycle visible but read-only for members", async () => {
    installApi("member", { initialStatus: "suspended" });
    window.history.replaceState({}, "", `/agents/${agentId}`);
    render(<App />);
    expect((await screen.findAllByText("Suspended")).length).toBeGreaterThan(0);
    expect(screen.queryByRole("button", { name: "Reactivate Agent" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete Agent permanently" })).toBeNull();
  });

  it("keeps the Agent home focused on status, current activity, and contact", async () => {
    installApi("admin", { bound: true });
    window.history.replaceState({}, "", `/agents/${agentId}`);
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Reviewer" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Current activity" })).toBeTruthy();
    expect(screen.getByText("No active work")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Contact" })).toBeTruthy();
    expect(screen.getByText("Send a direct message, or mention @reviewer in a Feishu conversation.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Settings" }).getAttribute("href")).toBe(`/agents/${agentId}/settings`);
    expect(screen.getByRole("link", { name: "Usage" }).getAttribute("href")).toBe(`/agents/${agentId}/usage`);
    expect(screen.queryByRole("navigation", { name: "Agent sections" })).toBeNull();
    expect(screen.queryByText("Runtime")).toBeNull();
  });

  it("shows confirmed active work without exposing conversation content", async () => {
    installApi("admin", {
      bound: true,
      agentActivity: { state: "working", startedAt: "2026-08-24T09:00:00.000Z" },
    });
    window.history.replaceState({}, "", `/agents/${agentId}`);
    render(<App />);

    expect((await screen.findAllByText("Working")).length).toBeGreaterThan(0);
    expect(screen.getAllByText("Handling a request").length).toBeGreaterThan(0);
    expect(screen.getByText(/^Started /)).toBeTruthy();
    expect(document.body.textContent).not.toContain("Private conversation content");
  });

  it("keeps all admin-only controls in six understandable Settings sections", async () => {
    installApi("admin");
    window.history.replaceState({}, "", `/agents/${agentId}/settings`);
    render(<App />);

    const navigation = await screen.findByRole("navigation", { name: "Agent settings" });
    expect(
      within(navigation)
        .getAllByRole("link")
        .map((link) => link.textContent),
    ).toEqual(["Settings", "Identity", "Instructions", "Execution", "Messaging", "Computer", "Manage"]);
    expect(screen.getByText("Provider, model, and reasoning")).toBeTruthy();
    expect(screen.queryByText("Runtime")).toBeNull();
  });

  it("pauses and deletes an Agent from Manage with destructive confirmation", async () => {
    installApi("admin");
    window.history.replaceState({}, "", `/agents/${agentId}/settings/manage`);
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(false).mockReturnValueOnce(true);
    render(<App />);

    const unavailableDeleteButton = await screen.findByRole("button", { name: "Delete permanently" });
    expect(unavailableDeleteButton.hasAttribute("disabled")).toBe(true);
    expect(screen.getByText("Pause this Agent before deleting it permanently.")).toBeTruthy();
    fireEvent.click(unavailableDeleteButton);
    expect(confirm).not.toHaveBeenCalled();

    fireEvent.click(await screen.findByRole("button", { name: "Pause" }));
    expect(await screen.findByRole("button", { name: "Reactivate" })).toBeTruthy();
    const deleteButton = screen.getByRole("button", { name: "Delete permanently" });
    expect(deleteButton.hasAttribute("disabled")).toBe(false);
    fireEvent.click(deleteButton);
    expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === "DELETE")).toBe(false);
    fireEvent.click(deleteButton);
    await waitFor(() => expect(window.location.pathname).toBe("/agents"));
    expect(confirm).toHaveBeenLastCalledWith(
      "Permanently delete Reviewer? This will end active Sessions, remove messaging credentials and execution settings, and retain Session and message history. This Agent cannot be restored.",
    );
    confirm.mockRestore();
  });

  it("shows detailed Agent Token usage and changes the selected period", async () => {
    installApi("admin");
    window.history.replaceState({}, "", `/agents/${agentId}/usage`);
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Usage" })).toBeTruthy();
    expect(await screen.findByRole("img", { name: /428K Tokens used during the last 30 days/ })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Token usage over time" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Token breakdown" })).toBeTruthy();
    expect(screen.getAllByText(/0 Tokens$/).length).toBeGreaterThan(0);
    expect(screen.getByText("Input")).toBeTruthy();
    expect(screen.getByText("Output")).toBeTruthy();
    expect(screen.getByText("Cached input")).toBeTruthy();
    expect(screen.queryByText("Turns")).toBeNull();

    fireEvent.change(screen.getByLabelText("Usage period"), { target: { value: "7" } });
    await waitFor(() =>
      expect(
        vi.mocked(fetch).mock.calls.some(([input]) => String(input) === `/api/v1/agents/${agentId}/usage?days=7`),
      ).toBe(true),
    );
    expect(await screen.findByRole("img", { name: /428K Tokens used during the last 7 days/ })).toBeTruthy();
  });

  it("redirects legacy Agent URLs without keeping the old UI", async () => {
    installApi("admin");
    window.history.replaceState({}, "", `/agents/${agentId}/runtime`);
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Execution" })).toBeTruthy();
    expect(window.location.pathname).toBe(`/agents/${agentId}/settings/execution`);
    expect(screen.queryByText("Runtime")).toBeNull();
  });

  it.each([
    ["integrations", "Agent integrations are not available here", "Browse Workspace integrations"],
    ["skills", "Agent skills are not available here", "Browse Workspace skills"],
  ])("keeps legacy Agent %s URLs inside an explicit Agent-scoped boundary", async (section, heading, action) => {
    installApi("admin");
    window.history.replaceState({}, "", `/agents/${agentId}/${section}`);
    render(<App />);

    expect(await screen.findByRole("heading", { name: heading })).toBeTruthy();
    expect(window.location.pathname).toBe(`/agents/${agentId}/${section}`);
    expect(screen.getByText(/assigned to Reviewer.*Workspace catalog is separate/)).toBeTruthy();
    expect(screen.getByRole("link", { name: action }).getAttribute("href")).toBe(`/${section}`);
  });

  it("redirects the removed Agent Access URL to Workspace members", async () => {
    installApi("member");
    window.history.replaceState({}, "", `/agents/${agentId}/access`);
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Workspace" })).toBeTruthy();
    expect(window.location.pathname).toBe("/workspace");
    expect(window.location.hash).toBe("#members");
  });

  it("keeps assigned Computer details in its own Settings page", async () => {
    installApi("admin", { bound: true });
    window.history.replaceState({}, "", `/agents/${agentId}/settings/computer`);
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Reviewer" })).toBeTruthy();
    expect(await screen.findByText("Ada's Mac · macOS")).toBeTruthy();
    expect(screen.getByText("Online")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Computer" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Execution" })).toBeNull();
    expect(screen.queryByText(/Turn timeout/i)).toBeNull();
    expect(screen.queryByText(/Last seen/i)).toBeNull();
  });

  it("shows Computer recovery details only when the assigned Computer is offline", async () => {
    installApi("admin", { bound: true, computerStatus: () => "offline" });
    window.history.replaceState({}, "", `/agents/${agentId}/settings/computer`);
    render(<App />);

    expect(await screen.findByText("Ada's Mac · macOS")).toBeTruthy();
    expect(screen.getByText("Offline")).toBeTruthy();
    expect(screen.getByText(/Last seen/)).toBeTruthy();
    expect(screen.getByText("New requests can start after this Computer reconnects.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Check again" })).toBeTruthy();
  });

  it("refreshes Agent availability when the page regains focus", async () => {
    let computerStatus: "online" | "offline" = "online";
    installApi("admin", { bound: true, computerStatus: () => computerStatus });
    window.history.replaceState({}, "", `/agents/${agentId}`);
    render(<App />);
    expect((await screen.findAllByText("Ready")).length).toBeGreaterThan(0);

    computerStatus = "offline";
    fireEvent(window, new Event("focus"));
    expect(await screen.findByText("The assigned Computer is offline, so new requests cannot start.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Review Computer" })).toBeTruthy();
  });

  it("keeps Agent cards useful when Computer status cannot be confirmed", async () => {
    installApi("admin", { bound: true, computerEvidenceFails: true });
    window.history.replaceState({}, "", "/agents");
    render(<App />);

    expect(await screen.findByText("Reviewer")).toBeTruthy();
    expect(screen.getByText("Unconfirmed")).toBeTruthy();
    expect(screen.getByText("Unable to confirm readiness")).toBeTruthy();
    expect(screen.queryByText("Ada's Mac · macOS")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).includes("/computers"))).toBe(true);
    expect(vi.mocked(fetch).mock.calls.some(([input]) => String(input).includes(`/agents/${agentId}/im-binding`))).toBe(
      false,
    );
  });

  it("requires the selected runtime Provider to be ready before an Agent card is Ready", async () => {
    installApi("admin", {
      bound: true,
      runtimeProvider: "claude-code",
      computerProviderReadiness: [
        { provider: "codex", status: "ready", observedAt: "2026-08-20T00:00:00.000Z" },
        { provider: "claude-code", status: "sign-in", observedAt: "2026-08-20T00:00:00.000Z" },
      ],
    });
    window.history.replaceState({}, "", "/agents");
    render(<App />);

    expect(await screen.findByText("Needs attention")).toBeTruthy();
    expect(screen.getByText("Computer not ready")).toBeTruthy();
    expect(screen.queryByText("Ready")).toBeNull();
  });

  it("shows a user-facing recovery without readiness implementation details", async () => {
    installApi("admin", { bound: true, handoffReady: false });
    window.history.replaceState({}, "", `/agents/${agentId}`);
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Reviewer" })).toBeTruthy();
    expect(screen.getByText("Messages cannot currently be handed off to this Agent.")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Review messaging" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Current activity" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Contact" })).toBeTruthy();
    expect(screen.queryByText("Handoff")).toBeNull();
    expect(screen.queryByText("Ada's Mac")).toBeNull();
    expect(screen.queryByText("Runtime")).toBeNull();
  });

  it("does not infer an empty contact when messaging evidence cannot be confirmed", async () => {
    installApi("admin", { bound: true, bindingEvidenceFails: true });
    window.history.replaceState({}, "", `/agents/${agentId}`);
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Reviewer" })).toBeTruthy();
    expect(await screen.findByText("Status temporarily unavailable")).toBeTruthy();
    expect(screen.getByText("Unable to confirm messaging")).toBeTruthy();
    expect(screen.queryByText("No messaging connected")).toBeNull();
    expect(screen.queryByText("Handoff")).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("offers messaging setup only when the missing binding is confirmed", async () => {
    installApi("admin", { bound: false });
    window.history.replaceState({}, "", `/agents/${agentId}/settings/messaging`);
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Contact channel" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "No messaging channel" })).toBeTruthy();
    expect(screen.getByText(/cannot contact this Agent/)).toBeTruthy();
  });

  it("separates a connected contact channel from its trigger rules", async () => {
    installApi("admin", { bound: true });
    window.history.replaceState({}, "", `/agents/${agentId}/settings/messaging`);
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Contact channel" })).toBeTruthy();
    expect(screen.getByText(/Feishu · Available/)).toBeTruthy();
    expect(screen.getAllByText("@reviewer")).toHaveLength(2);
    expect(screen.getByText("Send a direct message, or mention @reviewer in a Feishu conversation.")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Trigger rules" })).toBeTruthy();
    expect(screen.getByText("A direct message can always start work.")).toBeTruthy();
    expect(screen.getByRole("group", { name: "Conversation trigger rule" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Replace Feishu Bot" })).toBeTruthy();
  });

  it("keeps the contact summary readable and Settings unavailable to regular members", async () => {
    installApi("member", { bound: true });
    window.history.replaceState({}, "", `/agents/${agentId}`);
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Contact" })).toBeTruthy();
    expect(screen.getByText("Send a direct message, or mention @reviewer in a Feishu conversation.")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Settings" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Manage messaging" })).toBeNull();
  });

  it("shows a Messaging error instead of inferring an empty channel", async () => {
    installApi("admin", { bindingEvidenceFails: true });
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
    installApi("admin", {
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
    expect(await screen.findByText("Cannot receive new work")).toBeTruthy();
  });

  it("invalidates a stale Agent detail after a background not-found response", async () => {
    let agentReadStatus: number | undefined;
    installApi("admin", { agentReadStatus: () => agentReadStatus, bound: true });
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
    installApi("admin", { agentListStatus: () => agentListStatus, bound: true });
    window.history.replaceState({}, "", "/agents");
    render(<App />);
    expect(await screen.findByText("Ready")).toBeTruthy();

    agentListStatus = 503;
    fireEvent(window, new Event("focus"));
    expect(await screen.findByText("Unconfirmed")).toBeTruthy();
    expect(screen.getByText("Reviewer")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("refreshes the parent Agent projection after an IM mutation", async () => {
    installApi("admin", { bound: true });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    window.history.replaceState({}, "", `/agents/${agentId}/settings/messaging`);
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "All messages" }));
    await waitFor(() =>
      expect(
        vi
          .mocked(fetch)
          .mock.calls.filter(
            ([input, init]) => String(input) === `/api/v1/agents/${agentId}` && (init?.method ?? "GET") === "GET",
          ),
      ).toHaveLength(2),
    );
    confirm.mockRestore();
  });

  it("resumes a provisioning Slack setup after a refresh before credentials were submitted", async () => {
    installApi("admin", { bound: true, provider: "slack", bindingState: "provisioning" });
    window.history.replaceState({}, "", `/agents/${agentId}/settings/messaging`);
    const view = render(<App />);

    expect(await screen.findByRole("button", { name: "Resume Slack setup" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Replace Slack App" })).toBeNull();
    expect(screen.queryByLabelText("Bot User OAuth Token")).toBeNull();
    expect(
      vi
        .mocked(fetch)
        .mock.calls.filter(
          ([input, init]) =>
            String(input) === `/api/v1/agents/${agentId}/im-binding/slack/setup-attempts` && init?.method === "POST",
        ),
    ).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Resume Slack setup" }));
    expect(await screen.findByLabelText("Bot User OAuth Token")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Cancel setup" })).toBeTruthy();
    expect(
      vi
        .mocked(fetch)
        .mock.calls.filter(
          ([input, init]) =>
            String(input) === `/api/v1/agents/${agentId}/im-binding/slack/setup-attempts` && init?.method === "POST",
        ),
    ).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Cancel setup" }));
    expect(await screen.findByText(/State: canceled/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Retry Slack setup" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Resume Slack setup" })).toBeTruthy();

    // The binding row remains provisioning after cancellation, but a refresh must not mutate it.
    view.unmount();
    vi.mocked(fetch).mockClear();
    render(<App />);
    expect(await screen.findByRole("button", { name: "Resume Slack setup" })).toBeTruthy();
    expect(screen.queryByLabelText("Bot User OAuth Token")).toBeNull();
    expect(
      vi
        .mocked(fetch)
        .mock.calls.filter(
          ([input, init]) =>
            String(input) === `/api/v1/agents/${agentId}/im-binding/slack/setup-attempts` && init?.method === "POST",
        ),
    ).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Resume Slack setup" }));
    expect(await screen.findByLabelText("Bot User OAuth Token")).toBeTruthy();
    expect(
      vi
        .mocked(fetch)
        .mock.calls.filter(
          ([input, init]) =>
            String(input) === `/api/v1/agents/${agentId}/im-binding/slack/setup-attempts` && init?.method === "POST",
        ),
    ).toHaveLength(1);
  });

  it("resumes a provisioning Slack setup after a refresh while verification is pending", async () => {
    installApi("admin", {
      bound: true,
      provider: "slack",
      bindingState: "provisioning",
      slackSetupState: "awaiting_verification",
    });
    window.history.replaceState({}, "", `/agents/${agentId}/settings/messaging`);
    render(<App />);

    expect(await screen.findByRole("button", { name: "Resume Slack setup" })).toBeTruthy();
    expect(screen.queryByText(/Bot Token validated/)).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Resume Slack setup" }));
    expect(await screen.findByText(/Bot Token validated/)).toBeTruthy();
    expect(screen.getByText(/for workspace T1 \(bot user U1\)/)).toBeTruthy();
    expect(screen.getByText(/Signing Secret not yet verified/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Edit credentials" })).toBeTruthy();
    expect(screen.queryByLabelText("Bot User OAuth Token")).toBeNull();
    expect(screen.queryByRole("button", { name: "Replace Slack App" })).toBeNull();
  });

  it("shows the Tasks demo and opens a Task detail", async () => {
    installApi("admin");
    window.history.replaceState({}, "", "/tasks");
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Tasks" })).toBeTruthy();
    expect(screen.getByText("Demo data")).toBeTruthy();
    const task = screen.getByRole("link", {
      name: "Review the Q3 launch plan, identify unresolved owners, and flag every item without a confirmed date.",
    });
    fireEvent.click(task);
    expect(
      await screen.findByText(
        "Eight items were checked. Five are ready, two still need owners, and one has no confirmed date.",
      ),
    ).toBeTruthy();
    expect(screen.getByLabelText("Task source").textContent).toContain("Product Launch");
    expect(window.location.pathname).toBe("/tasks/q3-launch-readiness");
  });

  it("labels a directly opened Task detail as demo data", async () => {
    installApi("admin");
    window.history.replaceState({}, "", "/tasks/q3-launch-readiness");
    render(<App />);

    expect(
      await screen.findByText(
        "Eight items were checked. Five are ready, two still need owners, and one has no confirmed date.",
      ),
    ).toBeTruthy();
    expect(screen.getByText("Demo data")).toBeTruthy();
  });

  it("groups members and invitations with Workspace settings", async () => {
    installApi("admin");
    window.history.replaceState({}, "", "/workspace#members");
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Workspace" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Members & access" })).toBeTruthy();
    const membersSection = document.querySelector<HTMLElement>("#members");
    if (!membersSection) throw new Error("Members section was not rendered");
    const memberRows = await within(membersSection).findAllByRole("rowheader");
    expect(memberRows[0]?.textContent).toContain("Ada");
    const currentRoleSelect = await screen.findByLabelText("Role for Ada");
    expect(currentRoleSelect.classList.contains("ds-control--compact")).toBe(true);
    expect(within(membersSection).getByRole("heading", { level: 3, name: "Invite members" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Invite members" })).toBeNull();
  });

  it.each(["/settings/members", "/settings/access", "/settings/security"])(
    "redirects legacy member administration URL %s",
    async (path) => {
      installApi("member");
      window.history.replaceState({}, "", path);
      render(<App />);

      expect(await screen.findByRole("heading", { name: "Members & access" })).toBeTruthy();
      expect(window.location.pathname).toBe("/workspace");
      expect(window.location.hash).toBe("#members");
    },
  );

  it("redirects the former Members page to Workspace member access", async () => {
    installApi("member");
    window.history.replaceState({}, "", "/members");
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Members & access" })).toBeTruthy();
    expect(window.location.pathname).toBe("/workspace");
    expect(window.location.hash).toBe("#members");
  });

  it("redirects the legacy Settings account URL to the editable Account page", async () => {
    installApi("member");
    window.history.replaceState({}, "", "/settings/account");
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Account" })).toBeTruthy();
    expect(window.location.pathname).toBe("/account");
    expect(screen.queryByRole("navigation", { name: "Account settings" })).toBeNull();
    expect(screen.queryByRole("link", { name: "Create Workspace" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Account menu" }));
    expect(screen.getByRole("menuitem", { name: "Account settings" }).getAttribute("aria-current")).toBe("page");
    expect(screen.getByRole("menuitem", { name: "Workspace settings" }).getAttribute("aria-current")).toBeNull();
    const displayName = screen.getByLabelText("Display name") as HTMLInputElement;
    expect(displayName.readOnly).toBe(false);
    fireEvent.change(displayName, { target: { value: "Legacy Account" } });
    expect(await screen.findByRole("button", { name: "Save account profile" })).toBeTruthy();
  });

  it.each(["/settings", "/settings/team"])(
    "redirects legacy Workspace settings URL %s to the first-class Workspace page",
    async (path) => {
      installApi("admin");
      window.history.replaceState({}, "", path);
      render(<App />);

      expect(await screen.findByRole("heading", { name: "Workspace profile" })).toBeTruthy();
      expect(screen.getByRole("heading", { name: "Workspace", level: 1 })).toBeTruthy();
      expect(window.location.pathname).toBe("/workspace");
      expect(window.location.hash).toBe("");
      expect(screen.getByLabelText("Workspace name")).toBeTruthy();
    },
  );

  it("keeps the legacy Workspace management hash compatible with the Workspace page", async () => {
    installApi("admin");
    window.history.replaceState({}, "", "/account#workspace-management");
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Workspace profile" })).toBeTruthy();
    expect(window.location.pathname).toBe("/workspace");
    expect(window.location.hash).toBe("");
  });

  it("redirects the former nested Workspace URL to the top-level Workspace page", async () => {
    installApi("admin");
    window.history.replaceState({}, "", "/account/workspace");
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Workspace", level: 1 })).toBeTruthy();
    expect(window.location.pathname).toBe("/workspace");
    expect(screen.queryByRole("navigation", { name: "Account settings" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Account menu" }));
    expect(screen.getByRole("menuitem", { name: "Workspace settings" }).getAttribute("aria-current")).toBe("page");
  });

  it.each(["/resources", "/settings/resources"])(
    "redirects legacy Skills URL %s to the canonical page",
    async (path) => {
      installApi("admin");
      window.history.replaceState({}, "", path);
      render(<App />);

      expect(await screen.findByRole("heading", { name: "Skills" })).toBeTruthy();
      expect(window.location.pathname).toBe("/skills");
      expect(screen.getByText("Demo data")).toBeTruthy();
    },
  );

  it("navigates between the remaining minimal capability pages", async () => {
    installApi("admin");
    window.history.replaceState({}, "", "/skills");
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Skills" })).toBeTruthy();
    fireEvent.click(screen.getByRole("link", { name: "Integrations" }));
    expect(await screen.findByRole("heading", { name: "Integrations" })).toBeTruthy();
    expect(screen.getByRole("table", { name: "Demo Integrations" })).toBeTruthy();
    expect(screen.getByText("Demo data")).toBeTruthy();
    expect(screen.getByText("GitHub")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Usage" })).toBeNull();
  });

  it.each(["/usage", "/settings/usage"])("redirects removed Workspace Usage URL %s to Agents", async (path) => {
    installApi("admin");
    window.history.replaceState({}, "", path);
    render(<App />);

    expect(await screen.findByRole("heading", { name: "Agents" })).toBeTruthy();
    expect(window.location.pathname).toBe("/agents");
  });

  it("lets admins rename a Workspace from its top-level page without changing the CLI identifier", async () => {
    installApi("admin");
    window.localStorage.setItem("opentag.selectedTeamId", teamId);
    window.history.replaceState({}, "", "/workspace");
    render(<App />);
    const displayName = await screen.findByLabelText("Workspace name");
    const profileForm = displayName.closest("form");
    if (!profileForm) throw new Error("Workspace profile form was not rendered");
    const cliIdentifier = within(profileForm).getByText("example", { selector: "dd code" });
    expect(cliIdentifier.textContent).toContain("example");
    expect(within(profileForm).getAllByRole("textbox")).toHaveLength(1);
    fireEvent.change(displayName, { target: { value: "Renamed Team" } });
    fireEvent.click(await screen.findByRole("button", { name: "Save Workspace profile" }));
    await waitFor(() =>
      expect(vi.mocked(fetch).mock.calls.filter(([input]) => String(input) === "/api/v1/me")).toHaveLength(2),
    );
    const updateCall = vi
      .mocked(fetch)
      .mock.calls.find(([input, init]) => String(input) === `/api/v1/teams/${teamId}` && init?.method === "PATCH");
    expect(JSON.parse(String(updateCall?.[1]?.body))).toEqual({ displayName: "Renamed Team" });
    const refreshedDisplayName = (await screen.findByLabelText("Workspace name")) as HTMLInputElement;
    const refreshedProfileForm = refreshedDisplayName.closest("form");
    if (!refreshedProfileForm) throw new Error("Refreshed Workspace profile form was not rendered");
    expect(refreshedDisplayName.value).toBe("Renamed Team");
    expect(within(refreshedProfileForm).getByText("example", { selector: "dd code" })).toBeTruthy();
    expect(window.localStorage.getItem("opentag.selectedTeamId")).toBe(teamId);
  });

  it("keeps Workspace profile fields read-only for members", async () => {
    installApi("member");
    window.history.replaceState({}, "", "/workspace");
    render(<App />);
    expect(await screen.findByText("example")).toBeTruthy();
    expect(screen.getByText("Workspace name").parentElement?.querySelector("dd")?.textContent).toBe("Example");
    expect(screen.queryByRole("button", { name: "Save Workspace profile" })).toBeNull();
    expect(screen.queryByLabelText("CLI identifier")).toBeNull();
  });

  it("accepts an invitation and selects the newly joined Team", async () => {
    installApi("admin");
    window.history.replaceState({}, "", `/invites/${invitationToken}`);
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Join Workspace" }));
    expect(await screen.findByRole("heading", { name: "Agents" })).toBeTruthy();
    expect(window.localStorage.getItem("opentag.selectedTeamId")).toBe(invitedTeamId);
    expect(window.sessionStorage.getItem("opentag.pendingInvitationToken")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Account menu" }));
    expect(
      within(screen.getByRole("group", { name: "Workspaces" }))
        .getByRole("menuitem", { name: /Invited Team Member/ })
        .getAttribute("aria-current"),
    ).toBe("true");
  });

  it("resumes a pending invitation after sign-in without requiring a second click", async () => {
    installApi("admin");
    window.sessionStorage.setItem("opentag.pendingInvitationToken", invitationToken);
    window.history.replaceState({}, "", `/invites/${invitationToken}`);
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Agents" })).toBeTruthy();
    expect(window.localStorage.getItem("opentag.selectedTeamId")).toBe(invitedTeamId);
  });

  it("uses a server-selected Team after OAuth without replaying an invalidated invitation", async () => {
    installApi("admin", { alreadyJoinedInvitation: true, redeemFails: true });
    window.sessionStorage.setItem("opentag.pendingInvitationToken", invitationToken);
    window.history.replaceState({}, "", `/invites/${invitationToken}?joinedTeamId=${invitedTeamId}`);
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Agents" })).toBeTruthy();
    expect(window.localStorage.getItem("opentag.selectedTeamId")).toBe(invitedTeamId);
    expect(vi.mocked(fetch)).not.toHaveBeenCalledWith(
      `/api/v1/invitations/${invitationToken}/redeem`,
      expect.anything(),
    );
  });

  it("continues an OAuth-redeemed invitation when Team preference storage is unavailable", async () => {
    installApi("admin", { alreadyJoinedInvitation: true, redeemFails: true });
    window.sessionStorage.setItem("opentag.pendingInvitationToken", invitationToken);
    window.history.replaceState({}, "", `/invites/${invitationToken}?joinedTeamId=${invitedTeamId}`);
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("Storage unavailable");
    });
    try {
      render(<App />);
      expect(await screen.findByRole("heading", { name: "Agents" })).toBeTruthy();
      fireEvent.click(screen.getByRole("button", { name: "Account menu" }));
      expect(
        within(screen.getByRole("group", { name: "Workspaces" })).getByRole("menuitem", {
          name: /Invited Team Member/,
        }),
      ).toBeTruthy();
      expect(window.location.pathname).toBe("/agents");
    } finally {
      setItem.mockRestore();
    }
  });

  it("preserves the pending invitation while redirecting an unauthenticated join to sign-in", async () => {
    installApi("member", { unauthenticated: true });
    window.history.replaceState({}, "", `/invites/${invitationToken}`);
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Join Workspace" }));
    expect(await screen.findByRole("heading", { name: "Welcome back" })).toBeTruthy();
    expect(window.location.search).toBe(`?next=${encodeURIComponent(`/invites/${invitationToken}`)}`);
    expect(window.sessionStorage.getItem("opentag.pendingInvitationToken")).toBe(invitationToken);
  });

  it("lets Team admins create, copy, and rotate the invitation link", async () => {
    installApi("admin");
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, "clipboard", { configurable: true, value: { writeText } });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    window.history.replaceState({}, "", "/workspace#members");
    render(<App />);
    expect(await screen.findByText("This link lets anyone join as a member until it expires.")).toBeTruthy();
    const createInviteLink = await screen.findByRole("button", { name: "Create invite link" });
    expect(createInviteLink.parentElement?.classList.contains("actions")).toBe(true);
    fireEvent.click(createInviteLink);
    const link = (await screen.findByLabelText("Invite link")) as HTMLInputElement;
    expect(link.value).toBe(`https://opentag.example.com/invites/${"A".repeat(43)}`);
    expect(screen.getByText(/^Expires Aug 27, 2026 at /)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Copy link" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith((link as HTMLInputElement).value));
    fireEvent.click(screen.getByRole("button", { name: "Replace link" }));
    await waitFor(() => expect(link.value).toBe(`https://opentag.example.com/invites/${"B".repeat(43)}`));
    expect(confirm).toHaveBeenCalledOnce();
    confirm.mockRestore();
  });

  it("replaces a locally rotated invitation with a newer successful server read", async () => {
    const api = installApi("admin", { invitationExists: true });
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    window.history.replaceState({}, "", "/workspace#members");
    render(<App />);

    expect(((await screen.findByLabelText("Invite link")) as HTMLInputElement).value).toContain("/invites/AAA");
    fireEvent.click(screen.getByRole("button", { name: "Replace link" }));
    await waitFor(() =>
      expect((screen.getByLabelText("Invite link") as HTMLInputElement).value).toContain("/invites/BBB"),
    );

    api.setInvitationVersion("C");
    fireEvent.click(screen.getByRole("link", { name: "Agents" }));
    expect(await screen.findByRole("heading", { name: "Agents" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Account menu" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Workspace settings" }));
    expect(await screen.findByRole("heading", { name: "Members & access" })).toBeTruthy();

    await waitFor(() =>
      expect((screen.getByLabelText("Invite link") as HTMLInputElement).value).toContain("/invites/CCC"),
    );
    confirm.mockRestore();
  });

  it("shows the current Workspace without exposing switch or invitation shortcuts to single-Workspace members", async () => {
    installApi("member");
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Account menu" }));
    const workspaces = screen.getByRole("group", { name: "Workspaces" });
    expect(within(workspaces).getByText("Example").closest('[aria-current="true"]')).toBeTruthy();
    expect(within(workspaces).queryByRole("menuitem")).toBeNull();
    expect(screen.queryByRole("menuitem", { name: "Invite people" })).toBeNull();
    expect(screen.queryByText("Create Workspace")).toBeNull();
  });

  it("keeps invitation-link management hidden from regular members", async () => {
    installApi("member");
    window.history.replaceState({}, "", "/workspace#members");
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Members & access" })).toBeTruthy();
    expect(screen.queryByRole("heading", { name: "Invite people" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Invite members" })).toBeNull();
    expect(screen.queryByLabelText("Role for Ada")).toBeNull();
    expect(await screen.findAllByRole("cell", { name: "Member" })).toHaveLength(3);
  });

  it("lets Team admins update another member role from the member list", async () => {
    installApi("admin");
    window.history.replaceState({}, "", "/workspace#members");
    render(<App />);
    const role = (await screen.findByLabelText("Role for Grace")) as HTMLSelectElement;
    expect(within(role).getByRole("option", { name: "Admin" })).toBeTruthy();
    expect(within(role).getByRole("option", { name: "Member" })).toBeTruthy();
    fireEvent.change(role, { target: { value: "admin" } });
    await waitFor(() => expect((screen.getByLabelText("Role for Grace") as HTMLSelectElement).value).toBe("admin"));
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      `/api/v1/teams/${teamId}/members/${memberUserId}`,
      expect.objectContaining({ method: "PATCH", body: JSON.stringify({ role: "admin" }) }),
    );
  });

  it("tracks overlapping role updates per member and prevents duplicate submissions", async () => {
    let resolveGrace: (response: Response) => void = () => undefined;
    let resolveLin: (response: Response) => void = () => undefined;
    const graceUpdate = new Promise<Response>((resolve) => {
      resolveGrace = resolve;
    });
    const linUpdate = new Promise<Response>((resolve) => {
      resolveLin = resolve;
    });
    installApi("admin", {
      roleUpdate: (targetUserId) => (targetUserId === memberUserId ? graceUpdate : linUpdate),
    });
    window.history.replaceState({}, "", "/workspace#members");
    render(<App />);
    const graceRole = (await screen.findByLabelText("Role for Grace")) as HTMLSelectElement;
    const linRole = screen.getByLabelText("Role for Lin") as HTMLSelectElement;

    fireEvent.change(graceRole, { target: { value: "admin" } });
    fireEvent.change(linRole, { target: { value: "admin" } });
    fireEvent.change(graceRole, { target: { value: "admin" } });

    await waitFor(() => {
      expect((screen.getByLabelText("Role for Grace") as HTMLSelectElement).disabled).toBe(true);
      expect((screen.getByLabelText("Role for Lin") as HTMLSelectElement).disabled).toBe(true);
    });
    expect(
      vi
        .mocked(fetch)
        .mock.calls.filter(
          ([input, init]) => String(input).endsWith(`/members/${memberUserId}`) && init?.method === "PATCH",
        ),
    ).toHaveLength(1);

    resolveGrace(
      json({
        teamId,
        userId: memberUserId,
        email: "grace@example.com",
        displayName: "Grace",
        role: "admin",
        status: "active",
        createdAt: "2026-08-20T00:00:00.000Z",
        updatedAt: "2026-08-20T00:01:00.000Z",
      }),
    );
    await waitFor(() => {
      expect((screen.getByLabelText("Role for Grace") as HTMLSelectElement).disabled).toBe(false);
      expect((screen.getByLabelText("Role for Lin") as HTMLSelectElement).disabled).toBe(true);
    });

    resolveLin(
      json({
        teamId,
        userId: otherMemberUserId,
        email: "lin@example.com",
        displayName: "Lin",
        role: "admin",
        status: "active",
        createdAt: "2026-08-20T00:00:00.000Z",
        updatedAt: "2026-08-20T00:01:00.000Z",
      }),
    );
    await waitFor(() => expect((screen.getByLabelText("Role for Lin") as HTMLSelectElement).disabled).toBe(false));
  });

  it("refreshes current membership authority after an admin demotes themself", async () => {
    installApi("admin");
    window.history.replaceState({}, "", "/workspace#members");
    render(<App />);
    fireEvent.change(await screen.findByLabelText("Role for Ada"), { target: { value: "member" } });
    await waitFor(() =>
      expect(vi.mocked(fetch).mock.calls.filter(([input]) => String(input) === "/api/v1/me")).toHaveLength(2),
    );
    expect(screen.queryByRole("heading", { name: "Invite people" })).toBeNull();
    expect(screen.queryByLabelText("Role for Ada")).toBeNull();
  });

  it("keeps the confirmed role and displays the server error when an update is rejected", async () => {
    installApi("admin", { roleUpdateFails: true });
    window.history.replaceState({}, "", "/workspace#members");
    render(<App />);
    const role = (await screen.findByLabelText("Role for Ada")) as HTMLSelectElement;
    fireEvent.change(role, { target: { value: "member" } });
    expect((await screen.findByRole("alert")).textContent).toBe("The last active Team admin cannot be demoted");
    expect(role.value).toBe("admin");
  });

  it("does not create an IM setup attempt while rendering Agent detail", async () => {
    installApi("admin");
    window.history.replaceState({}, "", `/agents/${agentId}/settings/messaging`);
    render(<App />);
    expect(await screen.findByRole("button", { name: "Connect a Feishu Bot" })).toBeTruthy();
    expect(vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
  });

  it("creates a Feishu setup attempt only after an explicit admin click", async () => {
    installApi("admin");
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
    installApi("admin", { bindingReauth: true, bound: true });
    window.history.replaceState({}, "", `/agents/${agentId}/settings/messaging`);
    render(<App />);
    expect(await screen.findByText(/Permissions update required/)).toBeTruthy();
    expect(screen.queryByText(/Online/)).toBeNull();
    expect(screen.getByRole("button", { name: "Reauthorize Feishu" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Replace Feishu Bot" }));
    expect(await screen.findByText(/Choose an existing Feishu Bot or create a new one/)).toBeTruthy();
    const request = vi
      .mocked(fetch)
      .mock.calls.find(
        ([input, init]) => String(input).endsWith("/im-binding/feishu/setup-attempts") && init?.method === "POST",
      );
    expect(JSON.parse(String(request?.[1]?.body))).toEqual({ intent: "replace" });
  });

  it("describes an active binding as needing attention when handoff is unavailable", async () => {
    installApi("admin", { bound: true, handoffReady: false });
    window.history.replaceState({}, "", `/agents/${agentId}/settings/messaging`);
    render(<App />);

    expect((await screen.findByText(/Needs attention/)).closest(".ds-status")).toBeTruthy();
    expect(screen.queryByText(/Online/)).toBeNull();
  });

  it("shows a safe occupied-App recovery and retries the original replacement intent", async () => {
    installApi("admin", { bound: true, setupFailureCode: "FEISHU_APP_ALREADY_BOUND" });
    window.history.replaceState({}, "", `/agents/${agentId}/settings/messaging`);
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Replace Feishu Bot" }));
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

  it.each([
    ["feishu", "Reauthorize Feishu"],
    ["slack", "Reauthorize Slack"],
  ] as const)("offers provider-correct recovery when %s needs additional scopes", async (provider, recovery) => {
    installApi("admin", { bound: true, provider, scopeReauth: true });
    window.history.replaceState({}, "", `/agents/${agentId}/settings/messaging`);
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "All messages" }));
    expect(await screen.findByText("Additional IM scopes are required")).toBeTruthy();
    expect(await screen.findByText(recovery)).toBeTruthy();
    if (provider === "slack") expect(screen.queryByRole("button", { name: "Reauthorize Feishu" })).toBeNull();
    confirm.mockRestore();
  });

  it("starts a dedicated customer-owned Slack App setup from the Agent IM tab", async () => {
    installApi("admin");
    window.history.replaceState({}, "", `/agents/${agentId}/settings/messaging`);
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Connect Slack App" }));

    expect(await screen.findByRole("link", { name: /Create a dedicated Slack App/ })).toBeTruthy();
    expect(screen.getByLabelText("Bot User OAuth Token")).toBeTruthy();
    expect(screen.getByLabelText("Signing Secret")).toBeTruthy();
    expect(screen.getByText(/files:read/)).toBeTruthy();
    const request = vi
      .mocked(fetch)
      .mock.calls.find(
        ([input, init]) => String(input).endsWith("/im-binding/slack/setup-attempts") && init?.method === "POST",
      );
    expect(JSON.parse(String(request?.[1]?.body))).toEqual({ intent: "create" });
  });

  it("creates a Computer connection command only after an explicit admin click", async () => {
    installApi("admin");
    window.history.replaceState({}, "", "/settings/computers");
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Create Agent" })).toBeTruthy();
    expect(await screen.findByRole("heading", { name: "Connect a Local Computer" })).toBeTruthy();
    expect(window.location.pathname).toBe("/agents/new");
    const button = await screen.findByRole("button", { name: "Generate connection command" });
    expect(vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(0);
    fireEvent.click(button);
    expect(await screen.findByText(/opentag login --server https:\/\/opentag\.example\.com -- example/)).toBeTruthy();
  });

  it("guides Agent creation to Computer setup when none is connected", async () => {
    installApi("admin");
    window.history.replaceState({}, "", "/agents/new");
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Connect a Local Computer" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Generate connection command" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Agent runtime" })).toBeNull();
  });

  it("validates Agent name locally with an accessible field error before sending a request", async () => {
    installApi("admin", { ownComputer: true });
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
        .mock.calls.filter(
          ([input, init]) => String(input) === `/api/v1/teams/${teamId}/agents` && init?.method === "POST",
        ),
    ).toHaveLength(0);
  });

  it("asks for an explicit Agent name when the display name cannot produce an ASCII name", async () => {
    installApi("admin", { ownComputer: true });
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
        .mock.calls.filter(
          ([input, init]) => String(input) === `/api/v1/teams/${teamId}/agents` && init?.method === "POST",
        ),
    ).toHaveLength(0);
  });

  it("creates an Agent with a valid canonical name and keeps the existing payload", async () => {
    installApi("admin", { ownComputer: true });
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
      .mock.calls.find(
        ([input, init]) => String(input) === `/api/v1/teams/${teamId}/agents` && init?.method === "POST",
      );
    expect(JSON.parse(String(createCall?.[1]?.body))).toEqual({
      creationIntentId: expect.any(String),
      name: "bestony",
      displayName: "Bestony",
      runtimeProvider: "codex",
      computerId,
    });
  });

  it("maps a Server name issue back to the Agent name field", async () => {
    installApi("admin", { agentCreateError: "name", ownComputer: true });
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

  it("reveals the Agent name editor when the Server reports a Team name conflict", async () => {
    installApi("admin", { agentCreateError: "conflict", ownComputer: true });
    window.history.replaceState({}, "", "/agents/new");
    render(<App />);
    fireEvent.change(await screen.findByLabelText("Display name"), { target: { value: "Bestony" } });
    expect(screen.queryByLabelText("Agent name")).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Create Agent" }));

    const alert = await screen.findByRole("alert");
    const name = screen.getByLabelText("Agent name");
    expect(alert.textContent).toBe("An active Agent with this name already exists in the Team");
    expect(name.getAttribute("aria-invalid")).toBe("true");
    await waitFor(() => expect(name).toBe(document.activeElement));
  });

  it("keeps an unmapped Server validation error at form level", async () => {
    installApi("admin", { agentCreateError: "generic", ownComputer: true });
    window.history.replaceState({}, "", "/agents/new");
    render(<App />);
    fireEvent.change(await screen.findByLabelText("Display name"), { target: { value: "Bestony" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Agent" }));
    expect((await screen.findByRole("alert")).textContent).toBe("The request payload is invalid");
    expect(screen.queryByLabelText("Agent name")).toBeNull();
  });

  it("uses only a confirmed ready Computer and Provider route", async () => {
    installApi("admin", {
      computers: [
        {
          id: computerId,
          ownerUserId: userId,
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
        .mock.calls.find(([path, init]) => path === `/api/v1/teams/${teamId}/agents` && init?.method === "POST");
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
    let ownComputerReadStatus: number | undefined;
    installApi("admin", {
      computers: [
        {
          id: computerId,
          ownerUserId: userId,
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
      ownComputerReadStatus: () => ownComputerReadStatus,
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

    ownComputerReadStatus = 503;
    window.dispatchEvent(new Event("focus"));
    expect(await within(dialog).findByText("Readiness unconfirmed")).toBeTruthy();
    expect(within(dialog).getByRole("button", { name: "Create Agent" }).hasAttribute("disabled")).toBe(true);
  });

  it("removes a retained creation route after a terminal Computer refresh error", async () => {
    let ownComputerReadStatus: number | undefined;
    installApi("admin", { ownComputer: true, ownComputerReadStatus: () => ownComputerReadStatus });
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "New Agent" }));
    const dialog = await screen.findByRole("dialog", { name: "New Agent" });
    expect(await within(dialog).findByText("Ready to run")).toBeTruthy();

    ownComputerReadStatus = 404;
    window.dispatchEvent(new Event("focus"));

    expect((await within(dialog).findByRole("alert")).textContent).toContain("Request failed");
    expect(within(dialog).queryByRole("button", { name: "Create Agent" })).toBeNull();
  });

  it("keeps the Team-less authenticated gate read-only while the server finishes Workspace setup", async () => {
    installApi("admin", { teamless: true });
    render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
    expect(await screen.findByRole("heading", { name: "Workspace setup incomplete" })).toBeTruthy();
    expect(window.location.pathname).toBe("/agents");
    expect(screen.getByRole("alert").textContent).toContain("The server must finish Workspace setup");
    expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
    const initialMeReads = vi.mocked(fetch).mock.calls.filter(([path]) => path === "/api/v1/me").length;
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await waitFor(() =>
      expect(vi.mocked(fetch).mock.calls.filter(([path]) => path === "/api/v1/me")).toHaveLength(initialMeReads + 1),
    );
    expect(vi.mocked(fetch).mock.calls.some(([, init]) => init?.method === "POST")).toBe(false);
  });

  it("keeps standalone onboarding behind the read-only Workspace setup gate", async () => {
    installApi("admin", { teamless: true });
    window.history.replaceState({}, "", "/onboarding");
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Workspace setup incomplete" })).toBeTruthy();
    expect(window.location.pathname).toBe("/onboarding");
    expect(
      vi.mocked(fetch).mock.calls.some(([path, init]) => path === "/api/v1/teams" && init?.method === "POST"),
    ).toBe(false);
  });

  it("routes an admin with incomplete Team setup into onboarding", async () => {
    installApi("admin", { setupCompletedAt: null });
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Set up OpenTag" })).toBeTruthy();
    expect(window.location.pathname).toBe("/onboarding");
  });

  it("keeps completed Teams out of onboarding even when it is requested directly", async () => {
    installApi("admin");
    window.history.replaceState({}, "", "/onboarding");
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Agents" })).toBeTruthy();
    expect(window.location.pathname).toBe("/agents");
  });

  it("keeps a member out of incomplete onboarding and names the admin dependency", async () => {
    installApi("member", { setupCompletedAt: null });
    window.history.replaceState({}, "", "/onboarding");
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Agents" })).toBeTruthy();
    expect(window.location.pathname).toBe("/agents");
    expect(
      screen.getByText("Team setup is not complete. An administrator needs to prepare the first Agent."),
    ).toBeTruthy();
  });

  it("loads standalone onboarding when selected Team preference storage is unavailable", async () => {
    installApi("admin", { computerProviderReadiness: [], setupCompletedAt: null });
    window.history.replaceState({}, "", "/onboarding");
    const getItem = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("Storage unavailable");
    });
    const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("Storage unavailable");
    });
    try {
      render(<App />);
      expect(await screen.findByRole("heading", { name: "Reviewer needs its runtime route" })).toBeTruthy();
      expect(window.location.pathname).toBe("/onboarding");
      expect(vi.mocked(fetch).mock.calls.filter(([path]) => path === "/api/v1/me")).toHaveLength(1);
    } finally {
      getItem.mockRestore();
      setItem.mockRestore();
    }
  });

  it("resolves an internal Team handle collision without asking the user for another name", async () => {
    installApi("admin", { teamless: true, teamNameConflict: true });
    window.history.replaceState({}, "", "/teams/new");
    render(<App />);
    fireEvent.change(await screen.findByLabelText("Workspace name"), { target: { value: "Example" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Workspace" }));
    expect(await screen.findByRole("heading", { name: "Set up OpenTag" })).toBeTruthy();
    expect(window.location.pathname).toBe("/onboarding");
    const createRequests = vi
      .mocked(fetch)
      .mock.calls.filter(([path, init]) => path === "/api/v1/teams" && init?.method === "POST");
    expect(createRequests).toHaveLength(2);
    expect(JSON.parse(String(createRequests[0]?.[1]?.body))).toEqual({ name: "example", displayName: "Example" });
    expect(JSON.parse(String(createRequests[1]?.[1]?.body))).toMatchObject({
      displayName: "Example",
      name: expect.stringMatching(/^example-[a-f0-9]{8}$/),
    });
  });

  it("uses a fresh internal handle for every collision on a Workspace name without ASCII characters", async () => {
    installApi("admin", { teamless: true, teamNameConflicts: 2 });
    window.history.replaceState({}, "", "/teams/new");
    render(<App />);
    fireEvent.change(await screen.findByLabelText("Workspace name"), { target: { value: "示例团队" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Workspace" }));
    await screen.findByRole("heading", { name: "Set up OpenTag" });
    const requests = vi
      .mocked(fetch)
      .mock.calls.filter(([path, init]) => path === "/api/v1/teams" && init?.method === "POST");
    expect(requests).toHaveLength(3);
    const bodies = requests.map(
      (request) => JSON.parse(String(request[1]?.body)) as { displayName: string; name: string },
    );
    expect(bodies.every((body) => body.displayName === "示例团队")).toBe(true);
    expect(bodies.every((body) => /^team-[a-f0-9]{8}$/.test(body.name))).toBe(true);
    expect(new Set(bodies.map((body) => body.name))).toHaveProperty("size", 3);
  });

  it("creates an additional Workspace and enters its first-time setup", async () => {
    installApi("admin");
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Account menu" }));
    expect(screen.queryByRole("menuitem", { name: "Create Workspace" })).toBeNull();
    fireEvent.click(screen.getByRole("menuitem", { name: "Workspace settings" }));
    fireEvent.click(screen.getByRole("link", { name: "Create Workspace" }));
    fireEvent.change(await screen.findByLabelText("Workspace name"), { target: { value: "Second Team" } });
    fireEvent.click(screen.getByRole("button", { name: "Create Workspace" }));
    expect(await screen.findByRole("heading", { name: "Set up OpenTag" })).toBeTruthy();
    expect(window.location.pathname).toBe("/onboarding");
    expect(window.localStorage.getItem("opentag.selectedTeamId")).toBe(createdTeamId);
  });

  it("switches Teams when Team preference storage is unavailable", async () => {
    installApi("admin", { alreadyJoinedInvitation: true });
    window.localStorage.setItem("opentag.selectedTeamId", teamId);
    const setItem = vi.spyOn(window.localStorage, "setItem").mockImplementation(() => {
      throw new Error("Storage unavailable");
    });
    try {
      render(<App />);
      fireEvent.click(await screen.findByRole("button", { name: "Account menu" }));
      fireEvent.click(
        within(screen.getByRole("group", { name: "Workspaces" })).getByRole("menuitem", {
          name: /Invited Team Member/,
        }),
      );
      fireEvent.click(await screen.findByRole("button", { name: "Account menu" }));
      expect(
        within(screen.getByRole("group", { name: "Workspaces" }))
          .getByRole("menuitem", { name: /Invited Team Member/ })
          .getAttribute("aria-current"),
      ).toBe("true");
      expect(window.location.pathname).toBe("/agents");
      expect(window.localStorage.getItem("opentag.selectedTeamId")).toBe(teamId);
    } finally {
      setItem.mockRestore();
    }
  });

  it.each([`/agents/${agentId}`, "/agents/new"])(
    "leaves Workspace-scoped Agent route %s when switching Workspaces",
    async (path) => {
      installApi("admin", { alreadyJoinedInvitation: true });
      window.history.replaceState({}, "", path);
      render(<App />);

      fireEvent.click(await screen.findByRole("button", { name: "Account menu" }));
      const targetWorkspace = within(screen.getByRole("group", { name: "Workspaces" }))
        .getAllByRole("menuitem")
        .find(
          (item) => item.classList.contains("account-workspace-option") && item.getAttribute("aria-current") !== "true",
        );
      if (!targetWorkspace) throw new Error("A second Workspace option was not rendered");
      const targetWorkspaceName = targetWorkspace.querySelector("strong")?.textContent;
      fireEvent.click(targetWorkspace);

      expect(await screen.findByRole("heading", { name: "Agents" })).toBeTruthy();
      expect(window.location.pathname).toBe("/agents");
      fireEvent.click(screen.getByRole("button", { name: "Account menu" }));
      const selectedWorkspace = screen
        .getByRole("group", { name: "Workspaces" })
        .querySelector<HTMLElement>('[aria-current="true"]');
      expect(selectedWorkspace?.querySelector("strong")?.textContent).toBe(targetWorkspaceName);
    },
  );

  it("keeps account controls personal and signs out from the account menu", async () => {
    installApi("admin");
    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Account menu" }));
    expect(within(screen.getByRole("group", { name: "Workspaces" })).getByText("Example")).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: "Workspace settings" })).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitem", { name: "Account settings" }));
    expect(await screen.findByRole("heading", { name: "Account" })).toBeTruthy();
    expect(window.location.pathname).toBe("/account");
    const displayName = screen.getByLabelText("Display name") as HTMLInputElement;
    expect(displayName.readOnly).toBe(false);
    fireEvent.change(displayName, { target: { value: "Account Menu" } });
    expect(await screen.findByRole("button", { name: "Save account profile" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Account menu" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Sign out" }));
    expect(await screen.findByRole("heading", { name: "Welcome back" })).toBeTruthy();
    expect(vi.mocked(fetch)).toHaveBeenCalledWith(
      "/api/v1/auth/browser/logout",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("moves focus into multi-Workspace account options and returns it to the trigger on Escape", async () => {
    installApi("admin", { alreadyJoinedInvitation: true });
    render(<App />);
    const trigger = await screen.findByRole("button", { name: "Account menu" });
    fireEvent.click(trigger);
    const currentTeam = screen.getByRole("menuitem", { name: /Example Admin/ });
    expect(document.activeElement).toBe(currentTeam);
    fireEvent.keyDown(currentTeam, { key: "Escape" });
    expect(screen.queryByRole("menu", { name: "Account" })).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("supports arrow-key navigation and focus return in the account menu", async () => {
    installApi("admin");
    render(<App />);
    const trigger = await screen.findByRole("button", { name: "Account menu" });
    fireEvent.click(trigger);
    const account = screen.getByRole("menuitem", { name: "Account settings" });
    const workspace = screen.getByRole("menuitem", { name: "Workspace settings" });
    const signOut = screen.getByRole("menuitem", { name: "Sign out" });
    expect(document.activeElement).toBe(workspace);
    fireEvent.keyDown(workspace, { key: "ArrowDown" });
    expect(document.activeElement).toBe(account);
    fireEvent.keyDown(account, { key: "ArrowDown" });
    expect(document.activeElement).toBe(signOut);
    fireEvent.keyDown(signOut, { key: "ArrowDown" });
    expect(document.activeElement).toBe(workspace);
    fireEvent.keyDown(workspace, { key: "End" });
    expect(document.activeElement).toBe(signOut);
    fireEvent.keyDown(signOut, { key: "Escape" });
    expect(screen.queryByRole("menu", { name: "Account" })).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("removes the old admin product shell without a redirect", async () => {
    window.history.replaceState({}, "", "/admin");
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Page not found" })).toBeTruthy();
    expect(vi.mocked(fetch)).not.toHaveBeenCalled();
  });
});
