import { randomUUID } from "node:crypto";
import {
  RUNTIME_CAPABILITY,
  RUNTIME_PROVIDER_CLI_ARTIFACT_TTL_MS,
  RUNTIME_PROVIDER_CLI_CREDENTIAL_TTL_MS,
  RUNTIME_PROVIDER_CLI_REQUIREMENT_OPERATION,
} from "@opentag/shared";
import { describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { ConnectionRegistry } from "../runtime/connection-registry.js";
import { ProviderCliReconcileOwner } from "../runtime/provider-cli-reconcile-owner.js";

function socket(): WebSocket & { send: ReturnType<typeof vi.fn> } {
  return {
    readyState: WebSocket.OPEN,
    send: vi.fn((_data: string, cb?: (error?: Error) => void) => cb?.()),
    close: vi.fn(),
  } as unknown as WebSocket & { send: ReturnType<typeof vi.fn> };
}

async function registered(registry: ConnectionRegistry, options: { capabilities?: boolean } = {}) {
  const workspaceComputerId = randomUUID();
  const instanceId = randomUUID();
  const computerId = randomUUID();
  const runtimeSocket = socket();
  await registry.register(
    {
      active: true,
      computerId,
      instanceId,
      workspaceComputerId,
      workspaceId: randomUUID(),
      lastHeartbeatAt: Date.now(),
      socket: runtimeSocket,
      negotiatedCapabilities: options.capabilities === false ? {} : { [RUNTIME_CAPABILITY.providerCliReconcile]: 1 },
    },
    async () => undefined,
  );
  registry.activate(workspaceComputerId, instanceId, runtimeSocket);
  return { computerId, instanceId, workspaceComputerId, socket: runtimeSocket };
}

const identity = { provider: "slack" as const, teamId: "T1", botUserId: "U1", botId: "B1" };

function contextOf(connection: Awaited<ReturnType<typeof registered>>, overrides: Record<string, string> = {}) {
  return {
    computerId: connection.computerId,
    instanceId: connection.instanceId,
    signal: new AbortController().signal,
    workspaceComputerId: connection.workspaceComputerId,
    workspaceId: randomUUID(),
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
    expect(registry.providerCliCredentialReadiness(connection.workspaceComputerId)[0]?.observation).toMatchObject({
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
        computerId: connection.computerId,
        workspaceComputerId: connection.workspaceComputerId,
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
    expect(registry.providerCliCredentialReadiness(connection.workspaceComputerId)[0]?.observation.status).toBe(
      "ready",
    );
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
    expect(registry.providerCliCredentialReadiness(connection.workspaceComputerId)).toHaveLength(1);
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
    expect(registry.providerCliCredentialReadiness(connection.workspaceComputerId)[0]?.observation).toMatchObject({
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
    expect(registry.providerCliCredentialReadiness(connection.workspaceComputerId)[0]?.observation.status).toBe(
      "checking",
    );
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
      contextOf(connection, { computerId: randomUUID() }),
    );
    expect(registry.providerCliCredentialReadiness(connection.workspaceComputerId)[0]?.observation.status).toBe(
      "checking",
    );
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
    expect(registry.providerCliCredentialReadiness(connection.workspaceComputerId)[0]?.observation).toMatchObject({
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
    registry.touch(
      connection.workspaceComputerId,
      connection.instanceId,
      connection.socket,
      Date.now(),
      undefined,
      undefined,
      [{ provider: "slack", status: "ready" }],
    );
    expect(
      registry.imCliReadiness(connection.workspaceComputerId).some(({ observation }) => observation.status === "ready"),
    ).toBe(true);
    expect(
      registry
        .providerCliArtifactReadiness(connection.workspaceComputerId)
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
    await owner.onActiveBindingChanged({ agentId, workspaceComputerId: connection.workspaceComputerId });
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
      workspaceComputerId: connection.workspaceComputerId,
    });
    const second = owner.ensureActiveReadiness({
      agentId,
      workspaceComputerId: connection.workspaceComputerId,
    });
    await vi.waitFor(() => expect(listCalls).toBe(1));
    release();
    await Promise.all([first, second]);
    expect(listCalls).toBe(1);
    expect(connection.socket.send).toHaveBeenCalledTimes(1);
    connection.socket.send.mockClear();
    await owner.ensureActiveReadiness({ agentId, workspaceComputerId: connection.workspaceComputerId });
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
    await owner.ensureActiveReadiness({ agentId, workspaceComputerId: connection.workspaceComputerId });
    expect(connection.socket.send).not.toHaveBeenCalled();
    now += RUNTIME_PROVIDER_CLI_ARTIFACT_TTL_MS + 1;
    expect(registry.providerCliArtifactReadiness(connection.workspaceComputerId, now)).toEqual([]);
    expect(registry.providerCliCredentialReadiness(connection.workspaceComputerId, now)).toEqual([]);
    await owner.ensureActiveReadiness({ agentId, workspaceComputerId: connection.workspaceComputerId });
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
    expect(
      rejected.providerCliCredentialReadiness(rejectedConnection.workspaceComputerId, now)[0]?.observation,
    ).toMatchObject({
      status: "needs_attention",
      reason: "credential_rejected",
    });
    rejectedConnection.socket.send.mockClear();
    await rejectedOwner.ensureActiveReadiness({
      agentId,
      workspaceComputerId: rejectedConnection.workspaceComputerId,
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
    expect(registry.providerCliCredentialReadiness(connection.workspaceComputerId, now)[0]?.observation.status).toBe(
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

  it("cancels the old Computer and dispatches only the new Computer after Agent rebind", async () => {
    const registry = new ConnectionRegistry();
    const agentId = randomUUID();
    const integrationId = randomUUID();
    const first = await registered(registry);
    const second = await registered(registry);
    let host = first.workspaceComputerId;
    const bindings = {
      listActiveProviderCliRequirements: vi.fn(async (workspaceComputerId: string) =>
        workspaceComputerId === host
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
    host = second.workspaceComputerId;
    await owner.onAgentPlacementChanged({
      agentId,
      previousWorkspaceComputerId: first.workspaceComputerId,
      workspaceComputerId: second.workspaceComputerId,
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
        .providerCliCredentialReadiness(second.workspaceComputerId)
        .some(({ observation }) => observation.status === "ready"),
    ).toBe(false);
  });
});
