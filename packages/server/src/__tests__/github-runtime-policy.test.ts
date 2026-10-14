import { randomUUID } from "node:crypto";
import type { GitHubConnectionStatus, RuntimeExecutionSource } from "@opentag/shared";
import { describe, expect, it, vi } from "vitest";
import type { DatabaseClient } from "../db/client.js";
import type { RuntimeProxyAuthorization } from "../runtime-credentials/credential-broker.js";
import type { RuntimeExecutionRecord } from "../runtime-credentials/types.js";
import type { GitHubManagementService } from "../services/github/github-management-service.js";
import { GitHubRuntimePolicy } from "../services/github-proxy/runtime-policy.js";

const ACCOUNT = randomUUID(),
  AGENT = randomUUID(),
  SESSION = randomUUID(),
  BINDING_ID = randomUUID();
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
    cli: { provider: "github", connectionId: BINDING_ID, authority: "user-task" },
    resolveMaterial: async () => {
      throw new Error("resolve() must not resolve credential material");
    },
    recheck: vi.fn(async () => undefined),
    ...overrides,
  };
}

function fixture() {
  const connection = connectionStatus();
  const source: RuntimeExecutionSource = { kind: "delivery", deliveryId: randomUUID(), turnId: randomUUID() };
  const execution = { accountId: ACCOUNT, agentId: AGENT, sessionId: SESSION, source } as RuntimeExecutionRecord;
  let delivery = true;
  let message:
    | {
        scheduledOrigin: unknown;
        sourceSessionId: string | null;
        userTaskSource: { sessionId: string; source: RuntimeExecutionSource } | null;
      }
    | undefined;
  let configs: { agentId: string; contextTrees: { repository: string }[] }[] = [];
  const database = {
    select: (projection: Record<string, unknown>) => {
      const chain = {
        from: () => chain,
        innerJoin: () => chain,
        where: () => ("contextTrees" in projection ? Promise.resolve(configs) : chain),
        limit: async () =>
          "scheduledOrigin" in projection ? (message ? [message] : []) : delivery ? [{ id: source.deliveryId }] : [],
      };
      return chain;
    },
  } as unknown as DatabaseClient;
  const getOverview = vi.fn(async () => ({ connection }));
  const resolveRepository = vi.fn(async () => ({
    installationId: "100",
    repositoryId: "200",
    fullName: "acme/explicit",
    defaultBranch: "main",
    authorizationVersion: 7n,
    credentialGeneration: 3n,
  }));
  const policy = new GitHubRuntimePolicy({
    database,
    management: { getOverview, resolveRepository } as unknown as GitHubManagementService,
    execution: { get: () => execution },
  });
  const input = () => ({ accountId: ACCOUNT, agentId: AGENT, sessionId: SESSION, source: execution.source });
  return {
    policy,
    input,
    connection,
    execution,
    resolveRepository,
    setDelivery: (value: boolean) => {
      delivery = value;
    },
    setMessage: (value: typeof message) => {
      message = value;
    },
    setConfigs: (value: typeof configs) => {
      configs = value;
    },
  };
}
const target = { fullName: "acme/explicit", access: "read" as const };
describe("GitHub user-task authority", () => {
  it("admits an accepted human task without discovering or recording any repositories", async () => {
    const f = fixture();
    expect(await f.policy.admit(f.input())).toEqual({
      connectionId: BINDING_ID,
      authorizationVersion: "7",
      credentialGeneration: "3",
    });
    expect(f.resolveRepository).not.toHaveBeenCalled();
  });
  it("denies absent sources, validation, unaccepted human ingress and expired connections", async () => {
    const f = fixture();
    expect(await f.policy.admit({ ...f.input(), source: undefined })).toBeUndefined();
    expect(
      await f.policy.admit({ ...f.input(), source: { kind: "validation", validationRunId: randomUUID() } }),
    ).toBeUndefined();
    f.setDelivery(false);
    expect(await f.policy.admit(f.input())).toBeUndefined();
    f.setDelivery(true);
    f.connection.accessExpiresAt = new Date(0).toISOString();
    expect(await f.policy.admit(f.input())).toBeUndefined();
  });
  it("requires user provenance for scheduled tasks and Agent messages", async () => {
    const f = fixture();
    const root = f.execution.source;
    f.execution.source = { kind: "session-message", messageId: randomUUID() };
    f.setMessage({ scheduledOrigin: { scheduleId: randomUUID() }, sourceSessionId: null, userTaskSource: null });
    expect(await f.policy.admit(f.input())).toBeUndefined();
    f.setMessage({
      scheduledOrigin: { scheduleId: randomUUID() },
      sourceSessionId: null,
      userTaskSource: { sessionId: SESSION, source: root },
    });
    expect(await f.policy.admit(f.input())).toBeDefined();
    f.setMessage({ scheduledOrigin: null, sourceSessionId: randomUUID(), userTaskSource: null });
    expect(await f.policy.admit(f.input())).toBeUndefined();
  });
  it("follows exact Server-recorded user provenance for collaboration and refuses cyclic provenance", async () => {
    const f = fixture();
    const root = f.execution.source;
    f.execution.source = { kind: "session-message", messageId: randomUUID() };
    f.setMessage({
      scheduledOrigin: null,
      sourceSessionId: SESSION,
      userTaskSource: { sessionId: SESSION, source: root },
    });
    expect(await f.policy.admit(f.input())).toBeDefined();
    f.setMessage({
      scheduledOrigin: null,
      sourceSessionId: SESSION,
      userTaskSource: { sessionId: SESSION, source: f.execution.source },
    });
    expect(await f.policy.admit(f.input())).toBeUndefined();
  });
  it("resolves only the requested target and rechecks its live permission before use", async () => {
    const f = fixture();
    const auth = proxyAuthorization();
    const [repository] = await f.policy.resolve(auth, new AbortController().signal, target);
    expect(f.resolveRepository).toHaveBeenCalledWith(expect.objectContaining({ ...target, connectionId: BINDING_ID }));
    expect(repository?.scopes).toEqual([{ role: "code", access: "read", publish: "pull_request" }]);
    f.resolveRepository.mockRejectedValue(new Error("permission removed"));
    await expect(repository?.recheck?.(new AbortController().signal)).rejects.toThrow("permission removed");
  });
  it("pins repository identity across requests and clears pins with execution lifetime", async () => {
    const f = fixture();
    const auth = proxyAuthorization();
    const signal = new AbortController().signal;
    await f.policy.resolve(auth, signal, target);
    f.resolveRepository.mockResolvedValue({
      installationId: "100",
      repositoryId: "different",
      fullName: target.fullName,
      defaultBranch: "main",
      authorizationVersion: 7n,
      credentialGeneration: 3n,
    });
    await expect(f.policy.resolve(auth, signal, target)).rejects.toMatchObject({ code: "scope_denied" });
    f.policy.forgetExecution(auth.executionId);
    expect(await f.policy.resolve(auth, signal, target)).toHaveLength(1);
  });

  it("uses configured Tree targets as purpose and protects their default branch", async () => {
    const f = fixture();
    f.setConfigs([{ agentId: AGENT, contextTrees: [{ repository: target.fullName }] }]);
    const [repository] = await f.policy.resolve(proxyAuthorization(), new AbortController().signal, {
      ...target,
      access: "write",
    });
    expect(repository?.scopes).toEqual([
      { role: "context_tree", access: "write", publish: "direct", branch: "refs/heads/main" },
    ]);
    expect(repository?.protectedTreeRefs).toEqual(["refs/heads/main"]);
  });
  it("fences account/connection/version changes and aborts", async () => {
    const f = fixture();
    await expect(
      f.policy.resolve(proxyAuthorization({ accountId: randomUUID() }), new AbortController().signal, target),
    ).rejects.toMatchObject({ code: "scope_denied" });
    f.connection.authorizationVersion = "8";
    await expect(f.policy.resolve(proxyAuthorization(), new AbortController().signal, target)).rejects.toMatchObject({
      code: "scope_denied",
    });
    const abort = new AbortController();
    abort.abort();
    await expect(f.policy.admit({ ...f.input(), signal: abort.signal })).rejects.toThrow();
  });
});
