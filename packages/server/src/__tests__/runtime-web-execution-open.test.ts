import { randomUUID } from "node:crypto";
import { RUNTIME_CAPABILITY, type RuntimeCredentialClientFrame } from "@opentag/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { ConnectionRegistry } from "../runtime/connection-registry.js";
import type { RuntimeBusinessContext } from "../runtime/runtime-session.js";
import { RuntimeCapabilityStore } from "../runtime-credentials/capability-store.js";
import { RuntimeCredentialBroker } from "../runtime-credentials/credential-broker.js";
import type { RuntimeExecutionAuthority } from "../runtime-credentials/execution-authority.js";
import { RuntimeExecutionRegistry } from "../runtime-credentials/execution-registry.js";
import { UnavailableRuntimeGitHubAdmission } from "../runtime-credentials/github-admission.js";
import { RuntimeCredentialOwner } from "../runtime-credentials/runtime-credential-owner.js";
import type { RuntimeScopeResolverPort, RuntimeScopeSnapshot } from "../runtime-credentials/scope-resolver.js";
import { DefaultRuntimeTaskPolicy } from "../runtime-credentials/task-policy.js";
import { RuntimeProxyTicketStore } from "../runtime-credentials/ticket-store.js";
import { RuntimeValidationRunRegistry } from "../runtime-credentials/validation-runs.js";
import { ConfigRuntimeWebPolicy } from "../runtime-credentials/web-policy.js";

const ACCOUNT = "00000000-0000-4000-8000-0000000000e1";
const AGENT = "00000000-0000-4000-8000-0000000000a1";
const COMPUTER = "00000000-0000-4000-8000-0000000000c1";
const BINDING = "00000000-0000-4000-8000-0000000000b1";
const INSTALLATION = "00000000-0000-4000-8000-0000000000d1";
const REQUEST_ID = "00000000-0000-4000-8000-0000000000f1";

class FakeAuthority implements RuntimeExecutionAuthority {
  authorize = vi.fn(async () => ({ status: "authorized" as const }));
  revalidate = vi.fn(async () => "valid" as const);
}

class FakeScopeResolver implements RuntimeScopeResolverPort {
  session: RuntimeScopeSnapshot | undefined = sessionSnapshot();
  load(): Promise<RuntimeScopeSnapshot | undefined> {
    return Promise.resolve(this.session);
  }
  assertExecutionFence(): "binding_inactive" | undefined {
    return this.session?.binding.status === "active" ? undefined : "binding_inactive";
  }
}

function sessionSnapshot(overrides: Partial<RuntimeScopeSnapshot> = {}): RuntimeScopeSnapshot {
  return {
    sessionId: "session-1",
    sessionKind: "channel",
    sessionEnded: false,
    channelId: "C-channel",
    threadKey: null,
    binding: {
      id: BINDING,
      agentId: AGENT,
      provider: "feishu",
      status: "active",
      credentialGeneration: 3,
      externalAppId: "app",
      externalTeamId: null,
      externalTeamBrand: null,
      externalBotId: null,
      slackInstallationId: null,
    },
    slackInstallation: null,
    agent: { id: AGENT, status: "active", revision: 4, computerId: COMPUTER, createdByUserId: ACCOUNT },
    placement: { computerId: COMPUTER, generation: 2 },
    computer: { id: COMPUTER, kind: "local", ownerAccountId: ACCOUNT },
    sandbox: null,
    ...overrides,
  };
}

function openFrame(overrides: Record<string, unknown> = {}): RuntimeCredentialClientFrame {
  return {
    type: "runtime:execution:open",
    requestId: REQUEST_ID,
    sessionId: "session-1",
    agentId: AGENT,
    placementGeneration: 2,
    runId: randomUUID(),
    source: { kind: "delivery", deliveryId: "d1", turnId: "t1" },
    ...overrides,
  } as RuntimeCredentialClientFrame;
}

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanup.splice(0)) close();
});

async function fixture(options: {
  webPolicy?: ConfigRuntimeWebPolicy;
  negotiateWebTools?: boolean;
  bindingActive?: boolean;
}) {
  const registry = new ConnectionRegistry();
  const instanceId = randomUUID();
  const connectionId = randomUUID();
  const runtimeSocket = {
    readyState: WebSocket.OPEN,
    send: vi.fn((_data: string, cb?: (error?: Error) => void) => cb?.()),
    close: vi.fn(),
  } as unknown as WebSocket;
  const negotiatedCapabilities: Record<string, number> = {
    [RUNTIME_CAPABILITY.runtimeCredential]: 1,
    [RUNTIME_CAPABILITY.providerProxy]: 1,
  };
  if (options.negotiateWebTools) negotiatedCapabilities[RUNTIME_CAPABILITY.webTools] = 1;
  await registry.register(
    {
      active: true,
      computerId: COMPUTER,
      connectionId,
      installationId: INSTALLATION,
      instanceId,
      lastHeartbeatAt: Date.now(),
      socket: runtimeSocket,
      negotiatedCapabilities,
    },
    async () => undefined,
  );
  registry.activate(COMPUTER, instanceId, runtimeSocket);
  const executions = new RuntimeExecutionRegistry();
  const scopeResolver = new FakeScopeResolver();
  if (options.bindingActive === false) {
    scopeResolver.session = sessionSnapshot({
      binding: { ...sessionSnapshot().binding, status: "disabled" },
    });
  }
  const broker = new RuntimeCredentialBroker({
    capabilities: new RuntimeCapabilityStore(),
    executions,
    scopeResolver,
    policy: new DefaultRuntimeTaskPolicy(),
    gitHubAdmission: new UnavailableRuntimeGitHubAdmission(),
    materialResolvers: {
      feishu: { resolve: async () => ({ kind: "bearer" as const, token: "t", origin: "https://open.feishu.cn" }) },
    },
    authority: new FakeAuthority(),
    connectionFence: {
      isCurrent: (computerId, entryInstanceId, entryConnectionId) =>
        registry.isCurrentConnection(computerId, entryInstanceId, entryConnectionId),
      currentControlIdentity: () => undefined,
    },
  });
  const owner = new RuntimeCredentialOwner({
    registry,
    executions,
    capabilities: new RuntimeCapabilityStore(),
    tickets: new RuntimeProxyTicketStore(),
    validationRuns: new RuntimeValidationRunRegistry(),
    authority: new FakeAuthority(),
    scopeResolver,
    broker,
    policy: new DefaultRuntimeTaskPolicy(),
    gitHubAdmission: new UnavailableRuntimeGitHubAdmission(),
    ...(options.webPolicy ? { webPolicy: options.webPolicy } : {}),
    sweepIntervalMs: 60_000,
  });
  cleanup.push(() => owner.close());
  const context: RuntimeBusinessContext = {
    computerId: COMPUTER,
    installationId: INSTALLATION,
    connectionId,
    instanceId,
    negotiatedCapabilities,
    signal: new AbortController().signal,
  };
  return { owner, executions, context };
}

type OwnerHandleResult = Awaited<ReturnType<RuntimeCredentialOwner["handle"]>>;
type ExecutionResultFrame = Extract<NonNullable<OwnerHandleResult>, { type: "runtime:execution:result" }>;

/** The wiring always answers an open frame with an execution result; fail loudly otherwise. */
function executionFrame(result: OwnerHandleResult): ExecutionResultFrame {
  if (result?.type !== "runtime:execution:result") {
    throw new Error("Expected an execution result frame");
  }
  return result;
}

describe("execution open web services", () => {
  it("attaches exact web scopes when requested, negotiated, and policy-authorized", async () => {
    const state = await fixture({
      negotiateWebTools: true,
      webPolicy: new ConfigRuntimeWebPolicy({ tenants: new Map([[ACCOUNT, { tenantId: "t", routerKey: "k" }]]) }),
    });
    const result = executionFrame(await state.owner.handle(openFrame({ services: ["web"] }), state.context));
    expect(result).toMatchObject({
      status: "succeeded",
      services: [{ service: "web", scopes: ["web:search", "web:fetch"] }],
    });
    const executionId = result.status === "succeeded" ? result.executionId : undefined;
    const record = executionId ? state.executions.get(executionId) : undefined;
    expect(record?.services).toEqual([{ service: "web", scopes: ["web:search", "web:fetch"] }]);
  });

  it("opens a web-only execution when every provider binding is unavailable", async () => {
    const state = await fixture({
      negotiateWebTools: true,
      bindingActive: false,
      webPolicy: new ConfigRuntimeWebPolicy({ tenants: new Map([[ACCOUNT, { tenantId: "t", routerKey: "k" }]]) }),
    });
    const result = await state.owner.handle(openFrame({ services: ["web"] }), state.context);
    expect(result).toMatchObject({
      status: "succeeded",
      providers: [],
      services: [{ service: "web", scopes: ["web:search", "web:fetch"] }],
    });
  });

  it("omits services without negotiation, request, or policy authorization", async () => {
    // Not negotiated: the request field is ignored and the wire result never carries services.
    const silent = await fixture({
      negotiateWebTools: false,
      webPolicy: new ConfigRuntimeWebPolicy({ tenants: new Map([[ACCOUNT, { tenantId: "t", routerKey: "k" }]]) }),
    });
    const silentResult = executionFrame(await silent.owner.handle(openFrame({ services: ["web"] }), silent.context));
    expect(silentResult.status).toBe("succeeded");
    expect(silentResult).not.toHaveProperty("services");

    // Negotiated but not requested: nothing is granted implicitly.
    const unrequested = await fixture({
      negotiateWebTools: true,
      webPolicy: new ConfigRuntimeWebPolicy({ tenants: new Map([[ACCOUNT, { tenantId: "t", routerKey: "k" }]]) }),
    });
    const unrequestedResult = await unrequested.owner.handle(openFrame(), unrequested.context);
    expect(unrequestedResult).not.toHaveProperty("services");

    // Negotiated and requested but the Account has no mapping: denied, never defaulted.
    const denied = await fixture({
      negotiateWebTools: true,
      webPolicy: new ConfigRuntimeWebPolicy({ tenants: new Map() }),
    });
    const deniedResult = await denied.owner.handle(openFrame({ services: ["web"] }), denied.context);
    expect(deniedResult).not.toHaveProperty("services");

    // No policy at all (deployment off): services are never granted.
    const off = await fixture({ negotiateWebTools: true });
    const offResult = await off.owner.handle(openFrame({ services: ["web"] }), off.context);
    expect(offResult).not.toHaveProperty("services");
  });
});
