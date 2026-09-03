/**
 * The exact-Agent setup read projection, exercised against the embedded engine.
 *
 * The projection is pure SQL plus in-memory readiness sources: the authoritative Agent row, the
 * exact Computer binding and its reachability, the exact runtime Provider readiness, and the
 * Agent-owned Messaging binding with its setup attempt or handoff. Every scenario also parses the
 * produced snapshot against the shared contract, so stage, blockers, and actions cannot drift from
 * what `AgentSetupSnapshotSchema` considers canonical.
 */

import {
  type AgentSetupSnapshot,
  AgentSetupSnapshotSchema,
  FEISHU_REQUIRED_TENANT_SCOPES,
  type ImCliReadinessStatus,
  type IntegrationCredentialExecutionStatus,
  type ProviderReadinessStatus,
  SLACK_REQUIRED_BOT_SCOPES,
} from "@opentag/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createUnitDatabase, type UnitDatabase } from "../../../__tests__/support/unit-database.js";
import { bootstrapInitialAdmin as bootstrapTestAccount } from "../../../admin/bootstrap.js";
import { computers, imBindings, slackInstallations, users } from "../../../db/schema/index.js";
import type { ProviderReadinessSource } from "../../computers/index.js";
import { ApplicationCipher } from "../../crypto.js";
import type { FeishuRegistration, FeishuRegistrationGateway } from "../../im-bindings/feishu/index.js";
import { FeishuSetupService } from "../../im-bindings/feishu/index.js";
import { ImBindingService } from "../../im-bindings/index.js";
import { AgentSetupService } from "../agent-setup-service.js";
import { AgentService, AgentServiceError } from "../index.js";

const NOW = new Date("2026-09-01T10:00:00.000Z");
const NOW_ISO = "2026-09-01T10:00:00.000Z";
const FEISHU_INSTANCE_ID = "77777777-7777-4777-8777-777777777777";

let unitDatabase: UnitDatabase;

beforeAll(async () => {
  unitDatabase = await createUnitDatabase();
}, 60_000);

afterAll(async () => {
  await unitDatabase?.close();
});

beforeEach(async () => {
  await unitDatabase.reset();
});

async function account(email = "admin@example.com") {
  return bootstrapTestAccount(unitDatabase.database, { displayName: "Admin", email });
}

async function otherAccount(email = "other@example.com") {
  const [user] = await unitDatabase.database
    .insert(users)
    .values({ displayName: "Other", email })
    .returning({ id: users.id });
  if (!user) throw new Error("Other Account fixture was not created");
  return { userId: user.id };
}

async function createComputer(ownerAccountId: string, options: { online?: boolean; lastSeenAt?: Date } = {}) {
  const online = options.online ?? false;
  const [computer] = await unitDatabase.database
    .insert(computers)
    .values({
      ownerAccountId,
      currentInstallationId: crypto.randomUUID(),
      displayName: "workstation",
      platform: "linux" as const,
      arch: "x64",
      clientVersion: "0.0.2",
      currentInstanceId: online ? crypto.randomUUID() : null,
      lastSeenAt: online ? (options.lastSeenAt ?? NOW) : null,
    })
    .returning();
  if (!computer) throw new Error("Computer fixture was not created");
  return computer;
}

function runtimeReadiness(
  status: ProviderReadinessStatus,
  observedAt = NOW.getTime() - 5_000,
): ProviderReadinessSource {
  return {
    providerReadiness: () => [{ observation: { provider: "codex", status }, observedAt }],
  };
}

interface HarnessOptions {
  runtimeReadiness?: ProviderReadinessSource;
  agentRuntimeReadiness?: ProviderReadinessStatus;
  imCliReadiness?: ImCliReadinessStatus;
  credentialExecutionReadiness?: { status: IntegrationCredentialExecutionStatus };
  registrations?: FeishuRegistrationGateway;
  slackOAuthAvailable?: boolean;
}

function harness(options: HarnessOptions = {}) {
  const cipher = new ApplicationCipher(Buffer.alloc(32, 7));
  const imBindingService = new ImBindingService(unitDatabase.database, cipher, {
    now: () => NOW,
    agentRuntimeReadiness: () => options.agentRuntimeReadiness ?? "ready",
    imCliReadiness: () => options.imCliReadiness ?? "checking",
    credentialExecutionReadiness: () => options.credentialExecutionReadiness ?? { status: "unconfirmed" },
  });
  const feishuSetup = new FeishuSetupService({
    database: unitDatabase.database,
    cipher,
    instanceId: FEISHU_INSTANCE_ID,
    imBindings: imBindingService,
    registrations: options.registrations ?? {
      start: () => {
        throw new Error("The scenario did not expect a Feishu registration");
      },
    },
    activation: { activateAtomicAttempt: vi.fn() },
  });
  const agentService = new AgentService(unitDatabase.database, { now: () => NOW });
  const service = new AgentSetupService(unitDatabase.database, agentService, imBindingService, feishuSetup, {
    now: () => NOW,
    providerReadiness: options.runtimeReadiness,
    slackOAuthAvailable: options.slackOAuthAvailable,
  });
  return { agentService, feishuSetup, imBindingService, service };
}

function registrationGateway(qrExpiresAt: Date): FeishuRegistrationGateway {
  return {
    start: vi.fn((): FeishuRegistration => {
      return {
        qrReady: Promise.resolve({ url: "https://accounts.feishu.cn/device", expiresAt: qrExpiresAt }),
        // The Account never finishes authorizing inside a projection test.
        result: new Promise(() => undefined),
        abort: vi.fn(),
      };
    }),
  };
}

async function boundAgent(
  userId: string,
  options: { online?: boolean; name?: string } = {},
): Promise<{ agentId: string; computerId: string }> {
  const computer = await createComputer(userId, { online: options.online });
  const created = await new AgentService(unitDatabase.database, { now: () => NOW }).createForAccount(userId, {
    name: options.name ?? "reviewer",
    displayName: "Reviewer",
    runtimeProvider: "codex",
    computerId: computer.id,
  });
  return { agentId: created.id, computerId: computer.id };
}

async function activateSlackBinding(
  imBindingService: ImBindingService,
  agentId: string,
): Promise<{ imBindingId: string }> {
  const activated = await imBindingService.activateSlack(
    {
      intent: "create",
      agentId,
      appId: "A_OPENTAG",
      teamId: "T_TEAM",
      botUserId: "U_BOT",
      grantedBotScopes: [...SLACK_REQUIRED_BOT_SCOPES],
      botAccessToken: "xoxb-secret",
      signingSecret: "signing-secret",
      installedAt: NOW,
    },
    "B_BOT",
  );
  return { imBindingId: activated.imBindingId };
}

async function activateFeishuBinding(
  imBindingService: ImBindingService,
  agentId: string,
): Promise<{ imBindingId: string }> {
  const imBindingId = await imBindingService.activateFeishu({
    agentId,
    appId: "cli_app",
    appSecret: "secret",
    teamId: "T_TEAM",
    botOpenId: "ou_bot",
    grantedScopes: [...FEISHU_REQUIRED_TENANT_SCOPES],
  });
  return { imBindingId };
}

async function observeFeishuConnection(imBindingId: string): Promise<void> {
  await unitDatabase.database
    .update(imBindings)
    .set({
      connectionOwnerInstanceId: crypto.randomUUID(),
      connectionLeaseExpiresAt: new Date(NOW.getTime() + 60_000),
      observedConnectedAt: NOW,
      observedAt: NOW,
    })
    .where(eq(imBindings.id, imBindingId));
}

async function observeSlackConnection(agentId: string): Promise<void> {
  await unitDatabase.database
    .update(slackInstallations)
    .set({ observedConnectedAt: NOW, observedAt: NOW })
    .where(eq(slackInstallations.agentId, agentId));
}

function expectContractValid(snapshot: AgentSetupSnapshot): void {
  expect(AgentSetupSnapshotSchema.parse(snapshot)).toEqual(snapshot);
}

describe("Agent setup projection ownership", () => {
  it("serves only the exact Account-owned Agent named by the path", async () => {
    const bootstrap = await account();
    const other = await otherAccount();
    const { service } = harness();
    const { agentId } = await boundAgent(bootstrap.userId);

    const snapshot = await service.getSetupById(bootstrap.userId, agentId);
    expect(snapshot.agent.id).toBe(agentId);
    expect(snapshot.observedAt).toBe(NOW_ISO);

    await expect(service.getSetupById(other.userId, agentId)).rejects.toMatchObject({
      code: "RESOURCE_NOT_FOUND",
      statusCode: 404,
    });
    await expect(service.getSetupById(bootstrap.userId, crypto.randomUUID())).rejects.toMatchObject({
      code: "RESOURCE_NOT_FOUND",
      statusCode: 404,
    });
  });

  it("refuses a suspended Agent, and a deleted Agent reads as absent", async () => {
    const bootstrap = await account();
    const { agentService, service } = harness();
    const { agentId } = await boundAgent(bootstrap.userId);

    await agentService.suspendById(bootstrap.userId, agentId);
    await expect(service.getSetupById(bootstrap.userId, agentId)).rejects.toMatchObject({
      code: "AGENT_LIFECYCLE_CONFLICT",
      statusCode: 409,
    });

    await agentService.deleteById(bootstrap.userId, agentId);
    await expect(service.getSetupById(bootstrap.userId, agentId)).rejects.toMatchObject({
      code: "RESOURCE_NOT_FOUND",
      statusCode: 404,
    });
    await expect(agentService.getById(bootstrap.userId, agentId)).rejects.toBeInstanceOf(AgentServiceError);
  });

  it("fails closed when the exact Agent is suspended during snapshot observation", async () => {
    const bootstrap = await account();
    const { agentService, feishuSetup } = harness();
    const { agentId } = await boundAgent(bootstrap.userId, { online: true });
    const service = new AgentSetupService(
      unitDatabase.database,
      agentService,
      {
        getSetupBindingForAgent: async () => {
          await agentService.suspendById(bootstrap.userId, agentId);
          return undefined;
        },
      },
      feishuSetup,
      { now: () => NOW, providerReadiness: runtimeReadiness("ready") },
    );

    await expect(service.getSetupById(bootstrap.userId, agentId)).rejects.toMatchObject({
      code: "AGENT_LIFECYCLE_CONFLICT",
      statusCode: 409,
    });
  });
});

describe("Agent setup projection Computer states", () => {
  it("reports an unbound Agent as needing a Computer, which is a legal state", async () => {
    const bootstrap = await account();
    const { service } = harness();
    const created = await new AgentService(unitDatabase.database, { now: () => NOW }).createForAccount(
      bootstrap.userId,
      { name: "assistant", displayName: "Assistant", runtimeProvider: "codex" },
    );

    const snapshot = await service.getSetupById(bootstrap.userId, created.id);
    expectContractValid(snapshot);
    expect(snapshot).toMatchObject({
      stage: "needs-computer",
      computer: { kind: "not-bound" },
      runtime: { kind: "unavailable", provider: "codex", reason: "computer-not-bound" },
      messaging: { kind: "not-configured" },
      blockers: [{ code: "computer-not-bound" }],
      actions: [{ kind: "bind-computer" }],
      observedAt: NOW_ISO,
    });
  });

  it("keeps the identity of a Computer that requires rebind instead of reporting it as bound", async () => {
    const bootstrap = await account();
    const other = await otherAccount();
    const { service } = harness();
    const { agentId, computerId } = await boundAgent(bootstrap.userId);
    await unitDatabase.database
      .update(computers)
      .set({ ownerAccountId: other.userId })
      .where(eq(computers.id, computerId));

    const snapshot = await service.getSetupById(bootstrap.userId, agentId);
    expectContractValid(snapshot);
    expect(snapshot.agent.requiresComputerRebind).toBe(true);
    expect(snapshot).toMatchObject({
      stage: "needs-computer",
      computer: { kind: "requires-rebind", computerId, displayName: "workstation", platform: "linux" },
      runtime: { kind: "unavailable", provider: "codex", reason: "computer-rebind-required" },
      blockers: [{ code: "computer-rebind-required" }],
      actions: [{ kind: "bind-computer" }],
    });
  });

  it("makes a stale heartbeat authoritative over the last observed runtime and Messaging state", async () => {
    const bootstrap = await account();
    const { imBindingService, service } = harness({
      runtimeReadiness: runtimeReadiness("ready"),
      imCliReadiness: "ready",
      credentialExecutionReadiness: { status: "ready" },
    });
    const { agentId, computerId } = await boundAgent(bootstrap.userId, { online: true });
    const { imBindingId } = await activateSlackBinding(imBindingService, agentId);
    await observeSlackConnection(agentId);
    // The Computer was seen long enough ago that presence has lapsed even though an instance id remains.
    await unitDatabase.database
      .update(computers)
      .set({ lastSeenAt: new Date(NOW.getTime() - 120_000) })
      .where(eq(computers.id, computerId));

    const snapshot = await service.getSetupById(bootstrap.userId, agentId);
    expectContractValid(snapshot);
    expect(snapshot).toMatchObject({
      stage: "needs-computer",
      computer: {
        kind: "bound",
        computerId,
        connectionStatus: "offline",
        lastSeenAt: new Date(NOW.getTime() - 120_000).toISOString(),
        observedAt: NOW_ISO,
      },
      runtime: { kind: "unavailable", provider: "codex", reason: "computer-offline" },
      messaging: { kind: "ready", provider: "slack", bindingId: imBindingId },
      blockers: [{ code: "computer-offline", computerId }],
      actions: [{ kind: "refresh" }, { kind: "repair-computer", computerId }],
    });
  });
});

describe("Agent setup projection runtime readiness", () => {
  it("turns a persistent runtime observation failure into a structured retry blocker", async () => {
    const bootstrap = await account();
    const { service } = harness({
      runtimeReadiness: {
        providerReadiness: () => {
          throw new Error("runtime observer unavailable");
        },
      },
    });
    const { agentId } = await boundAgent(bootstrap.userId, { online: true });

    const snapshot = await service.getSetupById(bootstrap.userId, agentId);
    expectContractValid(snapshot);
    expect(snapshot).toMatchObject({
      stage: "needs-runtime",
      runtime: { kind: "observation-failed", provider: "codex" },
      blockers: [{ code: "resource-observation-failed", resource: "runtime" }],
      actions: [{ kind: "refresh" }],
    });
  });

  it.each([
    { name: "no observation yet", readiness: undefined, status: "checking", observedAt: null },
    {
      name: "install pending",
      readiness: runtimeReadiness("install"),
      status: "install",
      observedAt: "2026-09-01T09:59:55.000Z",
    },
    {
      name: "sign-in pending",
      readiness: runtimeReadiness("sign-in"),
      status: "sign-in",
      observedAt: "2026-09-01T09:59:55.000Z",
    },
    {
      name: "Provider unavailable",
      readiness: runtimeReadiness("unavailable"),
      status: "unavailable",
      observedAt: "2026-09-01T09:59:55.000Z",
    },
  ])("projects $name for the exact runtime Provider", async ({ readiness, status, observedAt }) => {
    const bootstrap = await account();
    const { service } = harness({ runtimeReadiness: readiness });
    const { agentId } = await boundAgent(bootstrap.userId, { online: true });

    const snapshot = await service.getSetupById(bootstrap.userId, agentId);
    expectContractValid(snapshot);
    expect(snapshot).toMatchObject({
      stage: "needs-runtime",
      computer: { kind: "bound", connectionStatus: "online" },
      runtime: { kind: "observed", provider: "codex", status, observedAt },
      blockers: [{ code: "runtime-not-ready", provider: "codex", status }],
      actions: [{ kind: "refresh" }],
    });
  });

  it("gates Messaging actions behind runtime readiness even when a binding is already waiting", async () => {
    const bootstrap = await account();
    const { imBindingService, service } = harness({ runtimeReadiness: runtimeReadiness("install") });
    const { agentId } = await boundAgent(bootstrap.userId, { online: true });
    await activateSlackBinding(imBindingService, agentId);

    const snapshot = await service.getSetupById(bootstrap.userId, agentId);
    expectContractValid(snapshot);
    expect(snapshot.stage).toBe("needs-runtime");
    expect(snapshot.messaging).toMatchObject({ kind: "waiting-handoff", provider: "slack" });
    expect(snapshot.blockers).toEqual([{ code: "runtime-not-ready", provider: "codex", status: "install" }]);
    expect(snapshot.actions).toEqual([{ kind: "refresh" }]);
  });
});

describe("Agent setup projection Messaging states", () => {
  async function messagingReadyAgent(userId: string) {
    const { agentId, computerId } = await boundAgent(userId, { online: true });
    return { agentId, computerId };
  }

  it("turns a persistent Messaging observation failure into a structured retry blocker", async () => {
    const bootstrap = await account();
    const { agentService } = harness();
    const { agentId } = await messagingReadyAgent(bootstrap.userId);
    const service = new AgentSetupService(
      unitDatabase.database,
      agentService,
      {
        getSetupBindingForAgent: async () => {
          throw new Error("Messaging observer unavailable");
        },
      },
      { observeForAgent: async () => undefined },
      { now: () => NOW, providerReadiness: runtimeReadiness("ready") },
    );

    const snapshot = await service.getSetupById(bootstrap.userId, agentId);
    expectContractValid(snapshot);
    expect(snapshot).toMatchObject({
      stage: "needs-messaging",
      messaging: { kind: "observation-failed" },
      blockers: [{ code: "resource-observation-failed", resource: "messaging" }],
      actions: [{ kind: "refresh" }],
    });
  });

  it("offers both Providers only while Messaging is not configured", async () => {
    const bootstrap = await account();
    const { service } = harness({ runtimeReadiness: runtimeReadiness("ready") });
    const { agentId } = await messagingReadyAgent(bootstrap.userId);

    const snapshot = await service.getSetupById(bootstrap.userId, agentId);
    expectContractValid(snapshot);
    expect(snapshot).toMatchObject({
      stage: "needs-messaging",
      messaging: { kind: "not-configured" },
      blockers: [{ code: "messaging-not-configured" }],
      actions: [
        { kind: "start-messaging", provider: "slack" },
        { kind: "start-messaging", provider: "feishu" },
      ],
    });
  });

  it("withholds Slack setup when the deployment has no Slack OAuth capability", async () => {
    const bootstrap = await account();
    const { service } = harness({
      runtimeReadiness: runtimeReadiness("ready"),
      slackOAuthAvailable: false,
    });
    const { agentId } = await messagingReadyAgent(bootstrap.userId);

    const snapshot = await service.getSetupById(bootstrap.userId, agentId);
    expectContractValid(snapshot);
    expect(snapshot).toMatchObject({
      stage: "needs-messaging",
      messaging: { kind: "not-configured" },
      actions: [{ kind: "start-messaging", provider: "feishu" }],
    });
  });

  it("names the exact live Feishu attempt while authorization is open", async () => {
    const bootstrap = await account();
    const qrExpiresAt = new Date(Date.now() + 60_000);
    const { feishuSetup, service } = harness({
      runtimeReadiness: runtimeReadiness("ready"),
      registrations: registrationGateway(qrExpiresAt),
    });
    const { agentId } = await messagingReadyAgent(bootstrap.userId);
    const attempt = await feishuSetup.createOrReuse(bootstrap.userId, agentId, "create");

    const snapshot = await service.getSetupById(bootstrap.userId, agentId);
    expectContractValid(snapshot);
    expect(snapshot).toMatchObject({
      stage: "needs-messaging",
      messaging: {
        kind: "authorizing",
        provider: "feishu",
        attemptId: attempt.id,
        qrUrl: "https://accounts.feishu.cn/device",
        expiresAt: qrExpiresAt.toISOString(),
      },
      blockers: [{ code: "messaging-not-ready", provider: "feishu", state: "authorizing" }],
      actions: [{ kind: "cancel-messaging-attempt", provider: "feishu", attemptId: attempt.id }],
    });
  });

  it("projects a live Feishu reauthorization attempt before the binding's prior handoff state", async () => {
    const bootstrap = await account();
    const qrExpiresAt = new Date(Date.now() + 60_000);
    const { feishuSetup, imBindingService, service } = harness({
      runtimeReadiness: runtimeReadiness("ready"),
      registrations: registrationGateway(qrExpiresAt),
    });
    const { agentId } = await messagingReadyAgent(bootstrap.userId);
    const { imBindingId } = await activateFeishuBinding(imBindingService, agentId);
    await unitDatabase.database
      .update(imBindings)
      .set({ status: "error", lastErrorCode: "FEISHU_SCOPE_REAUTH_REQUIRED" })
      .where(eq(imBindings.id, imBindingId));
    const before = await service.getSetupById(bootstrap.userId, agentId);
    if (before.messaging.kind !== "blocked" || before.messaging.credentialGeneration === undefined) {
      throw new Error("Feishu reauthorization fixture did not expose its exact binding generation");
    }

    const attempt = await feishuSetup.createOrReuse(bootstrap.userId, agentId, "reauthorize", {
      kind: "bound",
      provider: "feishu",
      bindingId: imBindingId,
      credentialGeneration: before.messaging.credentialGeneration,
    });
    const snapshot = await service.getSetupById(bootstrap.userId, agentId);

    expectContractValid(snapshot);
    expect(snapshot).toMatchObject({
      stage: "needs-messaging",
      messaging: {
        kind: "authorizing",
        provider: "feishu",
        attemptId: attempt.id,
        qrUrl: "https://accounts.feishu.cn/device",
        expiresAt: qrExpiresAt.toISOString(),
      },
      actions: [{ kind: "cancel-messaging-attempt", provider: "feishu", attemptId: attempt.id }],
    });
  });

  it("fails an attempt whose QR expired instead of projecting it as authorizing", async () => {
    const bootstrap = await account();
    const { feishuSetup, service } = harness({
      runtimeReadiness: runtimeReadiness("ready"),
      registrations: registrationGateway(new Date(Date.now() - 5_000)),
    });
    const { agentId } = await messagingReadyAgent(bootstrap.userId);
    await feishuSetup.createOrReuse(bootstrap.userId, agentId, "create");
    const [binding] = await unitDatabase.database
      .select({ id: imBindings.id })
      .from(imBindings)
      .where(eq(imBindings.agentId, agentId));
    if (!binding) throw new Error("Feishu provisioning binding fixture was not created");

    const snapshot = await service.getSetupById(bootstrap.userId, agentId);
    expectContractValid(snapshot);
    expect(snapshot).toMatchObject({
      stage: "needs-messaging",
      messaging: {
        kind: "blocked",
        provider: "feishu",
        bindingId: binding.id,
        code: "authorization-failed",
        errorCode: "FEISHU_SETUP_EXPIRED",
      },
      blockers: [{ code: "messaging-not-ready", provider: "feishu", bindingId: binding.id, state: "blocked" }],
      // A terminal attempt keeps its binding: the Account unbinds it before any Provider can start again.
      actions: [{ kind: "unbind-messaging", provider: "feishu", bindingId: binding.id }],
    });
  });

  it("fails an attempt whose owner stopped heartbeating", async () => {
    const bootstrap = await account();
    const { feishuSetup, service } = harness({
      runtimeReadiness: runtimeReadiness("ready"),
      registrations: registrationGateway(new Date(Date.now() + 60_000)),
    });
    const { agentId } = await messagingReadyAgent(bootstrap.userId);
    await feishuSetup.createOrReuse(bootstrap.userId, agentId, "create");
    await unitDatabase.database
      .update(imBindings)
      .set({ setupOwnerHeartbeatAt: new Date(Date.now() - 60_000) })
      .where(eq(imBindings.agentId, agentId));
    const [binding] = await unitDatabase.database
      .select({ id: imBindings.id })
      .from(imBindings)
      .where(eq(imBindings.agentId, agentId));
    if (!binding) throw new Error("Feishu provisioning binding fixture was not created");

    const snapshot = await service.getSetupById(bootstrap.userId, agentId);
    expectContractValid(snapshot);
    expect(snapshot.messaging).toMatchObject({
      kind: "blocked",
      provider: "feishu",
      bindingId: binding.id,
      code: "authorization-failed",
      errorCode: "FEISHU_SETUP_OWNER_RESTARTED",
    });
    expect(snapshot.actions).toEqual([{ kind: "unbind-messaging", provider: "feishu", bindingId: binding.id }]);
  });

  it("waits on the Provider CLI handoff of an active Slack binding, preserving its identity", async () => {
    const bootstrap = await account();
    const { imBindingService, service } = harness({ runtimeReadiness: runtimeReadiness("ready") });
    const { agentId } = await messagingReadyAgent(bootstrap.userId);
    const { imBindingId } = await activateSlackBinding(imBindingService, agentId);

    const snapshot = await service.getSetupById(bootstrap.userId, agentId);
    expectContractValid(snapshot);
    expect(snapshot).toMatchObject({
      stage: "needs-messaging",
      messaging: {
        kind: "waiting-handoff",
        provider: "slack",
        bindingId: imBindingId,
        progress: { phase: "preparing_cli" },
      },
      blockers: [{ code: "messaging-not-ready", provider: "slack", bindingId: imBindingId, state: "waiting-handoff" }],
      actions: [{ kind: "refresh" }, { kind: "unbind-messaging", provider: "slack", bindingId: imBindingId }],
    });
  });

  it("omits handoff progress when only the connection observation is missing", async () => {
    const bootstrap = await account();
    const { imBindingService, service } = harness({
      runtimeReadiness: runtimeReadiness("ready"),
      imCliReadiness: "ready",
      credentialExecutionReadiness: { status: "ready" },
    });
    const { agentId } = await messagingReadyAgent(bootstrap.userId);
    await activateSlackBinding(imBindingService, agentId);

    const snapshot = await service.getSetupById(bootstrap.userId, agentId);
    expectContractValid(snapshot);
    expect(snapshot.messaging).toEqual({
      kind: "waiting-handoff",
      provider: "slack",
      bindingId: expect.any(String),
      credentialGeneration: 1,
    });
  });

  it("reports a ready Slack binding with reauthorization and unbind, but no direct Provider switch", async () => {
    const bootstrap = await account();
    const { imBindingService, service } = harness({
      runtimeReadiness: runtimeReadiness("ready"),
      imCliReadiness: "ready",
      credentialExecutionReadiness: { status: "ready" },
    });
    const { agentId } = await messagingReadyAgent(bootstrap.userId);
    const { imBindingId } = await activateSlackBinding(imBindingService, agentId);
    await observeSlackConnection(agentId);

    const snapshot = await service.getSetupById(bootstrap.userId, agentId);
    expectContractValid(snapshot);
    expect(snapshot).toMatchObject({
      stage: "ready",
      messaging: { kind: "ready", provider: "slack", bindingId: imBindingId },
      blockers: [],
      actions: [
        { kind: "reauthorize-messaging", provider: "slack", bindingId: imBindingId },
        { kind: "unbind-messaging", provider: "slack", bindingId: imBindingId },
      ],
    });
    expect(snapshot.actions).not.toContainEqual(expect.objectContaining({ kind: "start-messaging" }));
    expect(snapshot.actions).not.toContainEqual(expect.objectContaining({ kind: "replace-messaging" }));
  });

  it("withholds Slack reauthorization when OAuth is unavailable but preserves exact unbind", async () => {
    const bootstrap = await account();
    const { imBindingService, service } = harness({
      runtimeReadiness: runtimeReadiness("ready"),
      imCliReadiness: "ready",
      credentialExecutionReadiness: { status: "ready" },
      slackOAuthAvailable: false,
    });
    const { agentId } = await messagingReadyAgent(bootstrap.userId);
    const { imBindingId } = await activateSlackBinding(imBindingService, agentId);
    await observeSlackConnection(agentId);

    const snapshot = await service.getSetupById(bootstrap.userId, agentId);
    expectContractValid(snapshot);
    expect(snapshot).toMatchObject({
      stage: "ready",
      messaging: { kind: "ready", provider: "slack", bindingId: imBindingId },
      actions: [{ kind: "unbind-messaging", provider: "slack", bindingId: imBindingId }],
    });
  });

  it("reports a ready Feishu binding with same-Provider replacement allowed", async () => {
    const bootstrap = await account();
    const { imBindingService, service } = harness({
      runtimeReadiness: runtimeReadiness("ready"),
      imCliReadiness: "ready",
      credentialExecutionReadiness: { status: "ready" },
    });
    const { agentId } = await messagingReadyAgent(bootstrap.userId);
    const { imBindingId } = await activateFeishuBinding(imBindingService, agentId);
    await observeFeishuConnection(imBindingId);

    const snapshot = await service.getSetupById(bootstrap.userId, agentId);
    expectContractValid(snapshot);
    expect(snapshot).toMatchObject({
      stage: "ready",
      messaging: { kind: "ready", provider: "feishu", bindingId: imBindingId },
      blockers: [],
      actions: [
        { kind: "reauthorize-messaging", provider: "feishu", bindingId: imBindingId },
        { kind: "replace-messaging", provider: "feishu", bindingId: imBindingId },
        { kind: "unbind-messaging", provider: "feishu", bindingId: imBindingId },
      ],
    });
  });

  it("blocks on a binding that requires reauthorization, keeping the recorded error code", async () => {
    const bootstrap = await account();
    const { imBindingService, service } = harness({ runtimeReadiness: runtimeReadiness("ready") });
    const { agentId } = await messagingReadyAgent(bootstrap.userId);
    const { imBindingId } = await activateSlackBinding(imBindingService, agentId);
    expect(await imBindingService.requireReauthorization(imBindingId, 1, "SLACK_AUTH_INVALID")).toBe(true);

    const snapshot = await service.getSetupById(bootstrap.userId, agentId);
    expectContractValid(snapshot);
    expect(snapshot).toMatchObject({
      stage: "needs-messaging",
      messaging: {
        kind: "blocked",
        provider: "slack",
        bindingId: imBindingId,
        code: "reauthorization-required",
        errorCode: "SLACK_AUTH_INVALID",
      },
      blockers: [{ code: "messaging-not-ready", provider: "slack", bindingId: imBindingId, state: "blocked" }],
      actions: [
        { kind: "reauthorize-messaging", provider: "slack", bindingId: imBindingId },
        { kind: "unbind-messaging", provider: "slack", bindingId: imBindingId },
      ],
    });
  });

  it("blocks on a binding the Provider reported an error for", async () => {
    const bootstrap = await account();
    const { imBindingService, service } = harness({ runtimeReadiness: runtimeReadiness("ready") });
    const { agentId } = await messagingReadyAgent(bootstrap.userId);
    const { imBindingId } = await activateFeishuBinding(imBindingService, agentId);
    await unitDatabase.database
      .update(imBindings)
      .set({ status: "error", lastErrorCode: "FEISHU_CONNECTION_LOST" })
      .where(eq(imBindings.id, imBindingId));

    const snapshot = await service.getSetupById(bootstrap.userId, agentId);
    expectContractValid(snapshot);
    expect(snapshot).toMatchObject({
      stage: "needs-messaging",
      messaging: {
        kind: "blocked",
        provider: "feishu",
        bindingId: imBindingId,
        code: "provider-error",
        errorCode: "FEISHU_CONNECTION_LOST",
      },
      actions: [
        { kind: "reauthorize-messaging", provider: "feishu", bindingId: imBindingId },
        { kind: "replace-messaging", provider: "feishu", bindingId: imBindingId },
        { kind: "unbind-messaging", provider: "feishu", bindingId: imBindingId },
      ],
    });
  });
});
