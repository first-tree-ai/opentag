import { randomUUID } from "node:crypto";
import {
  type CloudLatencyCorrelation,
  type CloudLatencyRecord,
  CloudLatencyRecorder,
  cloudLatencySessions,
  type RunnerClientFrame,
  type RunnerServerFrame,
} from "@opentag/shared";
import type { CloudTurnScope } from "./cloud-turns.js";

const clockId = randomUUID();
type Observation = {
  trace: CloudLatencyRecorder;
  context: CloudLatencyCorrelation;
  reportHash?: string;
  messageId?: string;
  reportOutcome?: string;
  sent: boolean;
};

export class RunnerCloudLatencyObserver {
  readonly #env: Readonly<Record<string, string | undefined>>;
  readonly #sessions: ReadonlySet<string>;
  readonly #scope: () => CloudTurnScope | undefined;
  readonly #write: (record: CloudLatencyRecord) => void;
  readonly #observations = new Map<string, Observation>();
  #active?: Observation;

  constructor(input: {
    env: Readonly<Record<string, string | undefined>>;
    scope: () => CloudTurnScope | undefined;
    write: (record: CloudLatencyRecord) => void;
  }) {
    this.#env = input.env;
    this.#sessions = cloudLatencySessions(input.env);
    this.#scope = input.scope;
    this.#write = input.write;
  }

  observes(sessionId: string): boolean {
    return this.#sessions.has(sessionId);
  }

  #observation(key: string, context: CloudLatencyCorrelation): Observation | undefined {
    const existing = this.#observations.get(key);
    if (existing)
      return existing.context.sessionId === context.sessionId &&
        existing.context.sandboxId === context.sandboxId &&
        existing.context.environmentGeneration === context.environmentGeneration
        ? existing
        : undefined;
    if (!this.#sessions.has(context.sessionId) || this.#observations.size >= 1024) return;
    try {
      const entry = {
        trace: new CloudLatencyRecorder({
          context,
          clockId,
          service: "runner",
          revision: this.#env.OPENTAG_REVISION,
          write: this.#write,
        }),
        context,
        sent: false,
      };
      this.#observations.set(key, entry);
      return entry;
    } catch {
      return undefined;
    }
  }

  #current(entry: Observation): boolean {
    const scope = this.#scope();
    return (
      scope?.sessionId === entry.context.sessionId &&
      scope.sandboxId === entry.context.sandboxId &&
      scope.environmentGeneration === entry.context.environmentGeneration
    );
  }

  diagnostic(record: Readonly<Record<string, unknown>>): void {
    const scope = this.#scope();
    if (
      !scope ||
      record.sessionId !== scope.sessionId ||
      record.sandboxId !== scope.sandboxId ||
      record.environmentGeneration !== scope.environmentGeneration ||
      typeof record.turnId !== "string"
    )
      return;
    if (record.phase === "worker_startup" && record.event === "start") {
      const entry = this.#observation(record.turnId, {
        sessionId: scope.sessionId,
        sandboxId: scope.sandboxId,
        environmentGeneration: scope.environmentGeneration,
        turnId: record.turnId,
        ...(typeof record.deliveryId === "string" ? { deliveryId: record.deliveryId } : {}),
        ...(typeof record.messageId === "string" ? { messageId: record.messageId } : {}),
      });
      this.#active = entry;
      entry?.trace.start("worker_execution");
    }
    if (record.event === "worker_end" && record.seq === undefined) {
      const trace = this.#observations.get(record.turnId)?.trace;
      if (record.diagnosticIncomplete === true) trace?.markIncomplete();
      trace?.end("worker_execution", record.severity === "ERROR" ? "failed" : "completed");
    }
  }

  checkpoint<T>(action: () => Promise<T>): Promise<T> {
    const entry = this.#active;
    return entry && this.#current(entry) ? entry.trace.measure("checkpoint", action) : action();
  }

  workspace<T>(action: () => Promise<T>): Promise<T> {
    const scope = this.#scope();
    const entry = scope
      ? this.#observation(`allocation:${scope.sessionId}:${scope.environmentGeneration}`, {
          sessionId: scope.sessionId,
          sandboxId: scope.sandboxId,
          environmentGeneration: scope.environmentGeneration,
        })
      : undefined;
    if (!entry) return action();
    return entry.trace.measure("workspace_ready", action, { falseIsFailure: true }).then(
      (result) => {
        entry.trace.finish(result === false ? "incomplete" : "completed");
        return result;
      },
      (error: unknown) => {
        entry.trace.finish("failed");
        throw error;
      },
    );
  }

  sent(frame: RunnerClientFrame): void {
    const scope = this.#scope();
    if (!scope) return;
    let entry: Observation | undefined;
    if (frame.type === "delivery:report") {
      entry = this.#observation(frame.report.turnId, {
        sessionId: frame.report.sessionId,
        sandboxId: scope.sandboxId,
        environmentGeneration: scope.environmentGeneration,
        turnId: frame.report.turnId,
        deliveryId: frame.report.deliveryId,
      });
      if (entry && !entry.sent) {
        entry.reportHash = frame.report.resultHash;
        entry.reportOutcome = frame.report.outcome;
      }
    }
    if (frame.type === "session:message:settled") {
      entry = this.#observation(frame.turnId, {
        sessionId: scope.sessionId,
        sandboxId: scope.sandboxId,
        environmentGeneration: scope.environmentGeneration,
        turnId: frame.turnId,
        messageId: frame.messageId,
      });
      if (entry && !entry.sent) {
        entry.messageId = frame.messageId;
        entry.reportOutcome = frame.outcome;
      }
    }
    if (!entry || !this.#current(entry) || entry.sent) return;
    entry.sent = true;
    entry.trace.start("report_ack");
    if (this.#active === entry) this.#active = undefined;
  }

  acknowledged(frame: RunnerServerFrame): void {
    if (frame.type !== "delivery:report:ack" && frame.type !== "session:message:settled:ack") return;
    const entry = this.#observations.get(frame.turnId);
    if (!entry?.sent || !this.#current(entry)) return;
    if (frame.type === "delivery:report:ack" && frame.resultHash !== entry.reportHash) return;
    if (frame.type === "session:message:settled:ack" && frame.messageId !== entry.messageId) return;
    const accepted = frame.status === "recorded" || frame.status === "already_recorded";
    entry.trace.end("report_ack", accepted ? "completed" : "failed");
    const outcome = ["completed", "failed", "cancelled", "unknown"].includes(entry.reportOutcome ?? "")
      ? (entry.reportOutcome as "completed" | "failed" | "cancelled" | "unknown")
      : "incomplete";
    entry.trace.finish(accepted ? outcome : "incomplete");
  }
}
