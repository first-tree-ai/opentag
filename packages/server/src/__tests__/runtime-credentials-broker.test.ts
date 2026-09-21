import { randomUUID } from "node:crypto";
import type { GitHubAgentScope } from "@opentag/shared";
import { describe, expect, it, vi } from "vitest";
import type { RuntimeControlIdentity } from "../runtime/connection-registry.js";
import { RuntimeCapabilityStore } from "../runtime-credentials/capability-store.js";
import {
  type RuntimeConnectionFence,
  RuntimeCredentialBroker,
  RuntimeCredentialError,
} from "../runtime-credentials/credential-broker.js";
import type {
  RuntimeExecutionAuthority,
  RuntimeExecutionRevalidation,
} from "../runtime-credentials/execution-authority.js";
import { RuntimeExecutionRegistry } from "../runtime-credentials/execution-registry.js";
import type { RuntimeGitHubAdmission, RuntimeGitHubAdmissionResult } from "../runtime-credentials/github-admission.js";
import type { RuntimeProviderMaterialResolver } from "../runtime-credentials/provider-material.js";
import type {
  RuntimeBindingSnapshot,
  RuntimeScopeResolverPort,
  RuntimeScopeSnapshot,
  RuntimeSlackInstallationSnapshot,
  RuntimeValidationScopeSnapshot,
} from "../runtime-credentials/scope-resolver.js";
import type { RuntimeTaskPolicy } from "../runtime-credentials/task-policy.js";
import { DefaultRuntimeTaskPolicy } from "../runtime-credentials/task-policy.js";
import type { RuntimeExecutionProviderBinding, RuntimeExecutionRecord } from "../runtime-credentials/types.js";
import { runtimeExecutionProviderBinding } from "../runtime-credentials/types.js";

const AGENT = "00000000-0000-4000-8000-0000000000a1";
const COMPUTER = "00000000-0000-4000-8000-0000000000c1";
const SESSION = "session-1";
const BINDING = "00000000-0000-4000-8000-0000000000b1";
const INSTALLATION = "00000000-0000-4000-8000-0000000000d1";

class FakeScopeResolver implements RuntimeScopeResolverPort {
  session: RuntimeScopeSnapshot = sessionSnapshot();
  validation: RuntimeValidationScopeSnapshot | undefined = validationSnapshot();
  violation: ReturnType<RuntimeScopeResolverPort["assertExecutionFence"]> = undefined;
  loads = 0;
  validationLoads = 0;

  load(): Promise<RuntimeScopeSnapshot | undefined> {
    this.loads += 1;
    return Promise.resolve(this.session);
  }

  loadValidationScope(): Promise<RuntimeValidationScopeSnapshot | undefined> {
    this.validationLoads += 1;
    return Promise.resolve(this.validation);
  }

  assertExecutionFence(): ReturnType<RuntimeScopeResolverPort["assertExecutionFence"]> {
    return this.violation;
  }
}

class FakeAdmission implements RuntimeGitHubAdmission {
  result?: RuntimeGitHubAdmissionResult;
  calls = 0;
  inputs: Array<{ source?: unknown }> = [];

  admit(input: { source?: unknown }): Promise<RuntimeGitHubAdmissionResult | undefined> {
    this.calls += 1;
    this.inputs.push(input);
    return Promise.resolve(this.result);
  }
}

class FakeAuthority implements RuntimeExecutionAuthority {
  authorize = vi.fn(async () => ({ status: "authorized" as const }));
  revalidate = vi.fn(async (): Promise<RuntimeExecutionRevalidation> => "valid");
}

function sessionSnapshot(overrides: Partial<RuntimeScopeSnapshot> = {}): RuntimeScopeSnapshot {
  return {
    sessionId: SESSION,
    sessionKind: "thread",
    sessionEnded: false,
    channelId: "C-channel",
    threadKey: "1700.1",
    binding: bindingSnapshot(),
    slackInstallation: installationSnapshot(),
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
    ...overrides,
  };
}

function bindingSnapshot(overrides: Partial<RuntimeBindingSnapshot> = {}): RuntimeBindingSnapshot {
  return {
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
    ...overrides,
  };
}

function installationSnapshot(
  overrides: Partial<RuntimeSlackInstallationSnapshot> = {},
): RuntimeSlackInstallationSnapshot {
  return {
    id: INSTALLATION,
    agentId: AGENT,
    status: "active",
    credentialGeneration: 7,
    externalTeamId: "T-team",
    externalBotId: "B-bot",
    ...overrides,
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

function execution(
  registry: RuntimeExecutionRegistry,
  providers: RuntimeExecutionProviderBinding[],
  overrides: Partial<Omit<RuntimeExecutionRecord, "executionId" | "createdAt" | "expiresAt" | "providers">> = {},
): RuntimeExecutionRecord {
  const map = new Map(providers.map((provider) => [`${provider.provider}:${provider.bindingId}`, provider]));
  return registry.open({
    runId: randomUUID(),
    accountId: "00000000-0000-4000-8000-0000000000e1",
    agentId: AGENT,
    agentRevision: 4,
    sessionId: SESSION,
    computerId: COMPUTER,
    instanceId: "instance-1",
    connectionId: "connection-1",
    placementGeneration: 2,
    source: { kind: "delivery", deliveryId: "d1", turnId: "t1" },
    purpose: "execution",
    computerKind: "local",
    providers: map,
    ...overrides,
  });
}

function slackProvider(): RuntimeExecutionProviderBinding {
  return runtimeExecutionProviderBinding("slack", BINDING, {
    provider: "slack",
    teamId: "T-team",
    botUserId: "B-bot",
  });
}

function createBroker(
  overrides: {
    scopeResolver?: RuntimeScopeResolverPort;
    admission?: FakeAdmission;
    policy?: RuntimeTaskPolicy;
    authority?: FakeAuthority;
    material?: RuntimeProviderMaterialResolver;
    connectionFence?: RuntimeConnectionFence;
    cloudControlActive?: (identity: RuntimeControlIdentity) => Promise<boolean> | boolean;
    capabilities?: RuntimeCapabilityStore;
  } = {},
) {
  const capabilities = overrides.capabilities ?? new RuntimeCapabilityStore();
  const executions = new RuntimeExecutionRegistry();
  const scopeResolver = overrides.scopeResolver ?? new FakeScopeResolver();
  const admission = overrides.admission ?? new FakeAdmission();
  const authority = overrides.authority;
  const materialResolver: RuntimeProviderMaterialResolver = overrides.material ?? {
    resolve: async () => ({ kind: "bearer", token: "real-token", origin: "https://slack.com" }),
  };
  const broker = new RuntimeCredentialBroker({
    capabilities,
    executions,
    scopeResolver,
    policy: overrides.policy ?? { authorize: () => "permit" },
    gitHubAdmission: admission,
    materialResolvers: { slack: materialResolver, feishu: materialResolver },
    ...(authority ? { authority } : {}),
    ...(overrides.connectionFence ? { connectionFence: overrides.connectionFence } : {}),
    ...(overrides.cloudControlActive ? { cloudControlActive: overrides.cloudControlActive } : {}),
  });
  return { broker, capabilities, executions, scopeResolver, admission, authority };
}

describe("RuntimeCredentialBroker.acquire", () => {
  it("issues a capability with outbox context and pinned generations", async () => {
    const { broker, executions } = createBroker();
    const record = execution(executions, [slackProvider()]);
    const outcome = await broker.acquire({ execution: record, provider: "slack", bindingId: BINDING });
    expect(outcome.status).toBe("succeeded");
    if (outcome.status !== "succeeded") return;
    expect(outcome.record.credentialGeneration).toBe("3:7");
    expect(outcome.record.authorizationRevision).toBe("slack:3:7");
    expect(outcome.cli).toEqual({
      provider: "slack",
      teamId: "T-team",
      botUserId: "B-bot",
      outboxContext: { provider: "slack", sessionKind: "thread", channelId: "C-channel", threadTs: "1700.1" },
    });
  });

  it("rejects a provider binding that the execution never opened", async () => {
    const { broker, executions } = createBroker();
    const record = execution(executions, [slackProvider()]);
    const outcome = await broker.acquire({ execution: record, provider: "feishu", bindingId: BINDING });
    expect(outcome).toEqual({ status: "rejected", code: "provider_mismatch" });
  });

  it("fails closed when the default scope policy denies GitHub", async () => {
    const { broker, executions, admission } = createBroker({ policy: new DefaultRuntimeTaskPolicy() });
    admission.result = {
      connectionId: "connection-live",
      authorizationVersion: "uat-1",
      credentialGeneration: "9",
      bindings: [{ repositoryId: "1", fullName: "acme/repo", role: "code", access: "read" }],
    };
    const record = execution(executions, [
      runtimeExecutionProviderBinding("github", "connection-live", {
        provider: "github",
        connectionId: "connection-live",
        repositories: [],
      }),
    ]);
    const denied = await broker.acquire({ execution: record, provider: "github", bindingId: "connection-live" });
    expect(denied).toEqual({ status: "rejected", code: "credential_scope_denied" });
  });

  it("allows GitHub only through the injected authoritative policy", async () => {
    const policy: RuntimeTaskPolicy = { authorize: (input) => (input.provider === "github" ? "permit" : "deny") };
    const { broker, executions, admission } = createBroker({ policy });
    admission.result = {
      connectionId: "connection-live",
      authorizationVersion: "uat-1",
      credentialGeneration: "9",
      bindings: [{ repositoryId: "1", fullName: "acme/repo", role: "code", access: "read" }],
    };
    const record = execution(executions, [
      runtimeExecutionProviderBinding("github", "connection-live", {
        provider: "github",
        connectionId: "connection-live",
        repositories: [],
      }),
    ]);
    const outcome = await broker.acquire({ execution: record, provider: "github", bindingId: "connection-live" });
    expect(outcome.status).toBe("succeeded");
    if (outcome.status !== "succeeded") return;
    expect(outcome.cli).toEqual({
      provider: "github",
      connectionId: "connection-live",
      repositories: [{ repositoryId: "1", fullName: "acme/repo", role: "code", access: "read" }],
    });
  });

  it("denies a foreign IM binding even under a permit-by-default test policy", async () => {
    const { broker, executions } = createBroker({
      policy: { authorize: (input) => (input.bindingId === input.sessionBindingId ? "permit" : "deny") },
    });
    const record = execution(executions, [
      runtimeExecutionProviderBinding("slack", "other-binding", {
        provider: "slack",
        teamId: "T",
        botUserId: "B",
      }),
    ]);
    const outcome = await broker.acquire({ execution: record, provider: "slack", bindingId: "other-binding" });
    expect(outcome).toEqual({ status: "rejected", code: "credential_scope_denied" });
  });

  it("rejects a stale binding generation pinned at capability issue time", async () => {
    const scopeResolver = new FakeScopeResolver();
    const { broker, executions } = createBroker({ scopeResolver });
    const record = execution(executions, [slackProvider()]);
    const outcome = await broker.acquire({ execution: record, provider: "slack", bindingId: BINDING });
    if (outcome.status !== "succeeded") throw new Error("expected grant");
    scopeResolver.session = sessionSnapshot({
      binding: bindingSnapshot({ credentialGeneration: 4 }),
    });
    await expect(
      broker.beginRequest({ capability: outcome.token, provider: "slack", bindingId: BINDING }),
    ).rejects.toMatchObject({ code: "credential_stale" });
  });
});

describe("RuntimeCredentialBroker data-request fences", () => {
  it("fails closed when the exact control connection is no longer current", async () => {
    const connectionFence: RuntimeConnectionFence = { isCurrent: () => false };
    const { broker, executions } = createBroker({ connectionFence });
    const record = execution(executions, [slackProvider()]);
    const outcome = await broker.acquire({ execution: record, provider: "slack", bindingId: BINDING });
    expect(outcome).toEqual({ status: "rejected", code: "execution_closed" });
  });

  it("rejects a capability from a different execution after that execution is closed", async () => {
    const { broker, executions } = createBroker();
    const first = execution(executions, [slackProvider()]);
    const second = execution(executions, [slackProvider()]);
    const outcome = await broker.acquire({ execution: first, provider: "slack", bindingId: BINDING });
    if (outcome.status !== "succeeded") throw new Error("expected grant");
    executions.close(first.executionId, "execution_closed");
    await expect(
      broker.beginRequest({ capability: outcome.token, provider: "slack", bindingId: BINDING }),
    ).rejects.toMatchObject({ code: "execution_closed" });
    expect(second.executionId).not.toBe(first.executionId);
  });

  it("rejects a capability presented for a different provider or binding", async () => {
    const { broker, executions } = createBroker();
    const record = execution(executions, [slackProvider()]);
    const outcome = await broker.acquire({ execution: record, provider: "slack", bindingId: BINDING });
    if (outcome.status !== "succeeded") throw new Error("expected grant");
    await expect(
      broker.beginRequest({ capability: outcome.token, provider: "feishu", bindingId: BINDING }),
    ).rejects.toMatchObject({ code: "provider_mismatch" });
    await expect(
      broker.beginRequest({ capability: outcome.token, provider: "slack", bindingId: "other" }),
    ).rejects.toMatchObject({ code: "provider_mismatch" });
  });

  it("rejects an unknown or copied capability value", async () => {
    const { broker } = createBroker();
    await expect(
      broker.beginRequest({ capability: "A".repeat(43), provider: "slack", bindingId: BINDING }),
    ).rejects.toMatchObject({ code: "credential_stale" });
  });

  it("keeps the previous capability usable while a renewal issues the current one", async () => {
    const { broker, executions } = createBroker();
    const record = execution(executions, [slackProvider()]);
    const first = await broker.acquire({ execution: record, provider: "slack", bindingId: BINDING });
    if (first.status !== "succeeded") throw new Error("expected grant");
    const renewed = await broker.renew({ execution: record, grantId: first.record.grantId });
    if (renewed.status !== "succeeded") throw new Error("expected renewal");
    expect(renewed.record.grantId).not.toBe(first.record.grantId);
    await expect(
      broker.beginRequest({ capability: first.token, provider: "slack", bindingId: BINDING }),
    ).resolves.toBeDefined();
    await expect(
      broker.beginRequest({ capability: renewed.token, provider: "slack", bindingId: BINDING }),
    ).resolves.toBeDefined();
  });

  it("never renews a revoked or closed execution", async () => {
    const { broker, executions } = createBroker();
    const record = execution(executions, [slackProvider()]);
    const granted = await broker.acquire({ execution: record, provider: "slack", bindingId: BINDING });
    if (granted.status !== "succeeded") throw new Error("expected grant");
    broker.revokeExecution(record.executionId);
    await expect(broker.renew({ execution: record, grantId: granted.record.grantId })).resolves.toEqual({
      status: "rejected",
      code: "grant_mismatch",
    });
    executions.close(record.executionId, "execution_closed");
    await expect(broker.renew({ execution: record, grantId: granted.record.grantId })).resolves.toEqual({
      status: "rejected",
      code: "grant_mismatch",
    });
  });

  it("rechecks accepted custody through the authority on every request", async () => {
    const authority = new FakeAuthority();
    const { broker, executions } = createBroker({ authority });
    const record = execution(executions, [slackProvider()]);
    const outcome = await broker.acquire({ execution: record, provider: "slack", bindingId: BINDING });
    if (outcome.status !== "succeeded") throw new Error("expected grant");
    authority.revalidate.mockResolvedValueOnce("invalid");
    await expect(
      broker.beginRequest({ capability: outcome.token, provider: "slack", bindingId: BINDING }),
    ).rejects.toMatchObject({ code: "execution_closed" });
    expect(authority.revalidate).toHaveBeenCalledTimes(2);
  });

  it("stops long-stream revalidation when no live capability matches after revocation", async () => {
    const { broker, executions } = createBroker();
    const record = execution(executions, [slackProvider()]);
    const granted = await broker.acquire({ execution: record, provider: "slack", bindingId: BINDING });
    if (granted.status !== "succeeded") throw new Error("expected grant");
    const authorization = await broker.beginRequest({
      capability: granted.token,
      provider: "slack",
      bindingId: BINDING,
    });
    await expect(broker.revalidate(authorization)).resolves.toBeUndefined();
    broker.revokeExecution(record.executionId);
    await expect(broker.revalidate(authorization)).rejects.toMatchObject({ code: "credential_stale" });
  });

  it("accepts a replacement grant during renewal overlap and expires with the capability window", async () => {
    const clock = { now: 1_000 };
    const capabilities = new RuntimeCapabilityStore({ now: () => clock.now, ttlMs: 100, refreshAfterMs: 50 });
    const { broker, executions } = createBroker({ capabilities });
    const record = execution(executions, [slackProvider()]);
    const first = await broker.acquire({ execution: record, provider: "slack", bindingId: BINDING });
    if (first.status !== "succeeded") throw new Error("expected first grant");
    const authorization = await broker.beginRequest({
      capability: first.token,
      provider: "slack",
      bindingId: BINDING,
    });
    clock.now = 1_060;
    const renewed = await broker.renew({ execution: record, grantId: first.record.grantId });
    expect(renewed.status).toBe("succeeded");
    clock.now = 1_110;
    // The original grant is expired; the replacement grant keeps the same stream authorized.
    expect(capabilities.lookup(first.token)).toBeUndefined();
    await expect(broker.revalidate(authorization)).resolves.toBeUndefined();
    clock.now = 1_170;
    await expect(broker.revalidate(authorization)).rejects.toMatchObject({ code: "credential_stale" });
  });

  it("rechecks the fence after an asynchronous material boundary", async () => {
    const scopeResolver = new FakeScopeResolver();
    const resolveMaterial = vi.fn(async () => {
      scopeResolver.violation = "agent_revision_changed";
      return { kind: "bearer" as const, token: "real-token", origin: "https://slack.com" };
    });
    const { broker, executions } = createBroker({ scopeResolver, material: { resolve: resolveMaterial } });
    const record = execution(executions, [slackProvider()]);
    const outcome = await broker.acquire({ execution: record, provider: "slack", bindingId: BINDING });
    if (outcome.status !== "succeeded") throw new Error("expected grant");
    const authorization = await broker.beginRequest({
      capability: outcome.token,
      provider: "slack",
      bindingId: BINDING,
    });
    const material = await authorization.resolveMaterial();
    expect(material.token).toBe("real-token");
    await expect(authorization.recheck()).rejects.toMatchObject({ code: "credential_stale" });
  });
});

describe("RuntimeCredentialBroker GitHub scope hash", () => {
  function admission(overrides: Partial<RuntimeGitHubAdmissionResult> = {}): RuntimeGitHubAdmissionResult {
    return {
      connectionId: "connection-live",
      authorizationVersion: "uat-1",
      credentialGeneration: "9",
      bindings: [{ repositoryId: "1", fullName: "acme/repo", role: "code", access: "read" }],
      ...overrides,
    };
  }

  function githubFixture() {
    const admissionMock = new FakeAdmission();
    const policy: RuntimeTaskPolicy = { authorize: () => "permit" };
    const { broker, executions } = createBroker({ admission: admissionMock, policy });
    const record = execution(executions, [
      runtimeExecutionProviderBinding("github", "connection-live", {
        provider: "github",
        connectionId: "connection-live",
        repositories: [],
      }),
    ]);
    return async (result: RuntimeGitHubAdmissionResult) => {
      admissionMock.result = result;
      return broker.describeProvider({
        execution: record,
        provider: "github",
        bindingId: "connection-live",
      });
    };
  }

  it("does not revoke unchanged scopes on a normal UAT refresh (credentialGeneration only)", async () => {
    const githubScope = githubFixture();
    const before = await githubScope(admission({ credentialGeneration: "9" }));
    const after = await githubScope(admission({ credentialGeneration: "10" }));
    expect(after.scopeHash).toBe(before.scopeHash);
    expect(after.credentialGeneration).toBe("10");
  });

  it("invalidates on authorizationVersion and on any exact repository scope change", async () => {
    const githubScope = githubFixture();
    const base = await githubScope(admission());
    const version = await githubScope(admission({ authorizationVersion: "uat-2" }));
    const access = await githubScope(
      admission({ bindings: [{ repositoryId: "1", fullName: "acme/repo", role: "code", access: "write" }] }),
    );
    const added = await githubScope(
      admission({
        bindings: [
          { repositoryId: "1", fullName: "acme/repo", role: "code", access: "read" },
          { repositoryId: "2", fullName: "acme/other", role: "code", access: "read" },
        ],
      }),
    );
    expect(version.scopeHash).not.toBe(base.scopeHash);
    expect(access.scopeHash).not.toBe(base.scopeHash);
    expect(added.scopeHash).not.toBe(base.scopeHash);
  });

  it("orders the repository scope canonically", async () => {
    const githubScope = githubFixture();
    const first = await githubScope(
      admission({
        bindings: [
          { repositoryId: "2", fullName: "acme/b", role: "code", access: "read" },
          { repositoryId: "1", fullName: "acme/a", role: "code", access: "read" },
        ],
      }),
    );
    const second = await githubScope(
      admission({
        bindings: [
          { repositoryId: "1", fullName: "acme/a", role: "code", access: "read" },
          { repositoryId: "2", fullName: "acme/b", role: "code", access: "read" },
        ],
      }),
    );
    expect(first.scopeHash).toBe(second.scopeHash);
  });
});

describe("RuntimeCredentialBroker validation executions", () => {
  it("authorizes against the binding fence without a business Session", async () => {
    const scopeResolver = new FakeScopeResolver();
    scopeResolver.session = sessionSnapshot({ sessionKind: "internal", sessionEnded: true });
    const { broker, executions } = createBroker({ scopeResolver });
    const record = execution(executions, [slackProvider()], {
      purpose: "validation",
      validation: { provider: "slack", bindingId: BINDING },
      source: { kind: "validation", validationRunId: randomUUID() },
    });
    const outcome = await broker.acquire({ execution: record, provider: "slack", bindingId: BINDING });
    expect(outcome.status).toBe("succeeded");
    expect(scopeResolver.validationLoads).toBe(1);
    expect(scopeResolver.loads).toBe(0);
  });

  it("fails the validation fence when the Agent revision advances", async () => {
    const scopeResolver = new FakeScopeResolver();
    scopeResolver.validation = { ...validationSnapshot(), agent: { ...validationSnapshot().agent, revision: 9 } };
    const { broker, executions } = createBroker({ scopeResolver });
    const record = execution(executions, [slackProvider()], {
      purpose: "validation",
      validation: { provider: "slack", bindingId: BINDING },
      source: { kind: "validation", validationRunId: randomUUID() },
    });
    const outcome = await broker.acquire({ execution: record, provider: "slack", bindingId: BINDING });
    expect(outcome).toEqual({ status: "rejected", code: "credential_stale" });
  });

  it("fails closed when no validation scope loader exists", async () => {
    const scopeResolver: RuntimeScopeResolverPort = {
      load: async () => undefined,
      assertExecutionFence: () => undefined,
    };
    const { broker, executions } = createBroker({ scopeResolver });
    const record = execution(executions, [slackProvider()], {
      purpose: "validation",
      validation: { provider: "slack", bindingId: BINDING },
      source: { kind: "validation", validationRunId: randomUUID() },
    });
    const outcome = await broker.acquire({ execution: record, provider: "slack", bindingId: BINDING });
    expect(outcome).toEqual({ status: "rejected", code: "execution_closed" });
  });
});

describe("RuntimeCredentialError", () => {
  it("carries the reject code for control-plane mapping", () => {
    const error = new RuntimeCredentialError("credential_stale");
    expect(error.code).toBe("credential_stale");
    expect(error.name).toBe("RuntimeCredentialError");
  });
});

describe("RuntimeCredentialBroker GitHub admission (source + full scope)", () => {
  function scope(overrides: Partial<GitHubAgentScope> = {}): GitHubAgentScope {
    return { agentId: AGENT, role: "code", access: "read", ...overrides };
  }

  function admissionResult(overrides: Partial<RuntimeGitHubAdmissionResult> = {}): RuntimeGitHubAdmissionResult {
    return {
      connectionId: "connection-live",
      authorizationVersion: "uat-1",
      credentialGeneration: "9",
      bindings: [{ repositoryId: "1", fullName: "acme/repo", role: "code", access: "read", scope: scope() }],
      ...overrides,
    };
  }

  function fixture() {
    const admissionMock = new FakeAdmission();
    const policy: RuntimeTaskPolicy = { authorize: () => "permit" };
    const { broker, executions } = createBroker({ admission: admissionMock, policy });
    const record = execution(executions, [
      runtimeExecutionProviderBinding("github", "connection-live", {
        provider: "github",
        connectionId: "connection-live",
        repositories: [],
      }),
    ]);
    return { admissionMock, broker, record };
  }

  it("passes the exact accepted execution source to GitHub admission", async () => {
    const { admissionMock, broker, record } = fixture();
    admissionMock.result = admissionResult();
    await broker.describeProvider({ execution: record, provider: "github", bindingId: "connection-live" });
    expect(admissionMock.inputs[0]?.source).toEqual(record.source);
  });

  it("propagates the exact repository scope into describe, acquire, and renew metadata", async () => {
    const sessionId = "00000000-0000-4000-8000-0000000000a2";
    const admissionMock = new FakeAdmission();
    const policy: RuntimeTaskPolicy = { authorize: () => "permit" };
    const { broker, executions } = createBroker({ admission: admissionMock, policy });
    const record = execution(
      executions,
      [
        runtimeExecutionProviderBinding("github", "connection-live", {
          provider: "github",
          connectionId: "connection-live",
          repositories: [],
        }),
      ],
      { sessionId },
    );
    admissionMock.result = {
      connectionId: "connection-live",
      authorizationVersion: "uat-1",
      credentialGeneration: "9",
      bindings: [
        {
          repositoryId: "1",
          fullName: "acme/repo",
          role: "context_tree",
          access: "write",
          scope: scope({
            role: "context_tree",
            access: "write",
            branch: "refs/heads/master",
            publish: "pull_request",
          }),
        },
      ],
    };
    const expectedCli = {
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
    };
    const described = await broker.describeProvider({
      execution: record,
      provider: "github",
      bindingId: "connection-live",
    });
    expect(described.cli).toEqual(expectedCli);
    const acquired = await broker.acquire({ execution: record, provider: "github", bindingId: "connection-live" });
    expect(acquired.status).toBe("succeeded");
    if (acquired.status !== "succeeded") return;
    expect(acquired.cli).toEqual(expectedCli);
    const renewed = await broker.renew({ execution: record, grantId: acquired.record.grantId });
    expect(renewed.status).toBe("succeeded");
    if (renewed.status === "succeeded") expect(renewed.cli).toEqual(expectedCli);

    // A caller that never sent a scope object keeps the compact metadata shape.
    admissionMock.result = {
      connectionId: "connection-live",
      authorizationVersion: "uat-1",
      credentialGeneration: "9",
      bindings: [{ repositoryId: "1", fullName: "acme/repo", role: "code", access: "read" }],
    };
    const compact = await broker.describeProvider({
      execution: record,
      provider: "github",
      bindingId: "connection-live",
    });
    expect(compact.cli).toEqual({
      provider: "github",
      connectionId: "connection-live",
      repositories: [{ repositoryId: "1", fullName: "acme/repo", role: "code", access: "read" }],
    });
  });

  it("invalidates when only the nested scope changes (branch, publish mode, delegation)", async () => {
    const admissionMock = new FakeAdmission();
    const policy: RuntimeTaskPolicy = { authorize: () => "permit" };
    const { broker, executions } = createBroker({ admission: admissionMock, policy });
    const record = execution(executions, [
      runtimeExecutionProviderBinding("github", "connection-live", {
        provider: "github",
        connectionId: "connection-live",
        repositories: [],
      }),
    ]);
    const describeScope = async (next: GitHubAgentScope) => {
      admissionMock.result = admissionResult({
        bindings: [{ repositoryId: "1", fullName: "acme/repo", role: "code", access: "read", scope: next }],
      });
      return broker.describeProvider({ execution: record, provider: "github", bindingId: "connection-live" });
    };
    const base = await describeScope(scope());
    const tree = await describeScope(scope({ role: "context_tree", branch: "refs/heads/main" }));
    const publish = await describeScope(scope({ access: "write", publish: "direct" }));
    const delegated = await describeScope(scope({ taskDelegation: { imSenders: [], sessionAgents: [AGENT] } }));
    expect(new Set([base.scopeHash, tree.scopeHash, publish.scopeHash, delegated.scopeHash]).size).toBe(4);
  });

  it("hashes equal scopes identically regardless of key insertion order", async () => {
    const admissionMock = new FakeAdmission();
    const policy: RuntimeTaskPolicy = { authorize: () => "permit" };
    const { broker, executions } = createBroker({ admission: admissionMock, policy });
    const record = execution(executions, [
      runtimeExecutionProviderBinding("github", "connection-live", {
        provider: "github",
        connectionId: "connection-live",
        repositories: [],
      }),
    ]);
    const first = { agentId: AGENT, role: "code", access: "read" } as GitHubAgentScope;
    const second = { access: "read", role: "code", agentId: AGENT } as GitHubAgentScope;
    const describeScope = async (next: GitHubAgentScope) => {
      admissionMock.result = admissionResult({
        bindings: [{ repositoryId: "1", fullName: "acme/repo", role: "code", access: "read", scope: next }],
      });
      return broker.describeProvider({ execution: record, provider: "github", bindingId: "connection-live" });
    };
    expect((await describeScope(first)).scopeHash).toBe((await describeScope(second)).scopeHash);
  });
});

describe("RuntimeCredentialBroker Cloud control liveness", () => {
  const identity: RuntimeControlIdentity = {
    credentialId: "credential-1",
    computerId: COMPUTER,
    installationId: "installation-1",
    kind: "cloud",
  };

  function cloudBroker(cloudControlActive?: () => boolean) {
    const connectionFence: RuntimeConnectionFence = {
      isCurrent: () => true,
      currentControlIdentity: () => identity,
    };
    const { broker, executions } = createBroker({
      connectionFence,
      ...(cloudControlActive ? { cloudControlActive } : {}),
    });
    const record = execution(executions, [slackProvider()], {
      computerKind: "cloud",
      sandbox: { sandboxId: randomUUID(), resourceUid: "uid-1", environmentGeneration: 1 },
    });
    return { broker, record };
  }

  it("fails closed for Cloud when no live control check is wired", async () => {
    const { broker, record } = cloudBroker();
    const outcome = await broker.acquire({ execution: record, provider: "slack", bindingId: BINDING });
    expect(outcome).toEqual({ status: "rejected", code: "execution_closed" });
  });

  it("admits Cloud only while the control credential is active, and revokes immediately after", async () => {
    let active = true;
    const { broker, record } = cloudBroker(() => active);
    const outcome = await broker.acquire({ execution: record, provider: "slack", bindingId: BINDING });
    expect(outcome.status).toBe("succeeded");
    if (outcome.status !== "succeeded") return;
    await expect(
      broker.beginRequest({ capability: outcome.token, provider: "slack", bindingId: BINDING }),
    ).resolves.toBeDefined();
    active = false;
    await expect(
      broker.beginRequest({ capability: outcome.token, provider: "slack", bindingId: BINDING }),
    ).rejects.toMatchObject({ code: "execution_closed" });
  });

  it("leaves Local executions independent of the Cloud control check", async () => {
    const connectionFence: RuntimeConnectionFence = { isCurrent: () => true };
    const { broker, executions } = createBroker({ connectionFence, cloudControlActive: () => false });
    const record = execution(executions, [slackProvider()]);
    const outcome = await broker.acquire({ execution: record, provider: "slack", bindingId: BINDING });
    expect(outcome.status).toBe("succeeded");
  });
});
