import { randomUUID } from "node:crypto";
import { RUNTIME_CAPABILITY } from "@opentag/shared";
import { describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import type { ConnectionRegistry } from "../runtime/connection-registry.js";
import { ConnectionRegistry as Registry } from "../runtime/connection-registry.js";
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
  options: { proxyMode?: boolean; computerKind?: "local" | "cloud" } = {},
) {
  const computerId = randomUUID();
  const instanceId = randomUUID();
  const installationId = randomUUID();
  const connectionId = randomUUID();
  const runtimeSocket = socket();
  await registry.register(
    {
      active: true,
      installationId,
      instanceId,
      computerId,
      connectionId,
      lastHeartbeatAt: Date.now(),
      socket: runtimeSocket,
      negotiatedCapabilities: {
        [RUNTIME_CAPABILITY.providerCliReconcile]: 1,
        ...(options.proxyMode === false
          ? {}
          : {
              [RUNTIME_CAPABILITY.runtimeCredential]: 1,
              [RUNTIME_CAPABILITY.providerProxy]: 1,
            }),
      },
    },
    async () => undefined,
  );
  registry.activate(computerId, instanceId, runtimeSocket);
  return { installationId, instanceId, computerId, connectionId, socket: runtimeSocket };
}

const identity = { provider: "slack" as const, teamId: "T1", botUserId: "U1", botId: "B1" };

function contextOf(connection: Awaited<ReturnType<typeof registered>>) {
  return {
    installationId: connection.installationId,
    instanceId: connection.instanceId,
    computerId: connection.computerId,
    signal: new AbortController().signal,
  };
}

async function driveToGrant(
  owner: ProviderCliReconcileOwner,
  connection: Awaited<ReturnType<typeof registered>>,
  agentId: string,
  integrationId: string,
) {
  await owner.onComputerRegistered(connection);
  const requirement = JSON.parse(connection.socket.send.mock.calls[0]?.[0] as string) as Record<string, unknown>;
  await owner.businessOptions().handle(
    {
      type: "provider-cli:artifact:status",
      requestId: requirement.requestId as string,
      provider: "slack",
      agentId,
      integrationId,
      credentialGeneration: 3,
      status: "ready",
    },
    contextOf(connection),
  );
  return requirement;
}

describe("ProviderCliReconcileOwner proxy-mode validation", () => {
  it("issues a Server-side validation run instead of raw material for proxy connections", async () => {
    const registry = new Registry();
    const agentId = randomUUID();
    const integrationId = randomUUID();
    const validationRunId = randomUUID();
    const bindings = {
      listActiveProviderCliRequirements: vi.fn(async () => [
        { agentId, integrationId, provider: "slack" as const, credentialGeneration: 3, expectedIdentity: identity },
      ]),
      issueIntegrationCliValidationGrant: vi.fn(),
      issueRuntimeValidationRun: vi.fn(async () => ({
        validationRunId,
        expiresAt: Date.now() + 60_000,
      })),
      computerKind: vi.fn(async () => "local" as const),
    };
    const owner = new ProviderCliReconcileOwner(registry, bindings);
    const connection = await registered(registry, { proxyMode: true });
    await driveToGrant(owner, connection, agentId, integrationId);
    expect(bindings.issueIntegrationCliValidationGrant).not.toHaveBeenCalled();
    expect(bindings.issueRuntimeValidationRun).toHaveBeenCalledWith(
      expect.objectContaining({ agentId, computerId: connection.computerId, connectionId: connection.connectionId }),
    );
    const frame = JSON.parse(connection.socket.send.mock.calls.at(-1)?.[0] as string) as Record<string, unknown>;
    expect(frame).toMatchObject({
      type: "provider-cli:validation:run",
      provider: "slack",
      agentId,
      integrationId,
      credentialGeneration: 3,
      validationRunId,
    });
    expect(JSON.stringify(frame)).not.toContain("xoxb");
    owner.close();
  });

  it("never sends a legacy raw grant to a Cloud connection", async () => {
    const registry = new Registry();
    const agentId = randomUUID();
    const integrationId = randomUUID();
    const bindings = {
      listActiveProviderCliRequirements: vi.fn(async () => [
        { agentId, integrationId, provider: "slack" as const, credentialGeneration: 3, expectedIdentity: identity },
      ]),
      issueIntegrationCliValidationGrant: vi.fn(),
      computerKind: vi.fn(async () => "cloud" as const),
    };
    const owner = new ProviderCliReconcileOwner(registry, bindings);
    const connection = await registered(registry, { proxyMode: false });
    await driveToGrant(owner, connection, agentId, integrationId);
    expect(bindings.issueIntegrationCliValidationGrant).not.toHaveBeenCalled();
    expect(registry.providerCliCredentialReadiness(connection.computerId)[0]?.observation).toMatchObject({
      status: "needs_attention",
      reason: "upgrade_required",
    });
    owner.close();
  });

  it("stops proxy validation with needs_attention when no run issuer is wired", async () => {
    const registry = new Registry();
    const agentId = randomUUID();
    const integrationId = randomUUID();
    const bindings = {
      listActiveProviderCliRequirements: vi.fn(async () => [
        { agentId, integrationId, provider: "slack" as const, credentialGeneration: 3, expectedIdentity: identity },
      ]),
      issueIntegrationCliValidationGrant: vi.fn(),
    };
    const owner = new ProviderCliReconcileOwner(registry, bindings);
    const connection = await registered(registry, { proxyMode: true });
    await driveToGrant(owner, connection, agentId, integrationId);
    expect(bindings.issueIntegrationCliValidationGrant).not.toHaveBeenCalled();
    expect(registry.providerCliCredentialReadiness(connection.computerId)[0]?.observation).toMatchObject({
      status: "needs_attention",
      reason: "upgrade_required",
    });
    owner.close();
  });

  it("preserves the legacy grant for a Local connection without proxy negotiation", async () => {
    const registry = new Registry();
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
      computerKind: vi.fn(async () => "local" as const),
    };
    const owner = new ProviderCliReconcileOwner(registry, bindings);
    const connection = await registered(registry, { proxyMode: false });
    await driveToGrant(owner, connection, agentId, integrationId);
    expect(bindings.issueIntegrationCliValidationGrant).toHaveBeenCalled();
    const frame = JSON.parse(connection.socket.send.mock.calls.at(-1)?.[0] as string) as Record<string, unknown>;
    expect(frame.type).toBe("provider-cli:validation:grant");
    owner.close();
  });
});
