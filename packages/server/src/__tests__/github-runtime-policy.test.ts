/*
 * Contract-level tests for the GitHub runtime policy: task-source admission (IM delivery vs
 * session message vs validation), owner-authored delegation, repository roles, live UAT admission,
 * stale-version fences, abort handling, and read/write/direct/PR selection.
 *
 * The two `#candidate` lookups run through a Drizzle-shaped query stub returning configured rows.
 * The stub exercises resolution and denial control flow only; the SQL predicate and join semantics
 * of those two queries are owned by the PostgreSQL integration suite and are not claimed here.
 * The management service and execution registry are legitimate dependency fakes: no network, no
 * credentials, no live provider call.
 */

import { randomUUID } from "node:crypto";
import type {
  GitHubAgentScope,
  GitHubConnectionStatus,
  GitHubRepositoryBinding,
  RuntimeExecutionSource,
} from "@opentag/shared";
import { describe, expect, it, vi } from "vitest";
import type { DatabaseClient } from "../db/client.js";
import type { RuntimeProxyAuthorization } from "../runtime-credentials/credential-broker.js";
import type { RuntimeExecutionRegistry } from "../runtime-credentials/execution-registry.js";
import type { RuntimeTaskPolicyInput } from "../runtime-credentials/task-policy.js";
import type { RuntimeExecutionRecord } from "../runtime-credentials/types.js";
import type { GitHubManagementService } from "../services/github/github-management-service.js";
import { GitPublicationError } from "../services/github-proxy/git-packets.js";
import { GitHubRuntimePolicy } from "../services/github-proxy/runtime-policy.js";

const ACCOUNT = randomUUID();
const AGENT = randomUUID();
const OTHER_AGENT = randomUUID();
const SESSION = randomUUID();
const BINDING_ID = randomUUID();
const IM_BINDING = randomUUID();
const IM_SENDER = "U0123456789";
const TREE_BRANCH = "refs/heads/opentag/tree/main";

type Delegation = NonNullable<GitHubAgentScope["taskDelegation"]>;

function delegation(overrides: Partial<Delegation> = {}): Delegation {
  return { imSenders: [], sessionAgents: [], ...overrides };
}

function readScope(agentId = AGENT, taskDelegation?: Delegation): GitHubAgentScope {
  return { agentId, role: "code", access: "read", ...(taskDelegation ? { taskDelegation } : {}) };
}

function writeScope(
  publish: "direct" | "pull_request",
  taskDelegation?: Delegation,
  agentId = AGENT,
): GitHubAgentScope {
  return { agentId, role: "code", access: "write", publish, ...(taskDelegation ? { taskDelegation } : {}) };
}

function treeWriteScope(
  branch: string,
  publish: "direct" | "pull_request",
  taskDelegation?: Delegation,
): GitHubAgentScope {
  return {
    agentId: AGENT,
    role: "context_tree",
    access: "write",
    publish,
    branch,
    ...(taskDelegation ? { taskDelegation } : {}),
  };
}

function repositoryBinding(
  scopes: GitHubAgentScope[],
  overrides: Partial<GitHubRepositoryBinding> = {},
): GitHubRepositoryBinding {
  return {
    bindingId: randomUUID(),
    installationId: "1001",
    repositoryId: "2002",
    fullNameDisplay: "octocat/hello-world",
    agentScopes: scopes,
    ...overrides,
  };
}

function connectionStatus(overrides: Partial<GitHubConnectionStatus> = {}): GitHubConnectionStatus {
  const now = Date.now();
  return {
    id: BINDING_ID,
    accountId: ACCOUNT,
    githubHost: "github.com",
    appId: "101",
    githubUserId: "42",
    githubLogin: "octocat",
    status: "active",
    bindingsSchemaVersion: 1,
    bindings: [],
    authorizationVersion: "7",
    credentialGeneration: "3",
    accessExpiresAt: new Date(now + 3_600_000).toISOString(),
    refreshExpiresAt: null,
    recheckRequired: false,
    nextRecheckAt: null,
    lastVerifiedAt: null,
    lastErrorCode: null,
    createdAt: new Date(now).toISOString(),
    updatedAt: new Date(now).toISOString(),
    ...overrides,
  };
}

function deliverySource(): RuntimeExecutionSource {
  return { kind: "delivery", deliveryId: randomUUID(), turnId: randomUUID() };
}

function executionRecord(overrides: Partial<RuntimeExecutionRecord> = {}): Partial<RuntimeExecutionRecord> {
  return { accountId: ACCOUNT, agentId: AGENT, sessionId: SESSION, source: deliverySource(), ...overrides };
}

function proxyAuthorization(overrides: Partial<RuntimeProxyAuthorization> = {}): RuntimeProxyAuthorization {
  return {
    executionId: randomUUID(),
    provider: "github",
    bindingId: BINDING_ID,
    purpose: "execution",
    scopeHash: "a".repeat(64),
    authorizationRevision: "github:7",
    credentialGeneration: "3",
    sessionId: SESSION,
    accountId: ACCOUNT,
    agentId: AGENT,
    cli: { provider: "github", connectionId: BINDING_ID, repositories: [] },
    resolveMaterial: async () => {
      throw new Error("resolve() must not resolve credential material");
    },
    recheck: vi.fn(async () => undefined),
    ...overrides,
  };
}

function taskPolicyInput(overrides: Partial<RuntimeTaskPolicyInput> = {}): RuntimeTaskPolicyInput {
  return {
    accountId: ACCOUNT,
    agentId: AGENT,
    sessionId: SESSION,
    provider: "github",
    bindingId: BINDING_ID,
    sessionBindingId: BINDING_ID,
    source: deliverySource(),
    purpose: "execution",
    ...overrides,
  };
}

interface QueryChain {
  from(): QueryChain;
  innerJoin(): QueryChain;
  where(): QueryChain;
  limit(count: number): Promise<unknown[]>;
}

interface PolicyFixtureOptions {
  connection: GitHubConnectionStatus | null;
  afterVerify?: GitHubConnectionStatus | null;
  proofVersion?: string;
  execution?: Partial<RuntimeExecutionRecord> | null;
  delivery?: { bindingId: string; senderId: string }[];
  message?: { sourceAgentId: string }[];
  verifyDelay?: () => void;
}

interface VerifyAdmissionInput {
  connectionId: string;
  installationId: string;
  repositoryId: string;
  access: "read" | "write";
  publish?: "direct" | "pull_request";
}

function buildPolicy(input: PolicyFixtureOptions) {
  let overviewCalls = 0;
  const getOverview = vi.fn(async () => {
    overviewCalls += 1;
    const current = overviewCalls === 1 || input.afterVerify === undefined ? input.connection : input.afterVerify;
    return { availability: { available: true, githubHost: "github.com", appId: "101" }, connection: current };
  });
  const verifyCurrentRepositoryAdmission = vi.fn<
    (admission: VerifyAdmissionInput) => Promise<{ authorizationVersion: bigint; credentialGeneration: bigint }>
  >(async () => {
    input.verifyDelay?.();
    return {
      authorizationVersion: BigInt(input.proofVersion ?? input.connection?.authorizationVersion ?? "0"),
      credentialGeneration: BigInt(input.connection?.credentialGeneration ?? "0"),
    };
  });
  const select = vi.fn((projection: Record<string, unknown>) => {
    const selected = "sourceAgentId" in projection ? (input.message ?? []) : (input.delivery ?? []);
    const chain: QueryChain = {
      from: () => chain,
      innerJoin: () => chain,
      where: () => chain,
      limit: () => Promise.resolve(selected),
    };
    return chain;
  });
  const executionGet = vi.fn(() =>
    input.execution === null || input.execution === undefined
      ? undefined
      : ({ ...executionRecord(), ...input.execution } as RuntimeExecutionRecord),
  );
  const policy = new GitHubRuntimePolicy({
    database: { select } as unknown as DatabaseClient,
    management: { getOverview, verifyCurrentRepositoryAdmission } as unknown as GitHubManagementService,
    execution: { get: executionGet } as unknown as Pick<RuntimeExecutionRegistry, "get">,
  });
  return { policy, getOverview, verifyCurrentRepositoryAdmission, select, executionGet };
}

function admissionInput(overrides: { source?: RuntimeExecutionSource; signal?: AbortSignal } = {}) {
  return {
    accountId: ACCOUNT,
    agentId: AGENT,
    sessionId: SESSION,
    source: overrides.source ?? deliverySource(),
    ...(overrides.signal ? { signal: overrides.signal } : {}),
  };
}

const delegatedSenderScope = readScope(
  AGENT,
  delegation({ imSenders: [{ bindingId: IM_BINDING, senderId: IM_SENDER }] }),
);
const noDelegationScope = readScope(AGENT);

describe("GitHubRuntimePolicy.authorize", () => {
  it("permits a non-GitHub provider only for the session's own binding", async () => {
    const { policy } = buildPolicy({ connection: null });
    await expect(
      policy.authorize(taskPolicyInput({ provider: "slack", bindingId: "binding-1", sessionBindingId: "binding-1" })),
    ).resolves.toBe("permit");
    await expect(
      policy.authorize(taskPolicyInput({ provider: "feishu", bindingId: "binding-1", sessionBindingId: "binding-2" })),
    ).resolves.toBe("deny");
  });

  it("denies GitHub execution before any lookup when the purpose is not execution", async () => {
    const { policy, getOverview } = buildPolicy({ connection: connectionStatus() });
    await expect(policy.authorize(taskPolicyInput({ purpose: "validation" }))).resolves.toBe("deny");
    expect(getOverview).not.toHaveBeenCalled();
  });

  it("permits GitHub execution for the owning IM sender delegation on the live connection", async () => {
    const connection = connectionStatus({ bindings: [repositoryBinding([delegatedSenderScope])] });
    const { policy } = buildPolicy({
      connection,
      delivery: [{ bindingId: IM_BINDING, senderId: IM_SENDER }],
    });
    await expect(
      policy.authorize(
        taskPolicyInput({ source: { kind: "delivery", deliveryId: randomUUID(), turnId: randomUUID() } }),
      ),
    ).resolves.toBe("permit");
  });

  it("denies GitHub execution when the resolved connection is not the requested binding", async () => {
    const connection = connectionStatus({ id: randomUUID(), bindings: [repositoryBinding([delegatedSenderScope])] });
    const { policy } = buildPolicy({
      connection,
      delivery: [{ bindingId: IM_BINDING, senderId: IM_SENDER }],
    });
    await expect(policy.authorize(taskPolicyInput())).resolves.toBe("deny");
  });

  it("denies GitHub execution when no scope delegates to the candidate", async () => {
    const connection = connectionStatus({ bindings: [repositoryBinding([noDelegationScope])] });
    const { policy } = buildPolicy({ connection, delivery: [{ bindingId: IM_BINDING, senderId: IM_SENDER }] });
    await expect(policy.authorize(taskPolicyInput())).resolves.toBe("deny");
  });

  it("denies GitHub execution when the execution source yields no candidate", async () => {
    const connection = connectionStatus({ bindings: [repositoryBinding([delegatedSenderScope])] });
    const { policy, select } = buildPolicy({ connection });
    await expect(
      policy.authorize(taskPolicyInput({ source: { kind: "validation", validationRunId: randomUUID() } })),
    ).resolves.toBe("deny");
    expect(select).not.toHaveBeenCalled();
  });
});

describe("GitHubRuntimePolicy.admit", () => {
  it("returns the exact delegated scope objects and verifies read/write/publish selection", async () => {
    const directWrite = writeScope(
      "direct",
      delegation({ imSenders: [{ bindingId: IM_BINDING, senderId: IM_SENDER }] }),
    );
    const pullRequestWrite = writeScope(
      "pull_request",
      delegation({ imSenders: [{ bindingId: IM_BINDING, senderId: IM_SENDER }] }),
    );
    const treeDirect = treeWriteScope(
      TREE_BRANCH,
      "direct",
      delegation({ imSenders: [{ bindingId: IM_BINDING, senderId: IM_SENDER }] }),
    );
    const treePullRequest = treeWriteScope(
      TREE_BRANCH,
      "pull_request",
      delegation({ imSenders: [{ bindingId: IM_BINDING, senderId: IM_SENDER }] }),
    );
    const connection = connectionStatus({
      bindings: [
        repositoryBinding([delegatedSenderScope], { repositoryId: "1" }),
        repositoryBinding([directWrite], { repositoryId: "2" }),
        repositoryBinding([pullRequestWrite], { repositoryId: "3" }),
        repositoryBinding([treeDirect], { repositoryId: "4" }),
        repositoryBinding([treePullRequest], { repositoryId: "5" }),
      ],
    });
    const { policy, verifyCurrentRepositoryAdmission } = buildPolicy({
      connection,
      delivery: [{ bindingId: IM_BINDING, senderId: IM_SENDER }],
    });
    const result = await policy.admit(admissionInput());
    if (!result) throw new Error("admission was denied");
    expect(result.connectionId).toBe(BINDING_ID);
    expect(result.authorizationVersion).toBe("7");
    expect(result.credentialGeneration).toBe("3");
    expect(result.bindings.map((binding) => binding.repositoryId)).toEqual(["1", "2", "3", "4", "5"]);
    expect(result.bindings[0]?.scope).toEqual(delegatedSenderScope);
    expect(result.bindings.map((binding) => binding.role)).toEqual([
      "code",
      "code",
      "code",
      "context_tree",
      "context_tree",
    ]);
    expect(result.bindings.map((binding) => binding.access)).toEqual(["read", "write", "write", "write", "write"]);
    expect(verifyCurrentRepositoryAdmission.mock.calls.map(([call]) => call)).toEqual([
      { connectionId: BINDING_ID, installationId: "1001", repositoryId: "1", access: "read" },
      { connectionId: BINDING_ID, installationId: "1001", repositoryId: "2", access: "write", publish: "direct" },
      { connectionId: BINDING_ID, installationId: "1001", repositoryId: "3", access: "write", publish: "pull_request" },
      { connectionId: BINDING_ID, installationId: "1001", repositoryId: "4", access: "write", publish: "direct" },
      { connectionId: BINDING_ID, installationId: "1001", repositoryId: "5", access: "write", publish: "pull_request" },
    ]);
    expect(verifyCurrentRepositoryAdmission.mock.calls[0]?.[0]).not.toHaveProperty("publish");
  });

  it.each([
    { label: "inactive", overrides: { status: "revoked" as const } },
    { label: "expired", overrides: { accessExpiresAt: new Date(Date.now() - 60_000).toISOString() } },
    { label: "missing expiry", overrides: { accessExpiresAt: null } },
    { label: "absent", overrides: null },
  ])("returns undefined for a $label connection", async ({ overrides }) => {
    const connection = overrides
      ? connectionStatus({ bindings: [repositoryBinding([delegatedSenderScope])], ...overrides })
      : null;
    const { policy } = buildPolicy({ connection, delivery: [{ bindingId: IM_BINDING, senderId: IM_SENDER }] });
    await expect(policy.admit(admissionInput())).resolves.toBeUndefined();
  });

  it("denies when the delegated binding's repository scope belongs to another agent", async () => {
    const connection = connectionStatus({
      bindings: [
        repositoryBinding([
          readScope(OTHER_AGENT, delegation({ imSenders: [{ bindingId: IM_BINDING, senderId: IM_SENDER }] })),
        ]),
      ],
    });
    const { policy } = buildPolicy({ connection, delivery: [{ bindingId: IM_BINDING, senderId: IM_SENDER }] });
    await expect(policy.admit(admissionInput())).resolves.toBeUndefined();
  });

  it("denies when the delivery row's sender is not in the scope delegation", async () => {
    const connection = connectionStatus({ bindings: [repositoryBinding([delegatedSenderScope])] });
    const { policy } = buildPolicy({ connection, delivery: [{ bindingId: IM_BINDING, senderId: "U9999999999" }] });
    await expect(policy.admit(admissionInput())).resolves.toBeUndefined();
  });

  it("denies when the delivery row is missing for the execution turn", async () => {
    const connection = connectionStatus({ bindings: [repositoryBinding([delegatedSenderScope])] });
    const { policy } = buildPolicy({ connection, delivery: [] });
    await expect(policy.admit(admissionInput())).resolves.toBeUndefined();
  });

  it("denies when the live proof reports a stale authorization version", async () => {
    const connection = connectionStatus({ bindings: [repositoryBinding([delegatedSenderScope])] });
    const { policy } = buildPolicy({
      connection,
      proofVersion: "8",
      delivery: [{ bindingId: IM_BINDING, senderId: IM_SENDER }],
    });
    await expect(policy.admit(admissionInput())).rejects.toMatchObject({ code: "scope_denied" });
  });

  it.each([
    { label: "removed", connection: null },
    { label: "inactive", connection: connectionStatus({ status: "revoked" }) },
    { label: "a different connection", connection: connectionStatus({ id: randomUUID() }) },
    { label: "a newer authorization version", connection: connectionStatus({ authorizationVersion: "8" }) },
  ])("denies when the connection is $label after verification", async ({ connection: afterVerify }) => {
    const connection = connectionStatus({ bindings: [repositoryBinding([delegatedSenderScope])] });
    const { policy } = buildPolicy({
      connection,
      afterVerify,
      delivery: [{ bindingId: IM_BINDING, senderId: IM_SENDER }],
    });
    await expect(policy.admit(admissionInput())).rejects.toMatchObject({ code: "scope_denied" });
  });

  it("denies when the execution carries no source at all", async () => {
    const connection = connectionStatus({ bindings: [repositoryBinding([delegatedSenderScope])] });
    const { policy, select } = buildPolicy({ connection, delivery: [{ bindingId: IM_BINDING, senderId: IM_SENDER }] });
    await expect(policy.admit({ accountId: ACCOUNT, agentId: AGENT, sessionId: SESSION })).resolves.toBeUndefined();
    expect(select).not.toHaveBeenCalled();
  });

  it("propagates an aborted signal before any candidate or overview lookup", async () => {
    const controller = new AbortController();
    controller.abort();
    const connection = connectionStatus({ bindings: [repositoryBinding([delegatedSenderScope])] });
    const { policy, getOverview, select } = buildPolicy({
      connection,
      delivery: [{ bindingId: IM_BINDING, senderId: IM_SENDER }],
    });
    await expect(policy.admit(admissionInput({ signal: controller.signal }))).rejects.toThrow();
    expect(getOverview).not.toHaveBeenCalled();
    expect(select).not.toHaveBeenCalled();
  });

  it("stops the repository loop when the signal aborts during live verification", async () => {
    const controller = new AbortController();
    const connection = connectionStatus({
      bindings: [
        repositoryBinding([delegatedSenderScope], { repositoryId: "1" }),
        repositoryBinding([delegatedSenderScope], { repositoryId: "2" }),
      ],
    });
    const { policy, verifyCurrentRepositoryAdmission } = buildPolicy({
      connection,
      delivery: [{ bindingId: IM_BINDING, senderId: IM_SENDER }],
      verifyDelay: () => controller.abort(),
    });
    await expect(policy.admit(admissionInput({ signal: controller.signal }))).rejects.toThrow();
    expect(verifyCurrentRepositoryAdmission).toHaveBeenCalledTimes(1);
  });

  it("resolves the source agent for an accepted session-message execution", async () => {
    const agentDelegation = delegation({ sessionAgents: [AGENT] });
    const connection = connectionStatus({ bindings: [repositoryBinding([readScope(AGENT, agentDelegation)])] });
    const { policy, select } = buildPolicy({
      connection,
      message: [{ sourceAgentId: AGENT.toUpperCase() }],
      execution: { source: { kind: "session-message", messageId: randomUUID() } },
    });
    await expect(
      policy.admit(admissionInput({ source: { kind: "session-message", messageId: randomUUID() } })),
    ).resolves.toMatchObject({ connectionId: BINDING_ID });
    expect(select).toHaveBeenCalledTimes(1);
  });

  it("denies when the session-message source row is missing", async () => {
    const connection = connectionStatus({
      bindings: [repositoryBinding([readScope(AGENT, delegation({ sessionAgents: [AGENT] }))])],
    });
    const { policy } = buildPolicy({ connection, message: [] });
    await expect(
      policy.admit(admissionInput({ source: { kind: "session-message", messageId: randomUUID() } })),
    ).resolves.toBeUndefined();
  });
});

describe("GitHubRuntimePolicy.resolve", () => {
  function resolveFixture(
    overrides: Partial<PolicyFixtureOptions> & {
      authorization?: Partial<RuntimeProxyAuthorization>;
      execution?: Partial<RuntimeExecutionRecord>;
      scopes?: GitHubAgentScope[];
    } = {},
  ) {
    const scopes = overrides.scopes ?? [
      readScope(AGENT, delegation({ imSenders: [{ bindingId: IM_BINDING, senderId: IM_SENDER }] })),
      treeWriteScope(
        TREE_BRANCH,
        "direct",
        delegation({ imSenders: [{ bindingId: IM_BINDING, senderId: IM_SENDER }] }),
      ),
    ];
    const connection = connectionStatus({ id: BINDING_ID, bindings: [repositoryBinding(scopes)] });
    const fixture = buildPolicy({
      connection,
      delivery: [{ bindingId: IM_BINDING, senderId: IM_SENDER }],
      execution: { source: deliverySource(), ...overrides.execution },
      ...overrides,
    });
    const authorization = proxyAuthorization(overrides.authorization);
    return { ...fixture, authorization };
  }

  it("returns repositories with delegated scopes and deduplicated protected Tree refs", async () => {
    const duplicatedBranch = "refs/heads/opentag/tree/other";
    const { policy, authorization, verifyCurrentRepositoryAdmission } = resolveFixture({
      scopes: [
        readScope(AGENT, delegation({ imSenders: [{ bindingId: IM_BINDING, senderId: IM_SENDER }] })),
        treeWriteScope(
          TREE_BRANCH,
          "direct",
          delegation({ imSenders: [{ bindingId: IM_BINDING, senderId: IM_SENDER }] }),
        ),
        treeWriteScope(
          TREE_BRANCH,
          "pull_request",
          delegation({ imSenders: [{ bindingId: IM_BINDING, senderId: IM_SENDER }] }),
        ),
        treeWriteScope(
          duplicatedBranch,
          "direct",
          delegation({ imSenders: [{ bindingId: IM_BINDING, senderId: IM_SENDER }] }),
        ),
      ],
    });
    const repositories = await policy.resolve(authorization, new AbortController().signal);
    expect(repositories).toHaveLength(1);
    expect(repositories[0]?.scopes).toHaveLength(4);
    expect(repositories[0]?.protectedTreeRefs).toEqual([TREE_BRANCH, duplicatedBranch]);
    expect(repositories[0]?.fullName).toBe("octocat/hello-world");
    expect(authorization.recheck).toHaveBeenCalledTimes(1);
    expect(verifyCurrentRepositoryAdmission).toHaveBeenCalledTimes(1);
  });

  it("denies when the execution record is missing or belongs to another owner scope", async () => {
    for (const execution of [
      null,
      { accountId: randomUUID() },
      { agentId: randomUUID() },
      { sessionId: randomUUID() },
    ]) {
      const fixture = resolveFixture();
      const recordGet = vi.mocked(fixture.executionGet);
      recordGet.mockReturnValueOnce(
        execution === null ? undefined : ({ ...executionRecord(), ...execution } as RuntimeExecutionRecord),
      );
      await expect(fixture.policy.resolve(fixture.authorization, new AbortController().signal)).rejects.toMatchObject({
        code: "scope_denied",
      });
    }
  });

  it("denies when the resolved connection is not the authorization binding", async () => {
    const fixture = resolveFixture({
      connection: connectionStatus({ id: randomUUID(), bindings: [repositoryBinding([delegatedSenderScope])] }),
    });
    await expect(fixture.policy.resolve(fixture.authorization, new AbortController().signal)).rejects.toMatchObject({
      code: "scope_denied",
    });
  });

  it("denies when the authorization revision is stale", async () => {
    const fixture = resolveFixture({ authorization: { authorizationRevision: "github:6" } });
    await expect(fixture.policy.resolve(fixture.authorization, new AbortController().signal)).rejects.toMatchObject({
      code: "scope_denied",
    });
  });

  it("denies when live admission reports a stale authorization version after resolution", async () => {
    const fixture = resolveFixture({ proofVersion: "8" });
    await expect(fixture.policy.resolve(fixture.authorization, new AbortController().signal)).rejects.toMatchObject({
      code: "scope_denied",
    });
    expect(fixture.authorization.recheck).not.toHaveBeenCalled();
  });

  it("denies when the source yields no candidate", async () => {
    const fixture = resolveFixture({ execution: { source: { kind: "validation", validationRunId: randomUUID() } } });
    await expect(fixture.policy.resolve(fixture.authorization, new AbortController().signal)).rejects.toMatchObject({
      code: "scope_denied",
    });
  });

  it("contributes no protected Tree ref for a branchless context_tree scope", async () => {
    // The shared schema requires a branch on context_tree scopes, so this is a defensive case for a
    // legacy/hand-crafted binding: the scope still delegates, but contributes no protected ref.
    const branchless = {
      ...treeWriteScope(
        TREE_BRANCH,
        "direct",
        delegation({ imSenders: [{ bindingId: IM_BINDING, senderId: IM_SENDER }] }),
      ),
      branch: undefined,
    } as unknown as GitHubAgentScope;
    const fixture = resolveFixture({ scopes: [branchless] });
    const repositories = await fixture.policy.resolve(fixture.authorization, new AbortController().signal);
    expect(repositories[0]?.protectedTreeRefs).toEqual([]);
    expect(repositories[0]?.scopes).toEqual([branchless]);
  });

  it("propagates a rejected final recheck", async () => {
    const fixture = resolveFixture();
    fixture.authorization.recheck = vi.fn(async () => {
      throw new GitPublicationError("scope_denied");
    });
    await expect(fixture.policy.resolve(fixture.authorization, new AbortController().signal)).rejects.toMatchObject({
      code: "scope_denied",
    });
  });
});
