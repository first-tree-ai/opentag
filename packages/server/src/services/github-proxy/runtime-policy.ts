import { type GitHubConnectionStatus, type RuntimeExecutionSource, RuntimeUserTaskSourceSchema } from "@opentag/shared";
import { and, eq } from "drizzle-orm";
import type { DatabaseClient } from "../../db/client.js";
import {
  agents,
  imBindings,
  imMessageDeliveries,
  imMessages,
  sessionMessages,
  sessions,
} from "../../db/schema/index.js";
import type { RuntimeGitHubAdmission } from "../../runtime-credentials/github-admission.js";
import type { RuntimeTaskPolicy, RuntimeTaskPolicyInput } from "../../runtime-credentials/task-policy.js";
import type { GitHubManagementService } from "../github/github-management-service.js";

interface AdmissionInput {
  accountId: string;
  agentId: string;
  sessionId: string;
  source?: RuntimeExecutionSource;
  signal?: AbortSignal;
}

/** Account authority belongs to a verifiable user task, never to an Agent repository record. */
export class GitHubRuntimePolicy implements RuntimeGitHubAdmission, RuntimeTaskPolicy {
  constructor(
    readonly options: {
      database: DatabaseClient;
      management: GitHubManagementService;
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
