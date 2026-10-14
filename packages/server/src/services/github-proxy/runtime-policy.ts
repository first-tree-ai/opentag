import { type GitHubConnectionStatus, type RuntimeExecutionSource, RuntimeUserTaskSourceSchema } from "@opentag/shared";
import { and, eq } from "drizzle-orm";
import type { DatabaseClient } from "../../db/client.js";
import {
  agentRuntimeConfigs,
  agents,
  imBindings,
  imMessageDeliveries,
  imMessages,
  sessionMessages,
  sessions,
} from "../../db/schema/index.js";
import type { RuntimeProxyAuthorization } from "../../runtime-credentials/credential-broker.js";
import type { RuntimeExecutionRegistry } from "../../runtime-credentials/execution-registry.js";
import type { RuntimeGitHubAdmission } from "../../runtime-credentials/github-admission.js";
import type { RuntimeTaskPolicy, RuntimeTaskPolicyInput } from "../../runtime-credentials/task-policy.js";
import type { GitHubManagementService } from "../github/github-management-service.js";
import type { GitHubExecutionPolicy, GitHubExecutionRepository, GitHubExecutionTarget } from "./execution-policy.js";
import { GitPublicationError } from "./git-packets.js";

interface AdmissionInput {
  accountId: string;
  agentId: string;
  sessionId: string;
  source?: RuntimeExecutionSource;
  signal?: AbortSignal;
}

/** Account authority belongs to a verifiable user task, never to an Agent repository record. */
export class GitHubRuntimePolicy implements RuntimeGitHubAdmission, RuntimeTaskPolicy, GitHubExecutionPolicy {
  readonly #targets = new Map<string, { repositoryId: string; installationId: string }>();

  forgetExecution(executionId: string): void {
    for (const key of this.#targets.keys()) if (key.startsWith(`${executionId}:`)) this.#targets.delete(key);
  }
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
    return (await this.#load(input))?.id === input.bindingId ? "permit" : "deny";
  }

  async admit(input: AdmissionInput) {
    const connection = await this.#load(input);
    return connection
      ? {
          connectionId: connection.id,
          authorizationVersion: connection.authorizationVersion,
          credentialGeneration: connection.credentialGeneration,
        }
      : undefined;
  }

  async resolve(
    authorization: RuntimeProxyAuthorization,
    signal: AbortSignal,
    target: GitHubExecutionTarget,
  ): Promise<GitHubExecutionRepository[]> {
    const execution = this.options.execution.get(authorization.executionId);
    if (
      !execution ||
      execution.accountId !== authorization.accountId ||
      execution.agentId !== authorization.agentId ||
      execution.sessionId !== authorization.sessionId
    )
      throw new GitPublicationError("scope_denied");
    const connection = await this.#load({ ...execution, signal });
    if (
      !connection ||
      connection.id !== authorization.bindingId ||
      `github:${connection.authorizationVersion}` !== authorization.authorizationRevision
    )
      throw new GitPublicationError("scope_denied");
    const repository = await this.options.management.resolveRepository({
      connectionId: connection.id,
      ...target,
      signal,
    });
    if (repository.authorizationVersion.toString() !== connection.authorizationVersion)
      throw new GitPublicationError("scope_denied");
    this.#pinTarget(authorization.executionId, target.fullName, repository);
    // Tree selections describe working purpose, not admission. Every target still passes live GitHub checks.
    const configs = await this.options.database
      .select({ agentId: agents.id, contextTrees: agentRuntimeConfigs.contextTrees })
      .from(agentRuntimeConfigs)
      .innerJoin(agents, eq(agents.id, agentRuntimeConfigs.agentId))
      .where(eq(agents.createdByUserId, execution.accountId));
    const selected = configs.filter((row) =>
      row.contextTrees.some((tree) => tree.repository.toLowerCase() === repository.fullName.toLowerCase()),
    );
    const tree = selected.some((row) => row.agentId === execution.agentId);
    const branch = `refs/heads/${repository.defaultBranch}`;
    await authorization.recheck(signal);
    const current = (await this.options.management.getOverview(execution.accountId)).connection;
    signal.throwIfAborted();
    if (
      !current ||
      current.id !== connection.id ||
      current.status !== "active" ||
      current.authorizationVersion !== connection.authorizationVersion
    )
      throw new GitPublicationError("scope_denied");
    return [
      {
        recheck: async (checkSignal) => {
          const proof = await this.options.management.resolveRepository({
            connectionId: connection.id,
            ...target,
            signal: checkSignal,
          });
          if (
            proof.defaultBranch !== repository.defaultBranch ||
            proof.repositoryId !== repository.repositoryId ||
            proof.installationId !== repository.installationId ||
            proof.authorizationVersion.toString() !== connection.authorizationVersion
          )
            throw new GitPublicationError("scope_denied");
          await authorization.recheck(checkSignal);
        },
        installationId: repository.installationId,
        repositoryId: repository.repositoryId,
        fullName: repository.fullName,
        scopes: [
          {
            role: tree ? "context_tree" : "code",
            access: target.access,
            publish: tree ? "direct" : "pull_request",
            ...(tree ? { branch } : {}),
          },
        ],
        protectedTreeRefs: selected.length ? [branch] : [],
      },
    ];
  }

  /** Identity pins are consistency facts; each use must still prove live admission. */
  #pinTarget(
    executionId: string,
    fullName: string,
    repository: { repositoryId: string; installationId: string },
  ): void {
    const key = `${executionId}:${fullName.toLowerCase()}`;
    const pinned = this.#targets.get(key);
    if (
      pinned &&
      (pinned.repositoryId !== repository.repositoryId || pinned.installationId !== repository.installationId)
    )
      throw new GitPublicationError("scope_denied");
    if (!pinned && this.#targets.size >= 4096) throw new GitPublicationError("scope_denied");
    this.#targets.set(key, { repositoryId: repository.repositoryId, installationId: repository.installationId });
  }

  async #load(input: AdmissionInput): Promise<GitHubConnectionStatus | undefined> {
    input.signal?.throwIfAborted();
    if (!(await this.#userTask(input.accountId, input.sessionId, input.source, new Set(), input.agentId)))
      return undefined;
    const { connection } = await this.options.management.getOverview(input.accountId);
    return connection?.accountId === input.accountId &&
      connection.status === "active" &&
      connection.accessExpiresAt &&
      Date.parse(connection.accessExpiresAt) > Date.now()
      ? connection
      : undefined;
  }

  /** Follow immutable, Server-recorded collaboration provenance; never infer it from Session text. */
  async #userTask(
    accountId: string,
    sessionId: string,
    source: RuntimeExecutionSource | undefined,
    visited: Set<string>,
    expectedAgentId?: string,
  ): Promise<boolean> {
    if (!source || source.kind === "validation" || visited.size >= 32) return false;
    const key = source.kind === "delivery" ? source.deliveryId : source.messageId;
    if (visited.has(key)) return false;
    visited.add(key);
    if (source.kind === "delivery") {
      const [row] = await this.options.database
        .select({ id: imMessageDeliveries.id })
        .from(imMessageDeliveries)
        .innerJoin(imMessages, eq(imMessages.id, imMessageDeliveries.messageId))
        .innerJoin(sessions, eq(sessions.id, imMessageDeliveries.sessionId))
        .innerJoin(imBindings, eq(imBindings.id, imMessages.imBindingId))
        .innerJoin(agents, eq(agents.id, imBindings.agentId))
        .where(
          and(
            eq(imMessageDeliveries.id, source.deliveryId),
            eq(imMessageDeliveries.sessionId, sessionId),
            eq(imMessageDeliveries.turnId, source.turnId),
            eq(imMessageDeliveries.state, "accepted"),
            eq(sessions.imBindingId, imMessages.imBindingId),
            expectedAgentId ? eq(agents.id, expectedAgentId) : undefined,
            eq(imMessages.direction, "inbound"),
            eq(imMessages.authorKind, "human"),
            eq(agents.createdByUserId, accountId),
          ),
        )
        .limit(1);
      return !!row;
    }
    const [row] = await this.options.database
      .select({
        scheduledOrigin: sessionMessages.scheduledOrigin,
        userTaskSource: sessionMessages.userTaskSource,
        sourceSessionId: sessionMessages.sourceSessionId,
      })
      .from(sessionMessages)
      .innerJoin(sessions, eq(sessions.id, sessionMessages.targetSessionId))
      .innerJoin(imBindings, eq(imBindings.id, sessions.imBindingId))
      .innerJoin(agents, eq(agents.id, imBindings.agentId))
      .where(
        and(
          eq(sessionMessages.id, source.messageId),
          eq(sessionMessages.targetSessionId, sessionId),
          eq(sessionMessages.lastOutcome, "accepted"),
          expectedAgentId ? eq(agents.id, expectedAgentId) : undefined,
          eq(agents.createdByUserId, accountId),
        ),
      )
      .limit(1);
    if (!row) return false;
    // A scheduler origin proves dispatch, not a user request. Its claim-frozen provenance survives
    // schedule edits/deletion; legacy and autonomous schedules without a user root stay denied.
    const provenance = RuntimeUserTaskSourceSchema.safeParse(row.userTaskSource);
    if (!provenance.success) return false;
    if (row.scheduledOrigin ? row.sourceSessionId !== null : row.sourceSessionId !== provenance.data.sessionId)
      return false;
    return this.#userTask(accountId, provenance.data.sessionId, provenance.data.source, visited);
  }
}
