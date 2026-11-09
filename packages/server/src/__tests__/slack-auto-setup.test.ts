import { randomUUID } from "node:crypto";
import {
  type AgentAdminConfig,
  SLACK_REQUIRED_BOT_SCOPES,
  SLACK_SUBSCRIBED_BOT_EVENTS,
  type SlackAutoSetupCommand,
  type SlackConfigurationView,
} from "@opentag/shared";
import { afterEach, expect, it, vi } from "vitest";
import { CloudSlackAutoSetupOwner } from "../runtime/cloud-slack-auto-setup-owner.js";
import type { ConnectionRegistry } from "../runtime/connection-registry.js";
import type { RuntimeBusinessContext } from "../runtime/runtime-session.js";
import { SlackAutoSetupOwner } from "../runtime/slack-auto-setup-owner.js";
import { SlackAutoSetupService } from "../services/agents/slack-auto-setup-service.js";

const agentId = randomUUID(),
  computerId = randomUUID(),
  instanceId = randomUUID();
const credentials = {
  appId: "A1",
  teamId: "T1",
  botUserId: "U1",
  botAccessToken: "private-token",
  signingSecret: "private-secret",
};
function unbound(): SlackConfigurationView {
  return {
    agentDisplayName: "QA",
    eventsUrl: "https://qa.example/events",
    allowedIntent: "create",
    blockedReason: null,
    expectedMessaging: { kind: "unbound" },
    preferredRecovery: "credentials",
    binding: null,
    identityClosure: null,
    handoff: null,
  };
}
function bound(): SlackConfigurationView {
  return {
    ...unbound(),
    binding: {
      id: randomUUID(),
      agentId,
      provider: "slack",
      bindingState: "active",
      bot: { displayName: "qa", avatarUrl: null },
      receiveMode: "all_message",
      lastInboundAt: null,
      lastValidatedAt: null,
      lastRuntimeObservationAt: null,
      identity: {
        provider: "slack",
        appId: "A1",
        teamId: "T1",
        botUserId: "U1",
        enterpriseId: null,
        appIdEvidence: "configured",
      },
      credentialGeneration: 1,
      grantedCapabilities: [],
      reauthorizationRequired: false,
      lastErrorCode: null,
    },
  };
}
function fixture(officialBinding = false) {
  const agents = {
    getConfigById: vi.fn(
      async () => ({ computerId, name: "qa-agent", displayName: "Friendly QA" }) as AgentAdminConfig,
    ),
  };
  const slack = {
    assertAutoSetupTarget: vi.fn(async () => undefined),
    view: vi.fn(async (_accountId: string, _agentId: string, _publicOrigin: string, signingSecret?: string) => {
      if (!officialBinding) return unbound();
      return { ...bound(), preferredRecovery: signingSecret === "official-secret" ? "oauth" : "credentials" } as const;
    }),
    configureToken: vi.fn(async () => ({}) as never),
  };
  const owner = {
    start: vi
      .fn<SlackAutoSetupOwner["start"]>()
      .mockResolvedValueOnce({ status: "installed", credentials })
      .mockResolvedValue({ status: "connected" }),
  };
  const service = new SlackAutoSetupService({
    agents,
    slack,
    owner,
    publicOrigin: "https://qa.example",
    officialSigningSecret: "official-secret",
  });
  return { agents, slack, owner, service };
}
afterEach(() => vi.useRealTimers());
it("returns confirmed pending approval without binding credentials or setting callbacks", async () => {
  const f = fixture();
  f.owner.start.mockReset().mockResolvedValue({ status: "approval_pending", appId: "A1", teamId: "T1" });
  expect(await f.service.run("account", agentId, { action: "connect" })).toEqual({
    status: "approval_pending",
    appId: "A1",
    teamId: "T1",
  });
  expect(f.slack.configureToken).not.toHaveBeenCalled();
  expect(f.owner.start).toHaveBeenCalledTimes(1);
});
it("uses Web Account ownership before accessing CLI and accepts no caller-selected Computer", async () => {
  const f = fixture();
  f.agents.getConfigById.mockRejectedValueOnce(new Error("not owned"));
  await expect(f.service.run("other", agentId, { action: "connect", challenge: "code" })).rejects.toThrow("not owned");
  expect(f.slack.view).not.toHaveBeenCalled();
  expect(f.owner.start).not.toHaveBeenCalled();
});
it("binds through the existing encrypted service and exposes only the public result", async () => {
  const f = fixture();
  f.slack.view.mockResolvedValueOnce(unbound()).mockResolvedValueOnce(unbound()).mockResolvedValue(bound());
  const result = await f.service.run("account", agentId, { action: "connect", challenge: "code" });
  expect(result).toEqual({ status: "connected" });
  expect(f.slack.configureToken).toHaveBeenCalledWith(
    "account",
    agentId,
    {
      intent: "create",
      expectedMessaging: { kind: "unbound" },
      botAccessToken: credentials.botAccessToken,
      signingSecret: credentials.signingSecret,
    },
    credentials,
    computerId,
  );
  expect(f.owner.start.mock.calls.map(([value]) => value.input.action)).toEqual(["install", "callbacks"]);
  expect(f.owner.start.mock.calls[0]?.[0].input).toEqual({
    action: "install",
    displayName: "qa-agent",
    challenge: "code",
  });
  expect(JSON.stringify(result)).not.toContain("private");
  for (const call of f.slack.view.mock.calls) expect(call[3]).toBe("official-secret");
});
it("only retries callbacks for an already bound App", async () => {
  const f = fixture();
  f.slack.view.mockResolvedValue(bound());
  f.owner.start.mockReset().mockResolvedValue({ status: "connected" });
  expect(await f.service.run("account", agentId, { action: "connect" })).toEqual({ status: "connected" });
  expect(f.owner.start).toHaveBeenCalledWith({
    computerId,
    agentId,
    input: expect.objectContaining({ action: "callbacks", appId: "A1", teamId: "T1" }),
  });
  expect(f.slack.configureToken).not.toHaveBeenCalled();
});
it.each(["authorize", "connect"] as const)(
  "rejects %s for an official OAuth binding before dispatch",
  async (action) => {
    const f = fixture(true);
    await expect(f.service.run("account", agentId, { action })).rejects.toMatchObject({
      code: "SLACK_CONFIGURATION_CONFLICT",
    });
    expect(f.owner.start).not.toHaveBeenCalled();
    expect(f.slack.configureToken).not.toHaveBeenCalled();
    expect(f.slack.view).toHaveBeenCalledWith("account", agentId, "https://qa.example", "official-secret");
  },
);
it("does not configure an OAuth App if the binding changes after installation", async () => {
  const f = fixture();
  f.slack.view
    .mockResolvedValueOnce(unbound())
    .mockResolvedValueOnce(unbound())
    .mockResolvedValue({ ...bound(), preferredRecovery: "oauth" });
  await expect(f.service.run("account", agentId, { action: "connect" })).rejects.toMatchObject({
    code: "SLACK_CONFIGURATION_CONFLICT",
  });
  expect(f.owner.start).toHaveBeenCalledTimes(1);
});
it("returns a definite creation rejection without attempting to bind or configure callbacks", async () => {
  const f = fixture();
  f.owner.start.mockReset().mockResolvedValue({ status: "failed", code: "create_failed" });
  expect(await f.service.run("account", agentId, { action: "connect" })).toEqual({
    status: "failed",
    code: "create_failed",
  });
  expect(f.slack.configureToken).not.toHaveBeenCalled();
  expect(f.owner.start).toHaveBeenCalledTimes(1);
});
it("passes the original Computer to final binding admission and skips callbacks on rejection", async () => {
  const f = fixture();
  f.slack.configureToken.mockRejectedValueOnce(new Error("moved"));
  await expect(f.service.run("account", agentId, { action: "connect", challenge: "code" })).rejects.toThrow("moved");
  expect(f.slack.configureToken).toHaveBeenCalledWith("account", agentId, expect.anything(), credentials, computerId);
  expect(f.owner.start).toHaveBeenCalledTimes(1);
});
it("dispatches Cloud Agents to the Cloud auto-setup owner and fails closed when absent", async () => {
  const f = fixture();
  f.slack.view
    .mockResolvedValueOnce(unbound())
    .mockResolvedValueOnce(unbound())
    .mockResolvedValueOnce(unbound())
    .mockResolvedValue(bound());
  const cloud = {
    start: vi
      .fn<SlackAutoSetupOwner["start"]>()
      .mockResolvedValueOnce({ status: "installed", credentials })
      .mockResolvedValue({ status: "connected" }),
  };
  const withoutCloud = new SlackAutoSetupService({
    agents: f.agents,
    slack: f.slack,
    owner: f.owner,
    computerKind: async () => "cloud",
    publicOrigin: "https://qa.example",
  });
  expect(await withoutCloud.run("account", agentId, { action: "authorize" })).toEqual({
    status: "failed",
    code: "capability_missing",
  });
  expect(f.owner.start).not.toHaveBeenCalled();

  const withCloud = new SlackAutoSetupService({
    agents: f.agents,
    slack: f.slack,
    owner: f.owner,
    cloud,
    computerKind: async () => "cloud",
    publicOrigin: "https://qa.example",
    officialSigningSecret: "official-secret",
  });
  expect(await withCloud.run("account", agentId, { action: "connect", challenge: "code" })).toEqual({
    status: "connected",
  });
  expect(f.owner.start).not.toHaveBeenCalled();
  expect(cloud.start.mock.calls.map(([value]) => value.input.action)).toEqual(["install", "callbacks"]);
  expect(f.slack.configureToken).toHaveBeenCalledTimes(1);
});
it("correlates results with the authenticated Computer instance and clears bounded pending work", async () => {
  vi.useFakeTimers();
  const registry = {
    currentInstanceId: vi.fn(() => instanceId),
    currentControlIdentity: vi.fn(),
    supportsCapability: vi.fn(() => true),
    send: vi.fn(async (..._args: unknown[]) => {}),
  };
  const owner = new SlackAutoSetupOwner(registry as unknown as ConnectionRegistry, 1000);
  const start = { computerId, agentId, input: { action: "authorize" as const } };
  const pending = owner.start(start);
  expect(await owner.start(start)).toEqual({ status: "failed", code: "busy" });
  const frame = registry.send.mock.calls[0]?.[2] as { requestId: string };
  const business = owner.businessOptions();
  const response = business.parse({
    type: "slack:auto-setup:result",
    requestId: frame.requestId,
    result: { status: "authorization_required", ticket: "ticket" },
  });
  if (!response) throw new Error("missing parsed result");
  await business.handle(response, { computerId, instanceId: "old" } as RuntimeBusinessContext);
  expect(await owner.start(start)).toEqual({ status: "failed", code: "busy" });
  await business.handle(response, { computerId, instanceId } as RuntimeBusinessContext);
  expect(await pending).toEqual({ status: "authorization_required", ticket: "ticket" });
  const next = owner.start(start);
  await vi.advanceTimersByTimeAsync(1000);
  expect(await next).toEqual({ status: "failed", code: "computer_unavailable" });
  registry.supportsCapability.mockReturnValue(false);
  expect(await owner.start(start)).toEqual({ status: "failed", code: "capability_missing" });
  registry.supportsCapability.mockReturnValue(true);
  registry.currentControlIdentity.mockReturnValue({ kind: "cloud" });
  const sent = registry.send.mock.calls.length;
  expect(await owner.start(start)).toEqual({ status: "failed", code: "capability_missing" });
  expect(registry.send).toHaveBeenCalledTimes(sent);
  owner.close();
});

function cloudFixture(options: { ttlMs?: number; maxEntries?: number; maxTeamsPerComputer?: number } = {}) {
  const cloudComputerId = randomUUID();
  const cloudAgentId = randomUUID();
  let currentNow = 1_700_000_000_000;
  let exchangeTeamId = "T1";
  let exchangeRefreshToken: string | undefined = "xoxe-refresh-1";
  let exchangeExp: number | undefined;
  let rotateError: string | undefined;
  let rotateExp: number | undefined;
  let createError: string | undefined;
  let createIncludeAppId = false;
  let loseCreate = false;
  let failCallbacks = false;
  let failInstallError: string | undefined;
  let failNetworkInstall = false;
  let approvalStatus: "pending" | "approved" | "denied" | "cancelled" | undefined;
  let canSelfApprove = false;
  let requireApprovalEligible: string | boolean = false;
  let submittedRequests = 0;
  let remote: Record<string, unknown> = {
    display_information: { name: "QA" },
    settings: { org_deploy_enabled: false },
  };
  const calls: Array<{ method: string; headers: Headers; body: string }> = [];
  const handlers: Record<string, (body: string) => Response> = {
    "apps.hosted.generateAuthTicket": () => Response.json({ ok: true, ticket: "test-ticket" }),
    "apps.hosted.exchangeAuthTicket": (body) => {
      const params = new URLSearchParams(body);
      if (params.get("ticket") !== "test-ticket" || !params.get("challenge")) {
        return Response.json({ ok: false, error: "invalid_arguments" });
      }
      return Response.json({
        ok: true,
        token: "xoxe.xoxp-user-1",
        ...(exchangeRefreshToken ? { refresh_token: exchangeRefreshToken } : {}),
        ...(exchangeExp !== undefined ? { exp: exchangeExp } : {}),
        team_id: exchangeTeamId,
        team_domain: "cloud-team",
      });
    },
    "tooling.tokens.rotate": () =>
      rotateError
        ? Response.json({ ok: false, error: rotateError })
        : Response.json({
            ok: true,
            token: "xoxe.xoxp-user-rotated",
            refresh_token: "xoxe-refresh-2",
            ...(rotateExp !== undefined ? { exp: rotateExp } : {}),
            team_id: "T1",
          }),
    "apps.manifest.validate": () => Response.json({ ok: true }),
    "apps.manifest.create": () => {
      if (loseCreate) return new Response("bad gateway", { status: 502 });
      if (createError) {
        return Response.json({
          ok: false,
          error: createError,
          ...(createIncludeAppId ? { app_id: "A1" } : {}),
        });
      }
      return Response.json({
        ok: true,
        app_id: "A1",
        credentials: { signing_secret: "private-secret" },
      });
    },
    "apps.approvals.requests.list": () =>
      Response.json({
        ok: true,
        requests: approvalStatus ? [{ id: "R1", status: approvalStatus, can_self_approve: canSelfApprove }] : [],
      }),
    "apps.developerInstall": () => {
      if (failNetworkInstall) throw new Error("network EOF private-user-token");
      if (failInstallError) return Response.json({ ok: false, error: failInstallError });
      if (requireApprovalEligible && approvalStatus !== "approved") {
        return Response.json({
          ok: false,
          error: "app_approval_request_eligible",
          ...(typeof requireApprovalEligible === "string" ? { team_id: requireApprovalEligible } : {}),
        });
      }
      return Response.json({
        ok: true,
        api_access_tokens: { bot: "private-token" },
      });
    },
    "apps.approvals.requests.create": () => {
      submittedRequests += 1;
      approvalStatus = "pending";
      return Response.json({ ok: true });
    },
    "auth.test": () => Response.json({ ok: true, team_id: "T1", user_id: "U1", app_id: "A1" }),
    "apps.manifest.export": () => Response.json({ ok: true, manifest: remote }),
    "apps.manifest.update": (body) => {
      if (failCallbacks) return Response.json({ ok: false, error: "invalid_manifest" });
      remote = JSON.parse((JSON.parse(body) as { manifest: string }).manifest) as Record<string, unknown>;
      return Response.json({ ok: true });
    },
  };
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    const method = url.replace("https://slack.com/api/", "");
    const headers = new Headers(init?.headers);
    const body = String(init?.body ?? "");
    calls.push({ method, headers, body });
    const handler = handlers[method];
    if (!handler) throw new Error(`Unexpected Slack method: ${method}`);
    return handler(body);
  });
  const owner = new CloudSlackAutoSetupOwner({
    fetchImpl,
    now: () => currentNow,
    ...options,
  });
  const run = (input: SlackAutoSetupCommand) =>
    owner.start({ computerId: cloudComputerId, agentId: cloudAgentId, input });
  const authorize = async () => {
    expect(await run({ action: "authorize", force: true })).toEqual({
      status: "authorization_required",
      ticket: "test-ticket",
    });
  };
  return {
    owner,
    run,
    authorize,
    calls,
    fetchImpl,
    cloudComputerId,
    cloudAgentId,
    now: () => currentNow,
    advanceTimeMs: (deltaMs: number) => {
      currentNow += deltaMs;
    },
    setExchangeTeamId: (value: string) => {
      exchangeTeamId = value;
    },
    setExchangeRefreshToken: (value: string | undefined) => {
      exchangeRefreshToken = value;
    },
    setExchangeExp: (value: number | undefined) => {
      exchangeExp = value;
    },
    setRotateError: (value: string | undefined) => {
      rotateError = value;
    },
    setRotateExp: (value: number | undefined) => {
      rotateExp = value;
    },
    setCreateError: (value: string | undefined, includeAppId = false) => {
      createError = value;
      createIncludeAppId = includeAppId;
    },
    loseCreate: () => {
      loseCreate = true;
    },
    setFailCallbacks: (value: boolean) => {
      failCallbacks = value;
    },
    setFailInstallError: (value: string | undefined) => {
      failInstallError = value;
    },
    setFailNetworkInstall: (value: boolean) => {
      failNetworkInstall = value;
    },
    setApprovalStatus: (value: typeof approvalStatus) => {
      approvalStatus = value;
    },
    allowSelfApproval: () => {
      canSelfApprove = true;
    },
    requireApproval: (teamId: string | boolean = "T1") => {
      requireApprovalEligible = teamId;
    },
    submittedRequests: () => submittedRequests,
  };
}
function callbacksCommand(
  appId = "A1",
  teamId = "T1",
  challenge?: string,
): Extract<SlackAutoSetupCommand, { action: "callbacks" }> {
  return {
    action: "callbacks",
    appId,
    teamId,
    botUserId: "U1",
    enterpriseId: null,
    ...(challenge ? { challenge } : {}),
    eventsUrl: "https://qa.example/events",
    interactionsUrl: "https://qa.example/interactions",
  };
}

it("Cloud owner completes ticket exchange, token rotation, app creation, approval request, install, and callbacks", async () => {
  const f = cloudFixture();
  await f.authorize();
  expect(f.calls[0]?.body).toBe("slack_cli_version=4.10.0");
  f.requireApproval("E12345");
  const pending = { status: "approval_pending", appId: "A1", teamId: "T1" };
  expect(await f.run({ action: "install", displayName: "QA", challenge: "code" })).toEqual(pending);
  expect(f.submittedRequests()).toBe(1);
  const approvalCreate = JSON.parse(
    f.calls.find((call) => call.method === "apps.approvals.requests.create")?.body ?? "{}",
  );
  expect(approvalCreate).toEqual({
    app: "A1",
    bot_scopes: SLACK_REQUIRED_BOT_SCOPES.join(","),
    reason: "This request has been automatically generated according to project environment settings.",
    domains: [],
  });
  // Retry while pending does not call developerInstall or submit another request, and rotates the stored token.
  expect(await f.run({ action: "install", displayName: "QA" })).toEqual(pending);
  expect(f.submittedRequests()).toBe(1);
  expect(f.calls.filter((call) => call.method === "tooling.tokens.rotate")).toHaveLength(1);
  expect(f.calls.filter((call) => call.method === "apps.developerInstall")).toHaveLength(1);

  f.setApprovalStatus("approved");
  expect(await f.run({ action: "install", displayName: "QA" })).toEqual({
    status: "installed",
    credentials,
  });
  expect(await f.run({ action: "authorize" })).toEqual({
    status: "authorized",
    teamName: "cloud-team",
  });
  expect(await f.run(callbacksCommand())).toEqual({ status: "connected" });
  expect(f.calls.filter((call) => call.method === "apps.manifest.create")).toHaveLength(1);
  const updateCall = JSON.parse(f.calls.find((call) => call.method === "apps.manifest.update")?.body ?? "{}") as {
    app_id: string;
    manifest: string;
  };
  const updatedManifest = JSON.parse(updateCall.manifest);
  expect(updatedManifest.settings.event_subscriptions).toEqual({
    request_url: "https://qa.example/events",
    bot_events: SLACK_SUBSCRIBED_BOT_EVENTS,
  });
  expect(updatedManifest.settings.interactivity).toEqual({
    is_enabled: true,
    request_url: "https://qa.example/interactions",
  });
  // Completed callbacks remove signingSecret while keeping the secret-free creation fence so callbacks can retry and install directs to manual_required.
  expect(await f.run(callbacksCommand())).toEqual({ status: "connected" });
  expect(await f.run({ action: "install", displayName: "QA" })).toEqual({
    status: "failed",
    code: "manual_required",
  });
});

it("Cloud owner skips token rotation while exp is fresh and rotates when near or past exp", async () => {
  const f = cloudFixture();
  const baseSeconds = Math.floor(f.now() / 1_000);
  f.setExchangeExp(baseSeconds + 3_600);
  f.setRotateExp(baseSeconds + 7_200);
  await f.authorize();
  expect(await f.run({ action: "install", displayName: "QA", challenge: "code" })).toEqual({
    status: "installed",
    credentials,
  });
  // Still well before exp - 300s: callbacks step skips tooling.tokens.rotate.
  f.advanceTimeMs(3_000 * 1_000);
  expect(await f.run(callbacksCommand())).toEqual({ status: "connected" });
  expect(f.calls.filter((call) => call.method === "tooling.tokens.rotate")).toHaveLength(0);

  // Within the 300s rotation window (baseSeconds + 3350s >= exp - 300s): rotates once and updates exp.
  f.advanceTimeMs(350 * 1_000);
  expect(await f.run(callbacksCommand())).toEqual({ status: "connected" });
  expect(f.calls.filter((call) => call.method === "tooling.tokens.rotate")).toHaveLength(1);
});

it("Cloud owner preserves unresolved creation fences across 24h TTL expiry, 4,100-entry capacity pressure, and production-constructor restarts", async () => {
  const f = cloudFixture({ ttlMs: 10_000, maxEntries: 4 });
  await f.authorize();
  f.requireApproval("T1");
  expect(await f.run({ action: "install", displayName: "QA", challenge: "code" })).toEqual({
    status: "approval_pending",
    appId: "A1",
    teamId: "T1",
  });

  // 4,100 authorize-only and connected projects must never capacity-evict A1's unresolved approval_pending fence.
  f.requireApproval(false);
  for (let i = 0; i < 4_100; i += 1) {
    const otherComputerId = randomUUID();
    const otherAgentId = randomUUID();
    await f.owner.start({
      computerId: otherComputerId,
      agentId: otherAgentId,
      input: { action: "authorize", force: true },
    });
    if (i < 16) {
      await f.owner.start({
        computerId: otherComputerId,
        agentId: otherAgentId,
        input: { action: "install", displayName: "QA", challenge: "code" },
      });
      await f.owner.start({
        computerId: otherComputerId,
        agentId: otherAgentId,
        input: callbacksCommand(),
      });
    }
  }

  // A1's unresolved fence and secret are still retained across all 4,100 other projects, and once approved, A1 installs without a second manifest.create.
  expect(await f.run({ action: "authorize" })).toEqual({
    status: "approval_pending",
    appId: "A1",
    teamId: "T1",
  });
  const createCallsBefore = f.calls.filter((call) => call.method === "apps.manifest.create").length;
  f.setApprovalStatus("approved");
  expect(await f.run({ action: "authorize", force: true })).toEqual({
    status: "authorization_required",
    ticket: "test-ticket",
  });
  expect(await f.run({ action: "install", displayName: "QA", challenge: "code" })).toEqual({
    status: "installed",
    credentials,
  });
  expect(f.calls.filter((call) => call.method === "apps.manifest.create")).toHaveLength(createCallsBefore);

  // Now test 24h TTL expiry during approval_pending on another Agent: secrets expire, but the fence prevents A2 creation.
  const idleAgentId = randomUUID();
  const runIdle = (input: SlackAutoSetupCommand) =>
    f.owner.start({ computerId: f.cloudComputerId, agentId: idleAgentId, input });
  f.setApprovalStatus(undefined);
  f.requireApproval("T1");
  expect(await runIdle({ action: "authorize", force: true })).toEqual({
    status: "authorization_required",
    ticket: "test-ticket",
  });
  expect(await runIdle({ action: "install", displayName: "QA", challenge: "code" })).toEqual({
    status: "approval_pending",
    appId: "A1",
    teamId: "T1",
  });
  expect(f.calls.filter((call) => call.method === "apps.manifest.create")).toHaveLength(createCallsBefore + 1);

  // Advance past ttlMs: login and signingSecret expire, but the creation fence stays and directs to manual_required.
  f.advanceTimeMs(11_000);
  expect(await runIdle({ action: "authorize" })).toEqual({
    status: "failed",
    code: "manual_required",
    appId: "A1",
    teamId: "T1",
  });
  expect(await runIdle({ action: "authorize", force: true })).toEqual({
    status: "authorization_required",
    ticket: "test-ticket",
  });
  expect(await runIdle({ action: "install", displayName: "QA", challenge: "code" })).toEqual({
    status: "failed",
    code: "manual_required",
  });
  expect(f.calls.filter((call) => call.method === "apps.manifest.create")).toHaveLength(createCallsBefore + 1);

  // Production constructor (no options, genuinely fresh backing store) after restart:
  // Both unforced authorize (fresh browser reload) and unchallenged install (Continue) fail closed to manual_required.
  vi.stubGlobal("fetch", f.fetchImpl);
  try {
    const restarted = new CloudSlackAutoSetupOwner();
    const runRestarted = (input: SlackAutoSetupCommand) =>
      restarted.start({ computerId: f.cloudComputerId, agentId: f.cloudAgentId, input });
    expect(await runRestarted({ action: "authorize" })).toEqual({
      status: "failed",
      code: "manual_required",
    });
    expect(await runRestarted({ action: "install", displayName: "QA" })).toEqual({
      status: "failed",
      code: "manual_required",
    });
    // Because unchallenged install fenced the restarted project as uncertain, even a subsequent forced authorize/install cannot create A2.
    expect(await runRestarted({ action: "authorize", force: true })).toEqual({
      status: "failed",
      code: "create_uncertain",
    });
    expect(await runRestarted({ action: "install", displayName: "QA", challenge: "code" })).toEqual({
      status: "failed",
      code: "create_uncertain",
    });
    expect(f.calls.filter((call) => call.method === "apps.manifest.create")).toHaveLength(createCallsBefore + 1);
  } finally {
    vi.unstubAllGlobals();
  }
});

it("Cloud owner prunes expired and excess login/transient entries and bounds teams per Computer", async () => {
  const f = cloudFixture({ ttlMs: 10_000, maxEntries: 2, maxTeamsPerComputer: 2 });
  const c1 = randomUUID(),
    c2 = randomUUID(),
    c3 = randomUUID();
  const a1 = randomUUID(),
    a2 = randomUUID(),
    a3 = randomUUID();

  // Populate two transient authorize-only projects on c1; touching c1:a1 and adding c1:a3 evicts c1:a2.
  expect(await f.owner.start({ computerId: c1, agentId: a1, input: { action: "authorize", force: true } })).toEqual({
    status: "authorization_required",
    ticket: "test-ticket",
  });
  expect(await f.owner.start({ computerId: c1, agentId: a2, input: { action: "authorize", force: true } })).toEqual({
    status: "authorization_required",
    ticket: "test-ticket",
  });
  expect(await f.owner.start({ computerId: c1, agentId: a1, input: { action: "authorize", force: true } })).toEqual({
    status: "authorization_required",
    ticket: "test-ticket",
  });
  expect(await f.owner.start({ computerId: c1, agentId: a3, input: { action: "authorize", force: true } })).toEqual({
    status: "authorization_required",
    ticket: "test-ticket",
  });
  expect(
    await f.owner.start({
      computerId: c1,
      agentId: a2,
      input: { action: "install", displayName: "QA", challenge: "code" },
    }),
  ).toEqual({ status: "failed", code: "authorization_failed" });

  // Bound teams per Computer (maxTeamsPerComputer = 2): exchanging T1, T2, T3 on c1 evicts T1.
  for (const [agent, team] of [
    [a1, "T1"],
    [a2, "T2"],
    [a3, "T3"],
  ] as const) {
    f.setExchangeTeamId(team);
    await f.owner.start({ computerId: c1, agentId: agent, input: { action: "authorize", force: true } });
    await f.owner.start({
      computerId: c1,
      agentId: agent,
      input: { action: "install", displayName: "QA", challenge: "code" },
    });
  }
  // T1 was evicted when T3 was added on c1, while T3 remains authorized.
  expect(await f.owner.start({ computerId: c1, agentId: a1, input: { action: "authorize" } })).toEqual({
    status: "failed",
    code: "manual_required",
    appId: "A1",
    teamId: "T1",
  });
  expect(await f.owner.start({ computerId: c1, agentId: a3, input: { action: "authorize" } })).toEqual({
    status: "authorized",
    teamName: "cloud-team",
  });

  // Evict c1's outer login entry by touching c2 and c3 (maxEntries = 2 on #logins).
  await f.owner.start({ computerId: c2, agentId: a2, input: { action: "authorize", force: true } });
  await f.owner.start({ computerId: c3, agentId: a3, input: { action: "authorize", force: true } });
  expect(await f.owner.start({ computerId: c1, agentId: a3, input: { action: "authorize", force: true } })).toEqual({
    status: "authorization_required",
    ticket: "test-ticket",
  });
});

it("Cloud owner includes non-enterprise team_id in approval creation and respects self-approval and denial", async () => {
  const f = cloudFixture();
  await f.authorize();
  f.requireApproval("T1");
  expect(await f.run({ action: "install", displayName: "QA", challenge: "code" })).toEqual({
    status: "approval_pending",
    appId: "A1",
    teamId: "T1",
  });
  const approvalCreate = JSON.parse(
    f.calls.find((call) => call.method === "apps.approvals.requests.create")?.body ?? "{}",
  );
  expect(approvalCreate.team_id).toBe("T1");

  f.setApprovalStatus("denied");
  expect(await f.run({ action: "install", displayName: "QA" })).toEqual({
    status: "failed",
    code: "approval_denied",
    appId: "A1",
    teamId: "T1",
  });

  // Historical denied request with can_self_approve allows installation once developerInstall succeeds.
  f.allowSelfApproval();
  f.requireApproval(false);
  expect(await f.run({ action: "install", displayName: "QA" })).toEqual({
    status: "installed",
    credentials,
  });
});

it.each([
  ["app_approval_request_pending", { status: "approval_pending", appId: "A1", teamId: "T1" }],
  [
    "app_approval_request_denied",
    {
      status: "failed",
      code: "approval_denied",
      appId: "A1",
      teamId: "T1",
      errorCode: "app_approval_request_denied",
    },
  ],
  [
    "comment_required",
    {
      status: "failed",
      code: "install_failed",
      appId: "A1",
      teamId: "T1",
      errorCode: "comment_required",
    },
  ],
] as const)("Cloud owner maps developerInstall %s response", async (error, expected) => {
  const f = cloudFixture();
  await f.authorize();
  f.setFailInstallError(error);
  expect(await f.run({ action: "install", displayName: "QA", challenge: "code" })).toEqual(expected);
});

it("Cloud owner recovers from network install failure without recreating the App or leaking secrets", async () => {
  const f = cloudFixture();
  await f.authorize();
  f.setFailNetworkInstall(true);
  const failed = await f.run({ action: "install", displayName: "QA", challenge: "code" });
  expect(failed).toEqual({
    status: "failed",
    code: "install_failed",
    errorCode: "http_request_failed",
    appId: "A1",
    teamId: "T1",
  });
  expect(JSON.stringify(failed)).not.toContain("private-user-token");
  f.setFailNetworkInstall(false);
  expect(await f.run({ action: "install", displayName: "QA" })).toEqual({
    status: "installed",
    credentials,
  });
  expect(f.calls.filter((call) => call.method === "apps.manifest.create")).toHaveLength(1);
});

it.each(["invalid_manifest", "managed_app_limit_reached", "ratelimited", "access_denied"])(
  "Cloud owner allows a retry after documented pre-creation rejection %s",
  async (error) => {
    const f = cloudFixture();
    await f.authorize();
    f.setCreateError(error);
    expect(await f.run({ action: "install", displayName: "QA", challenge: "code" })).toEqual({
      status: "failed",
      code: "create_failed",
      ...(error !== "managed_app_limit_reached" ? { errorCode: error } : {}),
    });
    f.setCreateError(undefined);
    expect(await f.run({ action: "install", displayName: "QA" })).toEqual({
      status: "installed",
      credentials,
    });
    expect(f.calls.filter((call) => call.method === "apps.manifest.create")).toHaveLength(2);
  },
);

it.each([
  ["internal_error", false],
  ["invalid_manifest", true],
] as const)("Cloud owner fences uncertain creation (%s, app_id=%s)", async (error, includeAppId) => {
  const f = cloudFixture();
  await f.authorize();
  f.setCreateError(error, includeAppId);
  expect(await f.run({ action: "install", displayName: "QA", challenge: "code" })).toEqual({
    status: "failed",
    code: "create_uncertain",
    ...(includeAppId ? { errorCode: "invalid_manifest" } : {}),
  });
  f.setCreateError(undefined);
  expect(await f.run({ action: "install", displayName: "QA" })).toEqual({
    status: "failed",
    code: "create_uncertain",
  });
  expect(f.calls.filter((call) => call.method === "apps.manifest.create")).toHaveLength(1);
});

it("Cloud owner fences network failure during creation, foreign callbacks, and reauthorization team mismatch", async () => {
  const f = cloudFixture();
  expect(await f.run(callbacksCommand())).toEqual({ status: "failed", code: "manual_required" });
  await f.authorize();
  await f.run({ action: "install", displayName: "QA", challenge: "code" });
  expect(await f.run(callbacksCommand("foreign"))).toEqual({ status: "failed", code: "manual_required" });

  // Force reauthorize preserves expected teamId and rejects another workspace.
  expect(await f.run({ action: "authorize", force: true })).toEqual({
    status: "authorization_required",
    ticket: "test-ticket",
  });
  f.setExchangeTeamId("wrong-team");
  expect(await f.run(callbacksCommand("A1", "T1", "new-code"))).toEqual({
    status: "failed",
    code: "authorization_failed",
  });
  f.setExchangeTeamId("T1");
  f.setFailCallbacks(true);
  expect(await f.run(callbacksCommand("A1", "T1", "valid-code"))).toEqual({
    status: "failed",
    code: "callbacks_failed",
    errorCode: "invalid_manifest",
  });
  // Creation secret was cleared once callbacks verified App and Team, even though update failed.
  expect(await f.run({ action: "install", displayName: "QA" })).toEqual({
    status: "failed",
    code: "manual_required",
  });
  f.setFailCallbacks(false);
  expect(await f.run(callbacksCommand("A1", "T1"))).toEqual({ status: "connected" });
});

it("Cloud owner enforces per-Computer single-flight, 32-request cap, and close()", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const owner = new CloudSlackAutoSetupOwner({
    fetchImpl: async () => {
      await gate;
      return Response.json({ ok: true, ticket: "ticket" });
    },
  });
  const first = owner.start({ computerId, agentId, input: { action: "authorize", force: true } });
  expect(await owner.start({ computerId, agentId, input: { action: "authorize", force: true } })).toEqual({
    status: "failed",
    code: "busy",
  });
  const others = Array.from({ length: 31 }, () =>
    owner.start({ computerId: randomUUID(), agentId, input: { action: "authorize", force: true } }),
  );
  expect(await owner.start({ computerId: randomUUID(), agentId, input: { action: "authorize", force: true } })).toEqual(
    {
      status: "failed",
      code: "busy",
    },
  );
  owner.close();
  expect(await first).toEqual({ status: "failed", code: "computer_unavailable" });
  for (const pending of others) {
    expect(await pending).toEqual({ status: "failed", code: "computer_unavailable" });
  }
  release();
});

it("Cloud owner fences late settlement of a timed-out request so a subsequent request on the same Computer stays tracked", async () => {
  vi.useFakeTimers();
  const deferreds: Array<() => void> = [];
  const owner = new CloudSlackAutoSetupOwner({
    timeoutMs: 1_000,
    callTimeoutMs: 60_000,
    fetchImpl: async () => {
      await new Promise<void>((resolve) => {
        deferreds.push(resolve);
      });
      return Response.json({ ok: true, ticket: `ticket-${deferreds.length}` });
    },
  });
  const targetComputerId = randomUUID();
  const targetAgentId = randomUUID();

  // Start request 1 and advance past its 1000ms timeout while its fetch remains unresolved.
  const first = owner.start({
    computerId: targetComputerId,
    agentId: targetAgentId,
    input: { action: "authorize", force: true },
  });
  await vi.advanceTimersByTimeAsync(1_000);
  expect(await first).toEqual({ status: "failed", code: "computer_unavailable" });

  // Start request 2 on the same computerId, then let request 1's fetch resolve late.
  const second = owner.start({
    computerId: targetComputerId,
    agentId: targetAgentId,
    input: { action: "authorize", force: true },
  });
  deferreds[0]?.();
  await Promise.resolve();
  await Promise.resolve();

  // Request 2 must still own the pending slot (a 3rd concurrent request returns busy) and resolve when its fetch completes.
  expect(
    await owner.start({
      computerId: targetComputerId,
      agentId: targetAgentId,
      input: { action: "authorize", force: true },
    }),
  ).toEqual({ status: "failed", code: "busy" });
  deferreds[1]?.();
  expect(await second).toEqual({ status: "authorization_required", ticket: "ticket-2" });
});
