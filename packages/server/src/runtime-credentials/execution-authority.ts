import type { RuntimeCredentialProvider, RuntimeExecutionSource } from "@opentag/shared";
import { and, eq, inArray } from "drizzle-orm";
import type { DatabaseClient } from "../db/client.js";
import {
  computers,
  imBindings,
  imMessageDeliveries,
  runtimeDurableWork,
  sandboxes,
  sessionMessages,
  sessionPlacements,
  sessions,
} from "../db/schema/index.js";
import type { RuntimeCustodyStore } from "../runtime/runtime-custody-store.js";
import { parseCloudSessionWorkEnvelope } from "../runtime/runtime-durable-work-store.js";
import type { RuntimeValidationRun, RuntimeValidationRunRegistry } from "./validation-runs.js";

export type RuntimeExecutionAuthorityDecision =
  | { status: "authorized"; validation?: RuntimeValidationRun }
  | { status: "not_ready" }
  | { status: "invalid" };

/**
 * Re-checked on every acquire/renew/data request: accepted custody is a live guarantee, not a
 * one-time admission. Terminal delivery states (steered/expired/terminal_rejected) invalidate an
 * open execution immediately, and a released Session message stops authorizing.
 */
export type RuntimeExecutionRevalidation = "valid" | "invalid" | "not_ready";

/** Non-terminal durable statuses: each one still carries accepted Cloud execution authority. */
const UNSETTLED_DURABLE_STATUSES = new Set<string>(["accepted", "running", "retryable"]);

export interface RuntimeExecutionAuthorityContext {
  sessionId: string;
  agentId: string;
  computerId: string;
  instanceId: string;
  placementGeneration: number;
}

/**
 * Accept authority for opening an execution. The Server never invents admission: a delivery must be
 * accepted runtime custody, a Session message must be a recorded accepted collaboration message,
 * and validation requires a current Server-issued validation run. An agent trace or a bare turnId
 * is never admission.
 */
export interface RuntimeExecutionAuthority {
  authorize(
    source: RuntimeExecutionSource,
    context: RuntimeExecutionAuthorityContext,
  ): Promise<RuntimeExecutionAuthorityDecision>;
  /** Live re-check of the execution's admission source for every subsequent request. */
  revalidate(
    source: RuntimeExecutionSource,
    context: { sessionId: string; agentId: string; computerId: string; instanceId: string },
  ): Promise<RuntimeExecutionRevalidation>;
}

export class PostgresRuntimeExecutionAuthority implements RuntimeExecutionAuthority {
  readonly #database: DatabaseClient;
  readonly #custody: RuntimeCustodyStore;
  readonly #validationRuns: RuntimeValidationRunRegistry;

  constructor(options: {
    database: DatabaseClient;
    custody: RuntimeCustodyStore;
    validationRuns: RuntimeValidationRunRegistry;
  }) {
    this.#database = options.database;
    this.#custody = options.custody;
    this.#validationRuns = options.validationRuns;
  }

  async authorize(
    source: RuntimeExecutionSource,
    context: RuntimeExecutionAuthorityContext,
  ): Promise<RuntimeExecutionAuthorityDecision> {
    if (source.kind === "delivery") return this.#authorizeDelivery(source, context);
    if (source.kind === "session-message") {
      const admission = await this.#sessionMessageAdmission(source, context);
      if (admission === "valid") return { status: "authorized" };
      return admission === "not_ready" ? { status: "not_ready" } : { status: "invalid" };
    }
    return this.#authorizeValidation(source, context);
  }

  async revalidate(
    source: RuntimeExecutionSource,
    context: { sessionId: string; agentId: string; computerId: string; instanceId: string },
  ): Promise<RuntimeExecutionRevalidation> {
    if (source.kind === "delivery") {
      const [row] = await this.#database
        .select({ state: imMessageDeliveries.state, turnId: imMessageDeliveries.turnId })
        .from(imMessageDeliveries)
        .where(eq(imMessageDeliveries.id, source.deliveryId))
        .limit(1);
      return row && row.state === "accepted" && row.turnId === source.turnId ? "valid" : "invalid";
    }
    if (source.kind === "session-message") {
      return this.#sessionMessageAdmission(source, context);
    }
    // A validation run is single-use at open; the binding/agent fence revalidates the rest.
    return "valid";
  }

  async #authorizeDelivery(
    source: Extract<RuntimeExecutionSource, { kind: "delivery" }>,
    context: RuntimeExecutionAuthorityContext,
  ): Promise<RuntimeExecutionAuthorityDecision> {
    const accepted = await this.#custody.getDelivery(source.deliveryId);
    if (
      accepted &&
      accepted.turnId === source.turnId &&
      accepted.sessionId === context.sessionId &&
      accepted.agentId === context.agentId &&
      accepted.computerId === context.computerId &&
      accepted.instanceId === context.instanceId &&
      accepted.placementGeneration === context.placementGeneration
    ) {
      return { status: "authorized" };
    }
    // The dispatch/accept race is expected: the Client prepares provider access as the Turn
    // starts. A live, not-yet-accepted delivery yields a bounded retryable not_ready; anything
    // else (terminal, steered, foreign) is plainly invalid.
    const [row] = await this.#database
      .select({ state: imMessageDeliveries.state, turnId: imMessageDeliveries.turnId })
      .from(imMessageDeliveries)
      .where(
        and(
          eq(imMessageDeliveries.id, source.deliveryId),
          eq(imMessageDeliveries.sessionId, context.sessionId),
          inArray(imMessageDeliveries.state, ["pending", "expired"]),
        ),
      )
      .limit(1);
    return row ? { status: "not_ready" } : { status: "invalid" };
  }

  /**
   * The recorded accepted outcome PLUS, for a Cloud target Session, the existing durable work
   * record that proves exactly which allocation the message was accepted on. A settled or
   * allocation-replaced record is never a fresh authority even though `session_messages` keeps
   * `lastOutcome=accepted` for the life of the message. Local keeps its outcome-only authority.
   */
  async #sessionMessageAdmission(
    source: Extract<RuntimeExecutionSource, { kind: "session-message" }>,
    context: { sessionId: string; agentId: string; computerId: string },
  ): Promise<RuntimeExecutionRevalidation> {
    const [facts] = await this.#database
      .select({
        lastOutcome: sessionMessages.lastOutcome,
        agentId: imBindings.agentId,
        placementComputerId: sessionPlacements.computerId,
        placementGeneration: sessionPlacements.generation,
        computerKind: computers.kind,
        sandboxId: sandboxes.id,
        sandboxResourceName: sandboxes.currentResourceName,
        sandboxEnvironmentGeneration: sandboxes.environmentGeneration,
      })
      .from(sessionMessages)
      .innerJoin(sessions, eq(sessions.id, sessionMessages.targetSessionId))
      .innerJoin(imBindings, eq(imBindings.id, sessions.imBindingId))
      .innerJoin(sessionPlacements, eq(sessionPlacements.sessionId, sessions.id))
      .innerJoin(computers, eq(computers.id, sessionPlacements.computerId))
      .leftJoin(sandboxes, eq(sandboxes.sessionId, sessions.id))
      .where(and(eq(sessionMessages.id, source.messageId), eq(sessionMessages.targetSessionId, context.sessionId)))
      .limit(1);
    if (!facts || facts.agentId !== context.agentId) return "invalid";
    if (facts.lastOutcome === "unknown") return "not_ready";
    if (facts.lastOutcome !== "accepted") return "invalid";
    if (facts.computerKind !== "cloud") return "valid";
    if (facts.placementComputerId !== context.computerId) return "invalid";

    const [record] = await this.#database
      .select({ status: runtimeDurableWork.status, payload: runtimeDurableWork.payload })
      .from(runtimeDurableWork)
      .where(
        and(
          eq(runtimeDurableWork.computerId, context.computerId),
          eq(runtimeDurableWork.kind, "session-message"),
          eq(runtimeDurableWork.recordKey, `${context.sessionId}:${source.messageId}`),
        ),
      )
      .limit(1);
    if (!record || !UNSETTLED_DURABLE_STATUSES.has(record.status)) return "invalid";
    const envelope = parseCloudSessionWorkEnvelope(record.payload);
    if (!envelope) return "invalid";
    if (
      envelope.request.targetSessionId !== context.sessionId ||
      envelope.request.agentId !== context.agentId ||
      envelope.request.placementGeneration !== facts.placementGeneration
    ) {
      return "invalid";
    }
    if (
      !facts.sandboxId ||
      envelope.allocation.sandboxId !== facts.sandboxId ||
      envelope.allocation.environmentGeneration !== facts.sandboxEnvironmentGeneration ||
      envelope.allocation.resourceName !== facts.sandboxResourceName
    ) {
      return "invalid";
    }
    return "valid";
  }

  async #authorizeValidation(
    source: Extract<RuntimeExecutionSource, { kind: "validation" }>,
    context: RuntimeExecutionAuthorityContext,
  ): Promise<RuntimeExecutionAuthorityDecision> {
    const run = this.#validationRuns.consume(source.validationRunId, {
      computerId: context.computerId,
      instanceId: context.instanceId,
      agentId: context.agentId,
    });
    return run ? { status: "authorized", validation: run } : { status: "invalid" };
  }
}

export function validationProviderBinding(run: RuntimeValidationRun): {
  provider: RuntimeCredentialProvider;
  bindingId: string;
} {
  return { provider: run.provider, bindingId: run.bindingId };
}
