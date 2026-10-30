import { randomUUID } from "node:crypto";
import {
  ContextTreeBranchSchema,
  type ContextTreeOperationResponse,
  ContextTreePathSchema,
  ContextTreeRepositorySchema,
} from "@opentag/shared";
import type { AgentGitHubConnection, AgentGitHubCredentialService } from "../github/agent-github-credential-service.js";
import { AgentGitHubAuthorizationError } from "../github/agent-github-credential-service.js";
import { GITHUB_CONNECTION_ERROR_CODES, GitHubConnectionServiceError } from "../github/errors.js";
import {
  GITHUB_API_CLIENT_ERROR_CODES,
  type GitHubApiClient,
  GitHubApiClientError,
} from "../github/github-api-client.js";
import type { GitHubExecutionCredentials } from "../github-proxy/execution-credentials.js";
import { GitPublicationError } from "../github-proxy/git-packets.js";
import { GitHubPublicationRemote, type PublicationRemote } from "../github-proxy/git-remote.js";
import { GitWorkspace } from "../github-proxy/git-workspace.js";
import { VerifiedTreeHead } from "../github-proxy/verified-tree-head.js";
import type { GitHubMcpAuthorityFence } from "../mcp/github-authorization.js";
import { contextTreeInitialContent } from "./context-tree-initial-content.js";

export interface GitHubContextTreeOperationInput {
  accountId: string;
  agentId: string;
  action: "connect" | "create";
  repository: string;
  path: string;
  ref: string;
}

/** Server-side GitHub operations used by the settings service. */
export interface PreparedContextTreeOperation {
  result: ContextTreeOperationResponse;
  authority?: GitHubMcpAuthorityFence;
}

export interface GitHubContextTreeOperationRunner {
  computerKind(computerId: string): Promise<"local" | "cloud" | undefined>;
  run(input: GitHubContextTreeOperationInput): Promise<PreparedContextTreeOperation>;
}

/** Server-internal credential port for settings; never an HTTP token response. */
export type ContextTreeGitHubManagement = Pick<
  AgentGitHubCredentialService,
  "getOverview" | "resolveRepository" | "getExecutionUserCredential"
>;

export interface GitHubContextTreeOperationsOptions {
  management: ContextTreeGitHubManagement;
  api: Pick<
    GitHubApiClient,
    "createPrivateRepository" | "initializeContextTree" | "getRepository" | "getAuthenticatedUser"
  >;
  credentials: Pick<GitHubExecutionCredentials, "acquire">;
  /** Exact Computer kind lookup; `undefined` for unknown rows so Cloud is never mistaken for Local. */
  computerKind: (computerId: string) => Promise<"local" | "cloud" | undefined>;
  /** Ephemeral verification root owner; constructed when absent. Closed by `close()`. */
  workspace?: GitWorkspace;
  /** Remote head verifier; constructed over the workspace when absent. */
  treeHeads?: Pick<VerifiedTreeHead, "verify">;
  /** GitHub remote factory; the default authenticates git through GIT_ASKPASS, never argv or URLs. */
  remoteFactory?: (fullName: string, accessToken: () => Promise<string>) => PublicationRemote;
  /** Total per-operation budget; an exhausted budget aborts the operation. */
  budgetMs?: number;
  /** Global in-flight bound; excess operations report `busy`. */
  maxConcurrent?: number;
}

type FailureCode = Extract<ContextTreeOperationResponse, { status: "failed" }>["code"];

interface Fencing {
  authorizationVersion: string;
}

const DEFAULT_BUDGET_MS = 120_000;
const DEFAULT_MAX_CONCURRENT = 8;

/** A deliberate, already-classified operation failure; the code is the public response code. */
class GitHubOperationFailure extends Error {
  constructor(readonly code: FailureCode) {
    super(`GitHub Context Tree operation failed: ${code}`);
    this.name = "GitHubOperationFailure";
  }
}

function failed(code: FailureCode): ContextTreeOperationResponse {
  return { status: "failed", code };
}

function halt(code: FailureCode): never {
  throw new GitHubOperationFailure(code);
}

function connectionFence(connection: AgentGitHubConnection): Fencing {
  return {
    authorizationVersion: connection.authorizationVersion,
  };
}

/** A fencing mismatch means the credential or binding state moved mid-operation; never commit. */
function assertFence(observed: Fencing, expected: Fencing): void {
  if (observed.authorizationVersion !== expected.authorizationVersion) {
    halt("stale_configuration");
  }
}

function parseRepository(raw: string): string {
  const parsed = ContextTreeRepositorySchema.safeParse(raw);
  if (!parsed.success) halt("failed");
  return parsed.data;
}

export class GitHubContextTreeOperations implements GitHubContextTreeOperationRunner {
  readonly #credentials: Pick<GitHubExecutionCredentials, "acquire">;
  readonly #management: ContextTreeGitHubManagement;
  readonly #api: GitHubContextTreeOperationsOptions["api"];
  readonly #computerKind: (computerId: string) => Promise<"local" | "cloud" | undefined>;
  readonly #treeHeads: Pick<VerifiedTreeHead, "verify">;
  readonly #remoteFactory: (fullName: string, accessToken: () => Promise<string>) => PublicationRemote;
  readonly #budgetMs: number;
  readonly #maxConcurrent: number;
  readonly #workspace: GitWorkspace;
  readonly #inFlight = new Map<string, { identity: string; promise: Promise<PreparedContextTreeOperation> }>();
  readonly #closer = new AbortController();
  #closed = false;

  constructor(options: GitHubContextTreeOperationsOptions) {
    this.#management = options.management;
    this.#api = options.api;
    this.#credentials = options.credentials;
    this.#computerKind = options.computerKind;
    this.#workspace = options.workspace ?? new GitWorkspace();
    this.#treeHeads = options.treeHeads ?? new VerifiedTreeHead({ workspace: this.#workspace });
    this.#remoteFactory =
      options.remoteFactory ??
      ((fullName, accessToken) => new GitHubPublicationRemote({ fullName, token: accessToken }));
    this.#budgetMs = options.budgetMs ?? DEFAULT_BUDGET_MS;
    this.#maxConcurrent = options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
  }

  computerKind(computerId: string): Promise<"local" | "cloud" | undefined> {
    return this.#computerKind(computerId);
  }

  /**
   * Runs one settings operation. At most one
   * operation per Agent is in flight; an identical replay joins it and a different one is `busy`.
   */
  run(input: GitHubContextTreeOperationInput): Promise<PreparedContextTreeOperation> {
    if (this.#closed) return Promise.resolve({ result: failed("failed") });
    const identity = JSON.stringify([
      input.accountId,
      input.action,
      input.repository.toLowerCase(),
      input.path,
      input.ref,
    ]);
    const active = this.#inFlight.get(input.agentId);
    if (active) return active.identity === identity ? active.promise : Promise.resolve({ result: failed("busy") });
    if (this.#inFlight.size >= this.#maxConcurrent) return Promise.resolve({ result: failed("busy") });
    const signal = AbortSignal.any([this.#closer.signal, AbortSignal.timeout(this.#budgetMs)]);
    const promise = this.#execute(input, signal).finally(() => {
      if (this.#inFlight.get(input.agentId)?.promise === promise) this.#inFlight.delete(input.agentId);
    });
    this.#inFlight.set(input.agentId, { identity, promise });
    return promise;
  }

  /** Aborts in-flight operations and removes the ephemeral verification root. Idempotent. */
  async close(): Promise<void> {
    this.#closed = true;
    this.#closer.abort();
    await Promise.allSettled([...this.#inFlight.values()].map((entry) => entry.promise));
    await this.#workspace.close();
  }

  async #execute(input: GitHubContextTreeOperationInput, signal: AbortSignal): Promise<PreparedContextTreeOperation> {
    try {
      const connection = await this.#activeConnection(input.accountId, input.agentId);
      const result =
        input.action === "create"
          ? await this.#create(input, signal, connection)
          : await this.#connect(input, signal, connection);
      return { result, ...(connection.fence ? { authority: connection.fence } : {}) };
    } catch (error) {
      return { result: this.#classify(error, signal) };
    }
  }

  async #create(
    input: GitHubContextTreeOperationInput,
    signal: AbortSignal,
    connection: AgentGitHubConnection,
  ): Promise<ContextTreeOperationResponse> {
    const api = this.#api;
    if (input.path !== "." || input.ref !== "HEAD") halt("invalid_tree");
    const repository = parseRepository(input.repository);
    if (connection.readOnly) halt("permission_denied");
    const fence = connectionFence(connection);
    const credential = async () => {
      await this.#assertFinalFence(input.accountId, input.agentId, connection.id, fence);
      const current = await this.#management.getExecutionUserCredential({
        accountId: input.accountId,
        agentId: input.agentId,
        connectionId: connection.id,
        authorizationRevision: `github:${connection.authorizationVersion}`,
      });
      if (!current) halt("authentication_required");

      signal.throwIfAborted();
      return current.accessToken;
    };
    const content = await contextTreeInitialContent(this.#workspace, signal, repository.split("/")[1] as string);
    const user = await api.getAuthenticatedUser({
      accessToken: await credential(),
      signal,
      requireRepositoryScope: false,
    });
    const accessToken = await credential();
    let created = false;
    try {
      await api.createPrivateRepository({
        accessToken,
        fullName: repository,
        githubLogin: user.login,
        signal,
      });
      created = true;
      await api.initializeContextTree({ accessToken: await credential(), fullName: repository, content, signal });
      const target = await api.getRepository({ accessToken: await credential(), fullName: repository, signal });
      if (!target.private || target.fullName.toLowerCase() !== repository.toLowerCase() || !target.defaultBranch)
        halt("publication_uncertain");
      await this.#assertFinalFence(input.accountId, input.agentId, connection.id, fence);
      return { status: "completed", repository, ref: ContextTreeBranchSchema.parse(target.defaultBranch) };
    } catch (error) {
      // Never retry a write automatically or adopt an existing repository after an uncertain reply.
      if (created || !(error instanceof GitHubApiClientError) || !error.status || error.status >= 500)
        halt("publication_uncertain");
      if (error.status === 422) halt("repository_rejected");
      throw error;
    }
  }

  /**
   * Resolves the requested working target, then verifies the live remote head with the canonical CLI;
   * `recheck` re-proves admission and the fencing versions around the remote read.
   */
  async #connect(
    input: GitHubContextTreeOperationInput,
    signal: AbortSignal,
    connection: AgentGitHubConnection,
  ): Promise<ContextTreeOperationResponse> {
    const repository = parseRepository(input.repository);
    const target = await this.#management.resolveRepository({
      accountId: input.accountId,
      agentId: input.agentId,
      connectionId: connection.id,
      expectedAuthorizationVersion: connection.authorizationVersion,
      fullName: repository,
      access: "read",
      signal,
    });
    const ref = ContextTreeBranchSchema.parse(input.ref === "HEAD" ? target.defaultBranch : input.ref);
    const branch = `refs/heads/${ref}`;
    const path = ContextTreePathSchema.parse(input.path);
    const fence = connectionFence(connection);
    assertFence(target, fence);
    const recheck = async () => {
      const observed = await this.#management.resolveRepository({
        accountId: input.accountId,
        agentId: input.agentId,
        connectionId: connection.id,
        expectedAuthorizationVersion: connection.authorizationVersion,
        fullName: repository,
        access: "read",
        signal,
      });
      assertFence(observed, fence);
      if (
        observed.repositoryId !== target.repositoryId ||
        (input.ref === "HEAD" && observed.defaultBranch !== target.defaultBranch)
      )
        halt("stale_configuration");
    };
    signal.throwIfAborted();
    const token = async () => {
      const lease = await this.#credentials.acquire(randomUUID(), {
        accountId: input.accountId,
        agentId: input.agentId,
        connectionId: connection.id,
        authorizationRevision: `github:${connection.authorizationVersion}`,
        signal,
      });
      try {
        return lease.token;
      } finally {
        await lease.release();
      }
    };
    await this.#treeHeads.verify({
      repositoryId: target.repositoryId,
      ref: branch,
      path,
      remote: this.#remoteFactory(repository, token),
      signal,
      recheck,
    });
    await recheck();
    await this.#assertFinalFence(input.accountId, input.agentId, connection.id, fence);
    return { status: "completed", repository, ...(input.ref === "HEAD" ? { ref } : {}) };
  }

  /** The current Agent's active GitHub MCP connection. */
  async #activeConnection(accountId: string, agentId: string): Promise<AgentGitHubConnection> {
    const { connection } = await this.#management.getOverview(accountId, agentId);
    if (!connection || connection.accountId !== accountId) {
      halt("authentication_required");
    }
    return connection;
  }

  /** After remote work, the same active connection and fencing versions must hold. */
  async #assertFinalFence(accountId: string, agentId: string, connectionId: string, fence: Fencing): Promise<void> {
    const connection = await this.#activeConnection(accountId, agentId);
    if (connection.id !== connectionId) halt("stale_configuration");
    assertFence(connectionFence(connection), fence);
  }

  #classify(error: unknown, signal: AbortSignal): ContextTreeOperationResponse {
    if (error instanceof AgentGitHubAuthorizationError) return failed(error.code);
    if (error instanceof GitHubOperationFailure) return failed(error.code);
    if (signal.aborted) return failed("failed");
    if (error instanceof GitHubConnectionServiceError) {
      switch (error.code) {
        case GITHUB_CONNECTION_ERROR_CODES.CONNECTION_NOT_FOUND:
        case GITHUB_CONNECTION_ERROR_CODES.CONNECTION_STATE_INVALID:
          return failed("authentication_required");
        case GITHUB_CONNECTION_ERROR_CODES.ADMISSION_PERMISSION_INSUFFICIENT:
        case GITHUB_CONNECTION_ERROR_CODES.ADMISSION_REPOSITORY_MISSING:
          return failed("permission_denied");
        case GITHUB_CONNECTION_ERROR_CODES.AUTHORIZATION_VERSION_CONFLICT:
          return failed("stale_configuration");
        default:
          return failed("failed");
      }
    }
    if (error instanceof GitHubApiClientError) {
      return failed(gitHubApiFailureCode(error));
    }
    if (error instanceof GitPublicationError) {
      if (error.code === "tree_invalid") return failed("invalid_tree");
      if (error.code === "scope_denied") return failed("permission_denied");
      return failed("failed");
    }
    return failed("failed");
  }
}

function gitHubApiFailureCode(error: GitHubApiClientError): FailureCode {
  if (error.code === GITHUB_API_CLIENT_ERROR_CODES.CREDENTIAL_INVALID) return "authentication_required";
  if (error.code === GITHUB_API_CLIENT_ERROR_CODES.RATE_LIMITED) return "failed";
  return [403, 404].includes(error.status ?? 0) ? "permission_denied" : "failed";
}
