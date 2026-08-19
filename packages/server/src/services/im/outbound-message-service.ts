import { createHash } from "node:crypto";
import { ImContentV1Schema, type ProviderWriteResult } from "@opentag/shared";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import type { DatabaseClient, DatabaseTransaction } from "../../db/client.js";
import {
  agents,
  computers,
  feishuIntegrationIdentities,
  imConversations,
  imMessageDeliveries,
  imMessages,
  imOutboundRequests,
  integrationCredentials,
  integrations,
  sessionPlacements,
  sessions,
  slackIntegrationIdentities,
} from "../../db/schema/index.js";
import type { ImProviderAdapter } from "../integrations/index.js";

const OutboundRequestSchema = z
  .object({
    requestId: z.string().uuid(),
    sessionId: z.string().uuid(),
    agentId: z.string().uuid(),
    computerId: z.string().uuid(),
    computerInstanceId: z.string().uuid(),
    placementGeneration: z.number().int().min(1),
    expectedLatestImMessageId: z.string().uuid(),
    operation: z.enum(["send", "reply", "react"]),
    content: ImContentV1Schema.optional(),
    replyToImMessageId: z.string().uuid().optional(),
    targetImMessageId: z.string().uuid().optional(),
    emoji: z.string().min(1).max(128).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.operation === "react") {
      if (!value.targetImMessageId) {
        context.addIssue({ code: "custom", path: ["targetImMessageId"], message: "A reaction target is required" });
      }
      if (!value.emoji) context.addIssue({ code: "custom", path: ["emoji"], message: "A reaction emoji is required" });
      return;
    }
    if (!value.content || value.content.fallbackText.trim().length === 0) {
      context.addIssue({ code: "custom", path: ["content"], message: "Outbound text content is required" });
    }
    if (value.operation === "reply" && !value.replyToImMessageId) {
      context.addIssue({ code: "custom", path: ["replyToImMessageId"], message: "A reply target is required" });
    }
  });

export type OutboundRequest = z.infer<typeof OutboundRequestSchema>;

export interface OutboundResult {
  state: "succeeded" | "deterministic_failed" | "credential_failed" | "transient_failed" | "unknown";
  code?: string;
  providerMessageId?: string;
  retryAfterSeconds?: number;
}

export class OutboundMessageService {
  readonly #database: DatabaseClient;
  readonly #now: () => Date;
  readonly #resolveAdapter: (integrationId: string, generation: number) => Promise<ImProviderAdapter<unknown>>;

  constructor(
    database: DatabaseClient,
    resolveAdapter: (integrationId: string, generation: number) => Promise<ImProviderAdapter<unknown>>,
    options: { now?: () => Date } = {},
  ) {
    this.#database = database;
    this.#resolveAdapter = resolveAdapter;
    this.#now = options.now ?? (() => new Date());
  }

  async execute(rawInput: OutboundRequest): Promise<OutboundResult> {
    const input = OutboundRequestSchema.parse(rawInput);
    const normalizedPayload = JSON.parse(JSON.stringify(input)) as Record<string, unknown>;
    const payloadHash = createHash("sha256").update(JSON.stringify(normalizedPayload)).digest("hex");

    const prepared = await this.#database.transaction(async (transaction) => {
      // Serialize admission before the first read. This makes concurrent
      // callers with the same id converge on one provider write instead of
      // racing into the request_id unique constraint.
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`im-outbound:${input.requestId}`}, 0))`,
      );
      const [existing] = await transaction
        .select()
        .from(imOutboundRequests)
        .where(eq(imOutboundRequests.requestId, input.requestId))
        .limit(1);
      if (existing) {
        if (existing.payloadHash !== payloadHash) throw new Error("OUTBOUND_REQUEST_CONFLICT");
        return { existing } as const;
      }

      const [scope] = await transaction
        .select({
          session: sessions,
          placement: sessionPlacements,
          conversation: imConversations,
          integration: integrations,
          agentId: agents.id,
          credential: integrationCredentials,
          currentInstanceId: computers.currentInstanceId,
        })
        .from(sessions)
        .innerJoin(sessionPlacements, eq(sessionPlacements.sessionId, sessions.id))
        .innerJoin(computers, eq(computers.id, sessionPlacements.computerId))
        .innerJoin(imConversations, eq(imConversations.id, sessions.conversationId))
        .innerJoin(integrations, eq(integrations.id, imConversations.integrationId))
        .innerJoin(agents, eq(agents.id, integrations.agentId))
        .innerJoin(integrationCredentials, eq(integrationCredentials.integrationId, integrations.id))
        .where(
          and(
            eq(sessions.id, input.sessionId),
            isNull(sessions.endedAt),
            isNull(imConversations.detachedAt),
            isNull(integrations.disabledAt),
            isNull(agents.deletedAt),
          ),
        )
        .limit(1)
        .for("update");
      if (!scope || scope.session.kind === "internal") throw new Error("OUTBOUND_SESSION_UNAUTHORIZED");
      if (scope.agentId !== input.agentId) throw new Error("OUTBOUND_SESSION_UNAUTHORIZED");
      if (
        scope.placement.computerId !== input.computerId ||
        scope.placement.generation !== input.placementGeneration ||
        scope.currentInstanceId !== input.computerInstanceId
      ) {
        throw new Error("OUTBOUND_PLACEMENT_STALE");
      }

      const [latest] = await transaction
        .select({ id: imMessages.id })
        .from(imMessages)
        .innerJoin(
          imMessageDeliveries,
          and(
            eq(imMessageDeliveries.messageId, imMessages.id),
            eq(imMessageDeliveries.messageRevision, imMessages.currentRevision),
            eq(imMessageDeliveries.sessionId, scope.session.id),
          ),
        )
        .where(
          and(
            eq(imMessages.conversationId, scope.conversation.id),
            eq(imMessages.direction, "inbound"),
            inArray(imMessageDeliveries.state, ["pending", "accepted"]),
          ),
        )
        .orderBy(desc(imMessages.occurredAt), desc(imMessages.id))
        .limit(1);
      if (!latest || latest.id !== input.expectedLatestImMessageId) throw new Error("OUTBOUND_LATEST_MESSAGE_STALE");

      const targetId = input.operation === "react" ? input.targetImMessageId : input.replyToImMessageId;
      const [target] = targetId
        ? await transaction
            .select({ externalId: imMessages.externalMessageId })
            .from(imMessages)
            .innerJoin(
              imMessageDeliveries,
              and(
                eq(imMessageDeliveries.messageId, imMessages.id),
                eq(imMessageDeliveries.messageRevision, imMessages.currentRevision),
                eq(imMessageDeliveries.sessionId, scope.session.id),
              ),
            )
            .where(
              and(
                eq(imMessages.id, targetId),
                eq(imMessages.conversationId, scope.conversation.id),
                isNull(imMessages.deletedAt),
                inArray(imMessageDeliveries.state, ["pending", "accepted"]),
              ),
            )
            .limit(1)
        : [];
      if (targetId && !target) throw new Error("OUTBOUND_TARGET_INVALID");
      if (input.operation === "react") {
        const requiredScope =
          scope.integration.provider === "slack" ? "reactions:write" : "im:message.reactions:write_only";
        if (!scope.credential.grantedCapabilities.includes(requiredScope)) {
          throw new Error("OUTBOUND_CAPABILITY_MISSING");
        }
      }

      const [request] = await transaction
        .insert(imOutboundRequests)
        .values({
          requestId: input.requestId,
          sessionId: input.sessionId,
          expectedLatestImMessageId: input.expectedLatestImMessageId,
          operation: input.operation,
          payloadHash,
          normalizedPayload,
          state: "prepared",
          createdAt: this.#now(),
        })
        .returning();
      if (!request) throw new Error("Outbound request insert did not return a row");
      return { request, scope, targetExternalId: target?.externalId } as const;
    });

    if ("existing" in prepared && prepared.existing) {
      return prepared.existing.state === "prepared"
        ? this.#awaitExisting(prepared.existing.id)
        : this.#existingResult(prepared.existing);
    }
    const { request, scope, targetExternalId } = prepared;
    let providerResult: ProviderWriteResult;
    try {
      const adapter = await this.#resolveAdapter(scope.integration.id, scope.credential.generation);
      if (input.operation === "react") {
        providerResult = await adapter.react({
          conversationExternalId: scope.conversation.externalId,
          messageExternalId: targetExternalId as string,
          emoji: input.emoji as string,
        });
      } else {
        providerResult = await adapter.send({
          conversationExternalId: scope.conversation.externalId,
          fallbackText: input.content?.fallbackText ?? "",
          threadKey: scope.session.threadKey ?? undefined,
          replyToExternalId: targetExternalId,
        });
      }
    } catch {
      providerResult = { ok: false, category: "unknown", code: "provider_unavailable" };
    }

    const mapped = this.#mapProviderResult(providerResult);
    await this.#database.transaction(async (transaction) => {
      await transaction
        .update(imOutboundRequests)
        .set({
          state: mapped.state,
          providerMessageId: mapped.providerMessageId ?? null,
          resultCode: mapped.code ?? null,
          retryAfterSeconds: mapped.retryAfterSeconds ?? null,
          completedAt: this.#now(),
        })
        .where(and(eq(imOutboundRequests.id, request.id), eq(imOutboundRequests.state, "prepared")));
      if (!providerResult.ok) {
        if (mapped.state === "credential_failed") {
          await transaction
            .update(integrations)
            .set({
              reauthorizationRequired: true,
              lastErrorCode: mapped.code ?? "provider_unknown",
              updatedAt: this.#now(),
            })
            .where(eq(integrations.id, scope.integration.id));
        }
        return;
      }
      const authorExternalId = await this.#botExternalId(transaction, scope.integration.id, scope.integration.provider);
      await transaction
        .insert(imMessages)
        .values({
          conversationId: scope.conversation.id,
          externalMessageId: providerResult.externalMessageId,
          currentRevision: 1,
          currentRevisionKey: `outbound:${input.requestId}`,
          direction: "outbound",
          threadKey: scope.session.threadKey,
          authorKind: "bot",
          authorExternalId,
          content: input.content ?? { version: 1, fallbackText: "", blocks: [], truncated: false },
          occurredAt: providerResult.occurredAt,
        })
        .onConflictDoUpdate({
          target: [imMessages.conversationId, imMessages.externalMessageId],
          set: {
            direction: "outbound",
            authorKind: "bot",
            authorExternalId,
            content: input.content ?? { version: 1, fallbackText: "", blocks: [], truncated: false },
          },
        });
      await transaction
        .update(integrations)
        .set({ lastOutboundAt: this.#now(), updatedAt: this.#now() })
        .where(eq(integrations.id, scope.integration.id));
    });
    return mapped;
  }

  async #botExternalId(
    transaction: DatabaseTransaction,
    integrationId: string,
    provider: "feishu" | "slack",
  ): Promise<string> {
    const [identity] =
      provider === "feishu"
        ? await transaction
            .select({ id: feishuIntegrationIdentities.botOpenId })
            .from(feishuIntegrationIdentities)
            .where(eq(feishuIntegrationIdentities.integrationId, integrationId))
            .limit(1)
        : await transaction
            .select({ id: slackIntegrationIdentities.botUserId })
            .from(slackIntegrationIdentities)
            .where(eq(slackIntegrationIdentities.integrationId, integrationId))
            .limit(1);
    const id = identity?.id;
    if (!id) throw new Error("OUTBOUND_BOT_IDENTITY_MISSING");
    return id;
  }

  #existingResult(row: typeof imOutboundRequests.$inferSelect): OutboundResult {
    if (row.state === "prepared") return { state: "unknown", code: "OUTBOUND_RESULT_UNKNOWN" };
    return {
      state: row.state,
      code: row.resultCode ?? undefined,
      providerMessageId: row.providerMessageId ?? undefined,
      retryAfterSeconds: row.retryAfterSeconds ?? undefined,
    };
  }

  async #awaitExisting(id: string): Promise<OutboundResult> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const [row] = await this.#database
        .select()
        .from(imOutboundRequests)
        .where(eq(imOutboundRequests.id, id))
        .limit(1);
      if (row && row.state !== "prepared") return this.#existingResult(row);
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
    return { state: "unknown", code: "OUTBOUND_RESULT_UNKNOWN" };
  }

  #mapProviderResult(result: ProviderWriteResult): OutboundResult {
    if (result.ok) return { state: "succeeded", providerMessageId: result.externalMessageId };
    const state =
      result.category === "credential"
        ? "credential_failed"
        : result.category === "transient" || result.category === "rate_limited"
          ? "transient_failed"
          : result.category === "unknown"
            ? "unknown"
            : "deterministic_failed";
    return { state, code: boundedProviderCode(result.code), retryAfterSeconds: result.retryAfterSeconds };
  }
}

function boundedProviderCode(code: string): string {
  return PROVIDER_RESULT_CODES.has(code) ? code : "provider_unknown";
}

const PROVIDER_RESULT_CODES = new Set([
  "account_inactive",
  "channel_not_found",
  "feishu_unknown",
  "format_error",
  "invalid_auth",
  "invalid_blocks",
  "missing_scope",
  "not_connected",
  "not_in_channel",
  "permission_denied",
  "provider_unavailable",
  "ratelimited",
  "slack_unknown",
  "ssrf_blocked",
  "target_revoked",
  "token_revoked",
]);
