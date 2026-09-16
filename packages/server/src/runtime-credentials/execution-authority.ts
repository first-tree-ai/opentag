import type { RuntimeCredentialProvider, RuntimeExecutionSource } from "@opentag/shared";
import { and, eq, inArray } from "drizzle-orm";
import type { DatabaseClient } from "../db/client.js";
import { imMessageDeliveries, sessionMessages } from "../db/schema/index.js";
import type { RuntimeCustodyStore } from "../runtime/runtime-custody-store.js";
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
    if (source.kind === "session-message") return this.#authorizeSessionMessage(source, context);
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
      const [row] = await this.#database
        .select({ lastOutcome: sessionMessages.lastOutcome })
        .from(sessionMessages)
        .where(and(eq(sessionMessages.id, source.messageId), eq(sessionMessages.targetSessionId, context.sessionId)))
        .limit(1);
      if (!row) return "invalid";
      if (row.lastOutcome === "accepted") return "valid";
      return row.lastOutcome === "unknown" ? "not_ready" : "invalid";
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

  async #authorizeSessionMessage(
    source: Extract<RuntimeExecutionSource, { kind: "session-message" }>,
    context: RuntimeExecutionAuthorityContext,
  ): Promise<RuntimeExecutionAuthorityDecision> {
    const [row] = await this.#database
      .select({ lastOutcome: sessionMessages.lastOutcome })
      .from(sessionMessages)
      .where(and(eq(sessionMessages.id, source.messageId), eq(sessionMessages.targetSessionId, context.sessionId)))
      .limit(1);
    if (!row) return { status: "invalid" };
    if (row.lastOutcome === "accepted") return { status: "authorized" };
    return row.lastOutcome === "unknown" ? { status: "not_ready" } : { status: "invalid" };
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
