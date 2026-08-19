import { setImmediate as waitImmediate } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { KeyedTaskScheduler } from "../runtime/keyed-task-scheduler.js";

describe("KeyedTaskScheduler", () => {
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
});
