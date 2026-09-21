import {
  type GitHubConnectionStatus,
  type GitHubTaskDelegationCandidate,
  githubAgentScopeAllowsTaskDelegation,
  type RuntimeExecutionSource,
} from "@opentag/shared";
import { and, eq, isNull } from "drizzle-orm";
import type { DatabaseClient } from "../../db/client.js";
import { imBindings, imMessageDeliveries, imMessages, sessionMessages, sessions } from "../../db/schema/index.js";
import type { RuntimeProxyAuthorization } from "../../runtime-credentials/credential-broker.js";
import type { RuntimeExecutionRegistry } from "../../runtime-credentials/execution-registry.js";
import type { RuntimeGitHubAdmission } from "../../runtime-credentials/github-admission.js";
import type { RuntimeTaskPolicy, RuntimeTaskPolicyInput } from "../../runtime-credentials/task-policy.js";
import type { GitHubManagementService } from "../github/github-management-service.js";
import type { GitHubExecutionPolicy, GitHubExecutionRepository } from "./execution-policy.js";
import { GitPublicationError } from "./git-packets.js";

interface AdmissionInput {
  accountId: string;
  agentId: string;
  sessionId: string;
  source?: RuntimeExecutionSource;
  signal?: AbortSignal;
}

/** DB-derived sender identities, owner-authored delegation, live UAT admission, and final version fence. */
export class GitHubRuntimePolicy implements RuntimeGitHubAdmission, RuntimeTaskPolicy, GitHubExecutionPolicy {
  constructor(
    readonly options: {
      database: DatabaseClient;
      management: GitHubManagementService;
      execution: Pick<RuntimeExecutionRegistry, "get">;
    },
  ) {}

  async authorize(input: RuntimeTaskPolicyInput): Promise<"permit" | "deny"> {
    if (input.provider !== "github") return input.bindingId === input.sessionBindingId ? "permit" : "deny";
    if (input.purpose !== "execution") return "deny";
    const result = await this.#load(input);
    return result?.connection.id === input.bindingId && result.repositories.length > 0 ? "permit" : "deny";
  }

  async admit(input: AdmissionInput) {
    const result = await this.#load(input);
    if (!result?.repositories.length) return undefined;
    await this.#verify(result.connection, result.repositories, input.signal);
    return {
      connectionId: result.connection.id,
      authorizationVersion: result.connection.authorizationVersion,
      credentialGeneration: result.connection.credentialGeneration,
      bindings: result.repositories.flatMap((repository) =>
        repository.scopes.map((scope) => ({
          repositoryId: repository.repositoryId,
          fullName: repository.fullName,
          role: scope.role,
          access: scope.access,
          // The broker hashes the complete object, including explicit ref, publish mode, and delegation.
          scope,
        })),
      ),
    };
  }

  async resolve(authorization: RuntimeProxyAuthorization, signal: AbortSignal): Promise<GitHubExecutionRepository[]> {
    const execution = this.options.execution.get(authorization.executionId);
    if (
      !execution ||
      execution.accountId !== authorization.accountId ||
      execution.agentId !== authorization.agentId ||
      execution.sessionId !== authorization.sessionId
    )
      throw new GitPublicationError("scope_denied");
    const result = await this.#load({
      accountId: execution.accountId,
      agentId: execution.agentId,
      sessionId: execution.sessionId,
      source: execution.source,
      signal,
    });
    if (
      !result ||
      result.connection.id !== authorization.bindingId ||
      `github:${result.connection.authorizationVersion}` !== authorization.authorizationRevision
    )
      throw new GitPublicationError("scope_denied");
    await this.#verify(result.connection, result.repositories, signal);
    await authorization.recheck(signal);
    return result.repositories;
  }

  async #load(
    input: AdmissionInput,
  ): Promise<{ connection: GitHubConnectionStatus; repositories: GitHubExecutionRepository[] } | undefined> {
    input.signal?.throwIfAborted();
    const candidate = await this.#candidate(input.sessionId, input.source);
    if (!candidate) return undefined;
    const { connection } = await this.options.management.getOverview(input.accountId);
    if (
      !connection ||
      connection.status !== "active" ||
      !connection.accessExpiresAt ||
      Date.parse(connection.accessExpiresAt) <= Date.now()
    )
      return undefined;
    const repositories = connection.bindings.flatMap((binding) => {
      const scopes = binding.agentScopes.filter(
        (scope) => scope.agentId === input.agentId && githubAgentScopeAllowsTaskDelegation(scope, candidate),
      );
      return scopes.length
        ? [
            {
              installationId: binding.installationId,
              repositoryId: binding.repositoryId,
              fullName: binding.fullNameDisplay,
              scopes,
              protectedTreeRefs: [
                ...new Set(
                  binding.agentScopes
                    .filter((scope) => scope.role === "context_tree")
                    .flatMap((scope) => (scope.branch ? [scope.branch] : [])),
                ),
              ],
            },
          ]
        : [];
    });
    return { connection, repositories };
  }

  async #verify(
    connection: GitHubConnectionStatus,
    repositories: GitHubExecutionRepository[],
    signal?: AbortSignal,
  ): Promise<void> {
    for (const repository of repositories) {
      signal?.throwIfAborted();
      const write = repository.scopes.some((scope) => scope.access === "write");
      const pullRequest = repository.scopes.some((scope) => scope.publish === "pull_request");
      const proof = await this.options.management.verifyCurrentRepositoryAdmission({
        connectionId: connection.id,
        installationId: repository.installationId,
        repositoryId: repository.repositoryId,
        access: write ? "write" : "read",
        ...(write ? { publish: pullRequest ? "pull_request" : "direct" } : {}),
      });
      if (proof.authorizationVersion.toString() !== connection.authorizationVersion)
        throw new GitPublicationError("scope_denied");
    }
    const current = (await this.options.management.getOverview(connection.accountId)).connection;
    signal?.throwIfAborted();
    if (
      !current ||
      current.id !== connection.id ||
      current.status !== "active" ||
      current.authorizationVersion !== connection.authorizationVersion
    )
      throw new GitPublicationError("scope_denied");
  }

  async #candidate(
    sessionId: string,
    source?: RuntimeExecutionSource,
  ): Promise<GitHubTaskDelegationCandidate | undefined> {
    if (!source || source.kind === "validation") return undefined;
    if (source.kind === "delivery") {
      const [row] = await this.options.database
        .select({ bindingId: imMessages.imBindingId, senderId: imMessages.authorExternalId })
        .from(imMessageDeliveries)
        .innerJoin(imMessages, eq(imMessages.id, imMessageDeliveries.messageId))
        .where(
          and(
            eq(imMessageDeliveries.id, source.deliveryId),
            eq(imMessageDeliveries.sessionId, sessionId),
            eq(imMessageDeliveries.turnId, source.turnId),
            eq(imMessageDeliveries.state, "accepted"),
            isNull(imMessageDeliveries.reportedAt),
            eq(imMessages.direction, "inbound"),
            eq(imMessages.authorKind, "human"),
          ),
        )
        .limit(1);
      return row ? { imSender: row } : undefined;
    }
    const [row] = await this.options.database
      .select({ sourceAgentId: imBindings.agentId })
      .from(sessionMessages)
      .innerJoin(sessions, eq(sessions.id, sessionMessages.sourceSessionId))
      .innerJoin(imBindings, eq(imBindings.id, sessions.imBindingId))
      .where(
        and(
          eq(sessionMessages.id, source.messageId),
          eq(sessionMessages.targetSessionId, sessionId),
          eq(sessionMessages.lastOutcome, "accepted"),
          isNull(sessions.endedAt),
        ),
      )
      .limit(1);
    return row;
  }
}
