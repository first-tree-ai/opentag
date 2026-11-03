import { randomUUID } from "node:crypto";
import { cloudLatencySessions } from "@opentag/shared";
import { z } from "zod";
import type { CloudTurnScope } from "./cloud-turns.js";

const clockId = randomUUID();
const phaseSchema = z.enum(["controller_drain", "native_cleanup", "gateway_health_close"]);
type ShutdownPhase = z.infer<typeof phaseSchema>;
const contextSchema = z.object({
  sessionId: z.string().uuid(),
  sandboxId: z.string().uuid(),
  environmentGeneration: z.number().int().nonnegative(),
});
const recordSchema = contextSchema.extend({
  module: z.literal("cloud-runner"),
  operation: z.literal("shutdown.diagnostic"),
  version: z.literal(1),
  environment: z.literal("staging"),
  severity: z.literal("INFO"),
  service: z.literal("opentag-runner"),
  revision: z.string().regex(/^(?:[a-f0-9]{40}|unknown)$/),
  clockId: z.string().uuid(),
  utc: z.string().datetime(),
  seq: z.number().int().min(1).max(8),
  event: z.enum(["request", "start", "end", "failure", "summary"]),
  phase: phaseSchema.optional(),
  trigger: z.enum(["request", "exit"]),
  elapsedMs: z.number().finite().nonnegative(),
  durationMs: z.number().finite().nonnegative(),
  outcome: z.enum(["completed", "failed", "incomplete"]).optional(),
  diagnosticIncomplete: z.boolean(),
});
export type RunnerShutdownRecord = z.infer<typeof recordSchema>;

export class RunnerShutdownObserver {
  readonly #sessions: ReadonlySet<string>;
  readonly #assignment: () => CloudTurnScope | undefined;
  readonly #write: (record: RunnerShutdownRecord) => void;
  readonly #revision: string;
  readonly #now: () => number;
  readonly #utc: () => string;
  readonly #seen = new Set<ShutdownPhase>();
  #context?: z.infer<typeof contextSchema>;
  #attempted = false;
  #closed = false;
  #started = 0;
  #seq = 0;
  #bytes = 0;
  #open = 0;
  #failed = false;
  #incomplete = false;
  #trigger: RunnerShutdownRecord["trigger"] = "exit";

  constructor(input: {
    env: Readonly<Record<string, string | undefined>>;
    assignment: () => CloudTurnScope | undefined;
    write: (record: RunnerShutdownRecord) => void;
    now?: () => number;
    utc?: () => string;
  }) {
    this.#sessions = cloudLatencySessions(input.env);
    this.#assignment = input.assignment;
    this.#write = input.write;
    const revision = input.env.OPENTAG_REVISION ?? "";
    this.#revision = /^[a-f0-9]{40}$/.test(revision) ? revision : "unknown";
    this.#now = input.now ?? (() => performance.now());
    this.#utc = input.utc ?? (() => new Date().toISOString());
  }

  start(trigger: RunnerShutdownRecord["trigger"]): void {
    if (this.#attempted) return;
    this.#attempted = true;
    if (this.#sessions.size === 0) return;
    const scope = this.#assignment();
    if (!scope || !this.#sessions.has(scope.sessionId)) return;
    const parsed = contextSchema.safeParse({
      sessionId: scope.sessionId,
      sandboxId: scope.sandboxId,
      environmentGeneration: scope.environmentGeneration,
    });
    if (!parsed.success) return;
    this.#context = parsed.data;
    this.#trigger = trigger;
    this.#started = this.#now();
    this.#emit("request", 0);
  }

  async measure<T>(
    phase: ShutdownPhase,
    action: () => Promise<T>,
    options: { falseIsFailure?: boolean } = {},
  ): Promise<T> {
    if (!this.#context || this.#closed) return action();
    if (this.#seen.has(phase)) {
      this.#incomplete = true;
      return action();
    }
    this.#seen.add(phase);
    this.#open++;
    const started = this.#now();
    this.#emit("start", 0, phase);
    try {
      const result = await action();
      const failed = options.falseIsFailure && result === false;
      this.#failed ||= !!failed;
      this.#emit(failed ? "failure" : "end", this.#now() - started, phase);
      return result;
    } catch (error) {
      this.#failed = true;
      this.#emit("failure", this.#now() - started, phase);
      throw error;
    } finally {
      this.#open--;
    }
  }

  finish(cleanupComplete: boolean): void {
    if (!this.#context || this.#closed) return;
    this.#incomplete ||= !cleanupComplete || this.#open > 0 || this.#seen.size !== phaseSchema.options.length;
    this.#emit("summary", this.#now() - this.#started);
    this.#closed = true;
  }

  async cleanup(action: () => Promise<void>): Promise<void> {
    this.start("exit");
    let complete = false;
    try {
      await action();
      complete = true;
    } finally {
      this.finish(complete);
    }
  }

  #emit(event: RunnerShutdownRecord["event"], durationMs: number, phase?: ShutdownPhase): void {
    if (this.#closed) return;
    try {
      const record = recordSchema.parse({
        ...this.#context,
        module: "cloud-runner",
        operation: "shutdown.diagnostic",
        version: 1,
        environment: "staging",
        severity: "INFO",
        service: "opentag-runner",
        revision: this.#revision,
        clockId,
        utc: this.#utc(),
        seq: ++this.#seq,
        event,
        phase,
        trigger: this.#trigger,
        elapsedMs: this.#now() - this.#started,
        durationMs,
        outcome:
          event === "summary" ? (this.#failed ? "failed" : this.#incomplete ? "incomplete" : "completed") : undefined,
        diagnosticIncomplete: this.#incomplete,
      });
      const bytes = Buffer.byteLength(JSON.stringify(record)) + 1;
      // Three phases are observed once; reserve the eighth record and 2 KiB for the summary.
      if (bytes > 2048 || this.#bytes + bytes > (event === "summary" ? 16 : 14) * 1024) {
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
