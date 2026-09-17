import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

let root: string, sessionId: string, executionId: string, bindingId: string;
let workspace: GitWorkspace, adapter: GitHubProviderAdapter, repository: GitHubExecutionRepository;
let authorization: RuntimeProxyAuthorization;
let upstream: ReturnType<typeof vi.fn<typeof fetch>>;
let mint: ReturnType<typeof vi.fn<GitHubInstallationTokenClient["mint"]>>,
  revoke: ReturnType<typeof vi.fn<GitHubInstallationTokenClient["revoke"]>>;
const iat = "ghs_test-installation-token";
const metadata = { id: 123, node_id: "R_test", full_name: "owner/repository", default_branch: "main" };
let writeBehavior: "ok" | "lost" | "secret" | "empty" | "malformed" | "reject422" | "status503" | "status408";
let writeCount: number;
const requests: { method: string; path: string; headers: Headers; body: unknown }[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(await realpath(tmpdir()), "opentag-provider-adapter-"));
  sessionId = randomUUID();
  executionId = randomUUID();
  bindingId = randomUUID();
  workspace = new GitWorkspace();
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
    requests.push({ method: init?.method ?? "GET", path, headers: new Headers(init?.headers), body });
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
  await adapter.close();
  await workspace?.close();
  await rm(root, { recursive: true, force: true });
});
function request(path: string, method = "GET", body?: unknown): ProviderProxyRequest {
  return {
    executionId,
    sessionId,
    bindingId,
    provider: "github",
    method,
    path,
    headers: { "x-opentag-provider-origin": "api.github.com" },
    body: jsonBody(body),
    capability: "trusted-runner-capability",
    capabilityTtlSeconds: 60,
    signal: new AbortController().signal,
  };
}
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
