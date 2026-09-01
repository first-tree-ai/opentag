import { randomUUID } from "node:crypto";
import { RUNTIME_CAPABILITY, RUNTIME_PROVIDER_CLI_REQUIREMENT_OPERATION } from "@opentag/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
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

async function registered(registry: ConnectionRegistry) {
  const computerId = randomUUID();
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
      negotiatedCapabilities: { [RUNTIME_CAPABILITY.providerCliReconcile]: 1 },
    },
    async () => undefined,
  );
  registry.activate(computerId, instanceId, runtimeSocket);
  return { installationId, instanceId, computerId, socket: runtimeSocket };
}

function contextOf(connection: Awaited<ReturnType<typeof registered>>) {
  return {
    installationId: connection.installationId,
    instanceId: connection.instanceId,
    signal: new AbortController().signal,
    computerId: connection.computerId,
  };
}

function framesOf(connection: Awaited<ReturnType<typeof registered>>): Record<string, unknown>[] {
  return connection.socket.send.mock.calls.map((call) => JSON.parse(call[0] as string) as Record<string, unknown>);
}

const identity = { provider: "slack" as const, teamId: "T1", botUserId: "U1", botId: "B1" };

const owners: ProviderCliReconcileOwner[] = [];
afterEach(() => {
  for (const owner of owners.splice(0)) owner.close();
});

describe("provider CLI product Server readiness", () => {
  it("does not dispatch a requirement or grant when the Computer has no active binding", async () => {
    const registry = new ConnectionRegistry();
    const bindings = {
      listActiveProviderCliRequirements: vi.fn(async () => []),
      issueIntegrationCliValidationGrant: vi.fn(),
    };
    const owner = new ProviderCliReconcileOwner(registry, bindings);
    owners.push(owner);
    const connection = await registered(registry);
    await owner.onComputerRegistered(connection);
    expect(connection.socket.send).not.toHaveBeenCalled();
    expect(bindings.issueIntegrationCliValidationGrant).not.toHaveBeenCalled();
    expect(registry.providerCliArtifactReadiness(connection.computerId)).toEqual([]);
    expect(registry.providerCliCredentialReadiness(connection.computerId)).toEqual([]);
  });

  it("requires both artifact and credential layers and fail-closes old generation observations", async () => {
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
    owners.push(owner);
    const connection = await registered(registry);
    await owner.onComputerRegistered(connection);
    const requirement = framesOf(connection)[0];
    expect(requirement).toMatchObject({
      type: "provider-cli:requirement",
      operation: RUNTIME_PROVIDER_CLI_REQUIREMENT_OPERATION,
      provider: "slack",
      credentialGeneration: 2,
    });
    expect(JSON.stringify(requirement)).not.toContain("xoxb-secret");
    expect(registry.providerCliArtifactReadiness(connection.computerId)[0]?.observation.status).toBe("checking");
    expect(registry.providerCliCredentialReadiness(connection.computerId)[0]?.observation.status).toBe("unconfirmed");

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
    expect(registry.providerCliCredentialReadiness(connection.computerId)[0]?.observation.status).toBe("unconfirmed");

    const requestId = requirement?.requestId as string;
    await owner.businessOptions().handle(
      {
        type: "provider-cli:artifact:status",
        requestId,
        provider: "slack",
        agentId,
        integrationId,
        credentialGeneration: 2,
        status: "ready",
      },
      contextOf(connection),
    );
    expect(bindings.issueIntegrationCliValidationGrant).toHaveBeenCalledTimes(1);
    expect(registry.providerCliArtifactReadiness(connection.computerId)[0]?.observation.status).toBe("ready");
    expect(registry.providerCliCredentialReadiness(connection.computerId)[0]?.observation.status).toBe("checking");
    const grant = framesOf(connection).find((frame) => frame.type === "provider-cli:validation:grant");
    expect(grant).toMatchObject({ type: "provider-cli:validation:grant", requirementRequestId: requestId });

    await owner.businessOptions().handle(
      {
        type: "provider-cli:validation:result",
        requestId: grant?.requestId as string,
        provider: "slack",
        agentId,
        integrationId,
        credentialGeneration: 2,
        status: "ready",
      },
      contextOf(connection),
    );
    expect(registry.providerCliArtifactReadiness(connection.computerId)[0]?.observation.status).toBe("ready");
    expect(registry.providerCliCredentialReadiness(connection.computerId)[0]?.observation.status).toBe("ready");

    await owner.businessOptions().handle(
      {
        type: "provider-cli:validation:result",
        requestId: grant?.requestId as string,
        provider: "slack",
        agentId,
        integrationId,
        credentialGeneration: 1,
        status: "ready",
      },
      contextOf(connection),
    );
    expect(registry.providerCliCredentialReadiness(connection.computerId)[0]?.observation).toMatchObject({
      status: "ready",
      credentialGeneration: 2,
    });
  });
});
