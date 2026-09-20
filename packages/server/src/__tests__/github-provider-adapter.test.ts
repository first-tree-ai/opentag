import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GitHubAgentScope } from "@opentag/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeProxyAuthorization } from "../runtime-credentials/credential-broker.js";
import type { ProviderProxyRequest, ProviderProxyResponse } from "../runtime-credentials/provider-proxy-adapter.js";
import type { GitHubInstallationTokenClient } from "../services/github/installation-token-client.js";
import { planGitHubRest } from "../services/github-proxy/api-policy.js";
import { GitHubProxyApiTransport, jsonBody } from "../services/github-proxy/api-transport.js";
import {
  assertPullRequestRefs,
  type GitHubExecutionRepository,
  publicationScopes,
} from "../services/github-proxy/execution-policy.js";
import { GitPublicationGuard } from "../services/github-proxy/git-publication.js";
import { GitReadTransport } from "../services/github-proxy/git-read-transport.js";
import { GitWorkspace } from "../services/github-proxy/git-workspace.js";
import { GitHubProviderAdapter } from "../services/github-proxy/github-provider-adapter.js";
import { GitHubIatLeases } from "../services/github-proxy/iat-leases.js";
import type { VerifiedTreeHead } from "../services/github-proxy/verified-tree-head.js";

let root: string, sessionId: string, executionId: string, bindingId: string;
let workspace: GitWorkspace, adapter: GitHubProviderAdapter, repository: GitHubExecutionRepository;
let extra: GitHubProviderAdapter[];
let authorization: RuntimeProxyAuthorization;
let upstream: ReturnType<typeof vi.fn<typeof fetch>>;
let mint: ReturnType<typeof vi.fn<GitHubInstallationTokenClient["mint"]>>,
  revoke: ReturnType<typeof vi.fn<GitHubInstallationTokenClient["revoke"]>>;
const iat = "ghs_test-installation-token";
const metadata = { id: 123, node_id: "R_test", full_name: "owner/repository", default_branch: "main" };
let writeBehavior: "ok" | "lost" | "secret" | "empty" | "malformed" | "reject422" | "status503" | "status408";
let writeCount: number;
const requests: { method: string; path: string; url: string; headers: Headers; body: unknown }[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(await realpath(tmpdir()), "opentag-provider-adapter-"));
  sessionId = randomUUID();
  executionId = randomUUID();
  bindingId = randomUUID();
  workspace = new GitWorkspace();
  extra = [];
  repository = {
    installationId: "456",
    repositoryId: "123",
    fullName: "owner/repository",
    scopes: [{ agentId: randomUUID(), role: "code", access: "write", publish: "pull_request" }],
    protectedTreeRefs: ["refs/heads/master"],
  };
  writeBehavior = "ok";
  writeCount = 0;
  requests.length = 0;
  authorization = {
    executionId,
    sessionId,
    bindingId,
    provider: "github",
    purpose: "execution",
    scopeHash: "a".repeat(64),
    authorizationRevision: "github:1",
    credentialGeneration: "2",
    accountId: randomUUID(),
    agentId: repository.scopes[0]?.agentId ?? randomUUID(),
    cli: { provider: "github" as const, connectionId: bindingId, repositories: [] },
    resolveMaterial: async () => {
      throw new Error("No user material may reach execution");
    },
    recheck: vi.fn(async () => undefined),
  };
  mint = vi.fn(async () => ({ token: iat, expiresAt: new Date(Date.now() + 3_600_000) }));
  revoke = vi.fn(async () => undefined);
  upstream = vi.fn(async (url, init) => {
    const path = new URL(String(url)).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ body, headers: new Headers(init?.headers), method: init?.method ?? "GET", path, url: String(url) });
    if (path === "/repositories/123" || path === "/repos/owner/repository") return Response.json(metadata);
    if (path === "/repos/owner/repository/pulls/1")
      return Response.json({
        number: 1,
        node_id: "PR_one",
        head: { ref: `opentag/${sessionId}/code/topic`, repo: { id: 123 } },
        base: { ref: "main", repo: { id: 123 } },
      });
    if (init?.method !== "GET") return fixtureWrite(path, body);
    return Response.json([]);
  });
  adapter = new GitHubProviderAdapter({
    policy: { resolve: async () => [repository] },
    leases: new GitHubIatLeases({ mint, revoke }),
    reads: new GitReadTransport({ workspace }),
    publication: new GitPublicationGuard({ workspace }),
    api: new GitHubProxyApiTransport(upstream),
  });
});
afterEach(async () => {
  await Promise.all(extra.map((instance) => instance.close()));
  await adapter.close();
  await workspace?.close();
  await rm(root, { recursive: true, force: true });
});
function request(
  path: string,
  method = "GET",
  body?: unknown,
  origin: string | null = "api.github.com",
): ProviderProxyRequest {
  return {
    executionId,
    sessionId,
    bindingId,
    provider: "github",
    method,
    path,
    headers: origin === null ? {} : { "x-opentag-provider-origin": origin },
    body: jsonBody(body),
    capability: "trusted-runner-capability",
    capabilityTtlSeconds: 60,
    signal: new AbortController().signal,
  };
}
/** A second adapter over the same mint/revoke stubs, for scope, transport, and Tree-head variants. */
function adapterFor(
  input: {
    scopes?: GitHubAgentScope[];
    reads?: { handle: (request: unknown) => Promise<ProviderProxyResponse> };
    treeHeads?: Pick<VerifiedTreeHead, "verify">;
    withApi?: boolean;
  } = {},
) {
  const target: GitHubExecutionRepository = input.scopes ? { ...repository, scopes: input.scopes } : repository;
  const built = new GitHubProviderAdapter({
    policy: { resolve: async () => [target] },
    leases: new GitHubIatLeases({ mint, revoke }),
    reads: (input.reads ?? new GitReadTransport({ workspace })) as GitReadTransport,
    publication: new GitPublicationGuard({ workspace }),
    ...(input.withApi === false ? {} : { api: new GitHubProxyApiTransport(upstream) }),
    ...(input.treeHeads ? { treeHeads: input.treeHeads as VerifiedTreeHead } : {}),
  });
  extra.push(built);
  return built;
}
// `authorization` is only assigned in `beforeEach`, so these scope builders must read `agentId`
// lazily — the `it.each` argument tables are evaluated at registration time.
const agentId = () => authorization?.agentId ?? "agent";
const codeScope = (): GitHubAgentScope => ({
  agentId: agentId(),
  role: "code",
  access: "write",
  publish: "pull_request",
});
const treeScope = (overrides: Partial<GitHubAgentScope> = {}): GitHubAgentScope => ({
  agentId: agentId(),
  role: "context_tree",
  access: "write",
  publish: "pull_request",
  branch: "refs/heads/main",
  ...overrides,
});
async function responseJson(response: ProviderProxyResponse) {
  const parts: Uint8Array[] = [];
  for await (const part of response.body) parts.push(part);
  return JSON.parse(Buffer.concat(parts).toString());
}
function pullBody() {
  return { title: "Work", head: `opentag/${sessionId}/code/topic`, base: "main" };
}

describe("production GitHub provider adapter", () => {
  it("uses exactly one repository IAT before returning native REST output", async () => {
    expect(await responseJson(await adapter.handle(request("/repos/owner/repository"), authorization))).toEqual(
      metadata,
    );
    expect(mint).toHaveBeenCalledWith(
      expect.objectContaining({
        installationId: "456",
        repositoryId: "123",
        permissions: { contents: "read", pull_requests: "read" },
      }),
    );
    expect(requests.every((item) => item.headers.get("authorization") === `Bearer ${iat}`)).toBe(true);
    expect(requests.some((item) => item.headers.has("x-opentag-provider-origin"))).toBe(false);
    expect(revoke).toHaveBeenCalledWith(iat);
  });
  it("denies another repository, encoded bypasses, and Git object writes before minting", async () => {
    for (const path of [
      "/repos/else/repository",
      "/repos/owner/repository/%2e%2e/tokens",
      "/repos/owner/repository/git/refs",
    ]) {
      await expect(
        adapter.handle(request(path, path.endsWith("refs") ? "POST" : "GET", {}), authorization),
      ).rejects.toThrow();
    }
    expect(mint).not.toHaveBeenCalled();
  });
  it("denies a foreign Session branch and a knowledge branch PR base", async () => {
    for (const body of [
      { ...pullBody(), head: `opentag/${randomUUID()}/code/topic` },
      { ...pullBody(), base: "master" },
    ])
      await expect(
        adapter.handle(request("/repos/owner/repository/pulls", "POST", body), authorization),
      ).rejects.toThrow(/scope_denied/);
    expect(writeCount).toBe(0);
  });
  it("makes one upstream write attempt and completes a native PR response", async () => {
    const result = await adapter.handle(request("/repos/owner/repository/pulls", "POST", pullBody()), authorization);
    expect(await responseJson(result)).toMatchObject({ number: 1 });
    expect(writeCount).toBe(1);
  });
  it("never replays a lost write; a caller retry is a fresh single attempt", async () => {
    writeBehavior = "lost";
    await expect(
      adapter.handle(request("/repos/owner/repository/pulls", "POST", pullBody()), authorization),
    ).rejects.toMatchObject({ code: "write_outcome_unknown" });
    expect(writeCount).toBe(1);
    // The gateway itself does not retry or block: a new caller request goes upstream exactly once.
    writeBehavior = "ok";
    const result = await adapter.handle(request("/repos/owner/repository/pulls", "POST", pullBody()), authorization);
    expect(await responseJson(result)).toMatchObject({ number: 1 });
    expect(writeCount).toBe(2);
  });
  it.each([
    ["a 503", 503],
    ["a 408", 408],
  ])("surfaces %s write response as write_outcome_unknown after one attempt", async (_label, status) => {
    writeBehavior = status === 503 ? "status503" : "status408";
    await expect(
      adapter.handle(request("/repos/owner/repository/pulls", "POST", pullBody()), authorization),
    ).rejects.toMatchObject({ code: "write_outcome_unknown" });
    expect(writeCount).toBe(1);
  });
  it.each([
    ["an empty 2xx body without mutation evidence", "empty"],
    ["a malformed 2xx body", "malformed"],
  ] as const)("surfaces %s as write_outcome_unknown", async (_label, behavior) => {
    writeBehavior = behavior;
    await expect(
      adapter.handle(request("/repos/owner/repository/pulls", "POST", pullBody()), authorization),
    ).rejects.toMatchObject({ code: "write_outcome_unknown" });
    expect(writeCount).toBe(1);
  });
  it("keeps a definite provider rejection visible as its own response", async () => {
    writeBehavior = "reject422";
    const result = await adapter.handle(request("/repos/owner/repository/pulls", "POST", pullBody()), authorization);
    expect(result.status).toBe(422);
    expect(writeCount).toBe(1);
  });
  it.each(["ok", "reject422"] as const)(
    "rechecks the fence after a %s write response without replay",
    async (behavior) => {
      writeBehavior = behavior;
      authorization.recheck = async () => {
        if (writeCount > 0) throw new Error("authorization revoked after the upstream attempt");
      };
      await expect(
        adapter.handle(request("/repos/owner/repository/pulls", "POST", pullBody()), authorization),
      ).rejects.toMatchObject({ code: "write_outcome_unknown" });
      expect(writeCount).toBe(1);
    },
  );
  it("passes through ordinary response text that merely resembles an https URL", async () => {
    const original = upstream.getMockImplementation();
    upstream.mockImplementation(async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path === "/repositories/123") return (original as typeof fetch)(url, init);
      return Response.json({
        body: "https://",
        note: "https://exa mple.com/not-a-url",
        nested: [{ text: "https://" }],
      });
    });
    const response = await adapter.handle(request("/repos/owner/repository"), authorization);
    expect(await responseJson(response)).toMatchObject({ body: "https://", note: "https://exa mple.com/not-a-url" });
  });
  it("does not return a token-bearing URL from a provider response", async () => {
    writeBehavior = "secret";
    await expect(
      adapter.handle(request("/repos/owner/repository/pulls", "POST", pullBody()), authorization),
    ).rejects.toMatchObject({ code: "write_outcome_unknown" });
    expect(writeCount).toBe(1);
  });
  it("keeps the IAT alive through GraphQL mutation completion, with ID established by a scoped read", async () => {
    await adapter.handle(request("/repos/owner/repository"), authorization);
    revoke.mockClear();
    const original = upstream.getMockImplementation();
    upstream.mockImplementation(async (...args) => {
      if (String(args[0]).endsWith("/graphql")) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        expect(revoke).not.toHaveBeenCalled();
      }
      return (original as typeof fetch)(...args);
    });
    const body = {
      query:
        "mutation($input:CreatePullRequestInput!){createPullRequest(input:$input){pullRequest{id number headRefName baseRefName}}}",
      variables: {
        input: { repositoryId: "R_test", title: "Work", headRefName: pullBody().head, baseRefName: "main" },
      },
    };
    expect(await responseJson(await adapter.handle(request("/graphql", "POST", body), authorization))).toHaveProperty(
      "data.createPullRequest.pullRequest.number",
      1,
    );
    expect(revoke).toHaveBeenCalledTimes(1);
  });
  it("completes an aliased GraphQL mutation with one attempt", async () => {
    // A prior scoped read establishes the repository node identity the mutation policy requires.
    await adapter.handle(request("/repos/owner/repository"), authorization);
    const original = upstream.getMockImplementation();
    upstream.mockImplementation(async (...args) => {
      if (String(args[0]).endsWith("/graphql")) {
        writeCount++;
        return Response.json({
          data: {
            reviewAlias: {
              pullRequest: { id: "PR_one", number: 1, headRefName: pullBody().head, baseRefName: "main" },
            },
          },
        });
      }
      return (original as typeof fetch)(...args);
    });
    const body = {
      query:
        "mutation($input:CreatePullRequestInput!){reviewAlias:createPullRequest(input:$input){pullRequest{id number headRefName baseRefName}}}",
      variables: {
        input: { repositoryId: "R_test", title: "Work", headRefName: pullBody().head, baseRefName: "main" },
      },
    };
    expect(await responseJson(await adapter.handle(request("/graphql", "POST", body), authorization))).toHaveProperty(
      "data.reviewAlias.pullRequest.number",
      1,
    );
    expect(writeCount).toBe(1);
  });
  it.each([
    ["empty data", { data: {} }],
    ["null mutation data", { data: { createPullRequest: null } }],
    ["partial errors", { data: { createPullRequest: { pullRequest: null } }, errors: [{ message: "partial" }] }],
  ])("surfaces a GraphQL 2xx with %s as write_outcome_unknown, never success or rejection", async (_label, payload) => {
    // A prior scoped read establishes the repository node identity the mutation policy requires.
    await adapter.handle(request("/repos/owner/repository"), authorization);
    const original = upstream.getMockImplementation();
    upstream.mockImplementation(async (...args) => {
      if (String(args[0]).endsWith("/graphql")) {
        writeCount++;
        return Response.json(payload);
      }
      return (original as typeof fetch)(...args);
    });
    const body = {
      query:
        "mutation($input:CreatePullRequestInput!){createPullRequest(input:$input){pullRequest{id number headRefName baseRefName}}}",
      variables: {
        input: { repositoryId: "R_test", title: "Work", headRefName: pullBody().head, baseRefName: "main" },
      },
    };
    await expect(adapter.handle(request("/graphql", "POST", body), authorization)).rejects.toMatchObject({
      code: "write_outcome_unknown",
    });
    expect(writeCount).toBe(1);
  });
  it("rejects actor-scope GraphQL escapes before minting and cannot establish foreign PR nodes", async () => {
    const hostile = {
      query:
        'query { repository(owner:"owner",name:"repository") { owner { ... on User { pullRequests(first:1){nodes{id number title}} } } } }',
    };
    mint.mockClear();
    upstream.mockClear();
    await expect(adapter.handle(request("/graphql", "POST", hostile), authorization)).rejects.toThrow(/policy/);
    expect(mint).not.toHaveBeenCalled();
    expect(upstream).not.toHaveBeenCalled();
    // The rejected read cannot authorize a later mutation against a node it would have discovered.
    const mutation = {
      query: 'mutation($id:ID!){updatePullRequest(input:{pullRequestId:$id,title:"x"}){pullRequest{id}}}',
      variables: { id: "PR_foreign" },
    };
    await expect(adapter.handle(request("/graphql", "POST", mutation), authorization)).rejects.toThrow(/policy/);
    expect(mint).not.toHaveBeenCalled();
    expect(writeCount).toBe(0);
  });

  it("rejects stale authorization after asynchronous IAT mint before sending anything upstream", async () => {
    authorization.recheck = async () => {
      throw new Error("revoked");
    };
    await expect(adapter.handle(request("/repos/owner/repository"), authorization)).rejects.toThrow("revoked");
    expect(upstream).not.toHaveBeenCalled();
    expect(revoke).toHaveBeenCalledWith(iat);
  });
  it("pins Tree PR head and base while excluding the Tree from a code write grant", () => {
    repository.scopes.push({
      agentId: authorization.agentId,
      role: "context_tree",
      access: "write",
      publish: "pull_request",
      branch: "refs/heads/master",
    });
    expect(publicationScopes(repository, sessionId)).toEqual([
      { role: "code", refPrefix: `refs/heads/opentag/${sessionId}/code/` },
      { role: "context_tree", refPrefix: `refs/heads/opentag/${sessionId}/context_tree/` },
    ]);
    expect(() =>
      assertPullRequestRefs({
        repository,
        sessionId,
        head: `opentag/${sessionId}/context_tree/topic`,
        base: "master",
        defaultBranch: "main",
      }),
    ).not.toThrow();
    expect(() =>
      assertPullRequestRefs({
        repository,
        sessionId,
        head: `opentag/${sessionId}/code/topic`,
        base: "master",
        defaultBranch: "main",
      }),
    ).toThrow();
  });
  it("plans raw multi-segment branch and commit refs while encoded separators stay denied", async () => {
    for (const path of [
      "/repos/owner/repository/branches/feature/topic",
      "/repos/owner/repository/commits/feature/topic",
      "/repos/owner/repository/commits/feature/topic/status",
      "/repos/owner/repository/commits/feature/topic/statuses",
    ])
      expect(planGitHubRest("GET", new URL(`https://api.github.com${path}`))).toMatchObject({
        operation: "read",
        codeOnly: true,
      });
    expect(
      planGitHubRest("GET", new URL("https://api.github.com/repos/owner/repository/commits/feature/topic/check-runs")),
    ).toMatchObject({ operation: "read", extraPermission: "checks" });
    // Empty ref segments and encoded or dot-segment escapes never reach the planner.
    expect(() => planGitHubRest("GET", new URL("https://api.github.com/repos/owner/repository/branches/"))).toThrow();
    mint.mockClear();
    for (const path of [
      "/repos/owner/repository/branches/feature%2Ftopic",
      "/repos/owner/repository/branches/..%2f..",
      "/repos/owner/repository/commits/../main",
    ])
      await expect(adapter.handle(request(path), authorization)).rejects.toThrow();
    expect(mint).not.toHaveBeenCalled();
  });

  it("registers bounded CI reads and rejects authentication or administrative operations", () => {
    expect(
      planGitHubRest("GET", new URL("https://api.github.com/repos/owner/repository/actions/runs?per_page=100")),
    ).toMatchObject({ extraPermission: "actions" });
    for (const path of [
      "/user",
      "/installation/token",
      "/repos/owner/repository/actions/secrets",
      "/repos/owner/repository/pulls?per_page=101",
    ])
      expect(() => planGitHubRest("GET", new URL(`https://api.github.com${path}`))).toThrow();
  });
});

it("revokes an IAT that finishes minting after its execution was closed", async () => {
  let resolveMint: ((value: { token: string; expiresAt: Date }) => void) | undefined;
  const pending = new Promise<{ token: string; expiresAt: Date }>((resolve) => {
    resolveMint = resolve;
  });
  const leases = new GitHubIatLeases({ mint: async () => pending, revoke });
  const result = leases.acquire(executionId, {
    installationId: "456",
    repositoryId: "123",
    permissions: { contents: "read" },
  });
  await leases.revokeExecution(executionId);
  resolveMint?.({ token: iat, expiresAt: new Date(Date.now() + 3600000) });
  await expect(result).rejects.toThrow(/scope_denied/);
  expect(revoke).toHaveBeenCalledWith(iat);
});

describe("production GitHub provider adapter execution lifecycle", () => {
  it("forgets the node index and revokes the execution's leases on closeExecution", async () => {
    // A scoped read establishes the repository node so the index is non-empty when it is forgotten.
    await adapter.handle(request("/repos/owner/repository"), authorization);
    await adapter.closeExecution(executionId);
    expect(revoke).toHaveBeenCalledWith(iat);
    // The forgotten node can no longer authorize a mutation against it.
    const mutation = {
      query: 'mutation($id:ID!){updatePullRequest(input:{pullRequestId:$id,title:"x"}){pullRequest{id}}}',
      variables: { id: "R_test" },
    };
    await expect(adapter.handle(request("/graphql", "POST", mutation), authorization)).rejects.toThrow(/policy/);
  });

  it("falls back to the real HTTP transport when no api transport is injected", async () => {
    // The default path constructs a GitHubProxyApiTransport over global fetch. A denylisted path is
    // rejected before any request is attempted, so this asserts the construction path safely.
    const real = adapterFor({ withApi: false });
    await expect(real.handle(request("/repos/owner/repository/%2e%2e/tokens"), authorization)).rejects.toThrow();
  });
});

describe("production GitHub provider adapter request admission", () => {
  it.each([
    ["a foreign provider", { provider: "slack" }, {}],
    ["a foreign authorization provider", {}, { provider: "slack" }],
    ["a mismatched execution id", {}, { executionId: "another-execution" }],
    ["a mismatched binding id", {}, { bindingId: "another-binding" }],
  ] as const)("denies %s before resolving the policy", async (_label, requestPatch, authPatch) => {
    const policy = vi.fn(async (_authorization: RuntimeProxyAuthorization, _signal: AbortSignal) => [repository]);
    const guarded = new GitHubProviderAdapter({
      policy: { resolve: policy },
      leases: new GitHubIatLeases({ mint, revoke }),
      reads: new GitReadTransport({ workspace }),
      publication: new GitPublicationGuard({ workspace }),
      api: new GitHubProxyApiTransport(upstream),
    });
    extra.push(guarded);
    await expect(
      guarded.handle({ ...request("/repos/owner/repository"), ...requestPatch }, { ...authorization, ...authPatch }),
    ).rejects.toMatchObject({ code: "scope_denied" });
    expect(policy).not.toHaveBeenCalled();
    expect(mint).not.toHaveBeenCalled();
  });

  it.each(["validation", "unknown"] as const)("denies a %s purpose", async (purpose) => {
    await expect(
      adapter.handle(request("/repos/owner/repository"), {
        ...authorization,
        purpose: purpose as RuntimeProxyAuthorization["purpose"],
      }),
    ).rejects.toMatchObject({ code: "scope_denied" });
    expect(mint).not.toHaveBeenCalled();
  });

  it.each([
    ["the git origin with a non-git path", "github.com", "/repos/owner/repository", "GET"],
    ["a GitHub origin the policy does not know", "api.github.com.evil.test", "/repos/owner/repository", "GET"],
    ["no provider origin at all", null, "/repos/owner/repository", "GET"],
  ] as const)("denies %s", async (_label, origin, path, method) => {
    const built = request(path, method, undefined, origin);
    await expect(adapter.handle(built, authorization)).rejects.toMatchObject({ code: "invalid_request" });
    expect(mint).not.toHaveBeenCalled();
  });

  it("routes the github.com origin into the native Git smart HTTP handler", async () => {
    const reads = { handle: vi.fn(async () => ({ status: 200, headers: {}, body: jsonBody(null) })) };
    const built = adapterFor({ reads, scopes: [codeScope()] });
    const path = "/owner/repository.git/info/refs?service=git-upload-pack";
    const response = await built.handle(request(path, "GET", undefined, "github.com"), authorization);
    expect(response.status).toBe(200);
    expect(reads.handle).toHaveBeenCalledWith(expect.objectContaining({ service: "git-upload-pack", advertise: true }));
  });

  it("rejects a path the request URL guard refuses before resolving the policy", async () => {
    const policy = vi.fn(async (_authorization: RuntimeProxyAuthorization, _signal: AbortSignal) => [repository]);
    const guarded = new GitHubProviderAdapter({
      policy: { resolve: policy },
      leases: new GitHubIatLeases({ mint, revoke }),
      reads: new GitReadTransport({ workspace }),
      publication: new GitPublicationGuard({ workspace }),
      api: new GitHubProxyApiTransport(upstream),
    });
    extra.push(guarded);
    for (const path of ["repos/owner/repository", "//api.github.com/x", "/repos/owner/repository#fragment"])
      await expect(guarded.handle(request(path), authorization)).rejects.toMatchObject({ code: "invalid_request" });
    expect(policy).not.toHaveBeenCalled();
  });
});

describe("production GitHub provider adapter REST scope gates", () => {
  it("denies a code-only read to a Tree-only grant without minting", async () => {
    const built = adapterFor({ scopes: [treeScope({ access: "read" })] });
    mint.mockClear();
    await expect(built.handle(request("/repos/owner/repository/branches/main"), authorization)).rejects.toMatchObject({
      code: "scope_denied",
    });
    expect(mint).not.toHaveBeenCalled();
  });

  it.each([
    ["a read-only Tree scope", [treeScope({ access: "read" })]],
    ["a direct-publish Tree scope", [treeScope({ access: "write", publish: "direct" })]],
    ["a code scope with no write", [{ agentId: "agent", role: "code", access: "read" }]],
  ] as const)("denies a write on %s without minting", async (_label, scopes) => {
    const built = adapterFor({ scopes: [...scopes] as GitHubAgentScope[] });
    mint.mockClear();
    await expect(
      built.handle(request("/repos/owner/repository/pulls", "POST", pullBody()), authorization),
    ).rejects.toMatchObject({ code: "scope_denied" });
    expect(mint).not.toHaveBeenCalled();
  });

  it("requests the extra checks permission for a check-runs read", async () => {
    await adapter.handle(request("/repos/owner/repository/commits/main/check-runs"), authorization);
    expect(mint).toHaveBeenCalledWith(
      expect.objectContaining({ permissions: { contents: "read", pull_requests: "read", checks: "read" } }),
    );
  });

  it("requests the extra actions permission for a workflow-runs read", async () => {
    await adapter.handle(request("/repos/owner/repository/actions/runs"), authorization);
    expect(mint).toHaveBeenCalledWith(
      expect.objectContaining({ permissions: { contents: "read", pull_requests: "read", actions: "read" } }),
    );
  });
});

describe("production GitHub provider adapter Tree-only REST reads", () => {
  it("pins the pulls list to the configured knowledge branch", async () => {
    const built = adapterFor({ scopes: [treeScope({ access: "read" })] });
    const response = await built.handle(request("/repos/owner/repository/pulls"), authorization);
    expect(response.status).toBe(200);
    // `url.pathname + url.search` is what actually reaches the fixed API origin.
    expect(requests.at(-1)?.url).toBe("https://api.github.com/repos/owner/repository/pulls?base=main");
  });

  it("confirms a single pull request belongs to the knowledge branch", async () => {
    const built = adapterFor({ scopes: [treeScope({ access: "read" })] });
    const original = upstream.getMockImplementation();
    upstream.mockImplementation(async (url, init) => {
      if (new URL(String(url)).pathname === "/repos/owner/repository/pulls/1")
        return Response.json({ number: 1, base: { ref: "main", repo: { id: 123 } } });
      return (original as typeof fetch)(url, init);
    });
    expect(await responseJson(await built.handle(request("/repos/owner/repository/pulls/1"), authorization))).toEqual({
      number: 1,
      base: { ref: "main", repo: { id: 123 } },
    });
  });

  it.each([
    ["a pull request on another base", { number: 1, base: { ref: "topic", repo: { id: 123 } } }],
    ["an unavailable pull request", undefined],
  ])("denies %s", async (_label, pull) => {
    const built = adapterFor({ scopes: [treeScope({ access: "read" })] });
    const original = upstream.getMockImplementation();
    upstream.mockImplementation(async (url, init) => {
      if (new URL(String(url)).pathname === "/repos/owner/repository/pulls/1")
        return pull === undefined ? Response.json({ message: "Not Found" }, { status: 404 }) : Response.json(pull);
      return (original as typeof fetch)(url, init);
    });
    await expect(built.handle(request("/repos/owner/repository/pulls/1"), authorization)).rejects.toMatchObject({
      code: "scope_denied",
    });
  });

  it("leaves a read outside the pull/issue families untouched by the Tree constraint", async () => {
    const built = adapterFor({ scopes: [treeScope({ access: "read" })] });
    const original = upstream.getMockImplementation();
    upstream.mockImplementation(async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path === "/repos/owner/repository") return Response.json({ ...metadata, private: true });
      return (original as typeof fetch)(url, init);
    });
    expect(await responseJson(await built.handle(request("/repos/owner/repository"), authorization))).toMatchObject({
      node_id: "R_test",
    });
  });

  it("denies a Tree-only grant whose scope carries no branch", async () => {
    const built = adapterFor({ scopes: [{ agentId: authorization.agentId, role: "context_tree", access: "read" }] });
    await expect(built.handle(request("/repos/owner/repository/pulls"), authorization)).rejects.toMatchObject({
      code: "scope_denied",
    });
  });

  it("leaves an issue read outside the pull-request family alone for a Tree grant", async () => {
    const built = adapterFor({ scopes: [treeScope({ access: "read" })] });
    const response = await built.handle(request("/repos/owner/repository/issues/1/comments"), authorization);
    expect(response.status).toBe(200);
    expect(requests.at(-1)?.url).toBe("https://api.github.com/repos/owner/repository/issues/1/comments");
  });
});

describe("production GitHub provider adapter REST writes", () => {
  it("updates a pull request through its checked identity in one attempt", async () => {
    // The scoped read records PR 1's identity so the later PATCH is admissible.
    await adapter.handle(request("/repos/owner/repository/pulls/1"), authorization);
    const original = upstream.getMockImplementation();
    upstream.mockImplementation(async (url, init) => {
      if (new URL(String(url)).pathname === "/repos/owner/repository/pulls/1" && init?.method === "PATCH") {
        writeCount++;
        return Response.json({ number: 1, node_id: "PR_one", title: "Renamed" });
      }
      return (original as typeof fetch)(url, init);
    });
    const response = await adapter.handle(
      request("/repos/owner/repository/pulls/1", "PATCH", { title: "Renamed" }),
      authorization,
    );
    expect(response.status).toBe(200);
    expect(await responseJson(response)).toMatchObject({ title: "Renamed" });
    expect(writeCount).toBe(1);
  });

  it("validates the new base of an update against the same ref policy as the head", async () => {
    await adapter.handle(request("/repos/owner/repository/pulls/1"), authorization);
    await expect(
      adapter.handle(request("/repos/owner/repository/pulls/1", "PATCH", { base: "master" }), authorization),
    ).rejects.toMatchObject({ code: "scope_denied" });
    expect(writeCount).toBe(0);
  });

  it("refuses an update whose repository check answer carries no pull request body", async () => {
    // The provider check response is parsed before its status is judged, so a 404 body without the
    // head/base pair is refused as an unreadable answer rather than read as a policy denial.
    const original = upstream.getMockImplementation();
    upstream.mockImplementation(async (url, init) => {
      if (new URL(String(url)).pathname === "/repos/owner/repository/pulls/1")
        return Response.json({ message: "Not Found" }, { status: 404 });
      return (original as typeof fetch)(url, init);
    });
    await expect(
      adapter.handle(request("/repos/owner/repository/pulls/1", "PATCH", { title: "Renamed" }), authorization),
    ).rejects.toMatchObject({ code: "unavailable" });
    expect(writeCount).toBe(0);
  });

  it("adds a comment only after confirming the issue belongs to the repository", async () => {
    const response = await adapter.handle(
      request("/repos/owner/repository/issues/1/comments", "POST", { body: "Looks good" }),
      authorization,
    );
    expect(response.status).toBe(201);
    expect(writeCount).toBe(1);
  });

  it.each([
    [
      "an issue in another repository",
      { head: { ref: "topic", repo: { id: 999 } }, base: { ref: "main", repo: { id: 123 } } },
      "scope_denied",
    ],
    ["an issue GitHub does not answer", undefined, "unavailable"],
  ] as const)("denies a comment on %s", async (_label, pull, code) => {
    const original = upstream.getMockImplementation();
    upstream.mockImplementation(async (url, init) => {
      if (new URL(String(url)).pathname === "/repos/owner/repository/pulls/1")
        return pull === undefined ? Response.json({ message: "Not Found" }, { status: 404 }) : Response.json(pull);
      return (original as typeof fetch)(url, init);
    });
    await expect(
      adapter.handle(request("/repos/owner/repository/issues/1/comments", "POST", { body: "x" }), authorization),
    ).rejects.toMatchObject({ code });
    expect(writeCount).toBe(0);
  });

  it.each([
    ["a create body missing the head ref", "POST", "/repos/owner/repository/pulls", { title: "Work" }],
    ["a create body with an unknown key", "POST", "/repos/owner/repository/pulls", { ...pullBody(), extra: 1 }],
    ["a comment body that is not an object", "POST", "/repos/owner/repository/issues/1/comments", "text"],
  ] as const)("rejects %s with a schema failure before any upstream write", async (_label, method, path, body) => {
    const error = await adapter.handle(request(path, method, body), authorization).catch((cause: unknown) => cause);
    // A zod schema failure, not a policy error: the body never reached a route handler.
    expect((error as Error).name).toBe("ZodError");
    expect(writeCount).toBe(0);
  });

  it.each([
    ["a non-JSON create body", "/repos/owner/repository/pulls"],
    ["a non-JSON comment body", "/repos/owner/repository/issues/1/comments"],
  ])("rejects %s as an invalid request before any upstream write", async (_label, path) => {
    await expect(
      adapter.handle({ ...request(path, "POST"), body: jsonBody(undefined) }, authorization),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(writeCount).toBe(0);
  });

  it("rejects a body that is not a bounded object", async () => {
    const built = adapterFor();
    const unbounded = { ...request("/repos/owner/repository/pulls", "POST", {}), body: jsonBody("x".repeat(300_000)) };
    await expect(built.handle(unbounded, authorization)).rejects.toMatchObject({ code: "invalid_request" });
    expect(writeCount).toBe(0);
  });
});

describe("production GitHub provider adapter Tree head verification", () => {
  const treeHeadBody = () => ({
    title: "Work",
    head: `opentag/${sessionId}/context_tree/topic`,
    base: "main",
  });

  it("verifies the published Tree head before a Tree-head pull request is created", async () => {
    const verify = vi.fn(async () => "c".repeat(40));
    const built = adapterFor({ scopes: [codeScope(), treeScope()], treeHeads: { verify } });
    const response = await built.handle(
      request("/repos/owner/repository/pulls", "POST", treeHeadBody()),
      authorization,
    );
    expect(response.status).toBe(201);
    expect(verify).toHaveBeenCalledWith(
      expect.objectContaining({ repositoryId: "123", ref: `refs/heads/opentag/${sessionId}/context_tree/topic` }),
    );
    expect(writeCount).toBe(1);
  });

  it("denies a Tree-head write when no verifier is configured", async () => {
    const built = adapterFor({ scopes: [codeScope(), treeScope()] });
    await expect(
      built.handle(request("/repos/owner/repository/pulls", "POST", treeHeadBody()), authorization),
    ).rejects.toMatchObject({ code: "tree_invalid" });
    expect(writeCount).toBe(0);
  });

  it("surfaces a verifier failure as the verifier's own error", async () => {
    const verify = vi.fn(async () => {
      throw new Error("tree verification failed");
    });
    const built = adapterFor({ scopes: [codeScope(), treeScope()], treeHeads: { verify } });
    await expect(
      built.handle(request("/repos/owner/repository/pulls", "POST", treeHeadBody()), authorization),
    ).rejects.toThrow("tree verification failed");
    expect(writeCount).toBe(0);
  });

  it("re-verifies the recorded Tree head after a successful write", async () => {
    const verify = vi.fn(async () => "c".repeat(40));
    const built = adapterFor({ scopes: [codeScope(), treeScope()], treeHeads: { verify } });
    await built.handle(request("/repos/owner/repository/pulls", "POST", treeHeadBody()), authorization);
    // Once before the attempt and once after the mutation landed.
    expect(verify).toHaveBeenCalledTimes(2);
    expect(writeCount).toBe(1);
  });

  it("fails closed with write_outcome_unknown when the post-write Tree head moved", async () => {
    const verify = vi
      .fn<VerifiedTreeHead["verify"]>()
      .mockResolvedValueOnce("c".repeat(40))
      .mockResolvedValueOnce("d".repeat(40));
    const built = adapterFor({ scopes: [codeScope(), treeScope()], treeHeads: { verify } });
    await expect(
      built.handle(request("/repos/owner/repository/pulls", "POST", treeHeadBody()), authorization),
    ).rejects.toMatchObject({ code: "write_outcome_unknown" });
    expect(writeCount).toBe(1);
  });

  it("leaves a code-branch pull request untouched by Tree head verification", async () => {
    const verify = vi.fn(async () => "c".repeat(40));
    const built = adapterFor({ scopes: [codeScope(), treeScope()], treeHeads: { verify } });
    expect(
      (await built.handle(request("/repos/owner/repository/pulls", "POST", pullBody()), authorization)).status,
    ).toBe(201);
    expect(verify).not.toHaveBeenCalled();
    expect(writeCount).toBe(1);
  });
});

describe("production GitHub provider adapter GraphQL reads", () => {
  it("answers a repository read and records the repository node identity", async () => {
    const original = upstream.getMockImplementation();
    upstream.mockImplementation(async (...args) => {
      if (String(args[0]).endsWith("/graphql"))
        return Response.json({ data: { repository: { id: "R_test", nameWithOwner: "owner/repository" } } });
      return (original as typeof fetch)(...args);
    });
    const body = { query: 'query { repository(owner:"owner",name:"repository") { id nameWithOwner } }' };
    expect(await responseJson(await adapter.handle(request("/graphql", "POST", body), authorization))).toEqual({
      data: { repository: { id: "R_test", nameWithOwner: "owner/repository" } },
    });
  });

  it("records nested pull request identities discovered by a scoped GraphQL read", async () => {
    const original = upstream.getMockImplementation();
    upstream.mockImplementation(async (...args) => {
      if (String(args[0]).endsWith("/graphql")) {
        if (String((args[1] as RequestInit).body).includes("mutation")) writeCount++;
        return Response.json({
          data: {
            repository: {
              id: "R_test",
              pullRequests: {
                nodes: [{ id: "PR_one", number: 1, headRefName: "topic", baseRefName: "main" }],
              },
            },
          },
        });
      }
      return (original as typeof fetch)(...args);
    });
    // The read must be scoped to a repository node the adapter already knows, so prime it first.
    await adapter.handle(request("/repos/owner/repository"), authorization);
    const body = {
      query:
        'query { node(id:"R_test") { ... on Repository { id pullRequests(first:1) { nodes { id number headRefName baseRefName } } } } }',
    };
    expect((await adapter.handle(request("/graphql", "POST", body), authorization)).status).toBe(200);
    // The nested identity authorizes a GraphQL updatePullRequest mutation for that same node.
    const mutation = {
      query:
        'mutation($id:ID!){updatePullRequest(input:{pullRequestId:$id,title:"x"}){pullRequest{id number headRefName baseRefName}}}',
      variables: { id: "PR_one" },
    };
    expect((await adapter.handle(request("/graphql", "POST", mutation), authorization)).status).toBe(200);
    expect(writeCount).toBe(1);
  });

  it("validates the GraphQL body schema before resolving any node", async () => {
    for (const body of [{}, { query: "" }, { query: "x", extra: 1 }])
      await expect(adapter.handle(request("/graphql", "POST", body), authorization)).rejects.toBeInstanceOf(Error);
    expect(writeCount).toBe(0);
  });
});

describe("production GitHub provider adapter GraphQL reads on a Tree grant", () => {
  const treeReadBody = {
    query: 'query { repository(owner:"owner",name:"repository") { id defaultBranchRef { name } } }',
  };

  it("constrains a Tree-scoped GraphQL read to the knowledge branch", async () => {
    const built = adapterFor({ scopes: [treeScope({ access: "read" })] });
    await built.handle(request("/repos/owner/repository"), authorization);
    const original = upstream.getMockImplementation();
    const seen: unknown[] = [];
    upstream.mockImplementation(async (...args) => {
      if (String(args[0]).endsWith("/graphql")) {
        seen.push(JSON.parse(String((args[1] as RequestInit).body)));
        return Response.json({ data: { repository: { id: "R_test", ref: { name: "main" } } } });
      }
      return (original as typeof fetch)(...args);
    });
    expect((await built.handle(request("/graphql", "POST", treeReadBody), authorization)).status).toBe(200);
    // `defaultBranchRef` is rewritten to an explicit `ref(qualifiedName: "refs/heads/main")`.
    expect(JSON.stringify(seen[0])).toContain("refs/heads/main");
  });

  it("denies a Tree-scoped GraphQL read when the grant carries no knowledge branch", async () => {
    const built = adapterFor({ scopes: [treeScope({ access: "read", branch: undefined })] });
    await expect(built.handle(request("/graphql", "POST", treeReadBody), authorization)).rejects.toMatchObject({
      code: "scope_denied",
    });
  });

  it("denies a Tree-scoped GraphQL read that names an unknown node id", async () => {
    const built = adapterFor({ scopes: [treeScope({ access: "read" })] });
    await built.handle(request("/repos/owner/repository"), authorization);
    const body = { query: 'query { node(id:"PR_foreign") { ... on PullRequest { id number } } }' };
    await expect(built.handle(request("/graphql", "POST", body), authorization)).rejects.toBeInstanceOf(Error);
  });

  it("denies a Tree-scoped GraphQL read that reaches a ref outside the knowledge branch", async () => {
    const built = adapterFor({ scopes: [treeScope({ access: "read" })] });
    await built.handle(request("/repos/owner/repository"), authorization);
    const body = {
      query:
        'query { repository(owner:"owner",name:"repository") { id ref(qualifiedName:"refs/heads/other") { name } } }',
    };
    await expect(built.handle(request("/graphql", "POST", body), authorization)).rejects.toMatchObject({
      code: "scope_denied",
    });
  });

  it("re-checks every node identity a Tree-scoped GraphQL read names", async () => {
    const built = adapterFor({ scopes: [treeScope({ access: "read" })] });
    // A scoped REST read of PR 1 records both its node identity and its number.
    await built.handle(request("/repos/owner/repository/pulls/1"), authorization);
    const original = upstream.getMockImplementation();
    upstream.mockImplementation(async (...args) => {
      const path = new URL(String(args[0])).pathname;
      if (path === "/graphql") return Response.json({ data: { node: { id: "PR_one", number: 1 } } });
      if (path === "/repos/owner/repository/pulls/1")
        return Response.json({
          number: 1,
          node_id: "PR_one",
          head: { ref: "topic", repo: { id: 123 } },
          base: { ref: "main", repo: { id: 123 } },
        });
      return (original as typeof fetch)(...args);
    });
    const body = { query: 'query { node(id:"PR_one") { ... on PullRequest { id number } } }' };
    expect((await built.handle(request("/graphql", "POST", body), authorization)).status).toBe(200);
    // The recorded number is re-checked against the knowledge branch before the read is answered.
    expect(
      requests.filter((item) => item.url === "https://api.github.com/repos/owner/repository/pulls/1"),
    ).toHaveLength(2);
  });

  it("denies a nested node identity the adapter never established", async () => {
    // The target field is a repository the adapter already knows, so the GraphQL policy resolves;
    // the nested `node` selection names an identity no scoped read ever recorded.
    const built = adapterFor({ scopes: [treeScope({ access: "read" })] });
    await built.handle(request("/repos/owner/repository"), authorization);
    const body = {
      query:
        'query { repository(owner:"owner",name:"repository") { id node(id:"PR_foreign") { ... on PullRequest { id number } } } }',
    };
    await expect(built.handle(request("/graphql", "POST", body), authorization)).rejects.toMatchObject({
      code: "scope_denied",
    });
  });

  it("constrains a Tree read of the repository node, which carries no pull request number", async () => {
    const built = adapterFor({ scopes: [treeScope({ access: "read" })] });
    // The scoped REST read records the repository node identity, and that identity has no number.
    await built.handle(request("/repos/owner/repository"), authorization);
    const original = upstream.getMockImplementation();
    upstream.mockImplementation(async (...args) => {
      if (new URL(String(args[0])).pathname === "/graphql")
        return Response.json({ data: { node: { id: "R_test", nameWithOwner: "owner/repository" } } });
      return (original as typeof fetch)(...args);
    });
    const body = {
      query: 'query { node(id:"R_test") { ... on Repository { id nameWithOwner } } }',
    };
    expect((await built.handle(request("/graphql", "POST", body), authorization)).status).toBe(200);
  });

  it("denies a Tree-scoped GraphQL read whose recorded pull request left the knowledge branch", async () => {
    const built = adapterFor({ scopes: [treeScope({ access: "read" })] });
    await built.handle(request("/repos/owner/repository/pulls/1"), authorization);
    const original = upstream.getMockImplementation();
    upstream.mockImplementation(async (...args) => {
      const path = new URL(String(args[0])).pathname;
      if (path === "/graphql") return Response.json({ data: { node: { id: "PR_one", number: 1 } } });
      if (path === "/repos/owner/repository/pulls/1")
        return Response.json({
          number: 1,
          node_id: "PR_one",
          head: { ref: "topic", repo: { id: 123 } },
          base: { ref: "other", repo: { id: 123 } },
        });
      return (original as typeof fetch)(...args);
    });
    const body = { query: 'query { node(id:"PR_one") { ... on PullRequest { id number } } }' };
    await expect(built.handle(request("/graphql", "POST", body), authorization)).rejects.toMatchObject({
      code: "scope_denied",
    });
  });
});

describe("production GitHub provider adapter metadata binding", () => {
  it.each([
    ["a mismatched repository id", { ...metadata, id: 999 }, "scope_denied"],
    ["a mismatched full name", { ...metadata, full_name: "other/repository" }, "scope_denied"],
    ["a missing full name", { ...metadata, full_name: undefined }, "scope_denied"],
    ["a missing default branch", { ...metadata, default_branch: undefined }, "scope_denied"],
    ["a non-object payload", [metadata], "unavailable"],
  ] as const)("denies %s", async (_label, payload, code) => {
    const built = adapterFor();
    const original = upstream.getMockImplementation();
    upstream.mockImplementation(async (url, init) => {
      if (new URL(String(url)).pathname === "/repositories/123") return Response.json(payload);
      return (original as typeof fetch)(url, init);
    });
    await expect(built.handle(request("/repos/owner/repository"), authorization)).rejects.toMatchObject({ code });
  });
  it("compares the provider full name against the grant case-insensitively", async () => {
    // The provider answers with a different casing than the grant; the binding still holds.
    const built = adapterFor();
    const original = upstream.getMockImplementation();
    upstream.mockImplementation(async (url, init) => {
      if (new URL(String(url)).pathname === "/repositories/123")
        return Response.json({ ...metadata, full_name: "Owner/Repository" });
      return (original as typeof fetch)(url, init);
    });
    await expect(built.handle(request("/repos/owner/repository"), authorization)).resolves.toMatchObject({
      status: 200,
    });
  });

  it("serves a repository whose metadata carries no node id", async () => {
    // `node_id` is optional in the binding check; without it no GraphQL node identity is recorded.
    const built = adapterFor();
    const original = upstream.getMockImplementation();
    upstream.mockImplementation(async (url, init) => {
      if (new URL(String(url)).pathname === "/repositories/123")
        return Response.json({ id: 123, full_name: "owner/repository", default_branch: "main" });
      return (original as typeof fetch)(url, init);
    });
    expect(await responseJson(await built.handle(request("/repos/owner/repository"), authorization))).toMatchObject({
      id: 123,
    });
  });
});

describe("production GitHub provider adapter response sanitizing", () => {
  it.each([
    ["a token-bearing string", { note: `https://example.com/?token=${iat}` }],
    ["a token-bearing nested value", { nested: [{ download_url: `https://x.invalid/${iat}` }] }],
    ["a signed URL", { url: "https://example.com/file?X-Amz-Signature=x" }],
    ["a URL-embedded password", { url: "https://user:pass@example.com/x" }],
    ["a URL-embedded username", { url: "https://user@example.com/x" }],
  ])("refuses a read response carrying %s", async (_label, payload) => {
    const built = adapterFor();
    const original = upstream.getMockImplementation();
    upstream.mockImplementation(async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path === "/repositories/123") return (original as typeof fetch)(url, init);
      return Response.json(payload);
    });
    const error = await built
      .handle(request("/repos/owner/repository/commits/main"), authorization)
      .then((response) => responseJson(response))
      .catch((cause: unknown) => cause);
    // The adapter refuses the response outright rather than forwarding scrubbed content, so no
    // credential-shaped value can appear in the caller's stream.
    expect(error).toMatchObject({ code: "unavailable" });
    expect(String(error)).not.toContain(iat);
  });

  it.each([
    ["an access token field", { access_token: iat, title: "Work" }],
    ["a refresh token field", { refresh_token: iat }],
    ["a client secret field", { client_secret: "client-secret-value" }],
  ])("drops %s from a read response", async (_label, payload) => {
    const built = adapterFor();
    const original = upstream.getMockImplementation();
    upstream.mockImplementation(async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path === "/repositories/123") return (original as typeof fetch)(url, init);
      return Response.json(payload);
    });
    const json = JSON.stringify(
      await responseJson(await built.handle(request("/repos/owner/repository/commits/main"), authorization)),
    );
    expect(json).not.toContain(iat);
    expect(json).not.toContain("client-secret-value");
  });

  it.each([
    ["an empty 2xx body", { status: 201, body: undefined }],
    ["a 2xx array body", { status: 201, body: [1, 2] }],
    ["a 2xx scalar body", { status: 201, body: 7 }],
  ])("surfaces %s as write_outcome_unknown", async (_label, shape) => {
    const built = adapterFor();
    const original = upstream.getMockImplementation();
    upstream.mockImplementation(async (url, init) => {
      if (init?.method === "POST") {
        writeCount++;
        return Response.json(shape.body ?? null, { status: shape.status });
      }
      return (original as typeof fetch)(url, init);
    });
    await expect(
      built.handle(request("/repos/owner/repository/pulls", "POST", pullBody()), authorization),
    ).rejects.toMatchObject({ code: "write_outcome_unknown" });
    expect(writeCount).toBe(1);
  });

  it.each([
    ["a null data field", { data: null }],
    ["an array data field", { data: [1] }],
    ["a scalar data field", { data: "ok" }],
  ])("surfaces a GraphQL 2xx with %s as write_outcome_unknown", async (_label, payload) => {
    await adapter.handle(request("/repos/owner/repository"), authorization);
    const original = upstream.getMockImplementation();
    upstream.mockImplementation(async (...args) => {
      if (String(args[0]).endsWith("/graphql")) {
        writeCount++;
        return Response.json(payload);
      }
      return (original as typeof fetch)(...args);
    });
    const body = {
      query:
        "mutation($input:CreatePullRequestInput!){createPullRequest(input:$input){pullRequest{id number headRefName baseRefName}}}",
      variables: {
        input: { repositoryId: "R_test", title: "Work", headRefName: pullBody().head, baseRefName: "main" },
      },
    };
    await expect(adapter.handle(request("/graphql", "POST", body), authorization)).rejects.toMatchObject({
      code: "write_outcome_unknown",
    });
    expect(writeCount).toBe(1);
  });

  it("denies a GraphQL update whose recorded node identity carries no pull request number", async () => {
    // The `repository-123` index entry is recorded by `#context` for the repository node itself. Its
    // repositoryId matches a granted repository, so the policy resolves, but it carries no pull
    // request number and can therefore never authorize an updatePullRequest mutation.
    const built = adapterFor();
    const original = upstream.getMockImplementation();
    upstream.mockImplementation(async (url, init) => {
      if (new URL(String(url)).pathname === "/repositories/123") return Response.json({ ...metadata, node_id: "123" });
      return (original as typeof fetch)(url, init);
    });
    await built.handle(request("/repos/owner/repository"), authorization);
    const body = {
      query:
        'mutation($id:ID!){updatePullRequest(input:{pullRequestId:$id,title:"x"}){pullRequest{id number headRefName baseRefName}}}',
      variables: { id: "repository-123" },
    };
    const error = await built.handle(request("/graphql", "POST", body), authorization).catch((cause: unknown) => cause);
    expect(error).toMatchObject({ code: "scope_denied" });
    expect(writeCount).toBe(0);
  });

  it("denies a GraphQL addComment whose recorded subject carries no pull request number", async () => {
    const built = adapterFor();
    const original = upstream.getMockImplementation();
    upstream.mockImplementation(async (url, init) => {
      if (new URL(String(url)).pathname === "/repositories/123") return Response.json({ ...metadata, node_id: "123" });
      return (original as typeof fetch)(url, init);
    });
    await built.handle(request("/repos/owner/repository"), authorization);
    const body = {
      query: 'mutation($id:ID!){addComment(input:{subjectId:$id,body:"x"}){commentEdge{node{id}}}}',
      variables: { id: "repository-123" },
    };
    const error = await built.handle(request("/graphql", "POST", body), authorization).catch((cause: unknown) => cause);
    expect(error).toMatchObject({ code: "scope_denied" });
    expect(writeCount).toBe(0);
  });

  it("denies a GraphQL mutation with no input object at all", async () => {
    await adapter.handle(request("/repos/owner/repository"), authorization);
    const body = {
      query: "mutation{pullRequests:createPullRequest{clientMutationId}}",
    };
    await expect(adapter.handle(request("/graphql", "POST", body), authorization)).rejects.toBeInstanceOf(Error);
    expect(writeCount).toBe(0);
  });

  it("denies a create mutation whose input omits both ref names", async () => {
    // A policy-valid input object may simply omit headRefName/baseRefName; the ref assertion then
    // receives empty strings and must refuse the write rather than treat the absence as permissive.
    await adapter.handle(request("/repos/owner/repository"), authorization);
    const body = {
      query:
        "mutation($input:CreatePullRequestInput!){createPullRequest(input:$input){pullRequest{id number headRefName baseRefName}}}",
      variables: { input: { repositoryId: "R_test", title: "Work" } },
    };
    await expect(adapter.handle(request("/graphql", "POST", body), authorization)).rejects.toMatchObject({
      code: "scope_denied",
    });
    expect(writeCount).toBe(0);
  });

  it("treats a non-string new base as an absent base on a GraphQL update", async () => {
    // The mutation input schema is key-checked, not value-typed; a non-string baseRefName must be
    // read as "no new base" rather than stringified into a ref assertion.
    await adapter.handle(request("/repos/owner/repository"), authorization);
    const read = adapter.handle(request("/repos/owner/repository/pulls/1"), authorization);
    const original = upstream.getMockImplementation();
    upstream.mockImplementation(async (...args) => {
      const path = new URL(String(args[0])).pathname;
      if (path === "/graphql" && String((args[1] as RequestInit).body).includes("mutation")) {
        writeCount++;
        return Response.json({
          data: {
            updatePullRequest: {
              pullRequest: { id: "PR_one", number: 1, headRefName: "topic", baseRefName: "main" },
            },
          },
        });
      }
      return (original as typeof fetch)(...args);
    });
    await read;
    const body = {
      query:
        "mutation($id:ID!,$base:String){updatePullRequest(input:{pullRequestId:$id,baseRefName:$base}){pullRequest{id number headRefName baseRefName}}}",
      variables: { base: 123, id: "PR_one" },
    };
    await expect(adapter.handle(request("/graphql", "POST", body), authorization)).resolves.toMatchObject({
      status: 200,
    });
    expect(writeCount).toBe(1);
  });

  it("ignores scalar and null entries in a read response when recording node identities", async () => {
    const built = adapterFor();
    const original = upstream.getMockImplementation();
    upstream.mockImplementation(async (url, init) => {
      const path = new URL(String(url)).pathname;
      if (path === "/repositories/123") return (original as typeof fetch)(url, init);
      return Response.json([1, null, "text", { number: 2, title: "Work" }, { nested: { deeper: null } }]);
    });
    expect(await responseJson(await built.handle(request("/repos/owner/repository/pulls"), authorization))).toEqual([
      1,
      null,
      "text",
      { number: 2, title: "Work" },
      { nested: { deeper: null } },
    ]);
  });
});

function fixtureWrite(path: string, body: { variables: { input: { headRefName: string } } }): Response {
  writeCount++;
  if (writeBehavior === "lost") throw new Error("untrusted transport detail");
  if (writeBehavior === "secret")
    return Response.json({ download_url: `https://github.com/private?token=${iat}` }, { status: 201 });
  if (writeBehavior === "empty") return Response.json({}, { status: 201 });
  if (writeBehavior === "malformed")
    return new Response("this is not json", { status: 201, headers: { "content-type": "application/json" } });
  if (writeBehavior === "reject422") return Response.json({ message: "Validation Failed" }, { status: 422 });
  if (writeBehavior === "status503") return Response.json({ message: "server error" }, { status: 503 });
  if (writeBehavior === "status408") return Response.json({ message: "timeout" }, { status: 408 });
  if (path === "/graphql")
    return Response.json({
      data: {
        createPullRequest: {
          pullRequest: {
            id: "PR_one",
            number: 1,
            headRefName: body.variables.input.headRefName,
            baseRefName: "main",
          },
        },
      },
    });
  return Response.json(
    { number: 1, node_id: "PR_one", html_url: "https://github.com/owner/repository/pull/1" },
    { status: 201 },
  );
}
