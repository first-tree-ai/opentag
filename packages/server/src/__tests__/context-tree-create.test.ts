import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import type { AgentAdminConfig, ContextTreeOperationRequest, GitHubConnectionStatus } from "@opentag/shared";
import { afterEach, expect, it, vi } from "vitest";
import { ContextTreeOperationService } from "../services/agents/context-tree-operation-service.js";
import {
  type ContextTreeGitHubManagement,
  GitHubContextTreeOperations,
} from "../services/agents/github-context-tree-operations.js";
import { GitHubApiClient } from "../services/github/github-api-client.js";
import { GitWorkspace } from "../services/github-proxy/git-workspace.js";

const operations: GitHubContextTreeOperations[] = [];
afterEach(async () => {
  await Promise.all(operations.splice(0).map((operation) => operation.close()));
});

function fixture(repository = "acme/memory") {
  const accountId = randomUUID();
  const connection = {
    id: randomUUID(),
    accountId,
    status: "active",
    githubLogin: "alice",
    authorizationVersion: "1",
    credentialGeneration: "1",
  } as GitHubConnectionStatus;
  const management = {
    getOverview: vi.fn(async () => ({
      availability: { available: true as const, githubHost: "github.com" as const, oauthClientId: "1" },
      connection,
    })),
    getExecutionUserCredential: vi.fn<ContextTreeGitHubManagement["getExecutionUserCredential"]>(async () => ({
      accessToken: "ghu_server_only",
      githubUserId: "42",
      accessExpiresAt: new Date(Date.now() + 3_600_000),
      credentialGeneration: 1n,
    })),
    resolveRepository: vi.fn(),
  };
  const remote = {
    id: 123,
    full_name: repository,
    private: true,
    default_branch: "trunk",
    permissions: { admin: true, pull: true, push: true },
  };
  const fetch = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) =>
    Response.json(remote, { status: 201, headers: { "x-oauth-scopes": "repo, offline_access" } }),
  );
  const api = new GitHubApiClient({
    clientId: "client",
    clientSecret: "secret",
    redirectUri: "http://localhost/callback",
    fetch,
  });
  const workspace = new GitWorkspace();
  const credentials = { acquire: vi.fn() };
  const runner = new GitHubContextTreeOperations({
    management,
    api,
    workspace,
    credentials,
    computerKind: async () => "local",
  });
  operations.push(runner);
  const config = {
    id: randomUUID(),
    computerId: randomUUID(),
    revision: 1,
    status: "active",
    runtimeConfig: { revision: 1, contextTrees: [] },
  } as unknown as AgentAdminConfig;
  const agents = {
    getConfigById: vi.fn(async () => config),
    updateContextTreeSelection: vi.fn(async () => config),
  };
  const registry = { currentInstanceId: vi.fn(() => "instance"), supportsCapability: vi.fn(() => true) };
  const service = new ContextTreeOperationService(agents, registry, runner);
  const input: ContextTreeOperationRequest = {
    kind: "git",
    repository,
    path: ".",
    ref: "HEAD",
    action: "create",
    expectedRevision: 1,
    expectedRuntimeConfigRevision: 1,
  };
  const run = () => service.run(accountId, config.id, input);
  return { accountId, management, fetch, workspace, runner, credentials, config, agents, input, run };
}

it.each(["acme/memory", "Alice/memory"])(
  "creates %s with the Account credential and GitHub default branch",
  async (repository) => {
    const f = fixture(repository);
    expect(await f.run()).toEqual({ status: "completed", repository, ref: "trunk" });
    expect(f.fetch.mock.calls.map(([url]) => String(url))).toEqual([
      repository.startsWith("Alice/") ? "https://api.github.com/user/repos" : "https://api.github.com/orgs/acme/repos",
      `https://api.github.com/repos/${repository}/contents/NODE.md`,
      `https://api.github.com/repos/${repository}`,
    ]);
    const requests = f.fetch.mock.calls.map(([, init]) => init);
    expect(JSON.parse(String(requests[0]?.body))).toEqual({ name: "memory", private: true, auto_init: false });
    const page = JSON.parse(String(requests[1]?.body));
    expect(page).toEqual({ message: "docs: initialize context tree", content: expect.any(String) });
    expect(Buffer.from(page.content, "base64").toString()).toContain("# memory");
    expect(requests[1]?.method).toBe("PUT");
    for (const request of requests) {
      expect(request?.headers).toMatchObject({ authorization: "Bearer ghu_server_only" });
      expect(request?.redirect).toBe("error");
    }
    expect(f.management.getExecutionUserCredential).toHaveBeenCalledWith({
      accountId: f.accountId,
      connectionId: (await f.management.getOverview()).connection.id,
      authorizationRevision: "github:1",
    });
    expect(f.agents.updateContextTreeSelection).toHaveBeenCalledWith(f.accountId, f.config.id, expect.any(Object), [
      { kind: "git", repository, path: ".", ref: "trunk" },
    ]);
    expect(f.credentials.acquire).not.toHaveBeenCalled();
    const root = f.workspace.root;
    await f.runner.close();
    expect(existsSync(root as string)).toBe(false);
  },
);

it("requires reconnection only when the Account connection is not active", async () => {
  const f = fixture();
  (await f.management.getOverview()).connection.status = "reauthorization_required";
  expect(await f.run()).toEqual({ status: "failed", code: "authentication_required" });
  expect(f.fetch).not.toHaveBeenCalled();
  expect(f.workspace.root).toBeUndefined();
  expect(f.agents.updateContextTreeSelection).not.toHaveBeenCalled();
});

it("reports denied repository-creation permissions without asking to reconnect", async () => {
  const f = fixture();
  f.fetch.mockResolvedValue(Response.json({ message: "denied" }, { status: 403 }));
  expect(await f.run()).toEqual({ status: "failed", code: "permission_denied" });
  expect(f.fetch).toHaveBeenCalledTimes(1);
  expect(f.agents.updateContextTreeSelection).not.toHaveBeenCalled();
});

it("never initializes or adopts a repository when creation is rejected", async () => {
  const f = fixture();
  f.fetch.mockResolvedValue(Response.json({ message: "already exists" }, { status: 422 }));
  expect(await f.run()).toEqual({ status: "failed", code: "repository_rejected" });
  expect(f.fetch).toHaveBeenCalledTimes(1);
  expect(f.agents.updateContextTreeSelection).not.toHaveBeenCalled();
});

it("preserves an uncertain publication and never retries a remote write automatically", async () => {
  const f = fixture();
  f.fetch.mockRejectedValueOnce(new Error("response lost"));
  expect(await f.run()).toEqual({ status: "failed", code: "publication_uncertain" });
  expect(f.fetch).toHaveBeenCalledTimes(1);
  expect(f.agents.updateContextTreeSelection).not.toHaveBeenCalled();
});

it("reports uncertain publication if creating the repository succeeds but initialization fails", async () => {
  const f = fixture();
  f.fetch
    .mockResolvedValueOnce(
      Response.json(
        {
          id: 123,
          full_name: "acme/memory",
          private: true,
          default_branch: "main",
          permissions: { admin: true, pull: true, push: true },
        },
        { status: 201, headers: { "x-oauth-scopes": "repo" } },
      ),
    )
    .mockRejectedValueOnce(new Error("initialization failed"));
  expect(await f.run()).toEqual({ status: "failed", code: "publication_uncertain" });
  expect(f.fetch).toHaveBeenCalledTimes(2);
  expect(f.agents.updateContextTreeSelection).not.toHaveBeenCalled();
});

it("rechecks authorization before initializing the new repository", async () => {
  const f = fixture();
  f.management.getExecutionUserCredential
    .mockResolvedValueOnce({
      accessToken: "ghu_server_only",
      githubUserId: "42",
      accessExpiresAt: new Date(Date.now() + 3_600_000),
      credentialGeneration: 1n,
    })
    .mockResolvedValueOnce(null);
  expect(await f.run()).toEqual({ status: "failed", code: "publication_uncertain" });
  expect(f.fetch).toHaveBeenCalledTimes(1);
  expect(f.agents.updateContextTreeSelection).not.toHaveBeenCalled();
});

it("does not recreate an already connected repository on a replay", async () => {
  const f = fixture();
  f.config.runtimeConfig.contextTrees = [{ kind: "git", repository: "acme/memory", path: ".", ref: "trunk" }];
  expect(await f.run()).toEqual({ status: "completed", repository: "acme/memory", ref: "trunk" });
  expect(f.fetch).not.toHaveBeenCalled();
  expect(f.agents.updateContextTreeSelection).not.toHaveBeenCalled();
});
