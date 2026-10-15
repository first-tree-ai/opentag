import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type DocumentNode,
  type FragmentDefinitionNode,
  Kind,
  parse,
  type SelectionNode,
  type SelectionSetNode,
} from "graphql";
import type { RuntimeProxyAuthorization } from "../../runtime-credentials/credential-broker.js";
import { GitHubProxyApiTransport } from "../../services/github-proxy/api-transport.js";
import { GitPublicationGuard } from "../../services/github-proxy/git-publication.js";
import { GitReadTransport } from "../../services/github-proxy/git-read-transport.js";
import { GitWorkspace } from "../../services/github-proxy/git-workspace.js";
import { GitHubProviderAdapter } from "../../services/github-proxy/github-provider-adapter.js";
import { GitHubUserTokenLeases } from "../../services/github-proxy/user-token-leases.js";

/** Project only selected response fields, as GraphQL does; extra fixture fields break native gh decoders. */
function project(set: SelectionSetNode, value: unknown, fragments: Map<string, FragmentDefinitionNode>): unknown {
  if (value == null) return null;
  if (Array.isArray(value)) return value.map((item) => project(set, item, fragments));
  const row = value as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  for (const selection of set.selections) Object.assign(result, projectSelection(selection, row, fragments));
  return result;
}
function projectSelection(
  selection: SelectionNode,
  row: Record<string, unknown>,
  fragments: Map<string, FragmentDefinitionNode>,
): unknown {
  if (selection.kind === Kind.INLINE_FRAGMENT) return project(selection.selectionSet, row, fragments);
  if (selection.kind === Kind.FRAGMENT_SPREAD) {
    const fragment = fragments.get(selection.name.value);
    return fragment ? project(fragment.selectionSet, row, fragments) : {};
  }
  const name = selection.name.value,
    child = row[name] ?? (name === "__typename" ? "User" : null);
  return {
    [selection.alias?.value ?? name]: selection.selectionSet
      ? project(selection.selectionSet, child, fragments)
      : child,
  };
}
function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}
function mutateFixture(
  query: string,
  body: Record<string, unknown>,
  pr: Record<string, unknown>,
): Response | undefined {
  if (!query.includes("mutation")) return undefined;
  const operation = [
    "createPullRequest",
    "updatePullRequest",
    "closePullRequest",
    "reopenPullRequest",
    "addComment",
  ].find((name) => query.includes(name));
  if (!operation) return undefined;
  if (operation === "closePullRequest") pr.state = "CLOSED";
  if (operation === "reopenPullRequest") pr.state = "OPEN";
  const input = record(record(body.variables).input);
  if (input.title) pr.title = input.title;
  return graphResponse(query, {
    [operation]: {
      __typename: "Payload",
      pullRequest: pr,
      commentEdge: { node: { id: "IC_fixture", url: `${pr.url}#issuecomment-1` } },
      subject: pr,
    },
  });
}
function fixtureHttpAuthorized(request: http.IncomingMessage, response: http.ServerResponse): boolean {
  if (request.headers.host === "api.github.com" && request.headers.authorization === "token otrh_fixture") return true;
  response.writeHead(403);
  response.end();
  return false;
}

function graphResponse(query: string, value: unknown): Response {
  const document: DocumentNode = parse(query);
  const fragments = new Map(
    document.definitions
      .filter((item) => item.kind === Kind.FRAGMENT_DEFINITION)
      .map((item) => [item.name.value, item]),
  );
  const operation = document.definitions.find((item) => item.kind === Kind.OPERATION_DEFINITION);
  if (!operation) throw new Error("Fixture requires an operation");
  return Response.json({ data: project(operation.selectionSet, value, fragments) });
}

export async function nativeGhFixture(options: { denyProjectMetadata?: boolean; privateRepository?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "ot-gh-server-"));
  const socketPath = join(root, "g.sock");
  const executionId = randomUUID(),
    sessionId = randomUUID(),
    bindingId = randomUUID();
  const fullName = "team/code",
    branch = `opentag/${sessionId}/code/fixture`;
  const repo = {
    id: "R_fixture",
    databaseId: 123,
    name: "code",
    nameWithOwner: fullName,
    isPrivate: options.privateRepository ?? false,
    owner: { id: "O_fixture", login: "team" },
    defaultBranchRef: { name: "main" },
    viewerPermission: "WRITE",
    hasIssuesEnabled: true,
    hasWikiEnabled: false,
    isFork: false,
    parent: null,
  };
  const contexts = {
    nodes: [
      {
        __typename: "CheckRun",
        name: "fixture-check",
        status: "COMPLETED",
        conclusion: "SUCCESS",
        isRequired: true,
        checkSuite: { workflowRun: { event: "push", workflow: { name: "fixture" } } },
        startedAt: "2026-10-14T01:00:00Z",
        completedAt: "2026-10-14T01:00:01Z",
        detailsUrl: "https://github.com/team/code/actions/runs/1",
      },
    ],
    pageInfo: { hasNextPage: false, endCursor: null },
    checkRunCount: 1,
    statusContextCount: 0,
    checkRunCountsByState: [{ state: "SUCCESS", count: 1 }],
    statusContextCountsByState: [],
  };
  const pr: Record<string, unknown> = {
    id: "PR_fixture",
    number: 1,
    title: "Fixture",
    body: "Fixture",
    url: "https://github.com/team/code/pull/1",
    state: "OPEN",
    isDraft: true,
    headRefName: branch,
    baseRefName: "main",
    author: { id: "U_fixture", login: "fixture-user", __typename: "User" },
    headRepository: repo,
    baseRepository: repo,
    headRepositoryOwner: repo.owner,
    isCrossRepository: false,
    maintainerCanModify: true,
    reviewRequests: { nodes: [] },
    assignedActors: { nodes: [], totalCount: 0 },
    labels: { nodes: [], totalCount: 0 },
    projectItems: { nodes: [], totalCount: 0, pageInfo: { hasNextPage: false } },
    milestone: null,
    autoMergeRequest: null,
    mergeable: "MERGEABLE",
    additions: 1,
    deletions: 1,
    createdAt: "2026-10-14T01:00:00Z",
    assignees: { nodes: [], totalCount: 0 },
    reviews: { nodes: [], totalCount: 0, pageInfo: { hasNextPage: false } },
    comments: { nodes: [], totalCount: 0, pageInfo: { hasNextPage: false } },
    reactionGroups: [],
    commits: { nodes: [{ commit: { oid: "1".repeat(40), statusCheckRollup: { contexts } } }], totalCount: 1 },
  };
  const foreignPr = { ...pr, id: "PR_foreign", number: 2, headRefName: `opentag/${randomUUID()}/code/foreign` };
  const upstreamRequests: { method: string; path: string; body: unknown; accept: string | null }[] = [];
  const permissions: unknown[] = [];
  const tokenPermissions = new Map<string, Record<string, string>>();
  const counts = { minted: 0, revoked: 0 };
  interface FixtureRequest {
    method: string;
    body: unknown;
    accept: string | null;
  }
  const metadata = () =>
    Response.json({
      ...repo,
      id: 123,
      node_id: repo.id,
      full_name: fullName,
      default_branch: "main",
      private: repo.isPrivate,
    });
  const routes: Record<string, (request: FixtureRequest) => Response> = {
    "/repositories/123": metadata,
    [`/repos/${fullName}`]: metadata,
    [`/repos/${fullName}/pulls/1`]: ({ method, accept }) => {
      if (method === "GET" && /diff|patch/.test(accept ?? ""))
        return new Response(
          "diff --git a/fixture.txt b/fixture.txt\n--- a/fixture.txt\n+++ b/fixture.txt\n@@ -1 +1 @@\n-before\n+after\n",
          { headers: { "content-type": "text/plain" } },
        );
      return Response.json({
        ...pr,
        node_id: pr.id,
        head: { ref: branch, repo: { id: 123 } },
        base: { ref: "main", repo: { id: 123 } },
      });
    },
    [`/repos/${fullName}/pulls/2`]: () =>
      Response.json({
        node_id: "PR_foreign",
        head: { ref: foreignPr.headRefName, repo: { id: 123 } },
        base: { ref: "main", repo: { id: 123 } },
      }),
    [`/repos/${fullName}/issues/1/comments`]: ({ body }) =>
      Response.json({ id: 1, node_id: "IC_fixture", html_url: `${pr.url}#issuecomment-1`, body: record(body).body }),
    "/graphql": ({ body }) => {
      const payload = record(body),
        query = String(payload.query ?? "");
      if (options.denyProjectMetadata && query.includes("PullRequestProjectItems"))
        return Response.json({
          errors: [
            {
              type: "FORBIDDEN",
              path: ["repository", "pullRequest", "projectItems"],
              message: "Resource not accessible by integration",
            },
          ],
        });
      const variables = record(payload.variables);
      const selected =
        variables.pr_number === 2 || variables.number === 2 || variables.id === "PR_foreign" ? foreignPr : pr;
      return (
        mutateFixture(query, payload, pr) ??
        graphResponse(query, {
          node: selected,
          repository: {
            ...repo,
            pullRequest: selected,
            pullRequests: { nodes: [], totalCount: 0, pageInfo: { hasNextPage: false } },
          },
        })
      );
    },
    [`/repos/${fullName}/commits/main/status`]: () =>
      Response.json({ state: "success", statuses: [{ context: "private-ci", state: "success" }] }),
    [`/repos/${fullName}/commits/feature/topic/statuses`]: () =>
      Response.json([{ context: "private-ci", state: "success" }]),
    [`/repos/${fullName}/statuses/feature/topic`]: () => Response.json([{ context: "private-ci", state: "success" }]),
  };
  const upstream: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname,
      method = init?.method ?? "GET";
    const body: unknown = init?.body ? JSON.parse(String(init.body)) : undefined;
    const accept = new Headers(init?.headers).get("accept");
    upstreamRequests.push({ method, path, body, accept });
    if (options.privateRepository && /\/(?:status|statuses)(?:\/|$)/.test(path)) {
      const token = new Headers(init?.headers).get("authorization")?.replace(/^Bearer /, "") ?? "";
      if (tokenPermissions.get(token)?.statuses !== "read")
        return Response.json({ message: "Resource not accessible by integration" }, { status: 403 });
    }
    const route = routes[path];
    if (!route) throw new Error(`Unregistered fixture request: ${method} ${path}`);
    return route({ method, body, accept });
  };
  const workspace = new GitWorkspace();
  const adapter = new GitHubProviderAdapter({
    policy: {
      resolve: async () => [
        {
          fullName,
          repositoryId: "123",
          installationId: "456",
          scopes: [{ role: "code", access: "write", publish: "pull_request" }],
          protectedTreeRefs: [],
        },
      ],
    },
    leases: new GitHubUserTokenLeases({
      mint: async (input) => {
        counts.minted++;
        permissions.push(input.permissions);
        const token = `ghu_fixture_${counts.minted}`;
        tokenPermissions.set(token, { ...input.permissions });
        return { token, expiresAt: new Date(Date.now() + 60000) };
      },
      revoke: async (token) => {
        tokenPermissions.delete(token);
        counts.revoked++;
      },
    }),
    api: new GitHubProxyApiTransport(upstream),
    reads: new GitReadTransport({ workspace }),
    publication: new GitPublicationGuard({ workspace }),
  });
  const authorization: RuntimeProxyAuthorization = {
    executionId,
    sessionId,
    bindingId,
    provider: "github",
    purpose: "execution",
    scopeHash: "a".repeat(64),
    authorizationRevision: "github:1",
    credentialGeneration: "1",
    accountId: randomUUID(),
    agentId: randomUUID(),
    cli: { provider: "github", connectionId: bindingId, authority: "user-task" },
    recheck: async () => {},
    resolveMaterial: async () => {
      throw new Error("No material for fixture Sandbox");
    },
  };
  const server = http.createServer((request, response) => {
    void (async () => {
      if (!fixtureHttpAuthorized(request, response)) return;
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      try {
        const result = await adapter.handle(
          {
            executionId,
            sessionId,
            bindingId,
            provider: "github",
            method: request.method ?? "GET",
            path: request.url ?? "/",
            headers: { accept: request.headers.accept ?? "", "x-opentag-provider-origin": "api.github.com" },
            body: (async function* () {
              yield Buffer.concat(chunks);
            })(),
            capability: "fixture",
            capabilityTtlSeconds: 60,
            signal: new AbortController().signal,
          },
          authorization,
        );
        response.writeHead(result.status, result.headers);
        for await (const chunk of result.body) response.write(chunk);
        response.end();
      } catch {
        response.writeHead(403);
        response.end("scope_denied");
      }
    })().catch(() => {
      response.destroy();
    });
  });
  server.listen(socketPath);
  await once(server, "listening");
  await chmod(socketPath, 0o600);
  await writeFile(join(root, "config.yml"), `http_unix_socket: ${JSON.stringify(socketPath)}\n`, { mode: 0o600 });
  return {
    root,
    branch,
    fullName,
    upstreamRequests,
    permissions,
    counts,
    pr,
    environment: {
      HOME: root,
      PATH: process.env.PATH,
      GH_HOST: "github.com",
      GH_TOKEN: "otrh_fixture",
      GH_CONFIG_DIR: root,
      GH_PROMPT_DISABLED: "1",
      GH_NO_UPDATE_NOTIFIER: "1",
    },
    async close() {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      await adapter.close();
      await workspace.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}
