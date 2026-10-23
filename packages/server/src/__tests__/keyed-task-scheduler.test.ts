import { setImmediate as waitImmediate } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { BackgroundFailureSupervisor } from "../observability/background-failure-supervisor.js";
import { KeyedTaskScheduler } from "../runtime/keyed-task-scheduler.js";

describe("KeyedTaskScheduler", () => {
  it("validates limits and rejects work after shutdown", () => {
    expect(() => new KeyedTaskScheduler({ maxConcurrent: 0, maxQueuedPerKey: 1, maxQueuedTotal: 1 })).toThrow(
      "maxConcurrent must be a positive safe integer",
    );
    const scheduler = new KeyedTaskScheduler({ maxConcurrent: 1, maxQueuedPerKey: 1, maxQueuedTotal: 1 });
    expect(scheduler.enqueue("", async () => undefined)).toBe(false);
    scheduler.close();
    expect(scheduler.enqueue("closed", async () => undefined)).toBe(false);

    const dropping = new KeyedTaskScheduler({ maxConcurrent: 1, maxQueuedPerKey: 1, maxQueuedTotal: 1 });
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    expect(dropping.enqueue("busy", async () => blocked)).toBe(true);
    expect(
      dropping.enqueue(
        "queued",
        async () => undefined,
        () => {
          throw new Error("drop observer");
        },
      ),
    ).toBe(true);
    dropping.close();
    release?.();
  });

  it("serializes one key while allowing bounded work for another key", async () => {
    const scheduler = new KeyedTaskScheduler({ maxConcurrent: 2, maxQueuedPerKey: 2, maxQueuedTotal: 4 });
    const events: string[] = [];
    let releaseA1: (() => void) | undefined;
    let releaseB1: (() => void) | undefined;
    const a1 = new Promise<void>((resolve) => {
      releaseA1 = resolve;
    });
    const b1 = new Promise<void>((resolve) => {
      releaseB1 = resolve;
    });

    expect(
      scheduler.enqueue("a", async () => {
        events.push("a1:start");
        await a1;
        events.push("a1:end");
      }),
    ).toBe(true);
    expect(
      scheduler.enqueue("a", async () => {
        events.push("a2:start");
        events.push("a2:end");
      }),
    ).toBe(true);
    expect(
      scheduler.enqueue("b", async () => {
        events.push("b1:start");
        await b1;
        events.push("b1:end");
      }),
    ).toBe(true);

    await waitImmediate();
    expect(events).toEqual(["a1:start", "b1:start"]);
    releaseA1?.();
    await waitImmediate();
    expect(events).toEqual(["a1:start", "b1:start", "a1:end", "a2:start", "a2:end"]);
    releaseB1?.();
    await waitImmediate();
    expect(events.at(-1)).toBe("b1:end");
  });

  it("admits a queued key before a repeatedly replenished first key", async () => {
    const scheduler = new KeyedTaskScheduler({ maxConcurrent: 1, maxQueuedPerKey: 64, maxQueuedTotal: 128 });
    const events: string[] = [];
    let releaseA: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const pushA = (id: number, wait: Promise<void> | undefined) => async () => {
      events.push(`a${id}`);
      if (wait) await wait;
    };

    expect(scheduler.enqueue("a", pushA(1, gate))).toBe(true);
    expect(
      scheduler.enqueue("b", async () => {
        events.push("b");
      }),
    ).toBe(true);
    for (let id = 2; id <= 20; id += 1) {
      expect(scheduler.enqueue("a", pushA(id, undefined))).toBe(true);
    }

    releaseA?.();
    await vi.waitFor(() => expect(scheduler.stats().queued).toBe(0));
    expect(events.slice(0, 2)).toEqual(["a1", "b"]);
    expect(events).toHaveLength(21);
  });

  it("keeps admitting other keys while one lane refills itself", async () => {
    const scheduler = new KeyedTaskScheduler({ maxConcurrent: 1, maxQueuedPerKey: 4, maxQueuedTotal: 256 });
    const events: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let produced = 0;
    const produce = (): void => {
      produced += 1;
      const id = produced;
      expect(
        scheduler.enqueue("a", async () => {
          events.push(`a${id}`);
          if (id === 1) await gate;
          if (id < 100) produce();
        }),
      ).toBe(true);
    };

    produce();
    expect(
      scheduler.enqueue("b", async () => {
        events.push("b");
      }),
    ).toBe(true);
    releaseFirst?.();
    await vi.waitFor(() => expect(events).toHaveLength(101));
    expect(events.slice(0, 3)).toEqual(["a1", "b", "a2"]);
  });

  it("serves ready keys in arrival order when capacity exceeds one", async () => {
    const scheduler = new KeyedTaskScheduler({ maxConcurrent: 2, maxQueuedPerKey: 4, maxQueuedTotal: 8 });
    const events: string[] = [];
    let releaseA: (() => void) | undefined;
    let releaseB: (() => void) | undefined;
    const aGate = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const bGate = new Promise<void>((resolve) => {
      releaseB = resolve;
    });

    expect(
      scheduler.enqueue("a", async () => {
        events.push("a1:start");
        await aGate;
        events.push("a1:end");
      }),
    ).toBe(true);
    expect(
      scheduler.enqueue("b", async () => {
        events.push("b1:start");
        await bGate;
        events.push("b1:end");
      }),
    ).toBe(true);
    expect(
      scheduler.enqueue("a", async () => {
        events.push("a2");
      }),
    ).toBe(true);
    expect(
      scheduler.enqueue("b", async () => {
        events.push("b2");
      }),
    ).toBe(true);
    expect(
      scheduler.enqueue("c", async () => {
        events.push("c1");
      }),
    ).toBe(true);

    releaseA?.();
    await vi.waitFor(() => expect(events).toContain("a2"));
    expect(events.indexOf("c1")).toBeLessThan(events.indexOf("a2"));
    expect(events).not.toContain("b2");

    releaseB?.();
    await vi.waitFor(() => expect(events).toContain("b2"));
    expect(events.indexOf("b1:end")).toBeLessThan(events.indexOf("b2"));
  });

  it("preserves per-key FIFO without overlapping runs for one key", async () => {
    const scheduler = new KeyedTaskScheduler({ maxConcurrent: 3, maxQueuedPerKey: 8, maxQueuedTotal: 8 });
    const events: string[] = [];
    let activeRuns = 0;
    let maxActiveRuns = 0;
    const task = (id: number) => async () => {
      activeRuns += 1;
      maxActiveRuns = Math.max(maxActiveRuns, activeRuns);
      events.push(`start:${id}`);
      await waitImmediate();
      events.push(`end:${id}`);
      activeRuns -= 1;
    };

    for (let id = 1; id <= 5; id += 1) expect(scheduler.enqueue("a", task(id))).toBe(true);
    await vi.waitFor(() => expect(events).toHaveLength(10));
    expect(events).toEqual([1, 2, 3, 4, 5].flatMap((id) => [`start:${id}`, `end:${id}`]));
    expect(maxActiveRuns).toBe(1);
  });

  it("reclaims lanes and keeps arrival order across many keys", async () => {
    const scheduler = new KeyedTaskScheduler({ maxConcurrent: 1, maxQueuedPerKey: 1, maxQueuedTotal: 300 });
    const events: string[] = [];
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    expect(
      scheduler.enqueue("hold", async () => {
        await gate;
      }),
    ).toBe(true);
    for (let index = 0; index < 200; index += 1) {
      expect(
        scheduler.enqueue(`key-${index}`, async () => {
          events.push(`key-${index}`);
        }),
      ).toBe(true);
    }
    expect(scheduler.stats()).toMatchObject({ active: 1, queued: 200, lanes: 201 });

    release?.();
    await vi.waitFor(() => expect(events).toHaveLength(200));
    await waitImmediate();
    expect(events[0]).toBe("key-0");
    expect(events.at(-1)).toBe("key-199");
    expect(scheduler.stats()).toMatchObject({ active: 0, queued: 0, lanes: 0 });
  });

  it("rejects queue overflow without creating unbounded work", async () => {
    const scheduler = new KeyedTaskScheduler({ maxConcurrent: 1, maxQueuedPerKey: 1, maxQueuedTotal: 1 });
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    expect(scheduler.enqueue("a", async () => blocked)).toBe(true);
    expect(scheduler.enqueue("a", async () => undefined)).toBe(true);
    expect(scheduler.enqueue("a", async () => undefined)).toBe(false);
    expect(scheduler.enqueue("b", async () => undefined)).toBe(false);
    release?.();
    await waitImmediate();
    scheduler.close();
  });

  it("reports queue age from an injected clock while preserving independent lanes", async () => {
    let now = 1_000;
    const scheduler = new KeyedTaskScheduler({
      maxConcurrent: 1,
      maxQueuedPerKey: 2,
      maxQueuedTotal: 3,
      now: () => now,
    });
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    expect(scheduler.enqueue("a", async () => blocked)).toBe(true);
    expect(scheduler.enqueue("b", async () => undefined)).toBe(true);
    now = 1_250;
    expect(scheduler.stats()).toMatchObject({ active: 1, queued: 1, lanes: 2, oldestQueueAgeMs: 250 });
    release?.();
    await waitImmediate();
    scheduler.close();
  });

  it("supervises rejected task promises with one structured event and counter", async () => {
    const events: unknown[] = [];
    const counters: unknown[] = [];
    const supervisor = new BackgroundFailureSupervisor({
      onEvent: (event) => events.push(event),
      onCounter: (name, labels) => counters.push({ name, labels }),
    });
    const scheduler = new KeyedTaskScheduler({
      maxConcurrent: 1,
      maxQueuedPerKey: 1,
      maxQueuedTotal: 1,
      supervisor,
    });
    expect(
      scheduler.enqueue("agent-1", async () => {
        throw new Error("task failed");
      }),
    ).toBe(true);
    await waitImmediate();
    await vi.waitFor(() => expect(events).toHaveLength(1));
    expect(counters).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "diagnostic.error",
      error: {
        code: "RUNTIME_SCHEDULER_TASK_FAILED",
        category: "internal",
        retryability: "never",
        phase: "scheduler",
        requestId: "agent-1",
      },
    });
    scheduler.close();
  });
});
