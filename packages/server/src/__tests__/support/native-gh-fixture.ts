import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strToU8, zipSync } from "fflate";
import {
  type DocumentNode,
  type FragmentDefinitionNode,
  Kind,
  parse,
  type SelectionNode,
  type SelectionSetNode,
} from "graphql";
import { GitHubProviderAdapter } from "../../services/github-proxy/github-provider-adapter.js";
import { GitHubHttpTransport } from "../../services/github-proxy/http-transport.js";
import { nativeProxyChannel } from "./native-proxy-channel.js";

async function bytes(input: AsyncIterable<Uint8Array>) {
  const chunks: Uint8Array[] = [];
  for await (const chunk of input) chunks.push(chunk);
  return Buffer.concat(chunks);
}

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
    "addPullRequestReview",
    "mergePullRequest",
  ].find((name) => query.includes(name));
  if (!operation) return undefined;
  if (operation === "closePullRequest") pr.state = "CLOSED";
  if (operation === "reopenPullRequest") pr.state = "OPEN";
  if (operation === "mergePullRequest") pr.state = "MERGED";
  const input = record(record(body.variables).input);
  if (input.title) pr.title = input.title;
  return graphResponse(query, {
    [operation]: {
      __typename: "Payload",
      pullRequest: pr,
      pullRequestReview: { id: "PRR_fixture", state: "APPROVED" },
      commentEdge: { node: { id: "IC_fixture", url: `${pr.url}#issuecomment-1` } },
      subject: pr,
    },
  });
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

export async function nativeGhFixture(
  options: { denyProjectMetadata?: boolean; privateRepository?: boolean; cloud?: boolean } = {},
) {
  const root = await mkdtemp(join(tmpdir(), "ot-gh-server-"));

  const fullName = "team/code",
    branch = "feature/ordinary-work";
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
    mergeCommitAllowed: true,
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
    mergeStateStatus: "CLEAN",
    viewerCanUpdate: true,
    additions: 1,
    deletions: 1,
    createdAt: "2026-10-14T01:00:00Z",
    assignees: { nodes: [], totalCount: 0 },
    reviews: { nodes: [], totalCount: 0, pageInfo: { hasNextPage: false } },
    comments: { nodes: [], totalCount: 0, pageInfo: { hasNextPage: false } },
    reactionGroups: [],
    commits: { nodes: [{ commit: { oid: "1".repeat(40), statusCheckRollup: { contexts } } }], totalCount: 1 },
  };
  const foreignPr: Record<string, unknown> = {
    ...pr,
    id: "PR_foreign",
    number: 2,
    headRefName: "opentag/different-session/code/foreign",
  };
  const upstreamRequests: {
    host: string;
    method: string;
    path: string;
    search: string;
    body: unknown;
    accept: string | null;
  }[] = [];
  interface FixtureRequest {
    method: string;
    body: unknown;
    accept: string | null;
    search: URLSearchParams;
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
  const workflow = { id: 42, name: "Fixture CI", path: ".github/workflows/ci.yml", state: "active" };
  const workflowRun = {
    id: 7,
    workflow_id: 42,
    jobs_url: `https://api.github.com/repos/${fullName}/actions/runs/7/jobs`,
    name: "Fixture CI",
    display_title: "Fixture commit",
    head_branch: "main",
    head_sha: "1".repeat(40),
    event: "push",
    status: "completed",
    conclusion: "success",
    run_number: 1,
    run_attempt: 1,
    created_at: "2026-10-14T01:00:00Z",
    updated_at: "2026-10-14T01:00:01Z",
    html_url: "https://github.com/team/code/actions/runs/7",
    pull_requests: [],
    actor: { login: "fixture-user" },
    head_commit: { message: "Fixture commit" },
  };
  const runs = () => Response.json({ total_count: 1, workflow_runs: [workflowRun] });
  const log = "2026-10-14T01:00:00.0000000Z fixture-log-line\n";
  const download = (name: string, host = "productionresultssa9.blob.core.windows.net") =>
    new Response(null, {
      status: 302,
      headers: { location: `https://${host}/storage/${name}?sig=fixture-only` },
    });
  const routes: Record<string, (request: FixtureRequest) => Response> = {
    [`/repos/${fullName}/issues`]: ({ search }) => {
      const page = Number(search.get("page") ?? "1");
      return Response.json([{ number: page }], {
        headers:
          page < 300 ? { link: `<https://api.github.com/repos/${fullName}/issues?page=${page + 1}>; rel="next"` } : {},
      });
    },
    [`/repos/${fullName}/issues/99/comments`]: ({ body }) =>
      Response.json({ id: 99, body: record(body).body, user: { login: "fixture-owner" } }),
    [`/repos/${fullName}/actions/runs/7/logs`]: () =>
      download("run.zip", "results-receiver.actions.githubusercontent.com"),
    [`/repos/${fullName}/actions/jobs/99/logs`]: () => download("job.txt"),
    [`/repos/${fullName}/actions/runs/7/artifacts`]: () =>
      Response.json({
        total_count: 1,
        artifacts: [
          {
            id: 55,
            name: "fixture-artifact",
            size_in_bytes: 100,
            expired: false,
            archive_download_url: `https://api.github.com/repos/${fullName}/actions/artifacts/55/zip`,
          },
        ],
      }),
    [`/repos/${fullName}/actions/artifacts/55/zip`]: () => download("artifact.zip"),
    "/storage/run.zip": () =>
      new Response(Buffer.from(zipSync({ "build/1_Run tests.txt": strToU8(log), "0_build.txt": strToU8(log) })), {
        headers: { "content-type": "application/zip" },
      }),
    "/storage/artifact.zip": () =>
      new Response(Buffer.from(zipSync({ "result.txt": strToU8("fixture-artifact-bytes\n") })), {
        headers: { "content-type": "application/zip" },
      }),
    "/storage/job.txt": () => new Response(log),
    [`/repos/${fullName}/releases/tags/v1.0.0`]: () =>
      Response.json({
        id: 1,
        tag_name: "v1.0.0",
        name: "Fixture release",
        draft: false,
        prerelease: false,
        zipball_url: `https://api.github.com/repos/${fullName}/zipball/v1.0.0`,
        assets: [
          {
            id: 88,
            name: "fixture.txt",
            size: 22,
            state: "uploaded",
            api_url: `https://api.github.com/repos/${fullName}/releases/assets/88`,
            url: `https://api.github.com/repos/${fullName}/releases/assets/88`,
            browser_download_url: `https://github.com/${fullName}/releases/download/v1.0.0/fixture.txt`,
          },
        ],
      }),
    [`/repos/${fullName}/releases/assets/88`]: () => download("release.txt", "release-assets.githubusercontent.com"),
    [`/repos/${fullName}/zipball/v1.0.0`]: () => download("archive.zip", "codeload.github.com"),
    "/storage/release.txt": () => new Response("fixture-release-bytes\n"),
    "/storage/archive.zip": () =>
      new Response(Buffer.from(zipSync({ "team-code/file.txt": strToU8("fixture-archive-bytes\n") })), {
        headers: { "content-type": "application/zip", "content-disposition": 'attachment; filename="code-v1.0.0.zip"' },
      }),
    "/repositories/123": metadata,
    [`/repos/${fullName}/pulls/2/merge`]: () =>
      Response.json({ merged: true, sha: "2".repeat(40), message: "Merged by fixture owner" }),
    [`/repos/${fullName}/pulls/2/reviews`]: () =>
      Response.json({ id: 12, state: "APPROVED", user: { login: "fixture-owner" } }),
    [`/repos/${fullName}/actions/workflows`]: () => Response.json({ total_count: 1, workflows: [workflow] }),
    [`/repos/${fullName}/actions/workflows/42`]: () => Response.json(workflow),
    [`/repos/${fullName}/actions/workflows/ci.yml`]: () => Response.json(workflow),
    [`/repos/${fullName}/actions/workflows/42/runs`]: runs,
    [`/repos/${fullName}/actions/workflows/ci.yml/runs`]: runs,
    [`/repos/${fullName}/actions/runs`]: runs,
    [`/repos/${fullName}/actions/runs/7`]: () => Response.json(workflowRun),
    [`/repos/${fullName}/actions/runs/7/jobs`]: () =>
      Response.json({
        total_count: 1,
        jobs: [
          {
            id: 99,
            name: "build",
            status: "completed",
            conclusion: "success",
            started_at: "2026-10-14T01:00:00Z",
            completed_at: "2026-10-14T01:00:01Z",
            steps: [
              {
                name: "Run tests",
                number: 1,
                status: "completed",
                conclusion: "success",
                started_at: "2026-10-14T01:00:00Z",
                completed_at: "2026-10-14T01:00:01Z",
              },
            ],
          },
        ],
      }),
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
      if (/\b__type\s*\(/.test(query))
        return graphResponse(query, {
          __type: {
            fields: [
              "id",
              "number",
              "statusCheckRollup",
              "assignedActors",
              "nodes",
              "pageInfo",
              "checkRunCount",
              "checkRunCountsByState",
              "statusContextCount",
              "statusContextCountsByState",
              "event",
              "workflow",
            ].map((name) => ({ name })),
          },
        });
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
        variables.pr_number === 2 ||
        variables.number === 2 ||
        variables.id === "PR_foreign" ||
        record(variables.input).pullRequestId === "PR_foreign"
          ? foreignPr
          : pr;
      return (
        mutateFixture(query, payload, selected) ??
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
  const upstream = http.createServer((request, response) => {
    void (async () => {
      const parsed = new URL(request.url ?? "/", "https://api.github.com");
      const method = request.method ?? "GET";
      const raw = await bytes(request);
      const body: unknown = parseFixtureBody(raw);
      const accept = request.headers.accept ?? null;
      upstreamRequests.push({
        host: request.headers.host ?? "",
        method,
        path: parsed.pathname,
        search: parsed.search,
        body,
        accept,
      });
      assertFixtureCredential(request);
      const route = routes[parsed.pathname];
      const denied = options.privateRepository && !["GET", "HEAD"].includes(method) && parsed.pathname !== "/graphql";
      let value = Response.json({ message: "Not Found" }, { status: 404 });
      if (route) value = route({ method, body, accept, search: parsed.searchParams });
      if (denied) value = Response.json({ message: "Resource not accessible by integration" }, { status: 403 });
      response.writeHead(value.status, Object.fromEntries(value.headers.entries()));
      response.end(Buffer.from(await value.arrayBuffer()));
    })().catch(() => response.destroy());
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const address = upstream.address();
  if (!address || typeof address === "string") throw Error("Fixture address missing");
  const adapter = new GitHubProviderAdapter({
    management: {
      getExecutionUserCredential: async () => ({
        accessToken: "ghu_fixture_owner",
        githubUserId: "owner",
        credentialGeneration: 1n,
        accessExpiresAt: new Date(Date.now() + 60000),
      }),
    },
    transport: new GitHubHttpTransport({
      resolveAddresses: async () => ["140.82.112.3"],
      connect: (url, options, listener) =>
        http.request(
          {
            ...options,
            hostname: "127.0.0.1",
            port: address.port,
            path: url.pathname + url.search,
            headers: { ...options.headers, host: url.host },
          },
          listener,
        ),
    }),
  });
  const channel = await nativeProxyChannel(root, adapter, options.cloud);
  return {
    root,
    channel,
    branch,
    fullName,
    upstreamRequests,
    foreignPr,
    pr,
    environment: { ...channel.environment, GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1" },
    async close() {
      await channel.close();
      upstream.closeAllConnections();
      await new Promise<void>((resolve) => upstream.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    },
  };
}

function parseFixtureBody(raw: Buffer): unknown {
  return raw.length ? JSON.parse(raw.toString()) : undefined;
}

function assertFixtureCredential(request: http.IncomingMessage): void {
  const expected = request.headers.host === "api.github.com" ? "Bearer ghu_fixture_owner" : undefined;
  if (request.headers.authorization !== expected) throw Error("Wrong owner token");
  if (request.headers.cookie !== undefined) throw Error("Unexpected cookie");
}
