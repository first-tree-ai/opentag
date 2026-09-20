import { randomUUID } from "node:crypto";
import {
  RUNTIME_CAPABILITY,
  RUNTIME_PROTOCOL_V2,
  RUNTIME_SERVER_CAPABILITY_OFFERS,
  type RuntimeCredentialClientFrame,
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
  runtimeDurableWork,
  sandboxes,
  sessionMessages,
  sessionPlacements,
  sessions,
} from "../../db/schema/index.js";
import { ConnectionRegistry, type RuntimeControlIdentity } from "../../runtime/connection-registry.js";
import { PostgresRuntimeCustodyStore } from "../../runtime/runtime-custody-store.js";
import type { RuntimeBusinessContext } from "../../runtime/runtime-session.js";
import { RuntimeCapabilityStore } from "../../runtime-credentials/capability-store.js";
import {
  type RuntimeConnectionFence,
  type RuntimeControlAuthority,
  RuntimeCredentialBroker,
} from "../../runtime-credentials/credential-broker.js";
import {
  PostgresRuntimeExecutionAuthority,
  type RuntimeExecutionAuthorityContext,
} from "../../runtime-credentials/execution-authority.js";
import { RuntimeExecutionRegistry } from "../../runtime-credentials/execution-registry.js";
import { FeishuTenantTokenCache } from "../../runtime-credentials/feishu-tenant-token.js";
import {
  type RuntimeGitHubAdmission,
  type RuntimeGitHubAdmissionResult,
  UnavailableRuntimeGitHubAdmission,
} from "../../runtime-credentials/github-admission.js";
import { ImProviderMaterialResolver } from "../../runtime-credentials/im-material.js";
import { RuntimeCredentialOwner } from "../../runtime-credentials/runtime-credential-owner.js";
import { RuntimeScopeResolver } from "../../runtime-credentials/scope-resolver.js";
import { DefaultRuntimeTaskPolicy, type RuntimeTaskPolicy } from "../../runtime-credentials/task-policy.js";
import { RuntimeProxyTicketStore } from "../../runtime-credentials/ticket-store.js";
import { KindAwareComputerAuthVerifier } from "../../runtime-credentials/trusted-control.js";
import { runtimeExecutionProviderBinding } from "../../runtime-credentials/types.js";
import { RuntimeValidationRunRegistry } from "../../runtime-credentials/validation-runs.js";
import { RuntimeWebExecutionAuthorizer } from "../../runtime-credentials/web-execution.js";
import type { RuntimeWebServicePolicy } from "../../runtime-credentials/web-policy.js";
import { AgentService } from "../../services/agents/index.js";
import { AuthServiceError } from "../../services/auth/index.js";
import { ComputerService } from "../../services/computers/index.js";
import { ApplicationCipher } from "../../services/crypto.js";
import { ImBindingService } from "../../services/im-bindings/index.js";
import { CloudDeliveryOwner } from "../../services/sandboxes/cloud-delivery-owner.js";
import { type CloudConnectionRecord, CloudRuntimeFence } from "../../services/sandboxes/cloud-runtime-fence.js";
import { createSessionCliCloudProofAuthority } from "../../services/sandboxes/cloud-session-collaboration-owner.js";
import { RunnerHub, type RunnerScope } from "../../services/sandboxes/runner-hub.js";
import { SessionCliProofService } from "../../services/sessions/index.js";
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

/**
 * E8 internal Cloud collaboration on real PostgreSQL: the production credential boundary
 * (`CloudDeliveryOwner` -> `RuntimeCredentialOwner` -> `openRuntimeSessionExecution`) must open a
 * scope-free execution for an internal child, mint its Session CLI proof, and keep denying every
 * inherited IM credential. The authority/durable-work regression proves that accepted work which
 * settled or moved allocation can never authorize a fresh execution.
 */
const CLOUD_SESSION_COLLABORATION_VERSION =
  RUNTIME_SERVER_CAPABILITY_OFFERS[RUNTIME_CAPABILITY.sessionCollaboration].max;

async function seedCloudDurableWork(
  state: Awaited<ReturnType<typeof fixture>>,
  input: {
    messageId: string;
    sessionId: string;
    sandboxId: string;
    environmentGeneration: number;
    resourceName: string;
    status?: "accepted" | "running" | "retryable" | "failed";
    allocation?: { sandboxId: string; environmentGeneration: number; resourceName: string };
  },
) {
  await state.database.insert(runtimeDurableWork).values({
    computerId: state.computer.id,
    kind: "session-message",
    recordKey: `${input.sessionId}:${input.messageId}`,
    payload: {
      type: "cloud-session-message-work",
      request: {
        type: "session:message:deliver",
        requestId: input.messageId,
        messageId: input.messageId,
        sourceSessionId: state.session.id,
        targetSessionId: input.sessionId,
        agentId: state.agent.id,
        placementGeneration: 1,
        content: { kind: "text", text: "run the child task" },
        runtime: {
          contextTreeRepository: null,
          revision: { agent: { sequence: 1, id: "agent" }, session: { sequence: 1, id: "session" } },
          agentId: state.agent.id,
          provider: "pi",
          instructions: { platform: "platform", agent: "agent" },
          execution: { approvalPolicy: "never", networkAccess: false },
          workspace: { workspaceId: "workspace", mode: "empty_on_create", sharing: "agent" },
        },
      },
      allocation: input.allocation ?? {
        sandboxId: input.sandboxId,
        environmentGeneration: input.environmentGeneration,
        resourceName: input.resourceName,
      },
      turnId: randomUUID(),
    },
    status: input.status ?? "accepted",
    attempts: 0,
    acceptedAt: Date.now(),
    updatedAt: Date.now(),
  });
}

/** A Cloud internal child of the fixture's visible Session, with its own Sandbox and accepted work. */
async function internalCloudFixture() {
  const state = await fixture({ computerKind: "cloud" });
  const [internal] = await state.database
    .insert(sessions)
    .values({
      imBindingId: state.imBindingId,
      channelId: state.session.channelId,
      conversationKind: state.session.conversationKind,
      kind: "internal",
      threadKey: null,
      createdBySessionId: state.session.id,
    })
    .returning();
  if (!internal) throw new Error("Internal Session fixture was not created");
  await state.database.insert(sessionPlacements).values({
    sessionId: internal.id,
    computerId: state.computer.id,
    generation: 1,
  });
  const [sandbox] = await state.database
    .insert(sandboxes)
    .values({
      sessionId: internal.id,
      storageUri: `gs://unit-cloud/${randomUUID()}`,
      lifecycle: "ready",
      environmentGeneration: 1,
      currentResourceName: `projects/unit/locations/us-west1/instances/ots-internal-${internal.id.slice(0, 8)}`,
      currentResourceUid: `unit-uid-${internal.id.slice(0, 8)}`,
    })
    .returning();
  if (!sandbox) throw new Error("Internal Sandbox fixture was not created");
  const messageId = randomUUID();
  await state.database.insert(sessionMessages).values({
    id: messageId,
    sourceSessionId: state.session.id,
    targetSessionId: internal.id,
    content: "run the child task",
    contentHash: "c".repeat(64),
    lastOutcome: "accepted",
  });
  const resourceName = sandbox.currentResourceName;
  if (!resourceName) throw new Error("Internal Sandbox resource name was not set");
  await seedCloudDurableWork(state, {
    messageId,
    sessionId: internal.id,
    sandboxId: sandbox.id,
    environmentGeneration: sandbox.environmentGeneration,
    resourceName,
  });
  return { ...state, internal, sandbox, messageId, resourceName };
}

interface CredentialOwnerStackOptions {
  controlAuthority: RuntimeControlAuthority;
  connectionFence: RuntimeConnectionFence;
  cloudControlActive?: (identity: RuntimeControlIdentity) => boolean | Promise<boolean>;
  gitHubAdmission?: RuntimeGitHubAdmission;
  taskPolicy?: RuntimeTaskPolicy;
  webPolicy?: RuntimeWebServicePolicy;
}

/** The real credential owner/broker/authority/resolver chain over the test database. */
function credentialOwnerStack(state: Awaited<ReturnType<typeof fixture>>, options: CredentialOwnerStackOptions) {
  const executions = new RuntimeExecutionRegistry();
  const capabilities = new RuntimeCapabilityStore();
  const tickets = new RuntimeProxyTicketStore();
  const validationRuns = new RuntimeValidationRunRegistry();
  const resolver = new RuntimeScopeResolver(state.database);
  const custody = new PostgresRuntimeCustodyStore(state.database);
  const authority = new PostgresRuntimeExecutionAuthority({
    database: state.database,
    custody,
    validationRuns,
  });
  const gitHubAdmission = options.gitHubAdmission ?? new UnavailableRuntimeGitHubAdmission();
  const policy = options.taskPolicy ?? new DefaultRuntimeTaskPolicy();
  const broker = new RuntimeCredentialBroker({
    capabilities,
    executions,
    scopeResolver: resolver,
    policy,
    gitHubAdmission,
    materialResolvers: {},
    authority,
    connectionFence: options.connectionFence,
    ...(options.cloudControlActive ? { cloudControlActive: options.cloudControlActive } : {}),
  });
  const owner = new RuntimeCredentialOwner({
    registry: new ConnectionRegistry(),
    controlAuthority: options.controlAuthority,
    executions,
    capabilities,
    tickets,
    validationRuns,
    authority,
    scopeResolver: resolver,
    broker,
    policy,
    gitHubAdmission,
    ...(options.cloudControlActive ? { cloudControlActive: options.cloudControlActive } : {}),
    ...(options.webPolicy ? { webPolicy: options.webPolicy } : {}),
    sweepIntervalMs: 60_000,
  });
  return { owner, broker, executions, capabilities, tickets, validationRuns, resolver, authority };
}

interface CloudCredentialStack {
  connection: CloudConnectionRecord;
  context: RuntimeBusinessContext;
  frame: Extract<RuntimeCredentialClientFrame, { type: "runtime:execution:open" }>;
  delivery: CloudDeliveryOwner;
  proofs: SessionCliProofService;
  owner: RuntimeCredentialOwner;
  executions: RuntimeExecutionRegistry;
  broker: RuntimeCredentialBroker;
  authority: PostgresRuntimeExecutionAuthority;
  resolver: RuntimeScopeResolver;
  connectionFence: RuntimeConnectionFence;
  cloudControlActive: (identity: RuntimeControlIdentity) => boolean;
}

/** The production-shaped Cloud boundary: real fence, owner, broker, proof service, delivery owner. */
function cloudCredentialStack(
  state: Awaited<ReturnType<typeof internalCloudFixture>>,
  options: {
    gitHubAdmission?: RuntimeGitHubAdmission;
    taskPolicy?: RuntimeTaskPolicy;
    webPolicy?: RuntimeWebServicePolicy;
  } = {},
): CloudCredentialStack {
  const scope: RunnerScope = {
    sandboxId: state.sandbox.id,
    sessionId: state.internal.id,
    environmentGeneration: state.sandbox.environmentGeneration,
    resourceName: state.resourceName,
  };
  const fence = new CloudRuntimeFence();
  const connection = fence.attach({
    computerId: state.computer.id,
    installationId: state.computer.currentInstallationId,
    scope,
    executionEligible: true,
    sessionCollaborationEligible: true,
  });
  const controlAuthority: RuntimeControlAuthority = {
    isCurrentConnection: (computerId, instanceId, connectionId) =>
      fence.isCurrent(computerId, instanceId, connectionId),
    currentControlIdentity: (computerId) => fence.currentControlIdentity(computerId),
  };
  const connectionFence: RuntimeConnectionFence = {
    isCurrent: (computerId, instanceId, connectionId) => fence.isCurrent(computerId, instanceId, connectionId),
    currentControlIdentity: (computerId) => fence.currentControlIdentity(computerId),
  };
  const cloudControlActive = (identity: RuntimeControlIdentity) => fence.isControlActive(identity);
  const stack = credentialOwnerStack(state, {
    controlAuthority,
    connectionFence,
    cloudControlActive,
    ...(options.gitHubAdmission ? { gitHubAdmission: options.gitHubAdmission } : {}),
    ...(options.taskPolicy ? { taskPolicy: options.taskPolicy } : {}),
    ...(options.webPolicy ? { webPolicy: options.webPolicy } : {}),
  });
  const proofs = new SessionCliProofService(
    state.database,
    { currentInstanceId: () => undefined, supportsCapability: () => false },
    new Uint8Array(32).fill(11),
    { cloud: createSessionCliCloudProofAuthority({ fence, registry: stack.executions }) },
  );
  const delivery = new CloudDeliveryOwner({
    custody: new PostgresRuntimeCustodyStore(state.database),
    database: state.database,
    fence,
    hub: new RunnerHub(),
    credentials: { owner: stack.owner },
    sessionProofs: proofs,
  });
  const frame: CloudCredentialStack["frame"] = {
    type: "runtime:execution:open",
    requestId: randomUUID(),
    sessionId: state.internal.id,
    agentId: state.agent.id,
    placementGeneration: 1,
    runId: randomUUID(),
    source: { kind: "session-message", messageId: state.messageId },
    sandbox: {
      sandboxId: state.sandbox.id,
      resourceUid: state.sandbox.currentResourceUid ?? "",
      environmentGeneration: state.sandbox.environmentGeneration,
    },
  };
  const context: RuntimeBusinessContext = {
    computerId: connection.computerId,
    installationId: connection.installationId,
    connectionId: connection.connectionId,
    instanceId: connection.instanceId,
    negotiatedCapabilities: {
      [RUNTIME_CAPABILITY.runtimeCredential]: 1,
      [RUNTIME_CAPABILITY.providerProxy]: 1,
      [RUNTIME_CAPABILITY.sessionCollaboration]: CLOUD_SESSION_COLLABORATION_VERSION,
    },
    signal: new AbortController().signal,
  };
  return {
    connection,
    context,
    frame,
    delivery,
    proofs,
    owner: stack.owner,
    executions: stack.executions,
    broker: stack.broker,
    authority: stack.authority,
    resolver: stack.resolver,
    connectionFence,
    cloudControlActive,
  };
}

async function ownerHandle(
  stack: CloudCredentialStack,
  frame: Record<string, unknown>,
  context: RuntimeBusinessContext = stack.context,
) {
  return stack.owner.handle(frame as RuntimeCredentialClientFrame, context);
}

describe("Cloud internal collaboration execution at the production credential boundary", () => {
  it("opens a scope-free internal child with no IM provider and mints a usable Session CLI proof", async () => {
    const state = await internalCloudFixture();
    const stack = cloudCredentialStack(state);
    const result = await stack.delivery.handleCredentialFrame(stack.connection, stack.frame);
    if (result?.type !== "runtime:execution:result" || result.status !== "succeeded") {
      throw new Error(`internal Cloud open was rejected: ${JSON.stringify(result)}`);
    }
    expect(result.providers).toEqual([]);
    expect(result.services).toBeUndefined();
    const record = stack.executions.get(result.executionId);
    expect(record).toMatchObject({
      internalAuthority: "cloud-session-collaboration",
      computerKind: "cloud",
      sessionId: state.internal.id,
    });
    expect(record?.providers.size).toBe(0);

    // The proof is usable exactly at the production boundary that mints it.
    expect(result.sessionCliProof).toBeDefined();
    const proof = result.sessionCliProof;
    if (!proof) throw new Error("internal Cloud open did not mint a Session CLI proof");
    await expect(stack.proofs.authenticate(proof.token)).resolves.toMatchObject({
      computerId: state.computer.id,
      sessionId: state.internal.id,
      sessionKind: "internal",
    });

    // The parent/visible IM binding is never reachable through the internal execution.
    const acquire = await ownerHandle(stack, {
      type: "runtime:credential:acquire",
      requestId: randomUUID(),
      executionId: result.executionId,
      provider: "slack",
      bindingId: state.imBindingId,
    });
    expect(acquire).toMatchObject({ type: "runtime:credential:result", status: "rejected", code: "provider_mismatch" });

    // Execution close drops the proof immediately; the old token can never revive.
    const closed = await ownerHandle(stack, {
      type: "runtime:execution:close",
      requestId: randomUUID(),
      executionId: result.executionId,
    });
    expect(closed).toMatchObject({ status: "succeeded" });
    await expect(stack.proofs.authenticate(proof.token)).rejects.toMatchObject({ code: "invalid_proof" });
    stack.owner.close();
  });

  it("uses explicitly authorized GitHub and web scope while still denying IM, then stops on settlement", async () => {
    const state = await internalCloudFixture();
    const admission: RuntimeGitHubAdmission = {
      admit: async (): Promise<RuntimeGitHubAdmissionResult> => ({
        connectionId: "connection-github",
        authorizationVersion: "42",
        credentialGeneration: "7",
        bindings: [{ repositoryId: "1", fullName: "acme/repo", role: "code", access: "read" }],
      }),
    };
    const stack = cloudCredentialStack(state, {
      gitHubAdmission: admission,
      taskPolicy: { authorize: () => "permit" },
      webPolicy: { authorizeWeb: () => ["web:fetch"] },
    });
    const webContext: RuntimeBusinessContext = {
      ...stack.context,
      negotiatedCapabilities: {
        ...stack.context.negotiatedCapabilities,
        [RUNTIME_CAPABILITY.webTools]: 1,
      },
    };
    const opened = await ownerHandle(stack, { ...stack.frame, services: ["web"] }, webContext);
    if (opened?.type !== "runtime:execution:result" || opened.status !== "succeeded") {
      throw new Error(`internal Cloud open was rejected: ${JSON.stringify(opened)}`);
    }
    expect(opened.providers).toHaveLength(1);
    expect(opened.providers[0]).toMatchObject({ provider: "github", bindingId: "connection-github" });
    expect(opened.providers.some((provider) => provider.provider === "slack" || provider.provider === "feishu")).toBe(
      false,
    );
    expect(opened.services).toEqual([{ service: "web", scopes: ["web:fetch"] }]);

    // The real broker fence issues the GitHub capability for the internal execution...
    const acquire = await ownerHandle(
      stack,
      {
        type: "runtime:credential:acquire",
        requestId: randomUUID(),
        executionId: opened.executionId,
        provider: "github",
        bindingId: "connection-github",
      },
      webContext,
    );
    expect(acquire).toMatchObject({ status: "succeeded", provider: "github", cli: { provider: "github" } });

    // ...and the real web authorizer accepts its granted scope.
    const webAuthorizer = new RuntimeWebExecutionAuthorizer({
      executions: stack.executions,
      scopeResolver: new RuntimeScopeResolver(state.database),
      authority: stack.authority,
      connectionFence: stack.connectionFence,
      cloudControlActive: stack.cloudControlActive,
    });
    await expect(
      webAuthorizer.authorize({
        executionId: opened.executionId,
        computerId: state.computer.id,
        scope: "web:fetch",
      }),
    ).resolves.toMatchObject({ executionId: opened.executionId });

    // Settlement terminalizes the durable record while `session_messages.lastOutcome` stays
    // accepted; both per-request fences must stop the still-open execution.
    await state.database
      .update(runtimeDurableWork)
      .set({ status: "failed", updatedAt: Date.now() })
      .where(eq(runtimeDurableWork.recordKey, `${state.internal.id}:${state.messageId}`));
    const afterSettlement = await ownerHandle(
      stack,
      {
        type: "runtime:credential:acquire",
        requestId: randomUUID(),
        executionId: opened.executionId,
        provider: "github",
        bindingId: "connection-github",
      },
      webContext,
    );
    expect(afterSettlement).toMatchObject({ status: "rejected", code: "execution_closed" });
    await expect(
      webAuthorizer.authorize({
        executionId: opened.executionId,
        computerId: state.computer.id,
        scope: "web:fetch",
      }),
    ).rejects.toMatchObject({ code: "execution_closed" });
    stack.owner.close();
  });

  it("rejects non-negotiated, forged, stale-allocation, and settled sources", async () => {
    const state = await internalCloudFixture();
    const stack = cloudCredentialStack(state);
    const sandbox = stack.frame.sandbox;
    if (!sandbox) throw new Error("the Cloud open frame requires a Sandbox");

    const notNegotiated = await ownerHandle(stack, stack.frame, {
      ...stack.context,
      negotiatedCapabilities: {
        [RUNTIME_CAPABILITY.runtimeCredential]: 1,
        [RUNTIME_CAPABILITY.providerProxy]: 1,
      },
    });
    expect(notNegotiated).toMatchObject({ status: "rejected", code: "execution_authority_denied" });

    const forgedMessage = await ownerHandle(stack, {
      ...stack.frame,
      requestId: randomUUID(),
      source: { kind: "session-message", messageId: randomUUID() },
    });
    expect(forgedMessage).toMatchObject({ status: "rejected", code: "execution_source_invalid" });

    const forgedDelivery = await ownerHandle(stack, {
      ...stack.frame,
      requestId: randomUUID(),
      source: { kind: "delivery", deliveryId: randomUUID(), turnId: randomUUID() },
    });
    expect(forgedDelivery).toMatchObject({ status: "rejected", code: "execution_authority_denied" });

    const staleUid = await ownerHandle(stack, {
      ...stack.frame,
      requestId: randomUUID(),
      sandbox: { ...sandbox, resourceUid: "forged-resource-uid" },
    });
    expect(staleUid).toMatchObject({ status: "rejected", code: "sandbox_mismatch" });

    const staleGeneration = await ownerHandle(stack, {
      ...stack.frame,
      requestId: randomUUID(),
      sandbox: { ...sandbox, environmentGeneration: sandbox.environmentGeneration + 1 },
    });
    expect(staleGeneration).toMatchObject({ status: "rejected", code: "sandbox_mismatch" });

    const stalePlacement = await ownerHandle(stack, {
      ...stack.frame,
      requestId: randomUUID(),
      placementGeneration: stack.frame.placementGeneration + 1,
    });
    expect(stalePlacement).toMatchObject({ status: "rejected", code: "placement_stale" });

    // A replaced Sandbox allocation is stale even when the frame repeats the old identity.
    await state.database
      .update(sandboxes)
      .set({
        environmentGeneration: sandbox.environmentGeneration + 1,
        currentResourceName: `${state.resourceName}-next`,
        currentResourceUid: "next-resource-uid",
      })
      .where(eq(sandboxes.id, state.sandbox.id));
    const replacedAllocation = await ownerHandle(stack, { ...stack.frame, requestId: randomUUID() });
    expect(replacedAllocation).toMatchObject({ status: "rejected", code: "sandbox_mismatch" });

    // Restore the allocation, then settle the durable work: `lastOutcome` stays accepted but the
    // accepted work can never authorize a fresh execution again.
    await state.database
      .update(sandboxes)
      .set({
        environmentGeneration: sandbox.environmentGeneration,
        currentResourceName: state.resourceName,
        currentResourceUid: state.sandbox.currentResourceUid,
      })
      .where(eq(sandboxes.id, state.sandbox.id));
    await state.database
      .update(runtimeDurableWork)
      .set({ status: "failed", updatedAt: Date.now() })
      .where(eq(runtimeDurableWork.recordKey, `${state.internal.id}:${state.messageId}`));
    const settled = await ownerHandle(stack, { ...stack.frame, requestId: randomUUID() });
    expect(settled).toMatchObject({ status: "rejected", code: "execution_source_invalid" });
    stack.owner.close();
  });

  it("never lets accepted work recorded on another allocation authorize a fresh execution", async () => {
    const state = await internalCloudFixture();
    const stack = cloudCredentialStack(state);
    await state.database
      .update(runtimeDurableWork)
      .set({
        payload: {
          type: "cloud-session-message-work",
          request: {
            type: "session:message:deliver",
            requestId: state.messageId,
            messageId: state.messageId,
            sourceSessionId: state.session.id,
            targetSessionId: state.internal.id,
            agentId: state.agent.id,
            placementGeneration: 1,
            content: { kind: "text", text: "run the child task" },
            runtime: {
              contextTreeRepository: null,
              revision: { agent: { sequence: 1, id: "agent" }, session: { sequence: 1, id: "session" } },
              agentId: state.agent.id,
              provider: "pi",
              instructions: { platform: "platform", agent: "agent" },
              execution: { approvalPolicy: "never", networkAccess: false },
              workspace: { workspaceId: "workspace", mode: "empty_on_create", sharing: "agent" },
            },
          },
          allocation: {
            sandboxId: state.sandbox.id,
            environmentGeneration: state.sandbox.environmentGeneration,
            resourceName: `${state.resourceName}-previous`,
          },
          turnId: randomUUID(),
        },
      })
      .where(eq(runtimeDurableWork.recordKey, `${state.internal.id}:${state.messageId}`));
    const result = await ownerHandle(stack, { ...stack.frame, requestId: randomUUID() });
    expect(result).toMatchObject({ status: "rejected", code: "execution_source_invalid" });
    stack.owner.close();
  });

  it("keeps Local internal Sessions denied even with collaboration negotiated", async () => {
    const state = await fixture();
    const [internal] = await state.database
      .insert(sessions)
      .values({
        imBindingId: state.imBindingId,
        channelId: state.session.channelId,
        conversationKind: state.session.conversationKind,
        kind: "internal",
        threadKey: null,
        createdBySessionId: state.session.id,
      })
      .returning();
    if (!internal) throw new Error("Internal Session fixture was not created");
    await state.database.insert(sessionPlacements).values({
      sessionId: internal.id,
      computerId: state.computer.id,
      generation: 1,
    });
    const messageId = randomUUID();
    await state.database.insert(sessionMessages).values({
      id: messageId,
      sourceSessionId: state.session.id,
      targetSessionId: internal.id,
      content: "run the child task",
      contentHash: "d".repeat(64),
      lastOutcome: "accepted",
    });
    const stack = credentialOwnerStack(state, {
      controlAuthority: { isCurrentConnection: () => true },
      connectionFence: { isCurrent: () => true },
    });
    const result = await stack.owner.handle(
      {
        type: "runtime:execution:open",
        requestId: randomUUID(),
        sessionId: internal.id,
        agentId: state.agent.id,
        placementGeneration: 1,
        runId: randomUUID(),
        source: { kind: "session-message", messageId },
      },
      {
        computerId: state.computer.id,
        installationId: state.computer.currentInstallationId,
        connectionId: "local-connection",
        instanceId: INSTANCE_ID,
        negotiatedCapabilities: {
          [RUNTIME_CAPABILITY.runtimeCredential]: 1,
          [RUNTIME_CAPABILITY.providerProxy]: 1,
          [RUNTIME_CAPABILITY.sessionCollaboration]: CLOUD_SESSION_COLLABORATION_VERSION,
        },
        signal: new AbortController().signal,
      },
    );
    expect(result).toMatchObject({ status: "rejected", code: "execution_authority_denied" });
    stack.owner.close();
  });
});
