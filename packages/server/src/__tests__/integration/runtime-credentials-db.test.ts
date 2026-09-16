import { randomUUID } from "node:crypto";
import {
  RUNTIME_PROTOCOL_V2,
  type RuntimeExecutionSource,
  type RuntimeImCredentialGrantRequest,
  SLACK_REQUIRED_BOT_SCOPES,
} from "@opentag/shared";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootstrapInitialAdmin } from "../../admin/bootstrap.js";
import { createDatabaseClient } from "../../db/client.js";
import {
  agents,
  computerCredentials,
  computers,
  imBindings,
  imMessageDeliveries,
  imMessages,
  sessionMessages,
  sessionPlacements,
  sessions,
} from "../../db/schema/index.js";
import { PostgresRuntimeCustodyStore } from "../../runtime/runtime-custody-store.js";
import { RuntimeCapabilityStore } from "../../runtime-credentials/capability-store.js";
import { RuntimeCredentialBroker } from "../../runtime-credentials/credential-broker.js";
import {
  PostgresRuntimeExecutionAuthority,
  type RuntimeExecutionAuthorityContext,
} from "../../runtime-credentials/execution-authority.js";
import { RuntimeExecutionRegistry } from "../../runtime-credentials/execution-registry.js";
import { FeishuTenantTokenCache } from "../../runtime-credentials/feishu-tenant-token.js";
import { UnavailableRuntimeGitHubAdmission } from "../../runtime-credentials/github-admission.js";
import { ImProviderMaterialResolver } from "../../runtime-credentials/im-material.js";
import { RuntimeScopeResolver } from "../../runtime-credentials/scope-resolver.js";
import { DefaultRuntimeTaskPolicy } from "../../runtime-credentials/task-policy.js";
import { KindAwareComputerAuthVerifier } from "../../runtime-credentials/trusted-control.js";
import { runtimeExecutionProviderBinding } from "../../runtime-credentials/types.js";
import { RuntimeValidationRunRegistry } from "../../runtime-credentials/validation-runs.js";
import { AgentService } from "../../services/agents/index.js";
import { AuthServiceError } from "../../services/auth/index.js";
import { ComputerService } from "../../services/computers/index.js";
import { ApplicationCipher } from "../../services/crypto.js";
import { ImBindingService } from "../../services/im-bindings/index.js";
import { type MigratedTestDatabase, startMigratedTestDatabase } from "./migrated-test-database.js";

const INSTANCE_ID = "11111111-1111-4111-8111-111111111111";

let testDatabase: MigratedTestDatabase;
let databaseUrl: string;

beforeAll(async () => {
  testDatabase = await startMigratedTestDatabase();
  databaseUrl = testDatabase.databaseUrl;
}, 120_000);

afterAll(async () => testDatabase.stop());

beforeEach(async () => testDatabase.reset());

async function fixture(options: { computerKind?: "local" | "cloud" } = {}) {
  const client = createDatabaseClient(databaseUrl);
  const bootstrap = await bootstrapInitialAdmin(client.database, {
    displayName: "Admin",
    email: "admin@example.com",
  });
  const [computer] = await client.database
    .insert(computers)
    .values({
      ownerAccountId: bootstrap.userId,
      currentInstallationId: randomUUID(),
      kind: options.computerKind ?? "local",
      displayName: "workstation",
      platform: "linux",
      arch: "x64",
      clientVersion: "0.0.2",
    })
    .returning();
  if (!computer) throw new Error("Computer fixture was not created");
  const isCloud = options.computerKind === "cloud";
  const agent = await new AgentService(client.database, { cloudIdentitiesEnabled: isCloud }).createForAccount(
    bootstrap.userId,
    {
      name: "assistant",
      displayName: "Assistant",
      runtimeProvider: isCloud ? "pi" : "codex",
      computerId: computer.id,
    },
  );
  const cipher = new ApplicationCipher(Buffer.alloc(32, 7));
  const imBindingService = new ImBindingService(client.database, cipher, {
    imCliReadiness: () => "ready",
    credentialExecutionReadiness: () => ({ status: "ready" }),
  });
  const activated = await imBindingService.activateSlack(
    {
      intent: "create",
      agentId: agent.id,
      appId: "A1",
      teamId: "T1",
      botUserId: "U_BOT",
      grantedBotScopes: [...SLACK_REQUIRED_BOT_SCOPES],
      botAccessToken: "xoxb-secret",
      signingSecret: "signing-secret",
      installedAt: new Date("2026-08-19T00:00:00.000Z"),
    },
    "B_BOT",
  );
  await imBindingService.recordSlackIdentityClosure(activated.imBindingId, activated.credentialGeneration);
  const [session] = await client.database
    .insert(sessions)
    .values({
      imBindingId: activated.imBindingId,
      channelId: "C1",
      conversationKind: "channel",
      kind: "channel",
    })
    .returning();
  if (!session) throw new Error("Session fixture was not created");
  await client.database.insert(sessionPlacements).values({
    sessionId: session.id,
    computerId: computer.id,
    generation: 1,
  });
  return {
    ...client,
    bootstrap,
    computer,
    agent,
    cipher,
    imBindingService,
    imBindingId: activated.imBindingId,
    session,
  };
}

async function seedDelivery(
  database: ReturnType<typeof createDatabaseClient>["database"],
  fixtureState: Awaited<ReturnType<typeof fixture>>,
  state: "pending" | "accepted" | "steered" | "terminal_rejected" | "expired",
  turnId: string,
) {
  const [message] = await database
    .insert(imMessages)
    .values({
      imBindingId: fixtureState.imBindingId,
      providerEventId: `event-${randomUUID()}`,
      channelId: "C1",
      externalMessageId: `message-${randomUUID()}`,
      providerRevisionKey: "1",
      operation: "created",
      direction: "inbound",
      providerContext: { provider: "slack", channelType: "channel" },
      threadKey: null,
      replyToExternalId: null,
      authorKind: "human",
      authorExternalId: "U_HUMAN",
      authorDisplayName: "Human",
      content: {
        version: 1,
        fallbackText: "hello",
        blocks: [{ type: "text", text: "hello" }],
        truncated: false,
      },
      occurredAt: new Date("2026-08-19T00:00:00.000Z"),
    })
    .returning({ id: imMessages.id });
  if (!message) throw new Error("Message fixture was not created");
  const [delivery] = await database
    .insert(imMessageDeliveries)
    .values({
      messageId: message.id,
      sessionId: fixtureState.session.id,
      attention: "direct",
      state,
      placementGeneration: 1,
      ...(state === "accepted"
        ? {
            inputHash: "a".repeat(64),
            turnId,
            acceptedAt: new Date(),
            reportOwnerInstanceId: INSTANCE_ID,
          }
        : {}),
      expiresAt: new Date("2026-08-26T00:00:00.000Z"),
    })
    .returning({ id: imMessageDeliveries.id });
  if (!delivery) throw new Error("Delivery fixture was not created");
  return delivery.id;
}

function executionRecord(
  registry: RuntimeExecutionRegistry,
  fixtureState: Awaited<ReturnType<typeof fixture>>,
  overrides: {
    agentRevision?: number;
    exactAgent?: string;
    exactComputer?: string;
    exactSession?: string;
    installationId?: string;
  } = {},
) {
  return registry.open({
    runId: randomUUID(),
    accountId: fixtureState.bootstrap.userId,
    agentId: overrides.exactAgent ?? fixtureState.agent.id,
    agentRevision: overrides.agentRevision ?? fixtureState.agent.revision,
    sessionId: overrides.exactSession ?? fixtureState.session.id,
    computerId: overrides.exactComputer ?? fixtureState.computer.id,
    instanceId: INSTANCE_ID,
    connectionId: "connection-1",
    placementGeneration: 1,
    source: { kind: "delivery", deliveryId: "d1", turnId: "t1" } satisfies RuntimeExecutionSource,
    purpose: "execution",
    computerKind: "local",
    providers: new Map([
      [
        `slack:${fixtureState.imBindingId}`,
        runtimeExecutionProviderBinding("slack", fixtureState.imBindingId, {
          provider: "slack",
          teamId: "T1",
          botUserId: "U_BOT",
        }),
      ],
    ]),
  });
}

describe("PostgresRuntimeScopeResolver", () => {
  it("loads the Session fence and detects revision, placement, and binding drift", async () => {
    const state = await fixture();
    const resolver = new RuntimeScopeResolver(state.database);
    const snapshot = await resolver.load(state.session.id);
    expect(snapshot).toMatchObject({
      sessionId: state.session.id,
      sessionKind: "channel",
      binding: { id: state.imBindingId, provider: "slack", status: "active" },
      agent: { id: state.agent.id, status: "active" },
      placement: { computerId: state.computer.id, generation: 1 },
      computer: { id: state.computer.id, kind: "local" },
    });
    const registry = new RuntimeExecutionRegistry();
    const record = executionRecord(registry, state);
    expect(snapshot && resolver.assertExecutionFence(record, snapshot)).toBeUndefined();

    await state.database
      .update(agents)
      .set({ revision: state.agent.revision + 1 })
      .where(eq(agents.id, state.agent.id));
    const advanced = await resolver.load(state.session.id);
    expect(advanced && resolver.assertExecutionFence(record, advanced)).toBe("agent_revision_changed");
    const updated = { ...record, agentRevision: state.agent.revision + 1 };
    registry.update(updated);

    await state.database
      .update(imBindings)
      .set({ status: "disabled", disabledAt: new Date() })
      .where(eq(imBindings.id, state.imBindingId));
    const disabled = await resolver.load(state.session.id);
    expect(disabled && resolver.assertExecutionFence(updated, disabled)).toBe("binding_inactive");
  });

  it("loads a validation fence without requiring a Session", async () => {
    const state = await fixture();
    const resolver = new RuntimeScopeResolver(state.database);
    const snapshot = await resolver.loadValidationScope({
      bindingId: state.imBindingId,
      agentId: state.agent.id,
    });
    expect(snapshot).toMatchObject({
      agent: { id: state.agent.id, status: "active" },
      binding: { id: state.imBindingId, provider: "slack" },
      slackInstallation: { status: "active" },
      computer: { id: state.computer.id, kind: "local" },
    });
    await expect(
      resolver.loadValidationScope({ bindingId: state.imBindingId, agentId: randomUUID() }),
    ).resolves.toBeUndefined();
    await expect(
      resolver.loadValidationScope({ bindingId: randomUUID(), agentId: state.agent.id }),
    ).resolves.toBeUndefined();
  });
});

describe("PostgresRuntimeExecutionAuthority", () => {
  async function authorityFixture() {
    const state = await fixture();
    const custody = new PostgresRuntimeCustodyStore(state.database);
    const validationRuns = new RuntimeValidationRunRegistry();
    const authority = new PostgresRuntimeExecutionAuthority({
      database: state.database,
      custody,
      validationRuns,
    });
    const context: RuntimeExecutionAuthorityContext = {
      sessionId: state.session.id,
      agentId: state.agent.id,
      computerId: state.computer.id,
      instanceId: INSTANCE_ID,
      placementGeneration: 1,
    };
    return { state, authority, validationRuns, context };
  }

  it("authorizes only matching accepted custody and reports pending as retryable", async () => {
    const { state, authority, context } = await authorityFixture();
    const pendingId = await seedDelivery(state.database, state, "pending", "");
    await expect(
      authority.authorize({ kind: "delivery", deliveryId: pendingId, turnId: "turn-1" }, context),
    ).resolves.toEqual({ status: "not_ready" });

    const acceptedId = await seedDelivery(state.database, state, "accepted", "turn-1");
    await expect(
      authority.authorize({ kind: "delivery", deliveryId: acceptedId, turnId: "turn-1" }, context),
    ).resolves.toEqual({ status: "authorized" });
    await expect(
      authority.authorize({ kind: "delivery", deliveryId: acceptedId, turnId: "turn-other" }, context),
    ).resolves.toEqual({ status: "invalid" });
    await expect(
      authority.authorize(
        { kind: "delivery", deliveryId: acceptedId, turnId: "turn-1" },
        { ...context, computerId: randomUUID() },
      ),
    ).resolves.toEqual({ status: "invalid" });
  });

  it("invalidates accepted custody when the delivery is steered or rejected later", async () => {
    const { state, authority, context } = await authorityFixture();
    const deliveryId = await seedDelivery(state.database, state, "accepted", "turn-1");
    const source = { kind: "delivery" as const, deliveryId, turnId: "turn-1" };
    await expect(authority.revalidate(source, context)).resolves.toBe("valid");
    const steerTargetId = await seedDelivery(state.database, state, "pending", "");
    await state.database
      .update(imMessageDeliveries)
      .set({
        state: "steered",
        turnId: null,
        acceptedAt: null,
        reportOwnerInstanceId: null,
        steeredAt: new Date(),
        steerTargetDeliveryId: steerTargetId,
      })
      .where(eq(imMessageDeliveries.id, deliveryId));
    await expect(authority.revalidate(source, context)).resolves.toBe("invalid");
    await expect(authority.authorize(source, context)).resolves.toEqual({ status: "invalid" });

    const rejectedId = await seedDelivery(state.database, state, "terminal_rejected", "");
    await expect(
      authority.authorize({ kind: "delivery", deliveryId: rejectedId, turnId: "turn-1" }, context),
    ).resolves.toEqual({ status: "invalid" });
  });

  it("authorizes and revalidates an accepted Session collaboration message", async () => {
    const { state, authority, context } = await authorityFixture();
    const messageId = randomUUID();
    await state.database.insert(sessionMessages).values({
      id: messageId,
      sourceSessionId: state.session.id,
      targetSessionId: state.session.id,
      content: "hello",
      contentHash: "b".repeat(64),
      lastOutcome: "accepted",
    });
    const source = { kind: "session-message" as const, messageId };
    await expect(authority.authorize(source, context)).resolves.toEqual({ status: "authorized" });
    await expect(authority.revalidate(source, context)).resolves.toBe("valid");
    await state.database
      .update(sessionMessages)
      .set({ lastOutcome: "rejected" })
      .where(eq(sessionMessages.id, messageId));
    await expect(authority.revalidate(source, context)).resolves.toBe("invalid");
  });

  it("consumes Server-issued validation runs exactly once", async () => {
    const { state, authority, validationRuns, context } = await authorityFixture();
    const run = validationRuns.issue({
      provider: "slack",
      bindingId: state.imBindingId,
      agentId: state.agent.id,
      computerId: state.computer.id,
      instanceId: INSTANCE_ID,
    });
    await expect(
      authority.authorize({ kind: "validation", validationRunId: run.validationRunId }, context),
    ).resolves.toMatchObject({ status: "authorized", validation: { bindingId: state.imBindingId } });
    await expect(
      authority.authorize({ kind: "validation", validationRunId: run.validationRunId }, context),
    ).resolves.toEqual({ status: "invalid" });
  });
});

describe("runtime credential broker against the real database", () => {
  it("acquires, renews, and revalidates through the Postgres fence", async () => {
    const state = await fixture();
    const resolver = new RuntimeScopeResolver(state.database);
    const registry = new RuntimeExecutionRegistry();
    const record = executionRecord(registry, state);
    const tenantTokens = new FeishuTenantTokenCache();
    const material = new ImProviderMaterialResolver({
      database: state.database,
      cipher: state.cipher,
      tenantTokens,
    });
    const broker = new RuntimeCredentialBroker({
      capabilities: new RuntimeCapabilityStore(),
      executions: registry,
      scopeResolver: resolver,
      policy: new DefaultRuntimeTaskPolicy(),
      gitHubAdmission: new UnavailableRuntimeGitHubAdmission(),
      materialResolvers: { slack: material, feishu: material },
    });
    const grant = await broker.acquire({
      execution: record,
      provider: "slack",
      bindingId: state.imBindingId,
    });
    expect(grant.status).toBe("succeeded");
    if (grant.status !== "succeeded") return;
    expect(grant.cli).toMatchObject({ provider: "slack", teamId: "T1" });
    const authorization = await broker.beginRequest({
      capability: grant.token,
      provider: "slack",
      bindingId: state.imBindingId,
    });
    const resolved = await authorization.resolveMaterial();
    expect(resolved).toMatchObject({ kind: "bearer", token: "xoxb-secret", origin: "https://slack.com" });
    await expect(authorization.recheck()).resolves.toBeUndefined();

    // A disabled binding fails the next live request even though the capability is unexpired.
    await state.database
      .update(imBindings)
      .set({ status: "disabled", disabledAt: new Date() })
      .where(eq(imBindings.id, state.imBindingId));
    await expect(authorization.recheck()).rejects.toMatchObject({ code: "binding_inactive" });
  });

  it("denies the legacy raw grant for Cloud", async () => {
    const cloud = await fixture({ computerKind: "cloud" });
    const cloudRequest: RuntimeImCredentialGrantRequest = {
      type: "im:credential",
      requestId: randomUUID(),
      sessionId: cloud.session.id,
      agentId: cloud.agent.id,
      placementGeneration: 1,
    };
    const cloudResult = await cloud.imBindingService.issueRuntimeCredentialGrant(cloudRequest, {
      computerId: cloud.computer.id,
      imCredentialGrantVersion: 2,
    });
    expect(cloudResult).toEqual({
      type: "im:credential:result",
      requestId: cloudRequest.requestId,
      status: "rejected",
      code: "credential_stale",
    });
    expect(JSON.stringify(cloudResult)).not.toContain("xoxb-secret");
  });

  it("preserves the legacy raw grant for Local", async () => {
    const local = await fixture();
    const request: RuntimeImCredentialGrantRequest = {
      type: "im:credential",
      requestId: randomUUID(),
      sessionId: local.session.id,
      agentId: local.agent.id,
      placementGeneration: 1,
    };
    const localResult = await local.imBindingService.issueRuntimeCredentialGrant(request, {
      computerId: local.computer.id,
      imCredentialGrantVersion: 2,
    });
    expect(localResult.status).toBe("succeeded");
  });
});

describe("KindAwareComputerAuthVerifier", () => {
  it("binds a trusted Cloud control credential to the existing logical Cloud Computer", async () => {
    const state = await fixture({ computerKind: "cloud" });
    const verifier = new KindAwareComputerAuthVerifier(
      {
        verifyMachineToken: async () => {
          throw new Error("The Local machine path must not run for a Cloud control credential");
        },
      },
      state.database,
      {
        verifyControlCredential: async (credential) =>
          credential === "good"
            ? {
                credentialId: "issued-credential-id",
                computerId: state.computer.id,
                installationId: state.computer.currentInstallationId,
              }
            : undefined,
      },
    );
    await expect(verifier.verifyMachineToken("otcloud-control.good")).resolves.toEqual({
      credentialId: "issued-credential-id",
      computerId: state.computer.id,
      installationId: state.computer.currentInstallationId,
      kind: "cloud",
    });
    await expect(verifier.verifyMachineToken("otcloud-control.bad")).rejects.toMatchObject({
      code: "AUTH_INVALID_TOKEN",
    });
    await expect(verifier.verifyMachineToken("otcloud-control.good")).resolves.toMatchObject({ kind: "cloud" });
  });

  it("fails closed when the Cloud verifier returns no issued credential id", async () => {
    const state = await fixture({ computerKind: "cloud" });
    const verifier = new KindAwareComputerAuthVerifier(
      {
        verifyMachineToken: async () => {
          throw new Error("unused");
        },
      },
      state.database,
      {
        verifyControlCredential: async () => ({
          computerId: state.computer.id,
          installationId: state.computer.currentInstallationId,
        }),
      },
    );
    await expect(verifier.verifyMachineToken("otcloud-control.good")).rejects.toMatchObject({
      code: "AUTH_INVALID_TOKEN",
    });
  });

  it("rejects a Cloud credential when the row installation no longer matches", async () => {
    const state = await fixture({ computerKind: "cloud" });
    const verifier = new KindAwareComputerAuthVerifier(
      {
        verifyMachineToken: async () => {
          throw new Error("unused");
        },
      },
      state.database,
      {
        verifyControlCredential: async () => ({
          credentialId: "issued-credential-id",
          computerId: state.computer.id,
          installationId: randomUUID(),
        }),
      },
    );
    await expect(verifier.verifyMachineToken("otcloud-control.good")).rejects.toMatchObject({
      code: "AUTH_INVALID_TOKEN",
    });
  });

  it("keeps the Local machine-token path unchanged", async () => {
    const machineAuth = {
      verifyMachineToken: async (token: string) => ({
        credentialId: "credential-1",
        computerId: "computer-1",
        installationId: "installation-1",
        ...(token === "local" ? {} : {}),
      }),
    };
    const verifier = new KindAwareComputerAuthVerifier(machineAuth, {
      select: () => {
        throw new Error("Local machine tokens must not query the Cloud verifier");
      },
    } as never);
    await expect(verifier.verifyMachineToken("local")).resolves.toMatchObject({
      computerId: "computer-1",
      credentialId: "credential-1",
    });
  });
});

describe("ComputerService Cloud control registration", () => {
  function registerFrame(installationId: string, instanceId: string) {
    return {
      type: "computer:register" as const,
      requestId: randomUUID(),
      installationId,
      instanceId,
      displayName: "cloud-runner",
      platform: "linux" as const,
      arch: "x64",
      clientVersion: "0.0.2",
      capabilities: { imCredentialGrant: 0 as const },
      protocolVersion: RUNTIME_PROTOCOL_V2,
      supportedCapabilities: { runtimeCredential: { min: 1, max: 1 } },
      requiredServerCapabilities: [],
    };
  }

  it("registers and heartbeats Cloud through the injected live control hook", async () => {
    const state = await fixture({ computerKind: "cloud" });
    const instanceId = randomUUID();
    const seen: string[] = [];
    const service = new ComputerService(state.database, {} as never, {
      cloudIdentities: { enabled: true, runnerVersion: "0.0.2" },
      assertCloudControlCredential: (context) => {
        seen.push(context.credentialId);
      },
    });
    const context = {
      credentialId: "issued-credential-id",
      computerId: state.computer.id,
      installationId: state.computer.currentInstallationId,
      kind: "cloud" as const,
    };
    await service.register(context, registerFrame(state.computer.currentInstallationId, instanceId));
    expect(seen).toEqual(["issued-credential-id"]);
    await expect(service.heartbeat(context, instanceId)).resolves.toBe(true);
    const [row] = await state.database
      .select({ kind: computers.kind, currentInstanceId: computers.currentInstanceId })
      .from(computers)
      .where(eq(computers.id, state.computer.id));
    expect(row).toMatchObject({ kind: "cloud", currentInstanceId: instanceId });
  });

  it("rejects Cloud registration without the hook or after the credential is revoked", async () => {
    const state = await fixture({ computerKind: "cloud" });
    const instanceId = randomUUID();
    const context = {
      credentialId: "issued-credential-id",
      computerId: state.computer.id,
      installationId: state.computer.currentInstallationId,
      kind: "cloud" as const,
    };
    const frame = registerFrame(state.computer.currentInstallationId, instanceId);
    const missingHook = new ComputerService(state.database, {} as never, {
      cloudIdentities: { enabled: true, runnerVersion: "0.0.2" },
    });
    await expect(missingHook.register(context, frame)).rejects.toMatchObject({
      code: "COMPUTER_NOT_REGISTERED",
    });
    const revoked = new ComputerService(state.database, {} as never, {
      cloudIdentities: { enabled: true, runnerVersion: "0.0.2" },
      assertCloudControlCredential: () => {
        throw new AuthServiceError("AUTH_INVALID_TOKEN", "credential", "The Cloud control credential is revoked", 401);
      },
    });
    await expect(revoked.register(context, frame)).rejects.toMatchObject({ code: "AUTH_INVALID_TOKEN" });
    await expect(revoked.heartbeat(context, instanceId)).rejects.toMatchObject({ code: "AUTH_INVALID_TOKEN" });
  });

  it("does not invoke the Cloud hook for Local registration", async () => {
    const state = await fixture();
    const instanceId = randomUUID();
    const [credential] = await state.database
      .insert(computerCredentials)
      .values({
        computerId: state.computer.id,
        secretHash: `sha256:${"a".repeat(64)}`,
        issuedByUserId: state.bootstrap.userId,
      })
      .returning({ id: computerCredentials.id });
    if (!credential) throw new Error("Credential fixture was not created");
    let calls = 0;
    const service = new ComputerService(state.database, {} as never, {
      assertCloudControlCredential: () => {
        calls += 1;
      },
    });
    await service.register(
      {
        credentialId: credential.id,
        computerId: state.computer.id,
        installationId: state.computer.currentInstallationId,
      },
      registerFrame(state.computer.currentInstallationId, instanceId),
    );
    expect(calls).toBe(0);
    await expect(
      service.heartbeat(
        {
          credentialId: credential.id,
          computerId: state.computer.id,
          installationId: state.computer.currentInstallationId,
        },
        instanceId,
      ),
    ).resolves.toBe(true);
    expect(calls).toBe(0);
  });
});
