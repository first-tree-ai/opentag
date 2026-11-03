import { randomUUID } from "node:crypto";
import { CloudLatencyRecorder, cloudLatencySessions } from "@opentag/shared";
import type { ServiceLogger } from "./service-logger.js";

const clockId = randomUUID();

export class CloudDeliveryLatency {
  readonly #sessions: ReadonlySet<string>;
  readonly #seen = new Set<string>();
  readonly #env: Readonly<Record<string, string | undefined>>;
  readonly #logger: ServiceLogger | undefined;

  constructor(env: Readonly<Record<string, string | undefined>>, logger?: ServiceLogger) {
    this.#sessions = cloudLatencySessions(env);
    this.#env = env;
    this.#logger = logger;
  }

  begin(sessionId: string, deliveryId: string, attempt: number): CloudLatencyRecorder | undefined {
    if (!this.#logger || !this.#sessions.has(sessionId) || this.#seen.has(deliveryId) || this.#seen.size >= 1024)
      return;
    this.#seen.add(deliveryId);
    try {
      return new CloudLatencyRecorder({
        context: { sessionId, deliveryId, attempt },
        clockId,
        service: "server",
        revision: this.#env.OPENTAG_REVISION,
        write: (record) => this.#logger?.info(record, "Cloud latency diagnostic"),
      });
    } catch {
      return undefined;
    }
  }
}
