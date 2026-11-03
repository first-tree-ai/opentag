import { randomUUID } from "node:crypto";
import { type CloudLatencyRecord, CloudLatencyRecorder, cloudLatencySessions } from "@opentag/shared";
import type { ServiceLogger } from "./service-logger.js";

const clockId = randomUUID();
type DeliveryBudget = { attempts: Set<number>; records: number; bytes: number };

function useBudget(budget: DeliveryBudget, record: CloudLatencyRecord): boolean {
  const recordLimit = record.event === "summary" ? 32 : 31;
  const byteLimit = record.event === "summary" ? 64 * 1024 : 60 * 1024;
  const bytes = Buffer.byteLength(JSON.stringify(record)) + 1;
  if (budget.records >= recordLimit || budget.bytes + bytes > byteLimit) return false;
  budget.records++;
  budget.bytes += bytes;
  return true;
}

export class CloudDeliveryLatency {
  readonly #sessions: ReadonlySet<string>;
  readonly #budgets = new Map<string, DeliveryBudget>();
  readonly #env: Readonly<Record<string, string | undefined>>;
  readonly #logger: ServiceLogger | undefined;

  constructor(env: Readonly<Record<string, string | undefined>>, logger?: ServiceLogger) {
    this.#sessions = cloudLatencySessions(env);
    this.#env = env;
    this.#logger = logger;
  }

  begin(sessionId: string, deliveryId: string, attempt: number): CloudLatencyRecorder | undefined {
    if (!this.#logger || !this.#sessions.has(sessionId)) return;
    let budget = this.#budgets.get(deliveryId);
    if (!budget) {
      if (this.#budgets.size >= 1024) return;
      budget = { attempts: new Set(), records: 0, bytes: 0 };
      this.#budgets.set(deliveryId, budget);
    }
    if (budget.attempts.has(attempt) || budget.attempts.size >= 32 || budget.records >= 32 || budget.bytes >= 64 * 1024)
      return;
    budget.attempts.add(attempt);
    const reserved = budget;
    try {
      let trace: CloudLatencyRecorder;
      trace = new CloudLatencyRecorder({
        context: { sessionId, deliveryId, attempt },
        clockId,
        service: "server",
        revision: this.#env.OPENTAG_REVISION,
        write: (record) => {
          if (!useBudget(reserved, record)) {
            trace.markIncomplete();
            return;
          }
          this.#logger?.info(record, "Cloud latency diagnostic");
        },
      });
      return trace;
    } catch {
      return undefined;
    }
  }
}
