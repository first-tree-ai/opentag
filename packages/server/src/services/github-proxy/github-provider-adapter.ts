import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { RuntimeProxyAuthorization } from "../../runtime-credentials/credential-broker.js";
import type {
  ProviderProxyAdapter,
  ProviderProxyRequest,
  ProviderProxyResponse,
} from "../../runtime-credentials/provider-proxy-adapter.js";
import type { SessionControlStore } from "../session-control-store/index.js";
import {
  CreatePullRequestBodySchema,
  PullRequestCommentBodySchema,
  planGitHubRest,
  UpdatePullRequestBodySchema,
} from "./api-policy.js";
import { findRepository, parseBody, safeRequestUrl } from "./api-request.js";
import { GitHubProxyApiTransport, jsonBody, objectValue, sanitizeGitHubResponse } from "./api-transport.js";
import {
  assertPullRequestRefs,
  type GitHubExecutionPolicy,
  type GitHubExecutionRepository,
  taskBranchPrefix,
} from "./execution-policy.js";
import { GitPublicationError } from "./git-packets.js";
import type { GitPublicationGuard } from "./git-publication.js";
import type { GitReadTransport } from "./git-read-transport.js";
import { GitHubPublicationRemote } from "./git-remote.js";
import { handleGitSmartHttp } from "./git-smart-http.js";
import { type GitHubGraphqlPlan, planGitHubGraphql } from "./graphql-policy.js";
import type { GitHubIatLeases } from "./iat-leases.js";
import { GitHubNodeStore } from "./node-store.js";
import { constrainTreeGraphql } from "./tree-graphql-policy.js";
import type { VerifiedTreeHead } from "./verified-tree-head.js";

const GraphqlRequest = z
  .object({
    query: z.string().min(1).max(262144),
    variables: z.record(z.string(), z.unknown()).optional(),
    operationName: z.string().max(256).optional(),
  })
  .strict();
interface ApiContext {
  request: ProviderProxyRequest;
  authorization: RuntimeProxyAuthorization;
  repository: GitHubExecutionRepository;
  token: string;
  metadata: Record<string, unknown>;
  treeHead?: { ref: string; sha: string };
  recheck(): Promise<void>;
}
export interface GitHubProviderAdapterOptions {
  policy: GitHubExecutionPolicy;
  leases: GitHubIatLeases;
  reads: GitReadTransport;
  publication: GitPublicationGuard;
  store: SessionControlStore;
  api?: GitHubProxyApiTransport;
  treeHeads?: VerifiedTreeHead;
}

/** One policy gateway for native Git smart HTTP, gh REST, and gh GraphQL. Only IAT reaches GitHub. */
export class GitHubProviderAdapter implements ProviderProxyAdapter {
  readonly #options: GitHubProviderAdapterOptions;
  readonly #api: GitHubProxyApiTransport;
  readonly #nodes = new GitHubNodeStore();
  constructor(options: GitHubProviderAdapterOptions) {
    this.#options = options;
    this.#api = options.api ?? new GitHubProxyApiTransport();
  }
  async closeExecution(executionId: string): Promise<void> {
    this.#nodes.forget(executionId);
    await this.#options.leases.revokeExecution(executionId);
  }
  async close(): Promise<void> {
    await this.#options.leases.close();
  }

  async handle(
    request: ProviderProxyRequest,
    authorization: RuntimeProxyAuthorization,
  ): Promise<ProviderProxyResponse> {
    if (
      request.provider !== "github" ||
      authorization.provider !== "github" ||
      request.executionId !== authorization.executionId ||
      request.bindingId !== authorization.bindingId
    )
      throw new GitPublicationError("scope_denied");
    if (authorization.purpose !== "execution") throw new GitPublicationError("scope_denied");
    const url = safeRequestUrl(request.path);
    const repositories = await this.#options.policy.resolve(authorization, request.signal);
    const origin = request.headers["x-opentag-provider-origin"];
    if (origin === "github.com")
      return handleGitSmartHttp(
        { ...this.#options, metadata: (repository, token, signal) => this.#metadata(repository, token, signal) },
        request,
        authorization,
        url,
        repositories,
      );
    if (origin !== "api.github.com") throw new GitPublicationError("invalid_request");
    if (url.pathname === "/graphql" && !url.search && request.method === "POST")
      return this.#graphql(request, authorization, repositories);
    return this.#rest(request, authorization, url, repositories);
  }

  async #rest(
    request: ProviderProxyRequest,
    authorization: RuntimeProxyAuthorization,
    url: URL,
    repositories: GitHubExecutionRepository[],
  ): Promise<ProviderProxyResponse> {
    const plan = planGitHubRest(request.method, url);
    const repository = findRepository(repositories, plan.fullName);
    if (plan.codeOnly && !repository.scopes.some((scope) => scope.role === "code"))
      throw new GitPublicationError("scope_denied");
    const write = plan.operation !== "read";
    if (write && !repository.scopes.some((scope) => scope.access === "write" && scope.publish === "pull_request"))
      throw new GitPublicationError("scope_denied");
    const lease = await this.#options.leases.acquire(request.executionId, {
      installationId: repository.installationId,
      repositoryId: repository.repositoryId,
      signal: request.signal,
      permissions: {
        contents: "read",
        pull_requests: write ? "write" : "read",
        ...(plan.extraPermission ? { [plan.extraPermission]: "read" as const } : {}),
      },
    });
    try {
      const context = await this.#context(request, authorization, repository, lease.token);
      if (!write) {
        await this.#constrainTreeRestRead(context, url);
        const response = await this.#api.request({
          token: lease.token,
          method: "GET",
          path: url.pathname + url.search,
          signal: request.signal,
        });
        await context.recheck();
        this.#remember(context, response.value);
        return { ...response, body: jsonBody(sanitizeGitHubResponse(response.value, lease.token)) };
      }
      const body = await parseBody(request);
      let validated: unknown;
      if (plan.operation === "createPullRequest") {
        const input = CreatePullRequestBodySchema.parse(body);
        this.#assertRefs(context, input.head, input.base);
        await this.#verifyTreeHead(context, input.head);
        validated = input;
      } else {
        const input =
          plan.operation === "updatePullRequest"
            ? UpdatePullRequestBodySchema.parse(body)
            : PullRequestCommentBodySchema.parse(body);
        await this.#assertExistingPull(
          context,
          plan.pullRequestNumber as number,
          "base" in input ? input.base : undefined,
        );
        validated = input;
      }
      return await this.#write(context, request.method, url.pathname, validated, plan.operation);
    } finally {
      await lease.release();
    }
  }

  async #graphql(
    request: ProviderProxyRequest,
    authorization: RuntimeProxyAuthorization,
    repositories: GitHubExecutionRepository[],
  ): Promise<ProviderProxyResponse> {
    const body = GraphqlRequest.parse(await parseBody(request));
    const node = (id: string) => this.#nodes.get(request.executionId, authorization.scopeHash, id);
    const plan = planGitHubGraphql(
      body,
      repositories.map((repository) => ({
        repositoryId: repository.repositoryId,
        fullName: repository.fullName,
        nodeId: this.#repositoryNodeId(request.executionId, authorization.scopeHash, repository.repositoryId),
      })),
      (id) => node(id)?.repositoryId,
    );
    const repository = findRepository(repositories, plan.repository.fullName);
    const write = plan.operation !== "read";
    const lease = await this.#options.leases.acquire(request.executionId, {
      installationId: repository.installationId,
      repositoryId: repository.repositoryId,
      permissions: { contents: "read", pull_requests: write ? "write" : "read" },
      signal: request.signal,
    });
    try {
      const context = await this.#context(request, authorization, repository, lease.token);
      if (write) {
        await this.#validateGraphqlWrite(context, plan);
        return await this.#write(context, "POST", "/graphql", body, plan.operation);
      }
      const constrained = await this.#constrainTreeGraphql(context, body);
      const response = await this.#api.request({
        token: lease.token,
        method: "POST",
        path: "/graphql",
        body: constrained,
        signal: request.signal,
      });
      await context.recheck();
      this.#remember(context, response.value);
      return {
        status: response.status,
        headers: response.headers,
        body: jsonBody(sanitizeGitHubResponse(response.value, lease.token)),
      };
    } finally {
      await lease.release();
    }
  }

  async #validateGraphqlWrite(context: ApiContext, plan: GitHubGraphqlPlan): Promise<void> {
    const input = plan.input ?? {};
    if (plan.operation === "createPullRequest") {
      this.#assertRefs(context, String(input.headRefName ?? ""), String(input.baseRefName ?? ""));
      await this.#verifyTreeHead(context, String(input.headRefName ?? ""));
      return;
    }
    const record = this.#nodes.get(
      context.request.executionId,
      context.authorization.scopeHash,
      String(input.pullRequestId ?? input.subjectId),
    );
    if (!record?.number) throw new GitPublicationError("scope_denied");
    await this.#assertExistingPull(
      context,
      record.number,
      typeof input.baseRefName === "string" ? input.baseRefName : undefined,
    );
  }

  async #context(
    request: ProviderProxyRequest,
    authorization: RuntimeProxyAuthorization,
    repository: GitHubExecutionRepository,
    token: string,
  ): Promise<ApiContext> {
    await authorization.recheck(request.signal);
    await this.#options.store.recordSource({
      sessionId: authorization.sessionId,
      provider: "github",
      resource: `repository:${repository.repositoryId}`,
      policyRevision: authorization.scopeHash,
      recordedAt: new Date().toISOString(),
    });
    const metadata = await this.#metadata(repository, token, request.signal);
    const context = {
      request,
      authorization,
      repository,
      token,
      metadata,
      recheck: () => authorization.recheck(request.signal),
    };
    await context.recheck();
    if (typeof metadata.node_id === "string") {
      this.#nodes.remember(request.executionId, authorization.scopeHash, metadata.node_id, repository.repositoryId);
      this.#nodes.remember(
        request.executionId,
        authorization.scopeHash,
        `repository-${repository.repositoryId}`,
        metadata.node_id,
      );
    }
    return context;
  }

  #repositoryNodeId(executionId: string, scopeHash: string, repositoryId: string): string {
    return this.#nodes.get(executionId, scopeHash, `repository-${repositoryId}`)?.repositoryId ?? "";
  }

  async #metadata(
    repository: GitHubExecutionRepository,
    token: string,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const response = await this.#api.request({
      token,
      method: "GET",
      path: `/repositories/${repository.repositoryId}`,
      signal,
    });
    const metadata = objectValue(response.value);
    if (
      response.status !== 200 ||
      String(metadata.id) !== repository.repositoryId ||
      typeof metadata.full_name !== "string" ||
      metadata.full_name.toLowerCase() !== repository.fullName.toLowerCase() ||
      typeof metadata.default_branch !== "string"
    )
      throw new GitPublicationError("scope_denied");
    return metadata;
  }

  #assertRefs(context: ApiContext, head: string, base: string): void {
    assertPullRequestRefs({
      repository: context.repository,
      sessionId: context.authorization.sessionId,
      head,
      base,
      defaultBranch: String(context.metadata.default_branch),
    });
  }

  async #assertExistingPull(context: ApiContext, number: number, newBase?: string): Promise<Record<string, unknown>> {
    const response = await this.#api.request({
      token: context.token,
      method: "GET",
      path: `/repos/${context.repository.fullName}/pulls/${number}`,
      signal: context.request.signal,
    });
    const pull = objectValue(response.value);
    const head = objectValue(pull.head),
      base = objectValue(pull.base);
    if (
      response.status !== 200 ||
      String(objectValue(head.repo).id) !== context.repository.repositoryId ||
      String(objectValue(base.repo).id) !== context.repository.repositoryId
    )
      throw new GitPublicationError("scope_denied");
    this.#assertRefs(context, String(head.ref), String(base.ref));
    if (newBase !== undefined) this.#assertRefs(context, String(head.ref), newBase);
    await this.#verifyTreeHead(context, String(head.ref));
    this.#remember(context, pull);
    return pull;
  }

  async #constrainTreeRestRead(context: ApiContext, url: URL): Promise<void> {
    if (context.repository.scopes.some((scope) => scope.role === "code")) return;
    const tree = context.repository.scopes.find((scope) => scope.role === "context_tree");
    const base = tree?.branch?.slice("refs/heads/".length);
    if (!base) throw new GitPublicationError("scope_denied");
    if (url.pathname.endsWith("/pulls")) {
      url.searchParams.set("base", base);
      return;
    }
    const match = /\/(?:pulls|issues)\/([1-9]\d*)(?:\/.*)?$/.exec(url.pathname);
    if (!match) return;
    const response = await this.#api.request({
      token: context.token,
      method: "GET",
      path: `/repos/${context.repository.fullName}/pulls/${match[1]}`,
      signal: context.request.signal,
    });
    if (response.status !== 200 || objectValue(objectValue(response.value).base).ref !== base)
      throw new GitPublicationError("scope_denied");
  }

  async #verifyTreeHead(context: ApiContext, head: string): Promise<void> {
    const ref = `refs/heads/${head}`;
    if (!ref.startsWith(taskBranchPrefix(context.authorization.sessionId, "context_tree"))) return;
    if (!this.#options.treeHeads) throw new GitPublicationError("tree_invalid");
    const sha = await this.#options.treeHeads.verify({
      sessionId: context.authorization.sessionId,
      repositoryId: context.repository.repositoryId,
      policyRevision: context.authorization.scopeHash,
      ref,
      remote: new GitHubPublicationRemote({ fullName: context.repository.fullName, token: context.token }),
      signal: context.request.signal,
      recheck: context.recheck,
    });
    if (context.treeHead && (context.treeHead.ref !== ref || context.treeHead.sha !== sha))
      throw new GitPublicationError("remote_conflict");
    context.treeHead = { ref, sha };
  }

  async #constrainTreeGraphql(context: ApiContext, body: z.infer<typeof GraphqlRequest>) {
    if (context.repository.scopes.some((scope) => scope.role === "code")) return body;
    const branch = context.repository.scopes.find((scope) => scope.role === "context_tree")?.branch;
    if (!branch) throw new GitPublicationError("scope_denied");
    const constrained = constrainTreeGraphql({
      request: body,
      branch,
      taskPrefix: taskBranchPrefix(context.authorization.sessionId, "context_tree"),
    });
    for (const id of constrained.nodeIds) {
      const node = this.#nodes.get(context.request.executionId, context.authorization.scopeHash, id);
      if (!node) throw new GitPublicationError("scope_denied");
      if (node.number) constrained.pullRequestNumbers.push(node.number);
    }
    for (const number of constrained.pullRequestNumbers) {
      const url = new URL(`/repos/${context.repository.fullName}/pulls/${number}`, "https://api.github.com");
      await this.#constrainTreeRestRead(context, url);
    }
    return constrained.request;
  }

  #remember(context: ApiContext, value: unknown): void {
    if (Array.isArray(value)) {
      for (const item of value) this.#remember(context, item);
      return;
    }
    if (!value || typeof value !== "object") return;
    const row = value as Record<string, unknown>;
    const id = row.node_id ?? row.id;
    const number = row.number;
    const pull =
      (typeof row.headRefName === "string" && typeof row.baseRefName === "string") ||
      (typeof row.head === "object" && typeof row.base === "object");
    if (pull && typeof id === "string" && typeof number === "number" && Number.isSafeInteger(number) && number > 0)
      this.#nodes.remember(
        context.request.executionId,
        context.authorization.scopeHash,
        id,
        context.repository.repositoryId,
        number,
      );
    for (const child of Object.values(row)) if (child && typeof child === "object") this.#remember(context, child);
  }

  async #recheckWrittenTree(context: ApiContext, succeeded: boolean): Promise<void> {
    if (succeeded && context.treeHead)
      await this.#verifyTreeHead(context, context.treeHead.ref.slice("refs/heads/".length));
  }

  async #write(
    context: ApiContext,
    method: string,
    path: string,
    body: unknown,
    operation: string,
  ): Promise<ProviderProxyResponse> {
    const operationId = randomUUID();
    const { intentHash } = await this.#options.store.beginWrite({
      sessionId: context.authorization.sessionId,
      executionId: context.request.executionId,
      operationId,
      provider: "github",
      resource: `repository:${context.repository.repositoryId}`,
      operation: `github.${operation}`.toLowerCase(),
      requestHash: createHash("sha256")
        .update(JSON.stringify([method, path, body, context.treeHead ?? null]))
        .digest("hex"),
      policyRevision: context.authorization.scopeHash,
      createdAt: new Date().toISOString(),
    });
    let sent = false;
    let recorded = false;
    try {
      await context.recheck();
      context.request.signal.throwIfAborted();
      sent = true;
      const response = await this.#api.request({
        token: context.token,
        method,
        path,
        body,
        signal: context.request.signal,
      });
      const succeeded = confirmedWriteResponse(path, response.status, response.value);
      await this.#recheckWrittenTree(context, succeeded);
      const rejected = rejectedWriteResponse(response.status);
      await this.#options.store.completeWrite(context.authorization.sessionId, {
        operationId,
        intentHash,
        state: succeeded ? "succeeded" : rejected ? "rejected" : "unknown",
        resultCode: succeeded ? "upstream_confirmed" : "upstream_rejected_or_unknown",
        completedAt: new Date().toISOString(),
      });
      recorded = true;
      await context.recheck();
      this.#remember(context, response.value);
      return {
        status: response.status,
        headers: response.headers,
        body: jsonBody(sanitizeGitHubResponse(response.value, context.token)),
      };
    } catch (error) {
      if (!recorded)
        await this.#options.store.completeWrite(context.authorization.sessionId, {
          operationId,
          intentHash,
          state: sent ? "unknown" : "rejected",
          resultCode: sent ? "write_outcome_unknown" : "authorization_changed",
          completedAt: new Date().toISOString(),
        });
      throw error;
    }
  }
}

function rejectedWriteResponse(status: number): boolean {
  return status >= 400 && status < 500 && status !== 408;
}
function confirmedWriteResponse(path: string, status: number, value: unknown): boolean {
  if (status < 200 || status >= 300 || !value || typeof value !== "object") return false;
  const row = objectValue(value);
  if (path === "/graphql") return !Array.isArray(row.errors) && !!row.data && typeof row.data === "object";
  return typeof row.id === "number" || typeof row.node_id === "string";
}
