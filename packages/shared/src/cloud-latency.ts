import { z } from "zod";

export const CloudLatencyPhaseSchema = z.enum([
  "runtime_assembly",
  "allocation_wait",
  "dispatch",
  "workspace_ready",
  "worker_execution",
  "checkpoint",
  "report_ack",
]);
export type CloudLatencyPhase = z.infer<typeof CloudLatencyPhaseSchema>;

const correlation = z
  .object({
    sessionId: z.string().uuid(),
    sandboxId: z.string().uuid().optional(),
    environmentGeneration: z.number().int().nonnegative().optional(),
    turnId: z.string().uuid().optional(),
    deliveryId: z.string().uuid().optional(),
    messageId: z.string().uuid().optional(),
    attempt: z.number().int().nonnegative().optional(),
  })
  .strict();
export type CloudLatencyCorrelation = z.infer<typeof correlation>;

export const CloudLatencyRecordSchema = correlation
  .extend({
    module: z.literal("cloud-latency"),
    operation: z.literal("cloud.latency"),
    version: z.literal(1),
    environment: z.literal("staging"),
    severity: z.literal("INFO").optional(),
    service: z.enum(["opentag-server", "opentag-runner"]),
    revision: z.string().regex(/^(?:[a-f0-9]{40}|unknown)$/),
    clockId: z.string().uuid(),
    utc: z.string().datetime(),
    seq: z.number().int().min(1).max(32),
    event: z.enum(["start", "end", "failure", "summary"]),
    phase: CloudLatencyPhaseSchema.optional(),
    elapsedMs: z.number().finite().nonnegative(),
    durationMs: z.number().finite().nonnegative(),
    outcome: z.enum(["completed", "failed", "incomplete", "cancelled", "unknown"]).optional(),
    diagnosticIncomplete: z.boolean(),
  })
  .strict();
export type CloudLatencyRecord = z.infer<typeof CloudLatencyRecordSchema>;

export function cloudLatencySessions(env: Readonly<Record<string, string | undefined>>): ReadonlySet<string> {
  if (env.OPENTAG_ENV !== "staging" || env.OPENTAG_CLOUD_LATENCY_DIAGNOSTICS !== "true") return new Set();
  const values = (env.OPENTAG_CLOUD_LATENCY_SESSION_IDS ?? "").split(",").map((value) => value.trim());
  if (values.length > 16 || values.some((value) => !z.string().uuid().safeParse(value).success)) return new Set();
  return new Set(values);
}

export class CloudLatencyRecorder {
  readonly #context: CloudLatencyCorrelation;
  readonly #clockId: string;
  readonly #service: CloudLatencyRecord["service"];
  readonly #revision: string;
  readonly #write: (record: CloudLatencyRecord) => void;
  readonly #now: () => number;
  readonly #utc: () => string;
  readonly #started: number;
  readonly #open = new Map<CloudLatencyPhase, number>();
  #seq = 0;
  #bytes = 0;
  #incomplete = false;
  #closed = false;

  constructor(input: {
    context: CloudLatencyCorrelation;
    clockId: string;
    service: "server" | "runner";
    revision: string | undefined;
    write: (record: CloudLatencyRecord) => void;
    now?: () => number;
    utc?: () => string;
  }) {
    this.#context = correlation.parse(input.context);
    this.#clockId = z.string().uuid().parse(input.clockId);
    this.#service = input.service === "server" ? "opentag-server" : "opentag-runner";
    this.#revision = /^[a-f0-9]{40}$/.test(input.revision ?? "") ? String(input.revision) : "unknown";
    this.#write = input.write;
    this.#now = input.now ?? (() => performance.now());
    this.#utc = input.utc ?? (() => new Date().toISOString());
    this.#started = this.#now();
  }

  start(phase: CloudLatencyPhase): void {
    if (this.#closed) return;
    if (this.#open.has(phase)) this.#incomplete = true;
    this.#open.set(phase, this.#now());
    this.#emit("start", 0, phase);
  }

  markIncomplete(): void {
    this.#incomplete = true;
  }

  end(phase: CloudLatencyPhase, outcome: "completed" | "failed" = "completed"): void {
    if (this.#closed) return;
    const started = this.#open.get(phase);
    if (started === undefined) {
      this.#incomplete = true;
      return;
    }
    this.#open.delete(phase);
    this.#emit(outcome === "failed" ? "failure" : "end", this.#now() - started, phase, outcome);
  }

  async measure<T>(
    phase: CloudLatencyPhase,
    action: () => Promise<T>,
    options: { falseIsFailure?: boolean } = {},
  ): Promise<T> {
    this.start(phase);
    try {
      const result = await action();
      this.end(phase, options.falseIsFailure && result === false ? "failed" : "completed");
      return result;
    } catch (error) {
      this.end(phase, "failed");
      throw error;
    }
  }

  finish(outcome: NonNullable<CloudLatencyRecord["outcome"]>): void {
    if (this.#closed) return;
    if (this.#open.size > 0 || outcome === "incomplete") this.#incomplete = true;
    this.#emit("summary", this.#now() - this.#started, undefined, outcome);
    this.#closed = true;
  }

  #emit(
    event: CloudLatencyRecord["event"],
    durationMs: number,
    phase?: CloudLatencyPhase,
    outcome?: CloudLatencyRecord["outcome"],
  ): void {
    if (event !== "summary" && (this.#seq >= 31 || this.#bytes >= 60 * 1024)) {
      this.#incomplete = true;
      return;
    }
    try {
      const record = CloudLatencyRecordSchema.parse({
        ...this.#context,
        module: "cloud-latency",
        operation: "cloud.latency",
        version: 1,
        environment: "staging",
        severity: "INFO",
        service: this.#service,
        revision: this.#revision,
        clockId: this.#clockId,
        utc: this.#utc(),
        seq: ++this.#seq,
        event,
        phase,
        outcome,
        elapsedMs: this.#now() - this.#started,
        durationMs,
        diagnosticIncomplete: this.#incomplete,
      });
      const bytes = JSON.stringify(record).length + 1;
      if (bytes > 4096 || this.#bytes + bytes > 64 * 1024) {
        this.#incomplete = true;
        return;
      }
      this.#bytes += bytes;
      this.#write(record);
    } catch {
      this.#incomplete = true;
    }
  }
}
