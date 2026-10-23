import type { KeyedTaskSchedulerOptions, TaskLane } from "./keyed-task-scheduler.types.js";

/**
 * Per-key FIFO lanes behind one global concurrency budget.
 *
 * Invariant: a key holds at most one unconsumed ready-queue entry, so live entries never exceed the
 * lane count. Consumed entries stay in the array until `#compactReady` drops them, so total length is
 * bounded by the lane count plus compaction slack, not by the lane count itself. A lane re-enters at
 * the back after each run, so admission is round-robin and a key that keeps refilling its lane cannot
 * delay a key that became ready earlier.
 */
export class KeyedTaskScheduler {
  readonly #options: KeyedTaskSchedulerOptions;
  readonly #lanes = new Map<string, TaskLane>();
  readonly #ready: string[] = [];
  readonly #readySet = new Set<string>();
  #readyHead = 0;
  #active = 0;
  #closed = false;
  #queued = 0;
  readonly #now: () => number;

  constructor(options: KeyedTaskSchedulerOptions) {
    for (const [name, value] of Object.entries(options).filter(([, value]) => typeof value === "number")) {
      if (!Number.isSafeInteger(value) || value < 1) {
        throw new Error(`${name} must be a positive safe integer`);
      }
    }
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  enqueue(key: string, task: () => Promise<void>, onDrop?: () => void): boolean {
    if (this.#closed || !key) return false;
    const lane = this.#lanes.get(key) ?? { queue: [], running: false };
    if (lane.queue.length >= this.#options.maxQueuedPerKey || this.#queued >= this.#options.maxQueuedTotal) {
      return false;
    }
    if (!this.#lanes.has(key)) this.#lanes.set(key, lane);
    lane.queue.push({ run: task, onDrop, enqueuedAt: this.#now() });
    this.#queued += 1;
    if (!lane.running) this.#markReady(key);
    this.#pump();
    return true;
  }

  stats(now = this.#now()): { active: number; queued: number; lanes: number; oldestQueueAgeMs: number } {
    let oldestEnqueuedAt = Number.POSITIVE_INFINITY;
    for (const lane of this.#lanes.values()) {
      const task = lane.queue[0];
      if (task) oldestEnqueuedAt = Math.min(oldestEnqueuedAt, task.enqueuedAt);
    }
    return {
      active: this.#active,
      queued: this.#queued,
      lanes: this.#lanes.size,
      oldestQueueAgeMs: Number.isFinite(oldestEnqueuedAt) ? Math.max(0, now - oldestEnqueuedAt) : 0,
    };
  }

  close(): void {
    this.#closed = true;
    for (const lane of this.#lanes.values()) {
      this.#queued -= lane.queue.length;
      for (const task of lane.queue.splice(0)) {
        try {
          task.onDrop?.();
        } catch {
          // Dropped-task observation must not interrupt scheduler shutdown.
        }
      }
    }
    for (const [key, lane] of this.#lanes) {
      if (!lane.running) this.#lanes.delete(key);
    }
    this.#ready.length = 0;
    this.#readySet.clear();
    this.#readyHead = 0;
  }

  #markReady(key: string): void {
    if (this.#readySet.has(key)) return;
    this.#readySet.add(key);
    this.#ready.push(key);
  }

  #takeReady(): string | undefined {
    let key: string | undefined;
    while (this.#readyHead < this.#ready.length) {
      const candidate = this.#ready[this.#readyHead] as string;
      this.#readyHead += 1;
      this.#readySet.delete(candidate);
      const lane = this.#lanes.get(candidate);
      if (lane && !lane.running && lane.queue.length > 0) {
        key = candidate;
        break;
      }
    }
    this.#compactReady();
    return key;
  }

  #compactReady(): void {
    if (this.#readyHead === this.#ready.length) {
      this.#ready.length = 0;
      this.#readyHead = 0;
      return;
    }
    // Consumed head entries would otherwise pin memory while the queue keeps growing.
    if (this.#readyHead >= 64 && this.#readyHead * 2 >= this.#ready.length) {
      this.#ready.splice(0, this.#readyHead);
      this.#readyHead = 0;
    }
  }

  #pump(): void {
    if (this.#closed) return;
    while (this.#active < this.#options.maxConcurrent) {
      const key = this.#takeReady();
      if (key === undefined) return;
      const lane = this.#lanes.get(key);
      const task = lane?.queue.shift();
      if (!(lane && task)) return;
      this.#queued -= 1;
      lane.running = true;
      this.#active += 1;
      void Promise.resolve()
        .then(task.run)
        .catch((error: unknown) => {
          this.#options.supervisor?.track(
            async () => {
              throw error;
            },
            {
              code: "RUNTIME_SCHEDULER_TASK_FAILED",
              category: "internal",
              retryability: "never",
              phase: "scheduler",
              requestId: key,
              operation: "keyed-task-scheduler",
            },
          );
        })
        .finally(() => {
          lane.running = false;
          this.#active -= 1;
          if (lane.queue.length === 0) this.#lanes.delete(key);
          else this.#markReady(key);
          this.#pump();
        });
    }
  }
}
