import { randomUUID } from "node:crypto";
import {
  type AgentTraceBatch,
  type AgentTraceEvent,
  AgentTraceEventSchema,
  RUNTIME_TRACE_BATCH_MAX_EVENTS,
  type RuntimeUsage,
} from "@opentag/shared";
import type { AgentRuntimeEvent } from "../agent-runtime/types.js";
import type { RuntimeConnection } from "./runtime-connection.js";

export const TURN_TRACE_MAX_BUFFER_BYTES = 256 * 1024;
export const TURN_TRACE_MAX_BUFFER_EVENTS = 256;
export const TURN_TRACE_SEND_DEADLINE_MS = 500;
export const TURN_TRACE_BATCH_SOFT_LIMIT_BYTES = 60 * 1024;

export interface TurnTraceBufferOptions {
  id?: () => string;
  maxBufferBytes?: number;
  maxBufferEvents?: number;
  now?: () => number;
  placementGeneration: number;
  sender: Pick<RuntimeConnection, "send">;
  sessionId: string;
  turnId: string;
}

export interface TurnTraceSummary {
  droppedEvents: number;
  lastSequence: number;
}

type TraceEventInput =
  | { kind: "turn_started" }
  | {
      kind: "item_completed";
      itemType: "agent_message" | "command" | "file_change" | "tool" | "other";
      status: "completed" | "failed";
    }
  | { kind: "usage_updated"; usage: RuntimeUsage }
  | { kind: "warning"; code: string; message: string }
  | { kind: "turn_completed"; outcome: "completed" | "failed" | "cancelled" | "unknown" };

export class TurnTraceBuffer {
  readonly #id: () => string;
  readonly #maxBufferBytes: number;
  readonly #maxBufferEvents: number;
  readonly #now: () => number;
  readonly #placementGeneration: number;
  readonly #sender: Pick<RuntimeConnection, "send">;
  readonly #sessionId: string;
  readonly #turnId: string;
  readonly #events: AgentTraceEvent[] = [];
  #bufferBytes = 0;
  #droppedEvents = 0;
  #finishing = false;
  #frozen = false;
  #inFlight = 0;
  #lastSequence = 0;
  #flushPromise?: Promise<void>;
  #flushRequested = false;
  #turnCompleted = false;
  #turnStarted = false;

  constructor(options: TurnTraceBufferOptions) {
    this.#id = options.id ?? randomUUID;
    this.#maxBufferBytes = options.maxBufferBytes ?? TURN_TRACE_MAX_BUFFER_BYTES;
    this.#maxBufferEvents = options.maxBufferEvents ?? TURN_TRACE_MAX_BUFFER_EVENTS;
    this.#now = options.now ?? Date.now;
    this.#placementGeneration = options.placementGeneration;
    this.#sender = options.sender;
    this.#sessionId = options.sessionId;
    this.#turnId = options.turnId;
    if (!Number.isSafeInteger(this.#maxBufferBytes) || this.#maxBufferBytes < 1024) {
      throw new Error("Trace byte limit must be a safe integer of at least 1024");
    }
    if (!Number.isSafeInteger(this.#maxBufferEvents) || this.#maxBufferEvents < 1) {
      throw new Error("Trace event limit must be a positive safe integer");
    }
  }

  turnStarted(): void {
    if (this.#turnStarted) return;
    this.#turnStarted = true;
    this.#append({ kind: "turn_started" });
  }

  itemCompleted(
    itemType: "agent_message" | "command" | "file_change" | "tool" | "other",
    status: "completed" | "failed",
  ): void {
    this.#append({ kind: "item_completed", itemType, status });
  }

  usageUpdated(usage: RuntimeUsage): void {
    this.#append({ kind: "usage_updated", usage });
  }

  warning(code: string, _message: string): void {
    this.#append({
      kind: "warning",
      code: /^[A-Za-z0-9:_-]{1,128}$/.test(code) ? code : "provider_warning",
      message: "Provider reported a runtime warning",
    });
  }

  turnCompleted(outcome: "completed" | "failed" | "cancelled" | "unknown"): void {
    if (this.#turnCompleted) return;
    this.#turnCompleted = true;
    this.#append({ kind: "turn_completed", outcome });
  }

  record(event: AgentRuntimeEvent): void {
    if (event.type === "run_started") {
      this.turnStarted();
      return;
    }
    if (event.type === "message_completed") {
      this.itemCompleted("agent_message", "completed");
      return;
    }
    if (event.type === "tool_completed") {
      this.itemCompleted("tool", event.status === "completed" ? "completed" : "failed");
      return;
    }
    if (event.type === "usage_updated") {
      this.usageUpdated(event.usage);
      return;
    }
    if (event.type === "provider_warning") {
      this.warning(event.code, event.message);
      return;
    }
    if (event.type === "run_completed") this.turnCompleted("completed");
    else if (event.type === "run_aborted" || event.type === "run_cancelled") this.turnCompleted("cancelled");
    else if (event.type === "run_failed") this.turnCompleted("failed");
  }

  summary(): TurnTraceSummary {
    return { lastSequence: this.#lastSequence, droppedEvents: this.#droppedEvents };
  }

  async finish(): Promise<TurnTraceSummary> {
    if (this.#frozen) return this.summary();
    this.#finishing = true;
    const active = this.#flushPromise;
    if (active) await active;
    if (this.#events.length > 0) await this.#flush();
    this.#frozen = true;
    this.#droppedEvents += this.#events.length;
    this.#events.length = 0;
    this.#bufferBytes = 0;
    return this.summary();
  }

  #append(input: TraceEventInput): void {
    if (this.#frozen) return;
    this.#lastSequence += 1;
    const event = AgentTraceEventSchema.parse({
      ...input,
      sequence: this.#lastSequence,
      at: new Date(this.#now()).toISOString(),
    });
    const bytes = Buffer.byteLength(JSON.stringify(event), "utf8");
    if (this.#events.length >= this.#maxBufferEvents || this.#bufferBytes + bytes > this.#maxBufferBytes) {
      if (event.kind !== "warning" && event.kind !== "turn_completed") {
        this.#droppedEvents += 1;
        return;
      }
      const expendableOffset = this.#events
        .slice(this.#inFlight)
        .findIndex((candidate) => candidate.kind !== "warning" && candidate.kind !== "turn_completed");
      const expendable = expendableOffset < 0 ? -1 : this.#inFlight + expendableOffset;
      if (expendable < 0) {
        this.#droppedEvents += 1;
        return;
      }
      this.#dropBuffered(expendable);
      if (this.#bufferBytes + bytes > this.#maxBufferBytes) {
        this.#droppedEvents += 1;
        return;
      }
    }
    this.#events.push(event);
    this.#bufferBytes += bytes;
    this.#scheduleFlush();
  }

  #scheduleFlush(): void {
    if (this.#frozen || this.#finishing) return;
    if (this.#flushPromise) {
      this.#flushRequested = true;
      return;
    }
    const active = this.#flush();
    this.#flushPromise = active;
    const settled = () => {
      if (this.#flushPromise !== active) return;
      this.#flushPromise = undefined;
      if (!this.#flushRequested || this.#finishing || this.#frozen) return;
      this.#flushRequested = false;
      this.#scheduleFlush();
    };
    void active.then(settled, settled);
  }

  async #flush(): Promise<void> {
    while (!this.#frozen && this.#events.length > 0) {
      const events = this.#events.slice(0, RUNTIME_TRACE_BATCH_MAX_EVENTS);
      while (events.length > 1 && batchBytes(events) > TURN_TRACE_BATCH_SOFT_LIMIT_BYTES) events.pop();
      this.#inFlight = events.length;
      const batch: AgentTraceBatch = {
        type: "agent:trace",
        batchId: this.#id(),
        sessionId: this.#sessionId,
        turnId: this.#turnId,
        placementGeneration: this.#placementGeneration,
        events,
      };
      try {
        await this.#sender.send(batch, {
          priority: "trace",
          deadline: this.#now() + TURN_TRACE_SEND_DEADLINE_MS,
        });
      } catch {
        this.#inFlight = 0;
        return;
      }
      this.#events.splice(0, events.length);
      this.#bufferBytes -= events.reduce((total, event) => total + eventBytes(event), 0);
      this.#inFlight = 0;
    }
  }

  #dropBuffered(index: number): void {
    const [removed] = this.#events.splice(index, 1);
    if (!removed) return;
    this.#bufferBytes -= eventBytes(removed);
    this.#droppedEvents += 1;
  }
}

function eventBytes(event: AgentTraceEvent): number {
  return Buffer.byteLength(JSON.stringify(event), "utf8");
}

function batchBytes(events: AgentTraceEvent[]): number {
  return events.reduce((total, event) => total + eventBytes(event), 1024);
}
