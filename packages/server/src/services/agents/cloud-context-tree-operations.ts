/*
 * Server-side Cloud Context Tree connect for Agents bound to a Cloud Computer, which has no
 * Runtime owner WebSocket. The repository must be one of this Agent's authorized `context_tree`
 * bindings; `VerifiedTreeHead` re-verifies the live remote head with the pinned CLI in a scrubbed
 * environment while admission and fencing versions are rechecked around it. Cloud create is a
 * deliberate `capability_missing` failure; Local Computers keep their own create path. The UAT is
 * used in memory only for one trusted Git transport and never persisted or inherited ambiently.
 */

import {
  type ContextTreeOperationResponse,
  ContextTreeRepositorySchema,
  type GitHubAgentScope,
  type GitHubConnectionStatus,
  type GitHubRepositoryBinding,
} from "@opentag/shared";
import { GITHUB_CONNECTION_ERROR_CODES, GitHubConnectionServiceError } from "../github/errors.js";
import { GITHUB_API_CLIENT_ERROR_CODES, GitHubApiClientError } from "../github/github-api-client.js";
import type { GitHubManagementService } from "../github/github-management-service.js";
import { GitPublicationError } from "../github-proxy/git-packets.js";
import { GitHubPublicationRemote, type PublicationRemote } from "../github-proxy/git-remote.js";
import { GitWorkspace } from "../github-proxy/git-workspace.js";
import { VerifiedTreeHead } from "../github-proxy/verified-tree-head.js";

export interface CloudContextTreeOperationInput {
  accountId: string;
  agentId: string;
  action: "connect" | "create";
  repository: string;
  alias: string;
}

/** The Cloud dispatch surface of the shared ContextTreeOperationService. */
export interface CloudContextTreeOperationRunner {
  computerKind(computerId: string): Promise<"local" | "cloud" | undefined>;
  run(input: CloudContextTreeOperationInput): Promise<ContextTreeOperationResponse>;
}

/** Exactly the GitHub management facade surface Cloud connect uses. Server-internal; never HTTP. */
export type CloudContextTreeGitHubManagement = Pick<
  GitHubManagementService,
  "getOverview" | "getCurrentUserCredential" | "verifyCurrentRepositoryAdmission"
>;

export interface CloudContextTreeOperationsOptions {
  management: CloudContextTreeGitHubManagement;
  /** Exact Computer kind lookup; `undefined` for unknown rows so Cloud is never mistaken for Local. */
  computerKind: (computerId: string) => Promise<"local" | "cloud" | undefined>;
  /** Ephemeral verification root owner; constructed when absent. Closed by `close()`. */
  workspace?: GitWorkspace;
  /** Remote head verifier; constructed over the workspace when absent. */
  treeHeads?: Pick<VerifiedTreeHead, "verify">;
  /** GitHub remote factory; the default authenticates git through GIT_ASKPASS, never argv or URLs. */
  remoteFactory?: (fullName: string, accessToken: string) => PublicationRemote;
  /** Total per-operation budget; an exhausted budget aborts the operation. */
  budgetMs?: number;
  /** Global in-flight bound; excess operations report `busy`. */
  maxConcurrent?: number;
}

type FailureCode = Extract<ContextTreeOperationResponse, { status: "failed" }>["code"];

interface Fencing {
  authorizationVersion: bigint;
  credentialGeneration: bigint;
}

const DEFAULT_BUDGET_MS = 120_000;
const DEFAULT_MAX_CONCURRENT = 8;

/** A deliberate, already-classified operation failure; the code is the public response code. */
class CloudOperationFailure extends Error {
  constructor(readonly code: FailureCode) {
    super(`Cloud Context Tree operation failed: ${code}`);
    this.name = "CloudOperationFailure";
  }
}

function failed(code: FailureCode): ContextTreeOperationResponse {
  return { status: "failed", code };
}

function halt(code: FailureCode): never {
  throw new CloudOperationFailure(code);
}

function connectionFence(connection: GitHubConnectionStatus): Fencing {
  return {
    authorizationVersion: BigInt(connection.authorizationVersion),
    credentialGeneration: BigInt(connection.credentialGeneration),
  };
}

/** A fencing mismatch means the credential or binding state moved mid-operation; never commit. */
function assertFence(observed: Fencing, expected: Fencing): void {
  if (
    observed.authorizationVersion !== expected.authorizationVersion ||
    observed.credentialGeneration !== expected.credentialGeneration
  ) {
    halt("stale_configuration");
  }
}

/** The Agent's authorized Context Tree binding for the requested repository on this connection, when one exists. */
function agentContextTreeBinding(
  connection: GitHubConnectionStatus,
  agentId: string,
  repository: string,
): { binding: GitHubRepositoryBinding; scope: GitHubAgentScope } | undefined {
  const id = agentId.toLowerCase();
  for (const binding of connection.bindings) {
    if (binding.fullNameDisplay.toLowerCase() !== repository.toLowerCase()) continue;
    for (const scope of binding.agentScopes) {
      if (scope.agentId.toLowerCase() === id && scope.role === "context_tree") return { binding, scope };
    }
  }
  return undefined;
}

function parseRepository(raw: string): string {
  const parsed = ContextTreeRepositorySchema.safeParse(raw);
  if (!parsed.success) halt("failed");
  return parsed.data;
}

export class CloudContextTreeOperations implements CloudContextTreeOperationRunner {
  readonly #management: CloudContextTreeGitHubManagement;
  readonly #computerKind: (computerId: string) => Promise<"local" | "cloud" | undefined>;
  readonly #treeHeads: Pick<VerifiedTreeHead, "verify">;
  readonly #remoteFactory: (fullName: string, accessToken: string) => PublicationRemote;
  readonly #budgetMs: number;
  readonly #maxConcurrent: number;
  readonly #workspace: GitWorkspace;
  readonly #inFlight = new Map<string, { identity: string; promise: Promise<ContextTreeOperationResponse> }>();
  readonly #closer = new AbortController();
  #closed = false;

  constructor(options: CloudContextTreeOperationsOptions) {
    this.#management = options.management;
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
   * Runs one connect. `create` fails with `capability_missing` before any work. At most one
   * operation per Agent is in flight; an identical replay joins it and a different one is `busy`.
   */
  run(input: CloudContextTreeOperationInput): Promise<ContextTreeOperationResponse> {
    if (input.action === "create") return Promise.resolve(failed("capability_missing"));
    if (this.#closed) return Promise.resolve(failed("failed"));
    const identity = JSON.stringify([input.accountId, input.alias, input.repository.toLowerCase()]);
    const active = this.#inFlight.get(input.agentId);
    if (active) return active.identity === identity ? active.promise : Promise.resolve(failed("busy"));
    if (this.#inFlight.size >= this.#maxConcurrent) return Promise.resolve(failed("busy"));
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

  async #execute(input: CloudContextTreeOperationInput, signal: AbortSignal): Promise<ContextTreeOperationResponse> {
    try {
      return await this.#connect(input, signal);
    } catch (error) {
      return this.#classify(error, signal);
    }
  }

  /**
   * Binds the Agent's authorized Tree, then verifies the live remote head with the canonical CLI;
   * `recheck` re-proves admission and the fencing versions around the remote read.
   */
  async #connect(input: CloudContextTreeOperationInput, signal: AbortSignal): Promise<ContextTreeOperationResponse> {
    const repository = parseRepository(input.repository);
    const connection = await this.#activeConnection(input.accountId);
    const tree = agentContextTreeBinding(connection, input.agentId, repository);
    if (!tree || tree.binding.fullNameDisplay.toLowerCase() !== repository.toLowerCase()) halt("permission_denied");
    const branch = tree.scope.branch;
    if (branch === undefined) halt("failed");
    const fence = connectionFence(connection);
    const credential = await this.#management.getCurrentUserCredential(connection.id);
    if (!credential || credential.accountId !== input.accountId) halt("authentication_required");
    assertFence(credential, fence);
    const recheck = async () => {
      const observed = await this.#management.verifyCurrentRepositoryAdmission({
        connectionId: connection.id,
        installationId: tree.binding.installationId,
        repositoryId: tree.binding.repositoryId,
        access: tree.scope.access,
        ...(tree.scope.publish !== undefined ? { publish: tree.scope.publish } : {}),
      });
      assertFence(observed, fence);
    };
    signal.throwIfAborted();
    await this.#treeHeads.verify({
      repositoryId: tree.binding.repositoryId,
      ref: branch,
      remote: this.#remoteFactory(repository, credential.accessToken),
      signal,
      recheck,
    });
    await this.#assertFinalFence(
      input.accountId,
      connection.id,
      fence,
      input.agentId,
      tree.binding.repositoryId,
      repository,
    );
    return { status: "completed", repository };
  }

  /** The Account's current active connection; nothing else may authenticate these operations. */
  async #activeConnection(accountId: string): Promise<GitHubConnectionStatus> {
    const { connection } = await this.#management.getOverview(accountId);
    if (!connection || connection.accountId !== accountId || connection.status !== "active") {
      halt("authentication_required");
    }
    return connection;
  }

  /** After remote work, the same active connection and the Agent's exact Tree binding must hold. */
  async #assertFinalFence(
    accountId: string,
    connectionId: string,
    fence: Fencing,
    agentId: string,
    repositoryId: string,
    repository: string,
  ): Promise<void> {
    const connection = await this.#activeConnection(accountId);
    if (connection.id !== connectionId) halt("stale_configuration");
    assertFence(connectionFence(connection), fence);
    const tree = agentContextTreeBinding(connection, agentId, repository);
    if (!tree || tree.binding.repositoryId !== repositoryId) halt("permission_denied");
  }

  #classify(error: unknown, signal: AbortSignal): ContextTreeOperationResponse {
    if (error instanceof CloudOperationFailure) return failed(error.code);
    if (signal.aborted) return failed("failed");
    if (error instanceof GitHubConnectionServiceError) {
      switch (error.code) {
        case GITHUB_CONNECTION_ERROR_CODES.CONNECTION_NOT_FOUND:
        case GITHUB_CONNECTION_ERROR_CODES.CONNECTION_STATE_INVALID:
          return failed("authentication_required");
        case GITHUB_CONNECTION_ERROR_CODES.ADMISSION_PERMISSION_INSUFFICIENT:
        case GITHUB_CONNECTION_ERROR_CODES.ADMISSION_INSTALLATION_MISSING:
        case GITHUB_CONNECTION_ERROR_CODES.ADMISSION_REPOSITORY_MISSING:
          return failed("permission_denied");
        case GITHUB_CONNECTION_ERROR_CODES.AUTHORIZATION_VERSION_CONFLICT:
          return failed("stale_configuration");
        default:
          return failed("failed");
      }
    }
    if (error instanceof GitHubApiClientError) {
      return failed(
        error.code === GITHUB_API_CLIENT_ERROR_CODES.CREDENTIAL_INVALID ? "authentication_required" : "failed",
      );
    }
    if (error instanceof GitPublicationError) {
      if (error.code === "tree_invalid") return failed("invalid_tree");
      if (error.code === "scope_denied") return failed("permission_denied");
      return failed("failed");
    }
    return failed("failed");
  }
}
