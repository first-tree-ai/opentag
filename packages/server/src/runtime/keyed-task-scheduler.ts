export interface KeyedTaskSchedulerOptions {
  maxConcurrent: number;
  maxQueuedPerKey: number;
  maxQueuedTotal: number;
  now?: () => number;
}

interface TaskLane {
  queue: Array<{ run: () => Promise<void>; onDrop?: () => void; enqueuedAt: number }>;
  running: boolean;
}

export class KeyedTaskScheduler {
  readonly #options: KeyedTaskSchedulerOptions;
  readonly #lanes = new Map<string, TaskLane>();
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
  }

  #pump(): void {
    if (this.#closed) return;
    while (this.#active < this.#options.maxConcurrent) {
      const next = [...this.#lanes.entries()].find(([, lane]) => !lane.running && lane.queue.length > 0);
      if (!next) return;
      const [key, lane] = next;
      const task = lane.queue.shift();
      if (!task) return;
      this.#queued -= 1;
      lane.running = true;
      this.#active += 1;
      void Promise.resolve()
        .then(task.run)
        .catch(() => undefined)
        .finally(() => {
          lane.running = false;
          this.#active -= 1;
          if (lane.queue.length === 0) this.#lanes.delete(key);
          this.#pump();
        });
    }
  }
}
