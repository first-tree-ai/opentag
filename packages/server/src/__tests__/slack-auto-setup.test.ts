import { randomUUID } from "node:crypto";
import type { AgentAdminConfig, SlackConfigurationView } from "@opentag/shared";
import { afterEach, expect, it, vi } from "vitest";
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
it("does not bind if the Agent moved Computers during installation", async () => {
  const f = fixture();
  f.agents.getConfigById
    .mockResolvedValueOnce({ computerId } as AgentAdminConfig)
    .mockResolvedValue({ computerId: randomUUID() } as AgentAdminConfig);
  await expect(f.service.run("account", agentId, { action: "connect", challenge: "code" })).rejects.toThrow("moved");
  expect(f.slack.configureToken).not.toHaveBeenCalled();
  expect(f.owner.start).toHaveBeenCalledTimes(1);
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
