import { randomUUID } from "node:crypto";
import {
  RUNTIME_CAPABILITY,
  RUNTIME_CLIENT_CAPABILITY_TTL_MS,
  RUNTIME_PROVIDER_CLI_ARTIFACT_TTL_MS,
  RUNTIME_PROVIDER_CLI_CREDENTIAL_TTL_MS,
  RUNTIME_PROVIDER_CLI_REQUIREMENT_OPERATION,
} from "@opentag/shared";
import { describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { z } from "zod";
import { ConnectionRegistry } from "../runtime/connection-registry.js";
import { ProviderCliReconcileOwner } from "../runtime/provider-cli-reconcile-owner.js";

function socket(): WebSocket & { send: ReturnType<typeof vi.fn> } {
  return {
    readyState: WebSocket.OPEN,
    send: vi.fn((_data: string, cb?: (error?: Error) => void) => cb?.()),
    close: vi.fn(),
  } as unknown as WebSocket & { send: ReturnType<typeof vi.fn> };
}

async function registered(
  registry: ConnectionRegistry,
  options: { capabilities?: boolean; prewarm?: boolean; computerId?: string } = {},
) {
  const computerId = options.computerId ?? randomUUID();
  const instanceId = randomUUID();
  const installationId = randomUUID();
  const runtimeSocket = socket();
  await registry.register(
    {
      active: true,
      installationId,
      instanceId,
      computerId,
      lastHeartbeatAt: Date.now(),
      socket: runtimeSocket,
      negotiatedCapabilities:
        options.capabilities === false
          ? {}
          : {
              [RUNTIME_CAPABILITY.providerCliReconcile]: 1,
              ...(options.prewarm === false ? {} : { [RUNTIME_CAPABILITY.providerCliPrewarm]: 1 }),
            },
    },
    async () => undefined,
  );
  registry.activate(computerId, instanceId, runtimeSocket);
  return { installationId, instanceId, computerId, socket: runtimeSocket };
}

const identity = { provider: "slack" as const, teamId: "T1", botUserId: "U1", botId: "B1" };

/** Exact v1 prewarm wire shape shipped to already-deployed Clients. Extra keys fail `.strict()`. */
const LegacyProviderCliPrewarmFrameSchema = z
  .object({
    type: z.literal("provider-cli:prewarm"),
    requestId: z.string().uuid(),
    providers: z.array(z.enum(["feishu", "slack"])).min(1),
  })
  .strict();

function contextOf(connection: Awaited<ReturnType<typeof registered>>, overrides: Record<string, string> = {}) {
  return {
    installationId: connection.installationId,
    instanceId: connection.instanceId,
    signal: new AbortController().signal,
    computerId: connection.computerId,
    ...overrides,
  };
}

describe("ProviderCliReconcileOwner", () => {
  it("does not send unknown frames to old Clients and reports upgrade_required", async () => {
    const registry = new ConnectionRegistry();
    const bindings = {
      listActiveProviderCliRequirements: vi.fn(async () => [
        {
          agentId: randomUUID(),
          integrationId: randomUUID(),
          provider: "slack" as const,
          credentialGeneration: 1,
          expectedIdentity: identity,
        },
      ]),
      issueIntegrationCliValidationGrant: vi.fn(),
    };
    const owner = new ProviderCliReconcileOwner(registry, bindings);
    const connection = await registered(registry, { capabilities: false });
    await owner.onComputerRegistered(connection);
    expect(connection.socket.send).not.toHaveBeenCalled();
    expect(registry.providerCliCredentialReadiness(connection.computerId)[0]?.observation).toMatchObject({
      status: "needs_attention",
      reason: "upgrade_required",
    });
  });

  it("sends a secret-free requirement and a grant fenced to that requirement", async () => {
    const registry = new ConnectionRegistry();
    const agentId = randomUUID();
    const integrationId = randomUUID();
    const bindings = {
      listActiveProviderCliRequirements: vi.fn(async () => [
        { agentId, integrationId, provider: "slack" as const, credentialGeneration: 3, expectedIdentity: identity },
      ]),
      issueIntegrationCliValidationGrant: vi.fn(async () => ({
        expectedIdentity: identity,
        grant: { provider: "slack" as const, botAccessToken: "xoxb-secret" },
      })),
    };
    const owner = new ProviderCliReconcileOwner(registry, bindings);
    const connection = await registered(registry);
    await owner.onComputerRegistered(connection);
    const requirement = JSON.parse(connection.socket.send.mock.calls[0]?.[0] as string) as Record<string, unknown>;
    expect(requirement).toMatchObject({
      type: "provider-cli:requirement",
      operation: RUNTIME_PROVIDER_CLI_REQUIREMENT_OPERATION,
      provider: "slack",
      credentialGeneration: 3,
    });
    expect(JSON.stringify(requirement)).not.toContain("xoxb-secret");
    const requestId = requirement.requestId as string;
    await owner.businessOptions().handle(
      {
        type: "provider-cli:artifact:status",
        requestId,
        provider: "slack",
        agentId,
        integrationId,
        credentialGeneration: 3,
        status: "ready",
      },
      contextOf(connection),
    );
    expect(bindings.issueIntegrationCliValidationGrant).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId,
        installationId: connection.installationId,
        computerId: connection.computerId,
        credentialGeneration: 3,
      }),
    );
    const grant = JSON.parse(connection.socket.send.mock.calls.at(-1)?.[0] as string) as Record<string, unknown>;
    expect(grant).toMatchObject({
      type: "provider-cli:validation:grant",
      requirementRequestId: requestId,
    });
    const grantId = grant.requestId as string;
    await owner.businessOptions().handle(
      {
        type: "provider-cli:validation:result",
        requestId: grantId,
        provider: "slack",
        agentId,
        integrationId,
        credentialGeneration: 3,
        status: "ready",
      },
      contextOf(connection),
    );
    expect(registry.providerCliCredentialReadiness(connection.computerId)[0]?.observation.status).toBe("ready");
    await owner.businessOptions().handle(
      {
        type: "provider-cli:artifact:status",
        requestId,
        provider: "slack",
        agentId,
        integrationId,
        credentialGeneration: 3,
        status: "checking",
      },
      contextOf(connection),
    );
    expect(registry.providerCliCredentialReadiness(connection.computerId)[0]?.observation.status).toBe("unconfirmed");
    await owner.businessOptions().handle(
      {
        type: "provider-cli:validation:result",
        requestId: grantId,
        provider: "slack",
        agentId,
        integrationId,
        credentialGeneration: 3,
        status: "ready",
      },
      contextOf(connection),
    );
    expect(registry.providerCliCredentialReadiness(connection.computerId)).toHaveLength(1);
  });

  it("fails closed when fresh grant material does not match the requirement identity", async () => {
    const registry = new ConnectionRegistry();
    const agentId = randomUUID();
    const integrationId = randomUUID();
    const bindings = {
      listActiveProviderCliRequirements: vi.fn(async () => [
        { agentId, integrationId, provider: "slack" as const, credentialGeneration: 3, expectedIdentity: identity },
      ]),
      issueIntegrationCliValidationGrant: vi.fn(async () => ({
        expectedIdentity: { ...identity, teamId: "T-other" },
        grant: { provider: "slack" as const, botAccessToken: "xoxb-secret" },
      })),
    };
    const owner = new ProviderCliReconcileOwner(registry, bindings);
    const connection = await registered(registry);
    await owner.onComputerRegistered(connection);
    const requirement = JSON.parse(connection.socket.send.mock.calls[0]?.[0] as string) as { requestId: string };
    await owner.businessOptions().handle(
      {
        type: "provider-cli:artifact:status",
        requestId: requirement.requestId,
        provider: "slack",
        agentId,
        integrationId,
        credentialGeneration: 3,
        status: "ready",
      },
      contextOf(connection),
    );
    expect(connection.socket.send).toHaveBeenCalledTimes(1);
    expect(registry.providerCliCredentialReadiness(connection.computerId)[0]?.observation).toMatchObject({
      status: "needs_attention",
    });
  });

  it("accepts artifact status only for the current requirement requestId", async () => {
    const registry = new ConnectionRegistry();
    const agentId = randomUUID();
    const integrationId = randomUUID();
    const bindings = {
      listActiveProviderCliRequirements: vi.fn(async () => [
        { agentId, integrationId, provider: "slack" as const, credentialGeneration: 2, expectedIdentity: identity },
      ]),
      issueIntegrationCliValidationGrant: vi.fn(),
    };
    const owner = new ProviderCliReconcileOwner(registry, bindings);
    const connection = await registered(registry);
    await owner.onComputerRegistered(connection);
    await owner.businessOptions().handle(
      {
        type: "provider-cli:artifact:status",
        requestId: randomUUID(),
        provider: "slack",
        agentId,
        integrationId,
        credentialGeneration: 2,
        status: "ready",
      },
      contextOf(connection),
    );
    expect(bindings.issueIntegrationCliValidationGrant).not.toHaveBeenCalled();
  });

  it("rejects validation results that reuse the requirement requestId or a mismatched computer", async () => {
    const registry = new ConnectionRegistry();
    const agentId = randomUUID();
    const integrationId = randomUUID();
    const bindings = {
      listActiveProviderCliRequirements: vi.fn(async () => [
        { agentId, integrationId, provider: "slack" as const, credentialGeneration: 2, expectedIdentity: identity },
      ]),
      issueIntegrationCliValidationGrant: vi.fn(async () => ({
        expectedIdentity: identity,
        grant: { provider: "slack" as const, botAccessToken: "xoxb-secret" },
      })),
    };
    const owner = new ProviderCliReconcileOwner(registry, bindings);
    const connection = await registered(registry);
    await owner.onComputerRegistered(connection);
    const requirement = JSON.parse(connection.socket.send.mock.calls[0]?.[0] as string) as { requestId: string };
    await owner.businessOptions().handle(
      {
        type: "provider-cli:artifact:status",
        requestId: requirement.requestId,
        provider: "slack",
        agentId,
        integrationId,
        credentialGeneration: 2,
        status: "ready",
      },
      contextOf(connection),
    );
    const grant = JSON.parse(connection.socket.send.mock.calls.at(-1)?.[0] as string) as { requestId: string };
    await owner.businessOptions().handle(
      {
        type: "provider-cli:validation:result",
        requestId: requirement.requestId,
        provider: "slack",
        agentId,
        integrationId,
        credentialGeneration: 2,
        status: "ready",
      },
      contextOf(connection),
    );
    expect(registry.providerCliCredentialReadiness(connection.computerId)[0]?.observation.status).toBe("checking");
    await owner.businessOptions().handle(
      {
        type: "provider-cli:validation:result",
        requestId: grant.requestId,
        provider: "slack",
        agentId,
        integrationId,
        credentialGeneration: 2,
        status: "ready",
      },
      contextOf(connection, { installationId: randomUUID() }),
    );
    expect(registry.providerCliCredentialReadiness(connection.computerId)[0]?.observation.status).toBe("checking");
  });

  it("keeps rate_limited after bounded retries instead of rewriting it as provider_unreachable", async () => {
    const registry = new ConnectionRegistry();
    const agentId = randomUUID();
    const integrationId = randomUUID();
    const bindings = {
      listActiveProviderCliRequirements: vi.fn(async () => [
        { agentId, integrationId, provider: "slack" as const, credentialGeneration: 1, expectedIdentity: identity },
      ]),
      issueIntegrationCliValidationGrant: vi.fn(async () => ({
        expectedIdentity: identity,
        grant: { provider: "slack" as const, botAccessToken: "xoxb-secret" },
      })),
    };
    const owner = new ProviderCliReconcileOwner(registry, bindings, { maxRetries: 0 });
    const connection = await registered(registry);
    await owner.onComputerRegistered(connection);
    const requirement = JSON.parse(connection.socket.send.mock.calls[0]?.[0] as string) as { requestId: string };
    await owner.businessOptions().handle(
      {
        type: "provider-cli:artifact:status",
        requestId: requirement.requestId,
        provider: "slack",
        agentId,
        integrationId,
        credentialGeneration: 1,
        status: "ready",
      },
      contextOf(connection),
    );
    const grant = JSON.parse(connection.socket.send.mock.calls.at(-1)?.[0] as string) as { requestId: string };
    await owner.businessOptions().handle(
      {
        type: "provider-cli:validation:result",
        requestId: grant.requestId,
        provider: "slack",
        agentId,
        integrationId,
        credentialGeneration: 1,
        status: "retrying",
        reason: "rate_limited",
      },
      contextOf(connection),
    );
    expect(registry.providerCliCredentialReadiness(connection.computerId)[0]?.observation).toMatchObject({
      status: "needs_attention",
      reason: "rate_limited",
    });
  });

  it("rejects stale generation and does not let heartbeat PATH overwrite fenced artifact status", async () => {
    const registry = new ConnectionRegistry();
    const agentId = randomUUID();
    const integrationId = randomUUID();
    const bindings = {
      listActiveProviderCliRequirements: vi.fn(async () => [
        { agentId, integrationId, provider: "slack" as const, credentialGeneration: 2, expectedIdentity: identity },
      ]),
      issueIntegrationCliValidationGrant: vi.fn(),
    };
    const owner = new ProviderCliReconcileOwner(registry, bindings);
    const connection = await registered(registry);
    await owner.onComputerRegistered(connection);
    registry.touch(connection.computerId, connection.instanceId, connection.socket, Date.now(), undefined, undefined, [
      { provider: "slack", status: "ready" },
    ]);
    expect(
      registry.imCliReadiness(connection.computerId).some(({ observation }) => observation.status === "ready"),
    ).toBe(true);
    expect(
      registry
        .providerCliArtifactReadiness(connection.computerId)
        .some(({ observation }) => observation.status === "ready"),
    ).toBe(false);
    await owner.businessOptions().handle(
      {
        type: "provider-cli:artifact:status",
        requestId: randomUUID(),
        provider: "slack",
        agentId,
        integrationId,
        credentialGeneration: 1,
        status: "ready",
      },
      contextOf(connection),
    );
    expect(bindings.issueIntegrationCliValidationGrant).not.toHaveBeenCalled();
  });

  it("sends a secret-free cancel when the binding requirement disappears", async () => {
    const registry = new ConnectionRegistry();
    const agentId = randomUUID();
    const integrationId = randomUUID();
    const bindings = {
      listActiveProviderCliRequirements: vi
        .fn()
        .mockResolvedValueOnce([
          { agentId, integrationId, provider: "slack" as const, credentialGeneration: 2, expectedIdentity: identity },
        ])
        .mockResolvedValue([]),
      issueIntegrationCliValidationGrant: vi.fn(),
    };
    const owner = new ProviderCliReconcileOwner(registry, bindings);
    const connection = await registered(registry);
    await owner.onComputerRegistered(connection);
    const requirement = JSON.parse(connection.socket.send.mock.calls[0]?.[0] as string) as {
      requestId: string;
    };
    await owner.onActiveBindingChanged({ agentId, computerId: connection.computerId });
    const cancel = JSON.parse(connection.socket.send.mock.calls.at(-1)?.[0] as string) as Record<string, unknown>;
    expect(cancel).toMatchObject({
      type: "provider-cli:cancel",
      requirementRequestId: requirement.requestId,
      integrationId,
      credentialGeneration: 2,
    });
    expect(JSON.stringify(cancel)).not.toContain("xoxb");
    expect(cancel).not.toHaveProperty("grant");
  });

  it("coalesces demand-driven freshness reads and does not force in-flight work", async () => {
    const registry = new ConnectionRegistry();
    const agentId = randomUUID();
    const integrationId = randomUUID();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let listCalls = 0;
    const bindings = {
      listActiveProviderCliRequirements: vi.fn(async () => {
        listCalls += 1;
        await gate;
        return [
          { agentId, integrationId, provider: "slack" as const, credentialGeneration: 2, expectedIdentity: identity },
        ];
      }),
      issueIntegrationCliValidationGrant: vi.fn(),
    };
    const owner = new ProviderCliReconcileOwner(registry, bindings);
    const connection = await registered(registry);
    const first = owner.ensureActiveReadiness({
      agentId,
      computerId: connection.computerId,
    });
    const second = owner.ensureActiveReadiness({
      agentId,
      computerId: connection.computerId,
    });
    await vi.waitFor(() => expect(listCalls).toBe(1));
    release();
    await Promise.all([first, second]);
    expect(listCalls).toBe(1);
    expect(connection.socket.send).toHaveBeenCalledTimes(1);
    connection.socket.send.mockClear();
    await owner.ensureActiveReadiness({ agentId, computerId: connection.computerId });
    expect(connection.socket.send).not.toHaveBeenCalled();
  });

  it("revalidates expired ready observations but keeps terminal needs_attention", async () => {
    const registry = new ConnectionRegistry();
    const agentId = randomUUID();
    const integrationId = randomUUID();
    let now = 1_000;
    const bindings = {
      listActiveProviderCliRequirements: vi.fn(async () => [
        { agentId, integrationId, provider: "slack" as const, credentialGeneration: 2, expectedIdentity: identity },
      ]),
      issueIntegrationCliValidationGrant: vi.fn(async () => ({
        expectedIdentity: identity,
        grant: { provider: "slack" as const, botAccessToken: "xoxb-secret" },
      })),
    };
    const owner = new ProviderCliReconcileOwner(registry, bindings, { now: () => now });
    const connection = await registered(registry);
    await owner.onComputerRegistered(connection);
    const requirement = JSON.parse(connection.socket.send.mock.calls[0]?.[0] as string) as { requestId: string };
    await owner.businessOptions().handle(
      {
        type: "provider-cli:artifact:status",
        requestId: requirement.requestId,
        provider: "slack",
        agentId,
        integrationId,
        credentialGeneration: 2,
        status: "ready",
      },
      contextOf(connection),
    );
    const grant = JSON.parse(connection.socket.send.mock.calls.at(-1)?.[0] as string) as { requestId: string };
    await owner.businessOptions().handle(
      {
        type: "provider-cli:validation:result",
        requestId: grant.requestId,
        provider: "slack",
        agentId,
        integrationId,
        credentialGeneration: 2,
        status: "ready",
      },
      contextOf(connection),
    );
    connection.socket.send.mockClear();
    await owner.ensureActiveReadiness({ agentId, computerId: connection.computerId });
    expect(connection.socket.send).not.toHaveBeenCalled();
    now += RUNTIME_PROVIDER_CLI_ARTIFACT_TTL_MS + 1;
    expect(registry.providerCliArtifactReadiness(connection.computerId, now)).toEqual([]);
    expect(registry.providerCliCredentialReadiness(connection.computerId, now)).toEqual([]);
    await owner.ensureActiveReadiness({ agentId, computerId: connection.computerId });
    expect(JSON.parse(connection.socket.send.mock.calls.at(-1)?.[0] as string)).toMatchObject({
      type: "provider-cli:requirement",
    });

    const rejected = new ConnectionRegistry();
    const rejectedOwner = new ProviderCliReconcileOwner(rejected, bindings, { now: () => now });
    const rejectedConnection = await registered(rejected);
    await rejectedOwner.onComputerRegistered(rejectedConnection);
    const rejectedRequirement = JSON.parse(rejectedConnection.socket.send.mock.calls[0]?.[0] as string) as {
      requestId: string;
    };
    await rejectedOwner.businessOptions().handle(
      {
        type: "provider-cli:artifact:status",
        requestId: rejectedRequirement.requestId,
        provider: "slack",
        agentId,
        integrationId,
        credentialGeneration: 2,
        status: "ready",
      },
      contextOf(rejectedConnection),
    );
    const rejectedGrant = JSON.parse(rejectedConnection.socket.send.mock.calls.at(-1)?.[0] as string) as {
      requestId: string;
    };
    await rejectedOwner.businessOptions().handle(
      {
        type: "provider-cli:validation:result",
        requestId: rejectedGrant.requestId,
        provider: "slack",
        agentId,
        integrationId,
        credentialGeneration: 2,
        status: "needs_attention",
        reason: "credential_rejected",
      },
      contextOf(rejectedConnection),
    );
    now += RUNTIME_PROVIDER_CLI_CREDENTIAL_TTL_MS + 1;
    expect(rejected.providerCliCredentialReadiness(rejectedConnection.computerId, now)[0]?.observation).toMatchObject({
      status: "needs_attention",
      reason: "credential_rejected",
    });
    rejectedConnection.socket.send.mockClear();
    await rejectedOwner.ensureActiveReadiness({
      agentId,
      computerId: rejectedConnection.computerId,
    });
    expect(rejectedConnection.socket.send).not.toHaveBeenCalled();
  });

  it("accepts validation_expired after the grant TTL and still honors maxRetries", async () => {
    const registry = new ConnectionRegistry();
    const agentId = randomUUID();
    const integrationId = randomUUID();
    let now = 0;
    const bindings = {
      listActiveProviderCliRequirements: vi.fn(async () => [
        { agentId, integrationId, provider: "slack" as const, credentialGeneration: 1, expectedIdentity: identity },
      ]),
      issueIntegrationCliValidationGrant: vi.fn(async () => ({
        expectedIdentity: identity,
        grant: { provider: "slack" as const, botAccessToken: "xoxb-secret" },
      })),
    };
    const owner = new ProviderCliReconcileOwner(registry, bindings, {
      grantTtlMs: 15_000,
      maxRetries: 0,
      now: () => now,
    });
    const connection = await registered(registry);
    await owner.onComputerRegistered(connection);
    const requirement = JSON.parse(connection.socket.send.mock.calls[0]?.[0] as string) as { requestId: string };
    await owner.businessOptions().handle(
      {
        type: "provider-cli:artifact:status",
        requestId: requirement.requestId,
        provider: "slack",
        agentId,
        integrationId,
        credentialGeneration: 1,
        status: "ready",
      },
      contextOf(connection),
    );
    const grant = JSON.parse(connection.socket.send.mock.calls.at(-1)?.[0] as string) as { requestId: string };
    now = 16_000;
    await owner.businessOptions().handle(
      {
        type: "provider-cli:validation:result",
        requestId: grant.requestId,
        provider: "slack",
        agentId,
        integrationId,
        credentialGeneration: 1,
        status: "retrying",
        reason: "validation_expired",
      },
      contextOf(connection),
    );
    expect(registry.providerCliCredentialReadiness(connection.computerId, now)[0]?.observation.status).toBe(
      "needs_attention",
    );

    const retrying = new ConnectionRegistry();
    now = 0;
    const retryOwner = new ProviderCliReconcileOwner(retrying, bindings, {
      grantTtlMs: 15_000,
      maxRetries: 1,
      now: () => now,
      random: () => 0.5,
    });
    const retryConnection = await registered(retrying);
    await retryOwner.onComputerRegistered(retryConnection);
    const retryRequirement = JSON.parse(retryConnection.socket.send.mock.calls[0]?.[0] as string) as {
      requestId: string;
    };
    await retryOwner.businessOptions().handle(
      {
        type: "provider-cli:artifact:status",
        requestId: retryRequirement.requestId,
        provider: "slack",
        agentId,
        integrationId,
        credentialGeneration: 1,
        status: "ready",
      },
      contextOf(retryConnection),
    );
    const firstGrant = JSON.parse(retryConnection.socket.send.mock.calls.at(-1)?.[0] as string) as {
      requestId: string;
    };
    now = 16_000;
    vi.useFakeTimers();
    await retryOwner.businessOptions().handle(
      {
        type: "provider-cli:validation:result",
        requestId: firstGrant.requestId,
        provider: "slack",
        agentId,
        integrationId,
        credentialGeneration: 1,
        status: "retrying",
        reason: "validation_expired",
      },
      contextOf(retryConnection),
    );
    await vi.advanceTimersByTimeAsync(1000);
    vi.useRealTimers();
    const secondGrant = JSON.parse(retryConnection.socket.send.mock.calls.at(-1)?.[0] as string) as {
      requestId: string;
      type: string;
    };
    expect(secondGrant).toMatchObject({ type: "provider-cli:validation:grant" });
    expect(secondGrant.requestId).not.toBe(firstGrant.requestId);
  });

  it("re-drives a retained unavailable artifact from a demand read instead of waiting for reconnect", async () => {
    /*
     * The daemon lost the foreground installer's lock race and reported unavailable; with no
     * retry budget left, the observation is retained but nothing is in flight. A demand-driven
     * readiness read (the handoff poll) must restart the requirement on the same connection.
     */
    const registry = new ConnectionRegistry();
    const agentId = randomUUID();
    const integrationId = randomUUID();
    const bindings = {
      listActiveProviderCliRequirements: vi.fn(async () => [
        { agentId, integrationId, provider: "slack" as const, credentialGeneration: 1, expectedIdentity: identity },
      ]),
      issueIntegrationCliValidationGrant: vi.fn(async () => ({
        expectedIdentity: identity,
        grant: { provider: "slack" as const, botAccessToken: "xoxb-secret" },
      })),
    };
    const owner = new ProviderCliReconcileOwner(registry, bindings, { maxRetries: 0 });
    const connection = await registered(registry);
    await owner.onComputerRegistered(connection);
    const requirement = JSON.parse(connection.socket.send.mock.calls[0]?.[0] as string) as { requestId: string };
    await owner.businessOptions().handle(
      {
        type: "provider-cli:artifact:status",
        requestId: requirement.requestId,
        provider: "slack",
        agentId,
        integrationId,
        credentialGeneration: 1,
        status: "unavailable",
      },
      contextOf(connection),
    );
    expect(registry.providerCliArtifactReadiness(connection.computerId)[0]?.observation.status).toBe("unavailable");

    connection.socket.send.mockClear();
    await owner.ensureActiveReadiness({ agentId, computerId: connection.computerId });

    const frames = connection.socket.send.mock.calls.map(
      (call) => JSON.parse(call[0] as string) as Record<string, unknown>,
    );
    expect(frames[0]).toMatchObject({ type: "provider-cli:cancel", requirementRequestId: requirement.requestId });
    expect(frames[1]).toMatchObject({ type: "provider-cli:requirement", agentId, integrationId });
    expect(frames[1]?.requestId).not.toBe(requirement.requestId);

    await owner.businessOptions().handle(
      {
        type: "provider-cli:artifact:status",
        requestId: frames[1]?.requestId,
        provider: "slack",
        agentId,
        integrationId,
        credentialGeneration: 1,
        status: "ready",
      },
      contextOf(connection),
    );
    expect(bindings.issueIntegrationCliValidationGrant).toHaveBeenCalledWith(
      expect.objectContaining({ agentId, integrationId, credentialGeneration: 1 }),
    );
  });

  it("does not redispatch an unavailable artifact while a bounded retry is still armed", async () => {
    const registry = new ConnectionRegistry();
    const agentId = randomUUID();
    const integrationId = randomUUID();
    const bindings = {
      listActiveProviderCliRequirements: vi.fn(async () => [
        { agentId, integrationId, provider: "slack" as const, credentialGeneration: 1, expectedIdentity: identity },
      ]),
      issueIntegrationCliValidationGrant: vi.fn(),
    };
    const owner = new ProviderCliReconcileOwner(registry, bindings, { maxRetries: 1, random: () => 0.5 });
    const connection = await registered(registry);
    await owner.onComputerRegistered(connection);
    const requirement = JSON.parse(connection.socket.send.mock.calls[0]?.[0] as string) as { requestId: string };

    vi.useFakeTimers();
    try {
      await owner.businessOptions().handle(
        {
          type: "provider-cli:artifact:status",
          requestId: requirement.requestId,
          provider: "slack",
          agentId,
          integrationId,
          credentialGeneration: 1,
          status: "unavailable",
        },
        contextOf(connection),
      );
      connection.socket.send.mockClear();
      await owner.ensureActiveReadiness({ agentId, computerId: connection.computerId });
      expect(connection.socket.send).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1000);
      const frames = connection.socket.send.mock.calls.map(
        (call) => JSON.parse(call[0] as string) as Record<string, unknown>,
      );
      expect(frames.at(-1)).toMatchObject({ type: "provider-cli:requirement", agentId, integrationId });
      expect(frames.at(-1)?.requestId).not.toBe(requirement.requestId);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels the old Computer and dispatches only the new Computer after Agent rebind", async () => {
    const registry = new ConnectionRegistry();
    const agentId = randomUUID();
    const integrationId = randomUUID();
    const first = await registered(registry);
    const second = await registered(registry);
    let host = first.computerId;
    const bindings = {
      listActiveProviderCliRequirements: vi.fn(async (computerId: string) =>
        computerId === host
          ? [
              {
                agentId,
                integrationId,
                provider: "slack" as const,
                credentialGeneration: 4,
                expectedIdentity: identity,
              },
            ]
          : [],
      ),
      issueIntegrationCliValidationGrant: vi.fn(async () => ({
        expectedIdentity: identity,
        grant: { provider: "slack" as const, botAccessToken: "xoxb-secret" },
      })),
    };
    const owner = new ProviderCliReconcileOwner(registry, bindings);
    await owner.onComputerRegistered(first);
    await owner.onComputerRegistered(second);
    const requirement = JSON.parse(first.socket.send.mock.calls[0]?.[0] as string) as { requestId: string };
    await owner.businessOptions().handle(
      {
        type: "provider-cli:artifact:status",
        requestId: requirement.requestId,
        provider: "slack",
        agentId,
        integrationId,
        credentialGeneration: 4,
        status: "ready",
      },
      contextOf(first),
    );
    const grant = JSON.parse(first.socket.send.mock.calls.at(-1)?.[0] as string) as { requestId: string };
    host = second.computerId;
    await owner.onAgentPlacementChanged({
      agentId,
      previousComputerId: first.computerId,
      computerId: second.computerId,
    });
    const cancel = JSON.parse(first.socket.send.mock.calls.at(-1)?.[0] as string) as Record<string, unknown>;
    expect(cancel).toMatchObject({
      type: "provider-cli:cancel",
      requirementRequestId: requirement.requestId,
      credentialGeneration: 4,
    });
    expect(JSON.parse(second.socket.send.mock.calls.at(-1)?.[0] as string)).toMatchObject({
      type: "provider-cli:requirement",
      credentialGeneration: 4,
    });
    await owner.businessOptions().handle(
      {
        type: "provider-cli:validation:result",
        requestId: grant.requestId,
        provider: "slack",
        agentId,
        integrationId,
        credentialGeneration: 4,
        status: "ready",
      },
      contextOf(first),
    );
    expect(
      registry
        .providerCliCredentialReadiness(second.computerId)
        .some(({ observation }) => observation.status === "ready"),
    ).toBe(false);
  });

  it("authorizes a one-time inspection of both official CLIs during first setup", async () => {
    const registry = new ConnectionRegistry();
    const shouldPrewarmOfficialProviderClis = vi.fn(async () => true);
    const issueIntegrationCliValidationGrant = vi.fn();
    const owner = new ProviderCliReconcileOwner(registry, {
      listActiveProviderCliRequirements: vi.fn(async () => []),
      issueIntegrationCliValidationGrant,
      shouldPrewarmOfficialProviderClis,
    });
    const connection = await registered(registry);
    await owner.onComputerRegistered(connection);
    expect(shouldPrewarmOfficialProviderClis).toHaveBeenCalledWith(connection.computerId);
    expect(connection.socket.send).toHaveBeenCalledTimes(1);
    const prewarm = JSON.parse(connection.socket.send.mock.calls[0]?.[0] as string) as Record<string, unknown>;
    expect(Object.keys(prewarm).sort()).toEqual(["providers", "requestId", "type"]);
    expect(prewarm).toMatchObject({
      type: "provider-cli:prewarm",
      providers: ["feishu", "slack"],
    });
    expect(JSON.stringify(connection.socket.send.mock.calls[0]?.[0])).not.toContain("xoxb");
    expect(JSON.stringify(connection.socket.send.mock.calls[0]?.[0])).not.toContain("appSecret");
    // An Agent without messaging setup gets inspection only: no requirement or validation grant.
    expect(issueIntegrationCliValidationGrant).not.toHaveBeenCalled();
  });

  it("requests ensure-and-repair when an Agent is placed on an already connected Computer", async () => {
    const registry = new ConnectionRegistry();
    const shouldPrewarmOfficialProviderClis = vi.fn(async () => true);
    const owner = new ProviderCliReconcileOwner(registry, {
      listActiveProviderCliRequirements: vi.fn(async () => []),
      issueIntegrationCliValidationGrant: vi.fn(),
      shouldPrewarmOfficialProviderClis,
    });
    const connection = await registered(registry);

    await owner.onAgentPlacementChanged({
      agentId: randomUUID(),
      computerId: connection.computerId,
      runtimeProvider: "codex",
    });

    expect(shouldPrewarmOfficialProviderClis).toHaveBeenCalledWith(connection.computerId);
    expect(connection.socket.send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(connection.socket.send.mock.calls[0]?.[0] as string)).toMatchObject({
      type: "provider-cli:prewarm",
      mode: "ensure",
      runtimeProvider: "codex",
      providers: ["feishu", "slack"],
    });
    owner.close();
  });

  it("fences Server-owned preparation so old heartbeats and results cannot restore stale ready", async () => {
    const registry = new ConnectionRegistry();
    const owner = new ProviderCliReconcileOwner(registry, {
      listActiveProviderCliRequirements: vi.fn(async () => []),
      issueIntegrationCliValidationGrant: vi.fn(),
      shouldPrewarmOfficialProviderClis: vi.fn(async () => true),
    });
    const connection = await registered(registry);
    expect(
      registry.touch(
        connection.computerId,
        connection.instanceId,
        connection.socket,
        10,
        undefined,
        [{ provider: "codex", status: "ready" }],
        [
          { provider: "feishu", status: "ready" },
          { provider: "slack", status: "ready" },
        ],
      ),
    ).toBe(true);

    await owner.prepareComputer({
      agentId: randomUUID(),
      computerId: connection.computerId,
      runtimeProvider: "codex",
    });
    const request = JSON.parse(connection.socket.send.mock.calls[0]?.[0] as string) as { requestId: string };
    expect(registry.providerReadiness(connection.computerId)[0]?.observation.status).toBe("checking");
    expect(registry.imCliReadiness(connection.computerId).map(({ observation }) => observation.status)).toEqual([
      "checking",
      "checking",
    ]);

    // A generic heartbeat may have been emitted before the daemon received this request. It must
    // update liveness without completing the operation or restoring the last ready snapshot.
    expect(
      registry.touch(
        connection.computerId,
        connection.instanceId,
        connection.socket,
        Date.now(),
        undefined,
        [{ provider: "codex", status: "ready" }],
        [
          { provider: "feishu", status: "ready" },
          { provider: "slack", status: "ready" },
        ],
      ),
    ).toBe(true);
    expect(registry.providerReadiness(connection.computerId)[0]?.observation.status).toBe("checking");

    await owner.businessOptions().handle(
      {
        type: "provider-cli:prewarm:result",
        requestId: randomUUID(),
        runtime: { provider: "codex", status: "ready" },
        providers: [
          { provider: "feishu", status: "ready" },
          { provider: "slack", status: "ready" },
        ],
      },
      contextOf(connection),
    );
    expect(registry.providerReadiness(connection.computerId)[0]?.observation.status).toBe("checking");

    await owner.businessOptions().handle(
      {
        type: "provider-cli:prewarm:result",
        requestId: request.requestId,
        runtime: { provider: "codex", status: "sign-in" },
        providers: [
          { provider: "feishu", status: "ready" },
          { provider: "slack", status: "install" },
        ],
      },
      contextOf(connection),
    );
    expect(registry.providerReadiness(connection.computerId)[0]?.observation.status).toBe("sign-in");
    expect(registry.imCliReadiness(connection.computerId).map(({ observation }) => observation.status)).toEqual([
      "ready",
      "install",
    ]);
    owner.close();
  });

  it("releases a checking fence when a strict legacy Client drops the extended prewarm", async () => {
    vi.useFakeTimers();
    const registry = new ConnectionRegistry();
    const owner = new ProviderCliReconcileOwner(
      registry,
      {
        listActiveProviderCliRequirements: vi.fn(async () => []),
        issueIntegrationCliValidationGrant: vi.fn(),
        shouldPrewarmOfficialProviderClis: vi.fn(async () => true),
      },
      { preparationTimeoutMs: 1_000 },
    );
    try {
      const connection = await registered(registry);
      expect(
        registry.touch(
          connection.computerId,
          connection.instanceId,
          connection.socket,
          Date.now(),
          undefined,
          [{ provider: "codex", status: "ready" }],
          [
            { provider: "feishu", status: "ready" },
            { provider: "slack", status: "ready" },
          ],
        ),
      ).toBe(true);

      await owner.prepareComputer({
        agentId: randomUUID(),
        computerId: connection.computerId,
        runtimeProvider: "codex",
      });
      const frame = JSON.parse(connection.socket.send.mock.calls[0]?.[0] as string) as Record<string, unknown>;
      expect(frame).toMatchObject({
        type: "provider-cli:prewarm",
        mode: "ensure",
        runtimeProvider: "codex",
        providers: ["feishu", "slack"],
      });
      expect(() => LegacyProviderCliPrewarmFrameSchema.parse(frame)).toThrow();
      expect(registry.providerReadiness(connection.computerId)[0]?.observation.status).toBe("checking");
      expect(registry.imCliReadiness(connection.computerId).map(({ observation }) => observation.status)).toEqual([
        "checking",
        "checking",
      ]);

      expect(
        registry.touch(
          connection.computerId,
          connection.instanceId,
          connection.socket,
          Date.now(),
          undefined,
          [{ provider: "codex", status: "ready" }],
          [
            { provider: "feishu", status: "ready" },
            { provider: "slack", status: "ready" },
          ],
        ),
      ).toBe(true);
      expect(registry.providerReadiness(connection.computerId)[0]?.observation.status).toBe("checking");

      // A schema-valid but mismatched result must not disarm the fallback for the real request.
      await owner.businessOptions().handle(
        {
          type: "provider-cli:prewarm:result",
          requestId: frame.requestId as string,
          runtime: { provider: "claude-code", status: "ready" },
          providers: [
            { provider: "feishu", status: "ready" },
            { provider: "slack", status: "ready" },
          ],
        },
        contextOf(connection),
      );
      expect(registry.providerReadiness(connection.computerId)[0]?.observation.status).toBe("checking");

      await vi.advanceTimersByTimeAsync(999);
      expect(registry.providerReadiness(connection.computerId)[0]?.observation.status).toBe("checking");

      await vi.advanceTimersByTimeAsync(1);
      expect(registry.providerReadiness(connection.computerId)[0]?.observation.status).toBe("unavailable");
      expect(registry.imCliReadiness(connection.computerId).map(({ observation }) => observation.status)).toEqual([
        "unavailable",
        "unavailable",
      ]);

      expect(
        registry.touch(
          connection.computerId,
          connection.instanceId,
          connection.socket,
          Date.now(),
          undefined,
          [{ provider: "codex", status: "checking" }],
          [
            { provider: "feishu", status: "checking" },
            { provider: "slack", status: "checking" },
          ],
        ),
      ).toBe(true);
      expect(registry.providerReadiness(connection.computerId)[0]?.observation.status).toBe("unavailable");
      expect(registry.imCliReadiness(connection.computerId).map(({ observation }) => observation.status)).toEqual([
        "unavailable",
        "unavailable",
      ]);

      expect(
        registry.touch(
          connection.computerId,
          connection.instanceId,
          connection.socket,
          Date.now(),
          undefined,
          [{ provider: "codex", status: "ready" }],
          [
            { provider: "feishu", status: "ready" },
            { provider: "slack", status: "ready" },
          ],
        ),
      ).toBe(true);
      expect(registry.providerReadiness(connection.computerId)[0]?.observation.status).toBe("unavailable");
      expect(registry.imCliReadiness(connection.computerId).map(({ observation }) => observation.status)).toEqual([
        "unavailable",
        "unavailable",
      ]);
    } finally {
      owner.close();
      vi.useRealTimers();
    }
  });

  it("does not let a stale ready heartbeat restore fallback unavailable", async () => {
    vi.useFakeTimers();
    const registry = new ConnectionRegistry();
    const owner = new ProviderCliReconcileOwner(
      registry,
      {
        listActiveProviderCliRequirements: vi.fn(async () => []),
        issueIntegrationCliValidationGrant: vi.fn(),
        shouldPrewarmOfficialProviderClis: vi.fn(async () => true),
      },
      { preparationTimeoutMs: 1_000 },
    );
    try {
      const connection = await registered(registry);
      expect(
        registry.touch(
          connection.computerId,
          connection.instanceId,
          connection.socket,
          Date.now(),
          undefined,
          [{ provider: "codex", status: "ready" }],
          [
            { provider: "feishu", status: "ready" },
            { provider: "slack", status: "ready" },
          ],
        ),
      ).toBe(true);

      await owner.prepareComputer({
        agentId: randomUUID(),
        computerId: connection.computerId,
        runtimeProvider: "codex",
      });
      const request = JSON.parse(connection.socket.send.mock.calls[0]?.[0] as string) as { requestId: string };
      await vi.advanceTimersByTimeAsync(1_000);
      expect(registry.providerReadiness(connection.computerId)[0]?.observation.status).toBe("unavailable");

      expect(
        registry.touch(
          connection.computerId,
          connection.instanceId,
          connection.socket,
          Date.now(),
          undefined,
          [{ provider: "codex", status: "ready" }],
          [
            { provider: "feishu", status: "ready" },
            { provider: "slack", status: "ready" },
          ],
        ),
      ).toBe(true);
      expect(registry.providerReadiness(connection.computerId)[0]?.observation.status).toBe("unavailable");
      expect(registry.imCliReadiness(connection.computerId).map(({ observation }) => observation.status)).toEqual([
        "unavailable",
        "unavailable",
      ]);

      await owner.businessOptions().handle(
        {
          type: "provider-cli:prewarm:result",
          requestId: request.requestId,
          runtime: { provider: "codex", status: "sign-in" },
          providers: [
            { provider: "feishu", status: "ready" },
            { provider: "slack", status: "install" },
          ],
        },
        contextOf(connection),
      );
      expect(registry.providerReadiness(connection.computerId)[0]?.observation.status).toBe("sign-in");
      expect(registry.imCliReadiness(connection.computerId).map(({ observation }) => observation.status)).toEqual([
        "ready",
        "install",
      ]);
    } finally {
      owner.close();
      vi.useRealTimers();
    }
  });

  it("keeps a matching preparation result when the fallback timer later fires", async () => {
    vi.useFakeTimers();
    const registry = new ConnectionRegistry();
    const owner = new ProviderCliReconcileOwner(
      registry,
      {
        listActiveProviderCliRequirements: vi.fn(async () => []),
        issueIntegrationCliValidationGrant: vi.fn(),
        shouldPrewarmOfficialProviderClis: vi.fn(async () => true),
      },
      { preparationTimeoutMs: 1_000 },
    );
    try {
      const connection = await registered(registry);
      await owner.prepareComputer({
        agentId: randomUUID(),
        computerId: connection.computerId,
        runtimeProvider: "codex",
      });
      const request = JSON.parse(connection.socket.send.mock.calls[0]?.[0] as string) as { requestId: string };
      await owner.businessOptions().handle(
        {
          type: "provider-cli:prewarm:result",
          requestId: request.requestId,
          runtime: { provider: "codex", status: "sign-in" },
          providers: [
            { provider: "feishu", status: "ready" },
            { provider: "slack", status: "install" },
          ],
        },
        contextOf(connection),
      );
      expect(registry.providerReadiness(connection.computerId)[0]?.observation.status).toBe("sign-in");

      await vi.advanceTimersByTimeAsync(1_000);
      expect(registry.providerReadiness(connection.computerId)[0]?.observation.status).toBe("sign-in");
      expect(registry.imCliReadiness(connection.computerId).map(({ observation }) => observation.status)).toEqual([
        "ready",
        "install",
      ]);
    } finally {
      owner.close();
      vi.useRealTimers();
    }
  });

  it("does not apply a replaced Computer's preparation fallback to the new instance", async () => {
    vi.useFakeTimers();
    const registry = new ConnectionRegistry();
    const owner = new ProviderCliReconcileOwner(
      registry,
      {
        listActiveProviderCliRequirements: vi.fn(async () => []),
        issueIntegrationCliValidationGrant: vi.fn(),
        shouldPrewarmOfficialProviderClis: vi.fn(async () => true),
      },
      { preparationTimeoutMs: 1_000 },
    );
    try {
      const first = await registered(registry);
      await owner.prepareComputer({
        agentId: randomUUID(),
        computerId: first.computerId,
        runtimeProvider: "codex",
      });
      expect(registry.providerReadiness(first.computerId)[0]?.observation.status).toBe("checking");

      const second = await registered(registry, { computerId: first.computerId });
      await owner.onComputerRegistered(second);
      const inspect = JSON.parse(second.socket.send.mock.calls[0]?.[0] as string) as Record<string, unknown>;
      expect(Object.keys(inspect).sort()).toEqual(["providers", "requestId", "type"]);
      expect(registry.providerReadiness(second.computerId)).toEqual([]);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(registry.providerReadiness(second.computerId)).toEqual([]);
      expect(registry.imCliReadiness(second.computerId)).toEqual([]);
    } finally {
      owner.close();
      vi.useRealTimers();
    }
  });

  it("still reconciles active bindings when Computer preparation is ineligible", async () => {
    const registry = new ConnectionRegistry();
    const agentId = randomUUID();
    const integrationId = randomUUID();
    const owner = new ProviderCliReconcileOwner(registry, {
      listActiveProviderCliRequirements: vi.fn(async () => [
        { agentId, integrationId, provider: "slack" as const, credentialGeneration: 2, expectedIdentity: identity },
      ]),
      issueIntegrationCliValidationGrant: vi.fn(),
      shouldPrewarmOfficialProviderClis: vi.fn(async () => false),
    });
    const connection = await registered(registry);

    await expect(
      owner.onAgentPlacementChanged({
        agentId,
        computerId: connection.computerId,
        runtimeProvider: "codex",
      }),
    ).rejects.toThrow("The Computer preparation operation could not be started");

    expect(connection.socket.send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(connection.socket.send.mock.calls[0]?.[0] as string)).toMatchObject({
      type: "provider-cli:requirement",
      provider: "slack",
      agentId,
      integrationId,
    });
  });

  it("still reconciles active bindings when Computer preparation send fails", async () => {
    const registry = new ConnectionRegistry();
    const agentId = randomUUID();
    const integrationId = randomUUID();
    const owner = new ProviderCliReconcileOwner(registry, {
      listActiveProviderCliRequirements: vi.fn(async () => [
        { agentId, integrationId, provider: "slack" as const, credentialGeneration: 2, expectedIdentity: identity },
      ]),
      issueIntegrationCliValidationGrant: vi.fn(),
      shouldPrewarmOfficialProviderClis: vi.fn(async () => true),
    });
    const connection = await registered(registry);
    connection.socket.send.mockImplementationOnce((_data: string, cb?: (error?: Error) => void) =>
      cb?.(new Error("socket closed")),
    );

    await expect(
      owner.onAgentPlacementChanged({
        agentId,
        computerId: connection.computerId,
        runtimeProvider: "codex",
      }),
    ).rejects.toThrow("The Computer preparation operation could not be started");

    const frames = connection.socket.send.mock.calls.map(
      (call) => JSON.parse(call[0] as string) as Record<string, unknown>,
    );
    expect(frames.map((frame) => frame.type)).toEqual(["provider-cli:prewarm", "provider-cli:requirement"]);
    expect(frames[1]).toMatchObject({ type: "provider-cli:requirement", provider: "slack", agentId, integrationId });
  });

  it("does not keep requesting unselected CLI inspection after setup is complete", async () => {
    const registry = new ConnectionRegistry();
    const owner = new ProviderCliReconcileOwner(registry, {
      listActiveProviderCliRequirements: vi.fn(async () => []),
      issueIntegrationCliValidationGrant: vi.fn(),
      shouldPrewarmOfficialProviderClis: vi.fn(async () => false),
    });
    const connection = await registered(registry);
    await owner.onComputerRegistered(connection);
    expect(connection.socket.send).not.toHaveBeenCalled();
  });

  it("does not send prewarm frames when the capability was not negotiated", async () => {
    const registry = new ConnectionRegistry();
    const owner = new ProviderCliReconcileOwner(registry, {
      listActiveProviderCliRequirements: vi.fn(async () => []),
      issueIntegrationCliValidationGrant: vi.fn(),
      shouldPrewarmOfficialProviderClis: vi.fn(async () => true),
    });
    const connection = await registered(registry, { prewarm: false });
    await owner.onComputerRegistered(connection);
    expect(connection.socket.send).not.toHaveBeenCalled();
  });

  it("keeps active-Integration reconcile running when the setup prewarm policy cannot be read", async () => {
    const registry = new ConnectionRegistry();
    const agentId = randomUUID();
    const integrationId = randomUUID();
    const owner = new ProviderCliReconcileOwner(registry, {
      listActiveProviderCliRequirements: vi.fn(async () => [
        { agentId, integrationId, provider: "slack" as const, credentialGeneration: 1, expectedIdentity: identity },
      ]),
      issueIntegrationCliValidationGrant: vi.fn(),
      shouldPrewarmOfficialProviderClis: vi.fn(async () => {
        throw new Error("setup state unavailable");
      }),
    });
    const connection = await registered(registry);

    await owner.onComputerRegistered(connection);

    expect(connection.socket.send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(connection.socket.send.mock.calls[0]?.[0] as string)).toMatchObject({
      type: "provider-cli:requirement",
      agentId,
      integrationId,
    });
  });

  it.each(["missing", "expired"])("repeats inspection on reconnect with %s observations", async (state) => {
    const registry = new ConnectionRegistry();
    const shouldPrewarmOfficialProviderClis = vi.fn(async () => true);
    const issueIntegrationCliValidationGrant = vi.fn();
    const owner = new ProviderCliReconcileOwner(registry, {
      listActiveProviderCliRequirements: vi.fn(async () => []),
      issueIntegrationCliValidationGrant,
      shouldPrewarmOfficialProviderClis,
    });
    const first = await registered(registry);
    await owner.onComputerRegistered(first);
    expect(first.socket.send).toHaveBeenCalledTimes(1);
    const firstFrame = JSON.parse(first.socket.send.mock.calls[0]?.[0] as string) as { requestId: string };

    if (state === "expired") {
      const observedAt = Date.now() - RUNTIME_CLIENT_CAPABILITY_TTL_MS - 1;
      expect(
        registry.touch(first.computerId, first.instanceId, first.socket, observedAt, undefined, undefined, [
          { provider: "feishu", status: "ready" },
          { provider: "slack", status: "ready" },
        ]),
      ).toBe(true);
      expect(registry.imCliReadiness(first.computerId, observedAt)).toHaveLength(2);
    }
    expect(registry.imCliReadiness(first.computerId)).toEqual([]);

    // A reconnect whose fresh registration has no observations is eligible again: exactly one new
    // inspection goes out, and only to the current instance.
    const second = await registered(registry, { computerId: first.computerId });
    await owner.onComputerRegistered(second);

    expect(shouldPrewarmOfficialProviderClis).toHaveBeenCalledTimes(2);
    expect(first.socket.send).toHaveBeenCalledTimes(1);
    expect(second.socket.send).toHaveBeenCalledTimes(1);
    const secondFrame = JSON.parse(second.socket.send.mock.calls[0]?.[0] as string) as Record<string, unknown>;
    expect(secondFrame).toMatchObject({ type: "provider-cli:prewarm", providers: ["feishu", "slack"] });
    expect(secondFrame.requestId).not.toBe(firstFrame.requestId);
    expect(issueIntegrationCliValidationGrant).not.toHaveBeenCalled();
  });

  it("sends prewarm only to the exact eligible Computer", async () => {
    const registry = new ConnectionRegistry();
    const target = await registered(registry);
    const other = await registered(registry);
    const shouldPrewarmOfficialProviderClis = vi.fn(async (computerId: string) => computerId === target.computerId);
    const owner = new ProviderCliReconcileOwner(registry, {
      listActiveProviderCliRequirements: vi.fn(async () => []),
      issueIntegrationCliValidationGrant: vi.fn(),
      shouldPrewarmOfficialProviderClis,
    });

    await Promise.all([owner.onComputerRegistered(target), owner.onComputerRegistered(other)]);

    expect(shouldPrewarmOfficialProviderClis).toHaveBeenCalledWith(target.computerId);
    expect(shouldPrewarmOfficialProviderClis).toHaveBeenCalledWith(other.computerId);
    expect(target.socket.send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(target.socket.send.mock.calls[0]?.[0] as string)).toMatchObject({
      type: "provider-cli:prewarm",
      providers: ["feishu", "slack"],
    });
    expect(other.socket.send).not.toHaveBeenCalled();
  });

  it("drops a stale eligibility result after another instance registers", async () => {
    const registry = new ConnectionRegistry();
    let resolveFirst!: (eligible: boolean) => void;
    const firstEligibility = new Promise<boolean>((resolve) => {
      resolveFirst = resolve;
    });
    const shouldPrewarmOfficialProviderClis = vi.fn(async () => true).mockReturnValueOnce(firstEligibility);
    const owner = new ProviderCliReconcileOwner(registry, {
      listActiveProviderCliRequirements: vi.fn(async () => []),
      issueIntegrationCliValidationGrant: vi.fn(),
      shouldPrewarmOfficialProviderClis,
    });
    const first = await registered(registry);
    const pending = owner.onComputerRegistered(first);
    await vi.waitFor(() => expect(shouldPrewarmOfficialProviderClis).toHaveBeenCalledTimes(1));
    const second = await registered(registry, { computerId: first.computerId });
    await owner.onComputerRegistered(second);
    resolveFirst(true);
    await pending;

    expect(first.socket.send).not.toHaveBeenCalled();
    expect(second.socket.send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(second.socket.send.mock.calls[0]?.[0] as string)).toMatchObject({
      type: "provider-cli:prewarm",
      providers: ["feishu", "slack"],
    });
  });

  it("converges only the selected Provider once a messaging binding exists", async () => {
    const registry = new ConnectionRegistry();
    const agentId = randomUUID();
    const integrationId = randomUUID();
    // Slack is bound and active; feishu was never selected, so no first-setup prewarm is due.
    const owner = new ProviderCliReconcileOwner(registry, {
      listActiveProviderCliRequirements: vi.fn(async () => [
        { agentId, integrationId, provider: "slack" as const, credentialGeneration: 2, expectedIdentity: identity },
      ]),
      issueIntegrationCliValidationGrant: vi.fn(async () => ({
        expectedIdentity: identity,
        grant: { provider: "slack" as const, botAccessToken: "xoxb-secret" },
      })),
      shouldPrewarmOfficialProviderClis: vi.fn(async () => false),
    });
    const connection = await registered(registry);
    await owner.onComputerRegistered(connection);

    const dispatched = connection.socket.send.mock.calls.map(
      (call) => JSON.parse(call[0] as string) as Record<string, unknown>,
    );
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toMatchObject({
      type: "provider-cli:requirement",
      provider: "slack",
      agentId,
      integrationId,
    });

    // The selected Provider converges through artifact and grant; the unselected one never gains
    // a requirement, a prewarm, or a grant.
    await owner.businessOptions().handle(
      {
        type: "provider-cli:artifact:status",
        requestId: dispatched[0]?.requestId as string,
        provider: "slack",
        agentId,
        integrationId,
        credentialGeneration: 2,
        status: "ready",
      },
      contextOf(connection),
    );
    const frames = connection.socket.send.mock.calls.map(
      (call) => JSON.parse(call[0] as string) as Record<string, unknown>,
    );
    expect(frames.map((frame) => frame.type)).toEqual(["provider-cli:requirement", "provider-cli:validation:grant"]);
    expect(frames.every((frame) => frame.provider === "slack")).toBe(true);
  });

  it("skips the setup prewarm when no eligibility predicate is wired", async () => {
    const registry = new ConnectionRegistry();
    const agentId = randomUUID();
    const integrationId = randomUUID();
    const owner = new ProviderCliReconcileOwner(registry, {
      listActiveProviderCliRequirements: vi.fn(async () => [
        { agentId, integrationId, provider: "slack" as const, credentialGeneration: 1, expectedIdentity: identity },
      ]),
      issueIntegrationCliValidationGrant: vi.fn(),
    });
    const connection = await registered(registry);
    await owner.onComputerRegistered(connection);

    // The missing predicate fails safe to "no prewarm"; active-binding reconcile continues.
    expect(connection.socket.send).toHaveBeenCalledTimes(1);
    expect(JSON.parse(connection.socket.send.mock.calls[0]?.[0] as string)).toMatchObject({
      type: "provider-cli:requirement",
      provider: "slack",
      agentId,
      integrationId,
    });
  });

  it("keeps active-Integration reconcile running when the prewarm send fails", async () => {
    const registry = new ConnectionRegistry();
    const agentId = randomUUID();
    const integrationId = randomUUID();
    const owner = new ProviderCliReconcileOwner(registry, {
      listActiveProviderCliRequirements: vi.fn(async () => [
        { agentId, integrationId, provider: "slack" as const, credentialGeneration: 1, expectedIdentity: identity },
      ]),
      issueIntegrationCliValidationGrant: vi.fn(),
      shouldPrewarmOfficialProviderClis: vi.fn(async () => true),
    });
    const connection = await registered(registry);
    connection.socket.send.mockImplementationOnce((_data: string, cb?: (error?: Error) => void) =>
      cb?.(new Error("socket closed")),
    );
    await owner.onComputerRegistered(connection);

    // The failed prewarm is dropped and the bound requirement is still dispatched.
    const frames = connection.socket.send.mock.calls.map(
      (call) => JSON.parse(call[0] as string) as Record<string, unknown>,
    );
    expect(frames.map((frame) => frame.type)).toEqual(["provider-cli:prewarm", "provider-cli:requirement"]);
    expect(frames[1]).toMatchObject({ provider: "slack", agentId, integrationId });
  });
});
