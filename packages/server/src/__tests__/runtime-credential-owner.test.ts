import { randomUUID } from "node:crypto";
import { RUNTIME_CAPABILITY, type RuntimeCredentialClientFrame } from "@opentag/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { ConnectionRegistry, type RuntimeControlIdentity } from "../runtime/connection-registry.js";
import type { RuntimeBusinessContext } from "../runtime/runtime-session.js";
import { RuntimeCapabilityStore } from "../runtime-credentials/capability-store.js";
import { RuntimeCredentialBroker } from "../runtime-credentials/credential-broker.js";
import type {
  RuntimeExecutionAuthority,
  RuntimeExecutionAuthorityDecision,
} from "../runtime-credentials/execution-authority.js";
import { RuntimeExecutionRegistry } from "../runtime-credentials/execution-registry.js";
import type { RuntimeGitHubAdmission, RuntimeGitHubAdmissionResult } from "../runtime-credentials/github-admission.js";
import { UnavailableRuntimeGitHubAdmission } from "../runtime-credentials/github-admission.js";
import { RuntimeCredentialOwner } from "../runtime-credentials/runtime-credential-owner.js";
import type {
  RuntimeScopeResolverPort,
  RuntimeScopeSnapshot,
  RuntimeValidationScopeSnapshot,
} from "../runtime-credentials/scope-resolver.js";
import { DefaultRuntimeTaskPolicy, type RuntimeTaskPolicy } from "../runtime-credentials/task-policy.js";
import { RuntimeProxyTicketStore } from "../runtime-credentials/ticket-store.js";
import { runtimeExecutionProviderBinding } from "../runtime-credentials/types.js";
import { RuntimeValidationRunRegistry } from "../runtime-credentials/validation-runs.js";

const AGENT = "00000000-0000-4000-8000-0000000000a1";
const COMPUTER = "00000000-0000-4000-8000-0000000000c1";
const BINDING = "00000000-0000-4000-8000-0000000000b1";
const INSTALLATION = "00000000-0000-4000-8000-0000000000d1";
const REQUEST_ID = "00000000-0000-4000-8000-0000000000f1";

class FakeAuthority implements RuntimeExecutionAuthority {
  decision: RuntimeExecutionAuthorityDecision = { status: "authorized" };
  authorize = vi.fn(async () => this.decision);
  revalidate = vi.fn(async () => "valid" as const);
}

class FakeScopeResolver implements RuntimeScopeResolverPort {
  session: RuntimeScopeSnapshot | undefined = sessionSnapshot();
  validation: RuntimeValidationScopeSnapshot | undefined = validationSnapshot();

  load(): Promise<RuntimeScopeSnapshot | undefined> {
    return Promise.resolve(this.session);
  }

  loadValidationScope(): Promise<RuntimeValidationScopeSnapshot | undefined> {
    return Promise.resolve(this.validation);
  }

  assertExecutionFence(): undefined {
    return undefined;
  }
}

function socket(): WebSocket & { send: ReturnType<typeof vi.fn> } {
  return {
    readyState: WebSocket.OPEN,
    send: vi.fn((_data: string, cb?: (error?: Error) => void) => cb?.()),
    close: vi.fn(),
  } as unknown as WebSocket & { send: ReturnType<typeof vi.fn> };
}

function sessionSnapshot(): RuntimeScopeSnapshot {
  return {
    sessionId: "session-1",
    sessionKind: "thread",
    sessionEnded: false,
    channelId: "C-channel",
    threadKey: "1700.1",
    binding: {
      id: BINDING,
      agentId: AGENT,
      provider: "slack",
      status: "active",
      credentialGeneration: 3,
      externalAppId: null,
      externalTeamId: "T-team",
      externalTeamBrand: null,
      externalBotId: "B-bot",
      slackInstallationId: INSTALLATION,
    },
    slackInstallation: {
      id: INSTALLATION,
      agentId: AGENT,
      status: "active",
      credentialGeneration: 7,
      externalTeamId: "T-team",
      externalBotId: "B-bot",
    },
    agent: {
      id: AGENT,
      status: "active",
      revision: 4,
      computerId: COMPUTER,
      createdByUserId: "00000000-0000-4000-8000-0000000000e1",
    },
    placement: { computerId: COMPUTER, generation: 2 },
    computer: { id: COMPUTER, kind: "local", ownerAccountId: "00000000-0000-4000-8000-0000000000e1" },
    sandbox: null,
  };
}

function validationSnapshot(): RuntimeValidationScopeSnapshot {
  const snapshot = sessionSnapshot();
  return {
    agent: snapshot.agent,
    binding: snapshot.binding,
    slackInstallation: snapshot.slackInstallation,
    computer: snapshot.computer,
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

async function fixture(
  overrides: {
    authority?: FakeAuthority;
    scopeResolver?: FakeScopeResolver;
    gitHubAdmission?: RuntimeGitHubAdmission;
    taskPolicy?: RuntimeTaskPolicy;
    control?: RuntimeControlIdentity;
    cloudControlActive?: (identity: RuntimeControlIdentity) => boolean | Promise<boolean>;
    controlAuthority?: import("../runtime-credentials/credential-broker.js").RuntimeControlAuthority;
  } = {},
) {
  const registry = new ConnectionRegistry();
  const instanceId = randomUUID();
  const connectionId = randomUUID();
  const runtimeSocket = socket();
  await registry.register(
    {
      active: true,
      computerId: COMPUTER,
      connectionId,
      ...(overrides.control ? { control: overrides.control } : {}),
      installationId: INSTALLATION,
      instanceId,
      lastHeartbeatAt: Date.now(),
      socket: runtimeSocket,
      negotiatedCapabilities: {
        [RUNTIME_CAPABILITY.runtimeCredential]: 1,
        [RUNTIME_CAPABILITY.providerProxy]: 1,
      },
    },
    async () => undefined,
  );
  registry.activate(COMPUTER, instanceId, runtimeSocket);
  const executions = new RuntimeExecutionRegistry();
  const capabilities = new RuntimeCapabilityStore();
  const tickets = new RuntimeProxyTicketStore();
  const validationRuns = new RuntimeValidationRunRegistry();
  const scopeResolver = overrides.scopeResolver ?? new FakeScopeResolver();
  const authority = overrides.authority ?? new FakeAuthority();
  const gitHubAdmission: RuntimeGitHubAdmission = overrides.gitHubAdmission ?? new UnavailableRuntimeGitHubAdmission();
  const policy = overrides.taskPolicy ?? new DefaultRuntimeTaskPolicy();
  const broker = new RuntimeCredentialBroker({
    capabilities,
    executions,
    scopeResolver,
    policy,
    gitHubAdmission,
    materialResolvers: {
      slack: { resolve: async () => ({ kind: "bearer", token: "t", origin: "https://slack.com" }) },
    },
    authority,
    connectionFence: {
      isCurrent: (computerId, entryInstanceId, entryConnectionId) =>
        registry.isCurrentConnection(computerId, entryInstanceId, entryConnectionId),
      currentControlIdentity: (computerId) => registry.currentControlIdentity(computerId),
    },
    ...(overrides.cloudControlActive ? { cloudControlActive: overrides.cloudControlActive } : {}),
  });
  const owner = new RuntimeCredentialOwner({
    registry,
    ...(overrides.controlAuthority ? { controlAuthority: overrides.controlAuthority } : {}),
    executions,
    capabilities,
    tickets,
    validationRuns,
    authority,
    scopeResolver,
    broker,
    policy,
    gitHubAdmission,
    ...(overrides.cloudControlActive ? { cloudControlActive: overrides.cloudControlActive } : {}),
    sweepIntervalMs: 60_000,
  });
  const context: RuntimeBusinessContext = {
    computerId: COMPUTER,
    installationId: INSTALLATION,
    connectionId,
    instanceId,
    negotiatedCapabilities: {
      [RUNTIME_CAPABILITY.runtimeCredential]: 1,
      [RUNTIME_CAPABILITY.providerProxy]: 1,
    },
    signal: new AbortController().signal,
  };
  return {
    owner,
    registry,
    executions,
    capabilities,
    tickets,
    validationRuns,
    scopeResolver,
    authority,
    broker,
    runtimeSocket,
    connectionId,
    instanceId,
    context,
  };
}

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const close of cleanup.splice(0)) close();
});

describe("RuntimeCredentialOwner execution open", () => {
  it("opens a delivery execution with the IM provider and outbox metadata", async () => {
    const fixtureState = await fixture();
    cleanup.push(() => fixtureState.owner.close());
    const result = await fixtureState.owner.handle(openFrame(), fixtureState.context);
    expect(result).toMatchObject({
      type: "runtime:execution:result",
      requestId: REQUEST_ID,
      status: "succeeded",
      providers: [
        {
          provider: "slack",
          bindingId: BINDING,
          cli: {
            provider: "slack",
            teamId: "T-team",
            outboxContext: { provider: "slack", sessionKind: "thread", channelId: "C-channel", threadTs: "1700.1" },
          },
        },
      ],
    });
  });

  it("returns bounded execution_not_ready while accepted custody is still pending", async () => {
    const authority = new FakeAuthority();
    authority.decision = { status: "not_ready" };
    const fixtureState = await fixture({ authority });
    cleanup.push(() => fixtureState.owner.close());
    const result = await fixtureState.owner.handle(openFrame(), fixtureState.context);
    expect(result).toEqual({
      type: "runtime:execution:result",
      requestId: REQUEST_ID,
      status: "rejected",
      code: "execution_not_ready",
    });
  });

  it("rejects a terminal custody source", async () => {
    const authority = new FakeAuthority();
    authority.decision = { status: "invalid" };
    const fixtureState = await fixture({ authority });
    cleanup.push(() => fixtureState.owner.close());
    const result = await fixtureState.owner.handle(openFrame(), fixtureState.context);
    expect(result).toMatchObject({ status: "rejected", code: "execution_source_invalid" });
  });

  it("rejects an internal Session while still allowing a validation execution for the same binding", async () => {
    const scopeResolver = new FakeScopeResolver();
    scopeResolver.session = { ...sessionSnapshot(), sessionKind: "internal" };
    const authority = new FakeAuthority();
    const fixtureState = await fixture({ scopeResolver, authority });
    cleanup.push(() => fixtureState.owner.close());
    const internalResult = await fixtureState.owner.handle(openFrame(), fixtureState.context);
    expect(internalResult).toMatchObject({ status: "rejected", code: "execution_authority_denied" });

    const run = fixtureState.validationRuns.issue({
      provider: "slack",
      bindingId: BINDING,
      agentId: AGENT,
      computerId: COMPUTER,
      instanceId: fixtureState.instanceId,
    });
    authority.decision = { status: "authorized", validation: run };
    const validationResult = await fixtureState.owner.handle(
      openFrame({ source: { kind: "validation", validationRunId: run.validationRunId } }),
      fixtureState.context,
    );
    expect(validationResult).toMatchObject({
      status: "succeeded",
      providers: [{ provider: "slack", bindingId: BINDING }],
    });
  });

  it("consumes a validation run exactly once", async () => {
    const authority = new FakeAuthority();
    const fixtureState = await fixture({ authority });
    cleanup.push(() => fixtureState.owner.close());
    const run = fixtureState.validationRuns.issue({
      provider: "slack",
      bindingId: BINDING,
      agentId: AGENT,
      computerId: COMPUTER,
      instanceId: fixtureState.instanceId,
    });
    authority.decision = { status: "authorized", validation: run };
    const source = { kind: "validation" as const, validationRunId: run.validationRunId };
    const first = await fixtureState.owner.handle(openFrame({ source }), fixtureState.context);
    expect(first).toMatchObject({ status: "succeeded" });
    authority.decision = { status: "invalid" };
    const second = await fixtureState.owner.handle(openFrame({ source }), fixtureState.context);
    expect(second).toMatchObject({ status: "rejected", code: "execution_source_invalid" });
  });

  it("issues validation runs only for an active, consistent binding/agent/computer fence", async () => {
    const scopeResolver = new FakeScopeResolver();
    const fixtureState = await fixture({ scopeResolver });
    cleanup.push(() => fixtureState.owner.close());
    const issued = await fixtureState.owner.issueValidationRun({
      provider: "slack",
      bindingId: BINDING,
      agentId: AGENT,
      computerId: COMPUTER,
      instanceId: fixtureState.instanceId,
      connectionId: fixtureState.connectionId,
    });
    expect(issued?.validationRunId).toBeDefined();

    scopeResolver.validation = {
      ...validationSnapshot(),
      agent: { ...validationSnapshot().agent, status: "inactive" },
    };
    await expect(
      fixtureState.owner.issueValidationRun({
        provider: "slack",
        bindingId: BINDING,
        agentId: AGENT,
        computerId: COMPUTER,
        instanceId: fixtureState.instanceId,
      }),
    ).resolves.toBeUndefined();

    scopeResolver.validation = validationSnapshot();
    await expect(
      fixtureState.owner.issueValidationRun({
        provider: "slack",
        bindingId: BINDING,
        agentId: AGENT,
        computerId: COMPUTER,
        instanceId: fixtureState.instanceId,
        connectionId: randomUUID(),
      }),
    ).resolves.toBeUndefined();
  });
});

describe("RuntimeCredentialOwner control flows", () => {
  async function opened() {
    const fixtureState = await fixture();
    cleanup.push(() => fixtureState.owner.close());
    const openResult = (await fixtureState.owner.handle(openFrame(), fixtureState.context)) as {
      type: string;
      status: string;
      executionId?: string;
    };
    if (openResult.status !== "succeeded" || !openResult.executionId) throw new Error("failed to open execution");
    return { ...fixtureState, executionId: openResult.executionId };
  }

  it("acquires, renews, and issues a single-use ticket", async () => {
    const state = await opened();
    const acquire = (await state.owner.handle(
      {
        type: "runtime:credential:acquire",
        requestId: REQUEST_ID,
        executionId: state.executionId,
        provider: "slack",
        bindingId: BINDING,
      } as RuntimeCredentialClientFrame,
      state.context,
    )) as { status: string; grantId?: string; opaqueToken?: string };
    expect(acquire.status).toBe("succeeded");
    const renew = (await state.owner.handle(
      {
        type: "runtime:credential:renew",
        requestId: randomUUID(),
        executionId: state.executionId,
        grantId: acquire.grantId,
      } as RuntimeCredentialClientFrame,
      state.context,
    )) as { status: string };
    expect(renew.status).toBe("succeeded");
    const ticket = (await state.owner.handle(
      {
        type: "runtime:proxy:ticket",
        requestId: randomUUID(),
        executionId: state.executionId,
      } as RuntimeCredentialClientFrame,
      state.context,
    )) as { status: string; ticket?: string };
    expect(ticket.status).toBe("succeeded");
    if (!ticket.ticket) throw new Error("missing ticket");
    expect(state.tickets.consume(ticket.ticket)?.executionId).toBe(state.executionId);
  });

  it("rejects control frames from a different connection than the one that opened the execution", async () => {
    const state = await opened();
    const foreignContext: RuntimeBusinessContext = { ...state.context, connectionId: randomUUID() };
    const acquire = await state.owner.handle(
      {
        type: "runtime:credential:acquire",
        requestId: REQUEST_ID,
        executionId: state.executionId,
        provider: "slack",
        bindingId: BINDING,
      } as RuntimeCredentialClientFrame,
      foreignContext,
    );
    expect(acquire).toMatchObject({ type: "runtime:credential:result", status: "rejected", code: "execution_unknown" });
    const ticket = await state.owner.handle(
      {
        type: "runtime:proxy:ticket",
        requestId: REQUEST_ID,
        executionId: state.executionId,
      } as RuntimeCredentialClientFrame,
      foreignContext,
    );
    expect(ticket).toMatchObject({ status: "rejected", code: "execution_unknown" });
  });

  it("fences a replaced control connection immediately", async () => {
    const state = await opened();
    state.registry.remove(COMPUTER, state.instanceId, state.runtimeSocket);
    const acquire = await state.owner.handle(
      {
        type: "runtime:credential:acquire",
        requestId: REQUEST_ID,
        executionId: state.executionId,
        provider: "slack",
        bindingId: BINDING,
      } as RuntimeCredentialClientFrame,
      state.context,
    );
    expect(acquire).toMatchObject({ status: "rejected", code: "execution_unknown" });
  });

  it("closes the execution and revokes capabilities and tickets", async () => {
    const state = await opened();
    const acquire = (await state.owner.handle(
      {
        type: "runtime:credential:acquire",
        requestId: REQUEST_ID,
        executionId: state.executionId,
        provider: "slack",
        bindingId: BINDING,
      } as RuntimeCredentialClientFrame,
      state.context,
    )) as { opaqueToken?: string };
    const closed = await state.owner.handle(
      {
        type: "runtime:execution:close",
        requestId: REQUEST_ID,
        executionId: state.executionId,
      } as RuntimeCredentialClientFrame,
      state.context,
    );
    expect(closed).toMatchObject({ status: "succeeded" });
    const replay = await state.owner.handle(
      {
        type: "runtime:credential:acquire",
        requestId: REQUEST_ID,
        executionId: state.executionId,
        provider: "slack",
        bindingId: BINDING,
      } as RuntimeCredentialClientFrame,
      state.context,
    );
    expect(replay).toMatchObject({ status: "rejected", code: "execution_unknown" });
    if (acquire.opaqueToken) expect(state.capabilities.lookup(acquire.opaqueToken)).toBeUndefined();
  });

  it("rejects an execution open without the negotiated capabilities", async () => {
    const state = await fixture();
    cleanup.push(() => state.owner.close());
    const result = await state.owner.handle(openFrame(), {
      ...state.context,
      negotiatedCapabilities: {},
    });
    expect(result).toMatchObject({ status: "rejected", code: "capability_unsupported" });
  });

  it("owner close destroys executions and aborts their grants", async () => {
    const state = await opened();
    const acquire = (await state.owner.handle(
      {
        type: "runtime:credential:acquire",
        requestId: REQUEST_ID,
        executionId: state.executionId,
        provider: "slack",
        bindingId: BINDING,
      } as RuntimeCredentialClientFrame,
      state.context,
    )) as { opaqueToken?: string };
    state.owner.close();
    expect(state.executions.get(state.executionId)).toBeUndefined();
    if (acquire.opaqueToken) expect(state.capabilities.lookup(acquire.opaqueToken)).toBeUndefined();
  });
});

describe("RuntimeCredentialOwner composed Cloud control authority", () => {
  it("keeps a live Cloud execution through the sweep and revokes it only when the Cloud fence detaches", async () => {
    const registry = new ConnectionRegistry();
    const cloudConnectionId = randomUUID();
    const cloudConnections = new Set<string>([cloudConnectionId]);
    const sendRevoked = vi.fn();
    const state = await fixture({
      controlAuthority: {
        isCurrentConnection: (computerId, instanceId, connectionId) =>
          registry.isCurrentConnection(computerId, instanceId, connectionId) || cloudConnections.has(connectionId),
        currentInstanceId: (computerId) => registry.currentInstanceId(computerId),
        currentControlIdentity: (computerId) => registry.currentControlIdentity(computerId),
        sendRevoked,
      },
    });
    cleanup.push(() => state.owner.close());
    const execution = state.executions.open({
      accountId: randomUUID(),
      agentId: AGENT,
      agentRevision: 1,
      computerId: COMPUTER,
      computerKind: "cloud",
      connectionId: cloudConnectionId,
      instanceId: "cloud-instance-1",
      placementGeneration: 1,
      providers: new Map(),
      purpose: "execution",
      runId: randomUUID(),
      sessionId: "session-cloud",
      source: { kind: "delivery", deliveryId: randomUUID(), turnId: randomUUID() },
    });
    // The Local registry does not know this Cloud connection; the composed authority does.
    state.owner.sweepNow();
    expect(state.executions.get(execution.executionId)).toBeDefined();
    expect(sendRevoked).not.toHaveBeenCalled();

    // The Cloud fence detaches: the sweep now revokes the execution and notifies the exact
    // owning connection through the composed send port.
    cloudConnections.clear();
    state.owner.sweepNow();
    expect(state.executions.get(execution.executionId)).toBeUndefined();
    expect(sendRevoked).toHaveBeenCalledWith(
      COMPUTER,
      "cloud-instance-1",
      expect.objectContaining({ type: "runtime:credential:revoked", executionId: execution.executionId }),
    );
  });

  it("closes executions by exact connection and by Session for an explicit Cloud stop", async () => {
    const state = await fixture();
    cleanup.push(() => state.owner.close());
    const openExecution = (sessionId: string, connectionId: string, instanceId: string) =>
      state.executions.open({
        accountId: randomUUID(),
        agentId: AGENT,
        agentRevision: 1,
        computerId: COMPUTER,
        computerKind: "cloud",
        connectionId,
        instanceId,
        placementGeneration: 1,
        providers: new Map(),
        purpose: "execution",
        runId: randomUUID(),
        sessionId,
        source: { kind: "delivery", deliveryId: randomUUID(), turnId: randomUUID() },
      });
    const first = openExecution("session-a", randomUUID(), "cloud-instance-a");
    const second = openExecution("session-a", randomUUID(), "cloud-instance-b");
    const third = openExecution("session-b", randomUUID(), "cloud-instance-c");

    expect(state.owner.closeConnection(first.connectionId, "connection_replaced")).toEqual([first.executionId]);
    expect(state.executions.get(first.executionId)).toBeUndefined();
    expect(state.executions.get(second.executionId)).toBeDefined();

    expect(state.owner.closeSessionExecutions("session-a", "execution_closed")).toEqual([second.executionId]);
    expect(state.executions.get(second.executionId)).toBeUndefined();
    expect(state.executions.get(third.executionId)).toBeDefined();
  });
});

describe("RuntimeCredentialOwner provider binding metadata", () => {
  it("correlates provider metadata at construction", () => {
    expect(() =>
      runtimeExecutionProviderBinding("slack", "b", { provider: "feishu", appId: "x", teamBrand: "feishu" }),
    ).toThrow();
  });
});

describe("RuntimeCredentialOwner GitHub source and Cloud control", () => {
  const SANDBOX = "00000000-0000-4000-8000-0000000000aa";

  function cloudSession() {
    const base = sessionSnapshot();
    return {
      ...base,
      computer: { ...base.computer, kind: "cloud" as const },
      sandbox: { id: SANDBOX, resourceUid: "uid-1", environmentGeneration: 2, lifecycle: "ready" },
    };
  }

  function cloudFrame() {
    return openFrame({
      sandbox: { sandboxId: SANDBOX, resourceUid: "uid-1", environmentGeneration: 2 },
    });
  }

  it("passes the exact frame source to GitHub admission at candidate discovery", async () => {
    const inputs: Array<{ source?: unknown }> = [];
    const admission: RuntimeGitHubAdmission = {
      admit: async (input: { source?: unknown }): Promise<RuntimeGitHubAdmissionResult> => {
        inputs.push(input);
        return {
          connectionId: "connection-live",
          authorizationVersion: "v1",
          credentialGeneration: "1",
          bindings: [{ repositoryId: "1", fullName: "acme/repo", role: "code", access: "read" }],
        };
      },
    };
    const state = await fixture({
      gitHubAdmission: admission,
      taskPolicy: { authorize: (input) => (input.provider === "github" ? "permit" : "deny") },
    });
    cleanup.push(() => state.owner.close());
    const source = { kind: "delivery" as const, deliveryId: "d1", turnId: "t1" };
    const result = await state.owner.handle(openFrame({ source }), state.context);
    expect(result).toMatchObject({
      status: "succeeded",
      providers: expect.arrayContaining([expect.objectContaining({ provider: "github" })]),
    });
    expect(inputs.length).toBeGreaterThanOrEqual(1);
    for (const input of inputs) expect(input.source).toEqual(source);
  });

  it("propagates the exact GitHub repository scope into the initial execution-open result", async () => {
    const sessionId = "00000000-0000-4000-8000-0000000000a2";
    const admission: RuntimeGitHubAdmission = {
      admit: async (): Promise<RuntimeGitHubAdmissionResult> => ({
        connectionId: "connection-live",
        authorizationVersion: "v1",
        credentialGeneration: "1",
        bindings: [
          {
            repositoryId: "1",
            fullName: "acme/repo",
            role: "context_tree",
            access: "write",
            scope: {
              agentId: AGENT,
              role: "context_tree",
              access: "write",
              branch: "refs/heads/master",
              publish: "pull_request",
            },
          },
        ],
      }),
    };
    const scopeResolver = new FakeScopeResolver();
    scopeResolver.session = { ...sessionSnapshot(), sessionId };
    const state = await fixture({
      scopeResolver,
      gitHubAdmission: admission,
      taskPolicy: { authorize: (input) => (input.provider === "github" ? "permit" : "deny") },
    });
    cleanup.push(() => state.owner.close());
    const result = await state.owner.handle(openFrame({ sessionId }), state.context);
    expect(result).toMatchObject({
      status: "succeeded",
      providers: [
        {
          provider: "github",
          bindingId: "connection-live",
          cli: {
            provider: "github",
            connectionId: "connection-live",
            repositories: [
              {
                repositoryId: "1",
                fullName: "acme/repo",
                role: "context_tree",
                access: "write",
                branch: "refs/heads/master",
                publish: "pull_request",
                workBranchPrefix: `refs/heads/opentag/${sessionId}/context_tree/`,
              },
            ],
          },
        },
      ],
    });
  });

  it("re-checks the live Cloud control credential before admitting a Cloud open", async () => {
    let active = false;
    const control: RuntimeControlIdentity = {
      credentialId: "credential-1",
      computerId: COMPUTER,
      installationId: INSTALLATION,
      kind: "cloud",
    };
    const scopeResolver = new FakeScopeResolver();
    scopeResolver.session = cloudSession();
    const state = await fixture({ scopeResolver, control, cloudControlActive: () => active });
    cleanup.push(() => state.owner.close());
    const denied = await state.owner.handle(cloudFrame(), state.context);
    expect(denied).toMatchObject({ status: "rejected", code: "execution_authority_denied" });
    active = true;
    const allowed = await state.owner.handle(cloudFrame(), state.context);
    expect(allowed).toMatchObject({ status: "succeeded", providers: [{ provider: "slack" }] });
  });

  it("re-checks live Cloud control for a validation execution open", async () => {
    const active = false;
    const control: RuntimeControlIdentity = {
      credentialId: "credential-1",
      computerId: COMPUTER,
      installationId: INSTALLATION,
      kind: "cloud",
    };
    const scopeResolver = new FakeScopeResolver();
    scopeResolver.validation = {
      ...validationSnapshot(),
      computer: { ...validationSnapshot().computer, kind: "cloud" },
    };
    const state = await fixture({ scopeResolver, control, cloudControlActive: () => active });
    cleanup.push(() => state.owner.close());
    const run = state.validationRuns.issue({
      provider: "slack",
      bindingId: BINDING,
      agentId: AGENT,
      computerId: COMPUTER,
      instanceId: state.instanceId,
    });
    state.authority.decision = { status: "authorized", validation: run };
    const source = { kind: "validation" as const, validationRunId: run.validationRunId };
    const denied = await state.owner.handle(openFrame({ source }), state.context);
    expect(denied).toMatchObject({ status: "rejected", code: "execution_authority_denied" });
  });
});
