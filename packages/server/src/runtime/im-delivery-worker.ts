import { randomUUID } from "node:crypto";
import {
  type DirectImMessageDeliveryRequest,
  type EffectiveRuntimeSnapshot,
  OPENTAG_MESSAGE_TOOLS,
  RUNTIME_DIRECT_TEXT_MAX_BYTES,
  RUNTIME_IM_HISTORY_MAX_BYTES,
  RUNTIME_MAX_FRAME_BYTES,
  runtimeFrameByteLength,
} from "@opentag/shared";
import { and, asc, desc, eq, isNull, lte, sql } from "drizzle-orm";
import type { DatabaseClient } from "../db/client.js";
import {
  agents,
  computers,
  imConversations,
  imMessageDeliveries,
  imMessageResources,
  imMessages,
  integrations,
  sessionPlacements,
  sessions,
} from "../db/schema/index.js";
import type { ConnectionRegistry } from "./connection-registry.js";
import type { RuntimeDomainOwner } from "./runtime-domain-owner.js";

const DEFAULT_INTERVAL_MS = 500;
const RETRY_DELAY_MS = 2_000;

export class ImDeliveryWorker {
  readonly #database: DatabaseClient;
  readonly #domain: RuntimeDomainOwner;
  readonly #registry: ConnectionRegistry;
  readonly #intervalMs: number;
  readonly #onDiagnostic: (code: string) => void;
  #timer?: ReturnType<typeof setInterval>;
  #running = false;

  constructor(input: {
    database: DatabaseClient;
    domain: RuntimeDomainOwner;
    registry: ConnectionRegistry;
    intervalMs?: number;
    onDiagnostic?: (code: string) => void;
  }) {
    this.#database = input.database;
    this.#domain = input.domain;
    this.#registry = input.registry;
    this.#intervalMs = input.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.#onDiagnostic = input.onDiagnostic ?? (() => undefined);
  }

  start(): void {
    if (this.#timer) return;
    this.#schedule();
    this.#timer = setInterval(() => this.#schedule(), this.#intervalMs);
    this.#timer.unref();
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  async runOnce(): Promise<void> {
    if (this.#running) return;
    this.#running = true;
    try {
      const claimed = await this.#claim();
      if (claimed) {
        if (claimed.kind === "pending") await this.#deliver(claimed.id);
        else await this.#recover(claimed.id);
      }
    } finally {
      this.#running = false;
    }
  }

  #schedule(): void {
    void this.runOnce().catch(() => this.#onDiagnostic("IM_DELIVERY_WORKER_SCHEDULING_FAILED"));
  }

  async #claim(): Promise<{ id: string; kind: "pending" | "recovery" } | undefined> {
    return this.#database.transaction(async (transaction) => {
      const now = new Date();
      await transaction
        .update(imMessageDeliveries)
        .set({ state: "expired", reason: "ttl" })
        .where(and(eq(imMessageDeliveries.state, "pending"), lte(imMessageDeliveries.expiresAt, now)));
      const [row] = await transaction
        .select({ id: imMessageDeliveries.id, generation: sessionPlacements.generation })
        .from(imMessageDeliveries)
        .innerJoin(sessionPlacements, eq(sessionPlacements.sessionId, imMessageDeliveries.sessionId))
        .where(
          and(
            eq(imMessageDeliveries.state, "pending"),
            lte(imMessageDeliveries.nextAttemptAt, now),
            sql`${imMessageDeliveries.expiresAt} > now()`,
          ),
        )
        .orderBy(asc(imMessageDeliveries.nextAttemptAt), asc(imMessageDeliveries.id))
        .limit(1)
        .for("update", { skipLocked: true });
      if (row) {
        await transaction
          .update(imMessageDeliveries)
          .set({
            attemptCount: sql`${imMessageDeliveries.attemptCount} + 1`,
            placementGeneration: row.generation,
            nextAttemptAt: new Date(now.getTime() + RETRY_DELAY_MS),
            lastErrorCode: null,
          })
          .where(and(eq(imMessageDeliveries.id, row.id), eq(imMessageDeliveries.state, "pending")));
        return { id: row.id, kind: "pending" as const };
      }
      const [recovery] = await transaction
        .select({ id: imMessageDeliveries.id })
        .from(imMessageDeliveries)
        .where(
          and(
            eq(imMessageDeliveries.state, "accepted"),
            isNull(imMessageDeliveries.reportedAt),
            lte(imMessageDeliveries.nextAttemptAt, now),
          ),
        )
        .orderBy(asc(imMessageDeliveries.nextAttemptAt), asc(imMessageDeliveries.id))
        .limit(1)
        .for("update", { skipLocked: true });
      if (!recovery) return undefined;
      await transaction
        .update(imMessageDeliveries)
        .set({
          attemptCount: sql`${imMessageDeliveries.attemptCount} + 1`,
          nextAttemptAt: new Date(now.getTime() + RETRY_DELAY_MS),
          lastErrorCode: null,
        })
        .where(eq(imMessageDeliveries.id, recovery.id));
      return { id: recovery.id, kind: "recovery" as const };
    });
  }

  async #deliver(deliveryId: string): Promise<void> {
    const [row] = await this.#database
      .select({
        delivery: imMessageDeliveries,
        message: imMessages,
        session: sessions,
        placement: sessionPlacements,
        conversation: imConversations,
        integration: integrations,
        agent: agents,
        computer: computers,
      })
      .from(imMessageDeliveries)
      .innerJoin(imMessages, eq(imMessages.id, imMessageDeliveries.messageId))
      .innerJoin(sessions, eq(sessions.id, imMessageDeliveries.sessionId))
      .innerJoin(sessionPlacements, eq(sessionPlacements.sessionId, sessions.id))
      .innerJoin(imConversations, eq(imConversations.id, sessions.conversationId))
      .innerJoin(integrations, eq(integrations.id, imConversations.integrationId))
      .innerJoin(agents, eq(agents.id, integrations.agentId))
      .innerJoin(computers, eq(computers.id, sessionPlacements.computerId))
      .where(
        and(
          eq(imMessageDeliveries.id, deliveryId),
          eq(imMessageDeliveries.state, "pending"),
          isNull(sessions.endedAt),
          isNull(imConversations.detachedAt),
          isNull(integrations.disabledAt),
          isNull(agents.deletedAt),
        ),
      )
      .limit(1);
    if (!row) return;
    if (row.delivery.placementGeneration !== row.placement.generation) {
      await this.#recordFailure(deliveryId, "IM_DELIVERY_PLACEMENT_STALE");
      return;
    }
    const instanceId = this.#registry.currentInstanceId(row.placement.computerId);
    if (!instanceId || row.computer.currentInstanceId !== instanceId) {
      await this.#recordFailure(deliveryId, "IM_DELIVERY_RUNTIME_UNAVAILABLE");
      return;
    }
    if (row.agent.runtimeProvider !== "codex") {
      await this.#reject(deliveryId, "configuration_unsupported");
      return;
    }
    const runtime = runtimeSnapshot(row.agent.id, row.agent.revision, row.session.id, row.session.revision);
    try {
      const reconcile = await this.#domain.requestReconcile(row.placement.computerId, instanceId, {
        type: "session:reconcile",
        requestId: randomUUID(),
        computerId: row.placement.computerId,
        sessionId: row.session.id,
        agentId: row.agent.id,
        placementGeneration: row.placement.generation,
        desired: "ready",
        runtime,
      });
      if (reconcile.status !== "ready") {
        await this.#recordFailure(deliveryId, "IM_DELIVERY_RECONCILE_NOT_READY");
        return;
      }
      const resources = await this.#database
        .select()
        .from(imMessageResources)
        .where(
          and(
            eq(imMessageResources.messageId, row.message.id),
            eq(imMessageResources.messageRevision, row.delivery.messageRevision),
          ),
        )
        .orderBy(asc(imMessageResources.ordinal));
      const history =
        row.agent.receiveMode === "mention_only" && row.delivery.attention === "direct"
          ? await this.#history(row.session.id, row.message.occurredAt, row.message.id)
          : { items: [], truncated: false };
      const request: DirectImMessageDeliveryRequest = {
        type: "im:deliver",
        requestId: randomUUID(),
        deliveryId: row.delivery.id,
        imMessageId: row.message.id,
        imMessageRevision: row.delivery.messageRevision,
        sessionId: row.session.id,
        agentId: row.agent.id,
        placementGeneration: row.placement.generation,
        attention: row.delivery.attention,
        content: {
          kind: "text",
          text: truncateUtf8(
            row.message.deletedAt ? "[deleted]" : row.message.content.fallbackText,
            RUNTIME_DIRECT_TEXT_MAX_BYTES,
          ),
          ...(history.items.length > 0 ? { history: history.items, historyTruncated: history.truncated } : {}),
          ...(resources.length > 0
            ? {
                resources: resources.map((resource) => ({
                  resourceId: resource.id,
                  kind: resource.kind,
                  ...(resource.filename ? { filename: resource.filename } : {}),
                  ...(resource.mediaType ? { mediaType: resource.mediaType } : {}),
                  ...(resource.sizeBytes !== null ? { sizeBytes: resource.sizeBytes } : {}),
                  availability: resource.availability,
                })),
              }
            : {}),
        },
        runtime,
        deadlineAt: row.delivery.expiresAt.toISOString(),
      };
      fitDeliveryFrame(request);
      const result = await this.#domain.requestDelivery(row.placement.computerId, instanceId, request);
      if (
        result.status === "rejected" &&
        ["configuration_unsupported", "invalid_input"].includes(result.reason ?? "")
      ) {
        await this.#reject(deliveryId, result.reason ?? "terminal_rejected");
      } else if (result.status === "rejected") {
        await this.#recordFailure(deliveryId, "IM_DELIVERY_RUNTIME_REJECTED");
      }
    } catch {
      await this.#recordFailure(deliveryId, "IM_DELIVERY_RUNTIME_FAILED");
    }
  }

  async #recover(deliveryId: string): Promise<void> {
    const [row] = await this.#database
      .select({
        delivery: imMessageDeliveries,
        session: sessions,
        placement: sessionPlacements,
        conversation: imConversations,
        integration: integrations,
        agent: agents,
        computer: computers,
      })
      .from(imMessageDeliveries)
      .innerJoin(sessions, eq(sessions.id, imMessageDeliveries.sessionId))
      .innerJoin(sessionPlacements, eq(sessionPlacements.sessionId, sessions.id))
      .innerJoin(imConversations, eq(imConversations.id, sessions.conversationId))
      .innerJoin(integrations, eq(integrations.id, imConversations.integrationId))
      .innerJoin(agents, eq(agents.id, integrations.agentId))
      .innerJoin(computers, eq(computers.id, sessionPlacements.computerId))
      .where(
        and(
          eq(imMessageDeliveries.id, deliveryId),
          eq(imMessageDeliveries.state, "accepted"),
          isNull(imMessageDeliveries.reportedAt),
          isNull(sessions.endedAt),
          isNull(imConversations.detachedAt),
          isNull(integrations.disabledAt),
          isNull(agents.deletedAt),
        ),
      )
      .limit(1);
    if (!row) return;
    if (row.delivery.placementGeneration !== row.placement.generation) {
      await this.#recordFailure(deliveryId, "IM_DELIVERY_PLACEMENT_STALE");
      return;
    }
    const instanceId = this.#registry.currentInstanceId(row.placement.computerId);
    if (!instanceId || row.computer.currentInstanceId !== instanceId) {
      await this.#recordFailure(deliveryId, "IM_DELIVERY_RUNTIME_UNAVAILABLE");
      return;
    }
    try {
      await this.#domain.requestReconcile(row.placement.computerId, instanceId, {
        type: "session:reconcile",
        requestId: randomUUID(),
        computerId: row.placement.computerId,
        sessionId: row.session.id,
        agentId: row.agent.id,
        placementGeneration: row.placement.generation,
        desired: "ready",
        runtime: runtimeSnapshot(row.agent.id, row.agent.revision, row.session.id, row.session.revision),
      });
    } catch {
      await this.#recordFailure(deliveryId, "IM_DELIVERY_RECOVERY_FAILED");
    }
  }

  async #recordFailure(deliveryId: string, code: string): Promise<void> {
    const bounded = /^IM_DELIVERY_[A-Z0-9_]{1,100}$/.test(code) ? code : "IM_DELIVERY_FAILED";
    await this.#database
      .update(imMessageDeliveries)
      .set({ lastErrorCode: bounded })
      .where(
        and(
          eq(imMessageDeliveries.id, deliveryId),
          sql`${imMessageDeliveries.state} in ('pending', 'accepted')`,
        ),
      );
    this.#onDiagnostic(bounded);
  }

  async #reject(deliveryId: string, reason: string): Promise<void> {
    await this.#database
      .update(imMessageDeliveries)
      .set({ state: "terminal_rejected", reason: reason.slice(0, 120), lastErrorCode: "IM_DELIVERY_TERMINAL" })
      .where(and(eq(imMessageDeliveries.id, deliveryId), eq(imMessageDeliveries.state, "pending")));
  }

  async #history(
    sessionId: string,
    occurredAt: Date,
    messageId: string,
  ): Promise<{
    items: Array<{ imMessageId: string; occurredAt: string; text: string }>;
    truncated: boolean;
  }> {
    const rows = await this.#database
      .select({ id: imMessages.id, occurredAt: imMessages.occurredAt, content: imMessages.content })
      .from(imMessageDeliveries)
      .innerJoin(imMessages, eq(imMessages.id, imMessageDeliveries.messageId))
      .where(
        and(
          eq(imMessageDeliveries.sessionId, sessionId),
          eq(imMessageDeliveries.state, "accepted"),
          sql`(${imMessages.occurredAt}, ${imMessages.id}) < (${occurredAt}, ${messageId})`,
        ),
      )
      .orderBy(desc(imMessages.occurredAt), desc(imMessages.id))
      .limit(101);
    const selected = rows.slice(0, 100);
    const items: Array<{ imMessageId: string; occurredAt: string; text: string }> = [];
    let bytes = 2;
    let truncated = rows.length > selected.length;
    for (const row of selected) {
      const item = {
        imMessageId: row.id,
        occurredAt: row.occurredAt.toISOString(),
        text: truncateUtf8(row.content.fallbackText, RUNTIME_DIRECT_TEXT_MAX_BYTES),
      };
      const itemBytes = Buffer.byteLength(JSON.stringify(item), "utf8") + (items.length > 0 ? 1 : 0);
      if (bytes + itemBytes > RUNTIME_IM_HISTORY_MAX_BYTES) {
        truncated = true;
        break;
      }
      items.push(item);
      bytes += itemBytes;
    }
    return { items: items.reverse(), truncated };
  }
}

function runtimeSnapshot(
  agentId: string,
  agentRevision: number,
  sessionId: string,
  sessionRevision: number,
): EffectiveRuntimeSnapshot {
  return {
    revision: {
      agent: { sequence: agentRevision, id: agentId },
      session: { sequence: sessionRevision, id: sessionId },
    },
    agentId,
    provider: "codex",
    instructions: {
      platform:
        "You run inside OpenTag. IM output is never sent automatically. Use an opentag_message_* tool only when you intend to write to the current IM conversation.",
      agent: "Act as the configured OpenTag Agent and follow the managed workspace instructions.",
    },
    allowedTools: [...OPENTAG_MESSAGE_TOOLS],
    execution: { approvalPolicy: "never", networkAccess: false },
    workspace: { workspaceId: agentId, mode: "empty_on_create", sharing: "agent" },
  };
}

function truncateUtf8(value: string, maxBytes: number): string {
  const encoded = Buffer.from(value, "utf8");
  return encoded.byteLength <= maxBytes ? value : encoded.subarray(0, maxBytes).toString("utf8");
}

function fitDeliveryFrame(request: DirectImMessageDeliveryRequest): void {
  const fits = () => runtimeFrameByteLength(JSON.stringify(request)) <= RUNTIME_MAX_FRAME_BYTES;
  while (!fits() && request.content.history && request.content.history.length > 0) {
    request.content.history.shift();
    request.content.historyTruncated = true;
  }
  while (!fits() && request.content.resources && request.content.resources.length > 0) {
    request.content.resources.pop();
  }
  if (!fits()) throw new Error("IM_DELIVERY_FRAME_TOO_LARGE");
}
