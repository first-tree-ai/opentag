import { createHash } from "node:crypto";
import { ImContentV1Schema, type ProviderWriteResult } from "@opentag/shared";
import { and, desc, eq, isNull, ne, sql } from "drizzle-orm";
import { z } from "zod";
import type { DatabaseClient } from "../../db/client.js";
import {
  agents,
  computers,
  imBindings,
  imMessages,
  imOutboundRequests,
  sessionPlacements,
  sessions,
} from "../../db/schema/index.js";
import { imAttrs, outcomeAttrs, runtimeAttrs, setActiveSpanAttributes, withSpan } from "../../observability/index.js";
import type { ImProviderAdapter } from "../im-bindings/index.js";
import { ProviderAdapterResolutionError } from "../im-bindings/provider-adapter-resolver.js";

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
  readonly #afterAgentLocked?: () => Promise<void>;
  readonly #database: DatabaseClient;
  readonly #now: () => Date;
  readonly #resolveAdapter: (imBindingId: string, generation: number) => Promise<ImProviderAdapter<unknown>>;

  constructor(
    database: DatabaseClient,
    resolveAdapter: (imBindingId: string, generation: number) => Promise<ImProviderAdapter<unknown>>,
    options: { afterAgentLocked?: () => Promise<void>; now?: () => Date } = {},
  ) {
    this.#afterAgentLocked = options.afterAgentLocked;
    this.#database = database;
    this.#resolveAdapter = resolveAdapter;
    this.#now = options.now ?? (() => new Date());
  }

  async execute(rawInput: OutboundRequest): Promise<OutboundResult> {
    const input = OutboundRequestSchema.parse(rawInput);
    return withSpan(
      "im.outbound.execute",
      {
        ...imAttrs({
          messageId: input.targetImMessageId ?? input.replyToImMessageId ?? input.expectedLatestImMessageId,
        }),
        ...runtimeAttrs({
          requestId: input.requestId,
          sessionId: input.sessionId,
          agentId: input.agentId,
          computerId: input.computerId,
          instanceId: input.computerInstanceId,
          placementGeneration: input.placementGeneration,
        }),
        "opentag.im.outbound.operation": input.operation,
      },
      async () => {
        try {
          return await this.#execute(input);
        } catch (error) {
          setActiveSpanAttributes(outcomeAttrs("failed", "IM_OUTBOUND_FAILED"));
          throw error;
        }
      },
    );
  }

  async #execute(input: OutboundRequest): Promise<OutboundResult> {
    const normalizedPayload = stableOutboundIntent(input);
    const payloadHash = createHash("sha256").update(JSON.stringify(normalizedPayload)).digest("hex");

    const prepared = await this.#database.transaction(async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`im-outbound:${input.requestId}`}, 0))`,
      );
      const [activeAgent] = await transaction
        .select({ id: agents.id })
        .from(agents)
        .where(and(eq(agents.id, input.agentId), eq(agents.status, "active")))
        .limit(1)
        .for("update");
      if (!activeAgent) throw new Error("OUTBOUND_AGENT_NOT_ACTIVE");
      const [scope] = await transaction
        .select({
          session: sessions,
          placement: sessionPlacements,
          imBinding: {
            id: imBindings.id,
            provider: imBindings.provider,
            status: imBindings.status,
            credentialGeneration: imBindings.credentialGeneration,
            grantedCapabilities: imBindings.grantedCapabilities,
            externalBotId: imBindings.externalBotId,
          },
          agentId: agents.id,
          currentInstanceId: computers.currentInstanceId,
        })
        .from(sessions)
        .innerJoin(sessionPlacements, eq(sessionPlacements.sessionId, sessions.id))
        .innerJoin(computers, eq(computers.id, sessionPlacements.computerId))
        .innerJoin(imBindings, eq(imBindings.id, sessions.imBindingId))
        .innerJoin(agents, eq(agents.id, imBindings.agentId))
        .where(
          and(
            eq(sessions.id, input.sessionId),
            isNull(sessions.endedAt),
            ne(imBindings.status, "disabled"),
            eq(agents.status, "active"),
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
      const [existing] = await transaction
        .select()
        .from(imOutboundRequests)
        .where(eq(imOutboundRequests.requestId, input.requestId))
        .limit(1);
      if (existing) {
        if (existing.payloadHash !== payloadHash) throw new Error("OUTBOUND_REQUEST_CONFLICT");
        return { existing } as const;
      }
      if (scope.imBinding.status !== "active") throw new Error("OUTBOUND_IM_BINDING_NOT_ACTIVE");

      const [latest] = await transaction
        .select({ id: imMessages.id })
        .from(imMessages)
        .where(
          and(
            eq(imMessages.imBindingId, scope.imBinding.id),
            eq(imMessages.channelId, scope.session.channelId),
            eq(imMessages.direction, "inbound"),
            ...(scope.session.kind === "thread" && scope.session.threadKey
              ? [eq(imMessages.threadKey, scope.session.threadKey)]
              : []),
          ),
        )
        .orderBy(desc(imMessages.occurredAt), desc(imMessages.providerRevisionKey), desc(imMessages.id))
        .limit(1);
      if (!latest || latest.id !== input.expectedLatestImMessageId) throw new Error("OUTBOUND_LATEST_MESSAGE_STALE");

      const targetId = input.operation === "react" ? input.targetImMessageId : input.replyToImMessageId;
      const [target] = targetId
        ? await transaction
            .select({ message: imMessages })
            .from(imMessages)
            .where(
              and(
                eq(imMessages.id, targetId),
                eq(imMessages.imBindingId, scope.imBinding.id),
                eq(imMessages.channelId, scope.session.channelId),
                ...(scope.session.kind === "thread" && scope.session.threadKey
                  ? [eq(imMessages.threadKey, scope.session.threadKey)]
                  : []),
              ),
            )
            .limit(1)
        : [];
      if (targetId && !target) throw new Error("OUTBOUND_TARGET_INVALID");
      if (target) {
        const [currentTarget] = await transaction
          .select({ operation: imMessages.operation })
          .from(imMessages)
          .where(
            and(
              eq(imMessages.imBindingId, target.message.imBindingId),
              eq(imMessages.channelId, target.message.channelId),
              eq(imMessages.externalMessageId, target.message.externalMessageId),
            ),
          )
          .orderBy(desc(imMessages.occurredAt), desc(imMessages.providerRevisionKey), desc(imMessages.id))
          .limit(1);
        if (!currentTarget || currentTarget.operation === "deleted") throw new Error("OUTBOUND_TARGET_INVALID");
      }
      if (input.operation === "react") {
        const requiredScope =
          scope.imBinding.provider === "slack" ? "reactions:write" : "im:message.reactions:write_only";
        if (!scope.imBinding.grantedCapabilities.includes(requiredScope)) {
          throw new Error("OUTBOUND_CAPABILITY_MISSING");
        }
      }

      const [request] = await transaction
        .insert(imOutboundRequests)
        .values({
          requestId: input.requestId,
          sessionId: input.sessionId,
          expectedLatestImMessageId: input.expectedLatestImMessageId,
          admittedCredentialGeneration: scope.imBinding.credentialGeneration,
          operation: input.operation,
          payloadHash,
          normalizedPayload,
          state: "prepared",
          createdAt: this.#now(),
        })
        .returning();
      if (!request) throw new Error("Outbound request insert did not return a row");
      return { request, scope, targetExternalId: target?.message.externalMessageId } as const;
    });

    if ("existing" in prepared && prepared.existing) {
      const existing =
        prepared.existing.state === "prepared"
          ? this.#awaitExisting(prepared.existing.requestId)
          : this.#existingResult(prepared.existing);
      const result = await existing;
      setActiveSpanAttributes(outcomeAttrs(result.state, result.code));
      return result;
    }
    const { request, scope, targetExternalId } = prepared;
    setActiveSpanAttributes(imAttrs({ provider: scope.imBinding.provider, bindingId: scope.imBinding.id }));
    const admission = await this.#database.transaction(async (transaction) => {
      const [agent] = await transaction
        .select({ status: agents.status })
        .from(agents)
        .where(eq(agents.id, input.agentId))
        .limit(1)
        .for("update");
      if (agent?.status !== "active") return { admitted: false } as const;
      await this.#afterAgentLocked?.();
      const adapter = await this.#resolveAdapter(scope.imBinding.id, request.admittedCredentialGeneration).catch(
        (error: unknown) => {
          const code =
            error instanceof ProviderAdapterResolutionError && error.code === "IM_BINDING_GENERATION_STALE"
              ? "generation_stale"
              : "provider_unavailable";
          return { resolutionFailure: { ok: false as const, category: "transient" as const, code } };
        },
      );
      if ("resolutionFailure" in adapter) {
        return { admitted: true, result: Promise.resolve(adapter.resolutionFailure) } as const;
      }
      try {
        const result =
          input.operation === "react"
            ? adapter.react({
                conversationExternalId: scope.session.channelId,
                messageExternalId: targetExternalId as string,
                emoji: input.emoji as string,
              })
            : adapter.send({
                requestId: input.requestId,
                conversationExternalId: scope.session.channelId,
                fallbackText: input.content?.fallbackText ?? "",
                threadKey: scope.session.threadKey ?? undefined,
                replyToExternalId: targetExternalId,
              });
        return { admitted: true, result } as const;
      } catch {
        return {
          admitted: true,
          result: Promise.resolve({ ok: false, category: "unknown", code: "provider_unavailable" } as const),
        } as const;
      }
    });
    if (!admission.admitted) {
      await this.#database
        .update(imOutboundRequests)
        .set({ state: "deterministic_failed", resultCode: "agent_not_active", completedAt: this.#now() })
        .where(and(eq(imOutboundRequests.requestId, request.requestId), eq(imOutboundRequests.state, "prepared")));
      throw new Error("OUTBOUND_AGENT_NOT_ACTIVE");
    }
    const providerResult: ProviderWriteResult = await admission.result.catch(() => ({
      ok: false,
      category: "unknown",
      code: "provider_unavailable",
    }));

    const mapped = this.#mapProviderResult(providerResult);
    await this.#database.transaction(async (transaction) => {
      const [finalized] = await transaction
        .update(imOutboundRequests)
        .set({
          state: mapped.state,
          providerMessageId: mapped.providerMessageId ?? null,
          resultCode: mapped.code ?? null,
          retryAfterSeconds: mapped.retryAfterSeconds ?? null,
          completedAt: this.#now(),
        })
        .where(and(eq(imOutboundRequests.requestId, request.requestId), eq(imOutboundRequests.state, "prepared")))
        .returning({ requestId: imOutboundRequests.requestId });
      if (!finalized) return;
      if (!providerResult.ok) {
        if (mapped.state === "credential_failed") {
          await transaction
            .update(imBindings)
            .set({
              status: "reauthorization_required",
              lastErrorCode: mapped.code ?? "provider_unknown",
              updatedAt: this.#now(),
            })
            .where(
              and(
                eq(imBindings.id, scope.imBinding.id),
                eq(imBindings.status, "active"),
                eq(imBindings.credentialGeneration, request.admittedCredentialGeneration),
              ),
            );
        }
        return;
      }
      if (input.operation === "react") return;
      await transaction.insert(imMessages).values({
        imBindingId: scope.imBinding.id,
        providerEventId: null,
        channelId: scope.session.channelId,
        externalMessageId: providerResult.externalMessageId,
        providerRevisionKey: `outbound:${input.requestId}`,
        operation: "created",
        direction: "outbound",
        threadKey: scope.session.threadKey,
        replyToExternalId: targetExternalId ?? null,
        authorKind: "bot",
        authorExternalId: scope.imBinding.externalBotId ?? "unknown",
        content: input.content as NonNullable<typeof input.content>,
        occurredAt: providerResult.occurredAt,
        receivedAt: this.#now(),
      });
    });
    setActiveSpanAttributes({
      ...imAttrs({
        provider: scope.imBinding.provider,
        bindingId: scope.imBinding.id,
        externalMessageId: providerResult.ok ? providerResult.externalMessageId : undefined,
      }),
      ...outcomeAttrs(mapped.state, mapped.code),
    });
    return mapped;
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

  async #awaitExisting(requestId: string): Promise<OutboundResult> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      const [row] = await this.#database
        .select()
        .from(imOutboundRequests)
        .where(eq(imOutboundRequests.requestId, requestId))
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
  "feishu_api_error",
  "feishu_invalid_request",
  "feishu_invalid_target",
  "feishu_permission_denied",
  "feishu_rate_limited",
  "format_error",
  "generation_stale",
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

function stableOutboundIntent(input: OutboundRequest): Record<string, unknown> {
  return {
    sessionId: input.sessionId,
    agentId: input.agentId,
    expectedLatestImMessageId: input.expectedLatestImMessageId,
    operation: input.operation,
    ...(input.content ? { content: input.content } : {}),
    ...(input.replyToImMessageId ? { replyToImMessageId: input.replyToImMessageId } : {}),
    ...(input.targetImMessageId ? { targetImMessageId: input.targetImMessageId } : {}),
    ...(input.emoji ? { emoji: input.emoji } : {}),
  };
}
