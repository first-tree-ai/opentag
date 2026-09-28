import { randomUUID } from "node:crypto";
import { RUNTIME_CAPABILITY, type RuntimeCredentialClientFrame } from "@opentag/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import type { ServiceLogger } from "../observability/service-logger.js";
import { ConnectionRegistry } from "../runtime/connection-registry.js";
import type { RuntimeBusinessContext } from "../runtime/runtime-session.js";
import { RuntimeCapabilityStore } from "../runtime-credentials/capability-store.js";
import { RuntimeCredentialBroker } from "../runtime-credentials/credential-broker.js";
import type { RuntimeExecutionAuthority } from "../runtime-credentials/execution-authority.js";
import { RuntimeExecutionRegistry } from "../runtime-credentials/execution-registry.js";
import { UnavailableRuntimeGitHubAdmission } from "../runtime-credentials/github-admission.js";
import { LiveMcpServicePolicy, type RuntimeMcpServicePolicy } from "../runtime-credentials/mcp-policy.js";
import { RuntimeCredentialOwner } from "../runtime-credentials/runtime-credential-owner.js";
import type { RuntimeScopeResolverPort, RuntimeScopeSnapshot } from "../runtime-credentials/scope-resolver.js";
import { DefaultRuntimeTaskPolicy } from "../runtime-credentials/task-policy.js";
import { RuntimeProxyTicketStore } from "../runtime-credentials/ticket-store.js";
import { RuntimeValidationRunRegistry } from "../runtime-credentials/validation-runs.js";
import { RuntimeWebGatewayTokenStore } from "../runtime-credentials/web-gateway-token-store.js";
import { ConfigRuntimeWebPolicy, type RuntimeWebServicePolicy } from "../runtime-credentials/web-policy.js";

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
  webPolicy?: RuntimeWebServicePolicy;
  negotiateWebTools?: boolean;
  bindingActive?: boolean;
  negotiateMcpGateway?: boolean;
  mcpPolicy?: RuntimeMcpServicePolicy;
  webGatewayTokens?: RuntimeWebGatewayTokenStore;
  logger?: ServiceLogger;
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
  if (options.negotiateMcpGateway) negotiatedCapabilities[RUNTIME_CAPABILITY.mcpGateway] = 1;
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
    ...(options.mcpPolicy ? { mcpPolicy: options.mcpPolicy } : {}),
    ...(options.webGatewayTokens ? { webGatewayTokens: options.webGatewayTokens } : {}),
    ...(options.logger ? { logger: options.logger } : {}),
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
  return { owner, executions, context, scopeResolver };
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
      webPolicy: new ConfigRuntimeWebPolicy({ routerKey: "k" }),
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

  it("grants the same default scopes to two Accounts with no per-Account mapping", async () => {
    const state = await fixture({
      negotiateWebTools: true,
      webPolicy: new ConfigRuntimeWebPolicy({ routerKey: "k" }),
    });
    const first = executionFrame(await state.owner.handle(openFrame({ services: ["web"] }), state.context));
    expect(first).toMatchObject({
      status: "succeeded",
      services: [{ service: "web", scopes: ["web:search", "web:fetch"] }],
    });
    // A different Account is not a different decision: the deployment config is the only input.
    const otherAccount = randomUUID();
    state.scopeResolver.session = sessionSnapshot({
      agent: { id: AGENT, status: "active", revision: 4, computerId: COMPUTER, createdByUserId: otherAccount },
      computer: { id: COMPUTER, kind: "local", ownerAccountId: otherAccount },
    });
    const second = executionFrame(await state.owner.handle(openFrame({ services: ["web"] }), state.context));
    expect(second).toMatchObject({
      status: "succeeded",
      services: [{ service: "web", scopes: ["web:search", "web:fetch"] }],
    });
  });

  it("opens a web-only execution when every provider binding is unavailable", async () => {
    const state = await fixture({
      negotiateWebTools: true,
      bindingActive: false,
      webPolicy: new ConfigRuntimeWebPolicy({ routerKey: "k" }),
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
      webPolicy: new ConfigRuntimeWebPolicy({ routerKey: "k" }),
    });
    const silentResult = executionFrame(await silent.owner.handle(openFrame({ services: ["web"] }), silent.context));
    expect(silentResult.status).toBe("succeeded");
    expect(silentResult).not.toHaveProperty("services");

    // Negotiated but not requested: nothing is granted implicitly.
    const unrequested = await fixture({
      negotiateWebTools: true,
      webPolicy: new ConfigRuntimeWebPolicy({ routerKey: "k" }),
    });
    const unrequestedResult = await unrequested.owner.handle(openFrame(), unrequested.context);
    expect(unrequestedResult).not.toHaveProperty("services");

    // Negotiated and requested but the deployment policy denies it: withheld, never defaulted.
    const denied = await fixture({
      negotiateWebTools: true,
      webPolicy: { authorizeWeb: () => undefined },
    });
    const deniedResult = await denied.owner.handle(openFrame({ services: ["web"] }), denied.context);
    expect(deniedResult).not.toHaveProperty("services");

    // No policy at all (deployment off): services are never granted.
    const off = await fixture({ negotiateWebTools: true });
    const offResult = await off.owner.handle(openFrame({ services: ["web"] }), off.context);
    expect(offResult).not.toHaveProperty("services");
  });
});

describe("execution web gateway bearer", () => {
  const webPolicy = { authorizeWeb: () => ["web:search", "web:fetch"] as const };

  it("issues one execution-scoped bearer for a granted execution and revokes it on close", async () => {
    const tokens = new RuntimeWebGatewayTokenStore();
    const state = await fixture({ negotiateWebTools: true, webPolicy, webGatewayTokens: tokens });
    const opened = executionFrame(await state.owner.handle(openFrame({ services: ["web"] }), state.context));
    if (opened.status !== "succeeded") throw new Error("Expected the open to succeed");
    const result = await state.owner.handle(
      { type: "runtime:web:gateway", requestId: REQUEST_ID, executionId: opened.executionId },
      state.context,
    );
    expect(result).toMatchObject({ type: "runtime:web:gateway:result", status: "succeeded" });
    if (result?.type !== "runtime:web:gateway:result" || result.status !== "succeeded") {
      throw new Error("Expected the web bearer to be issued");
    }
    expect(result.token.startsWith("otwg_")).toBe(true);
    expect(result.executionId).toBe(opened.executionId);
    expect(tokens.resolve(result.token)?.executionId).toBe(opened.executionId);
    // The bearer lives exactly as long as the execution: the close path every revocation route
    // funnels through drops it, so a stale token can never outlive its turn.
    await state.owner.handle(
      { type: "runtime:execution:close", requestId: REQUEST_ID, executionId: opened.executionId },
      state.context,
    );
    expect(tokens.resolve(result.token)).toBeUndefined();
  });

  it("refuses the bearer when the execution was never granted web, negotiated it, or a store exists", async () => {
    const granting = await fixture({ negotiateWebTools: true, webGatewayTokens: new RuntimeWebGatewayTokenStore() });
    const ungranted = executionFrame(await granting.owner.handle(openFrame(), granting.context));
    if (ungranted.status !== "succeeded") throw new Error("Expected the open to succeed");
    expect(
      await granting.owner.handle(
        { type: "runtime:web:gateway", requestId: REQUEST_ID, executionId: ungranted.executionId },
        granting.context,
      ),
    ).toMatchObject({ status: "rejected", code: "service_not_granted" });

    // Not negotiated: the frame is not even representable to this connection's peer.
    const unnegotiated = await fixture({ webPolicy, webGatewayTokens: new RuntimeWebGatewayTokenStore() });
    const opened = executionFrame(
      await unnegotiated.owner.handle(openFrame({ services: ["web"] }), unnegotiated.context),
    );
    if (opened.status !== "succeeded") throw new Error("Expected the open to succeed");
    expect(
      await unnegotiated.owner.handle(
        { type: "runtime:web:gateway", requestId: REQUEST_ID, executionId: opened.executionId },
        unnegotiated.context,
      ),
    ).toMatchObject({ status: "rejected", code: "capability_unsupported" });

    // A deployment with no web store can never mint one, regardless of the grant on the wire.
    const storeless = await fixture({ negotiateWebTools: true, webPolicy });
    const storedlessOpen = executionFrame(
      await storeless.owner.handle(openFrame({ services: ["web"] }), storeless.context),
    );
    if (storedlessOpen.status !== "succeeded") throw new Error("Expected the open to succeed");
    expect(
      await storeless.owner.handle(
        { type: "runtime:web:gateway", requestId: REQUEST_ID, executionId: storedlessOpen.executionId },
        storeless.context,
      ),
    ).toMatchObject({ status: "rejected", code: "capability_unsupported" });
  });
});

/** Captures the structured reason the gateway records when it withholds the service. */
function recordingLogger(): { logger: ServiceLogger; reasons: string[] } {
  const reasons: string[] = [];
  const capture = (bindings: Record<string, unknown>) => {
    if (bindings.code === "MCP_GATEWAY_NOT_GRANTED") reasons.push(String(bindings.reason));
  };
  return {
    reasons,
    logger: { debug: capture, info: capture, warn: capture, error: capture },
  };
}

const grantingPolicy = new LiveMcpServicePolicy({ hasUsableMount: async () => true });
const emptyPolicy = new LiveMcpServicePolicy({ hasUsableMount: async () => false });

describe("execution open MCP gateway service", () => {
  it("attaches the mcp scope when requested, negotiated, and the Agent has a usable mount", async () => {
    const state = await fixture({ negotiateMcpGateway: true, mcpPolicy: grantingPolicy });
    const result = executionFrame(await state.owner.handle(openFrame({ services: ["mcp"] }), state.context));
    expect(result).toMatchObject({ status: "succeeded", services: [{ service: "mcp", scopes: ["mcp:tools"] }] });
  });

  /*
   * The silence this diagnostic exists for. Each reason is a different thing to go fix, and none of
   * them is visible anywhere else: the Agent simply has no MCP tools and nothing says why.
   */
  it.each([
    {
      name: "the Client never negotiated the capability",
      options: { mcpPolicy: grantingPolicy },
      services: ["mcp"],
      reason: "capability_not_negotiated",
    },
    {
      /* The commonest cause in practice: a Client on the default legacy credential mode. */
      name: "the Client did not ask for the service",
      options: { negotiateMcpGateway: true, mcpPolicy: grantingPolicy },
      services: [],
      reason: "not_requested",
    },
    {
      name: "the deployment wired no policy",
      options: { negotiateMcpGateway: true },
      services: ["mcp"],
      reason: "policy_unavailable",
    },
    {
      name: "the Agent has nothing usable bound",
      options: { negotiateMcpGateway: true, mcpPolicy: emptyPolicy },
      services: ["mcp"],
      reason: "no_usable_mount",
    },
  ])("records $reason when $name", async ({ options, services, reason }) => {
    const recorder = recordingLogger();
    const state = await fixture({ ...options, logger: recorder.logger, negotiateWebTools: true });
    await state.owner.handle(openFrame({ services }), state.context);
    expect(recorder.reasons).toContain(reason);
  });

  it("records nothing when the service was granted", async () => {
    const recorder = recordingLogger();
    const state = await fixture({ negotiateMcpGateway: true, mcpPolicy: grantingPolicy, logger: recorder.logger });
    await state.owner.handle(openFrame({ services: ["mcp"] }), state.context);
    expect(recorder.reasons).toEqual([]);
  });
});
