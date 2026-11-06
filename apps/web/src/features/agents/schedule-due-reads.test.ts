import { describe, expect, it } from "vitest";
import { DUE_READ_ATTEMPTS, type DueObservation, planDueReads } from "./schedule-due-reads.js";

const START = "2026-10-26T08:01:00.000Z";
const NEXT = "2026-10-26T08:04:00.000Z";
const ID = "5238c0ee-a939-4bc0-8772-66d46c9df934";
const row = (nextTriggerAt: string | null = START, enabled = true) => ({ id: ID, enabled, nextTriggerAt });

/**
 * Runs minute ticks against one row. `advanceAt[i]` is the timestamp the read issued at tick `i`
 * observed, modelling the Server's five-second scan landing after that read.
 */
function ticks(points: string[], advanceAt: ReadonlyMap<number, string>) {
  let observations = new Map<string, DueObservation>();
  let current: string = START;
  let reads = 0;
  const readFlags: boolean[] = [];
  points.forEach((now, index) => {
    const planned = planDueReads([row(current)], Date.parse(now), observations);
    observations = planned.next;
    if (planned.read) reads += 1;
    readFlags.push(planned.read);
    const advanced = advanceAt.get(index);
    if (advanced !== undefined) current = advanced;
  });
  return { reads, readFlags, current };
}

describe("planDueReads", () => {
  it("keeps the retry path when the first due read precedes the scheduler scan", () => {
    // 08:00 mount; the 08:01 read lands before the scan and still reports 08:01; 08:02 must read again.
    const result = ticks(
      ["2026-10-26T08:00:00.000Z", "2026-10-26T08:01:00.000Z", "2026-10-26T08:02:00.000Z", "2026-10-26T08:03:00.000Z"],
      new Map([
        [1, START],
        [2, NEXT],
      ]),
    );
    expect(result.readFlags).toEqual([false, true, true, false]);
    expect(result.reads).toBe(2);
    expect(result.current).toBe(NEXT);
    // With the advanced occurrence still in the future, nothing is read.
    const settled = planDueReads(
      [row(NEXT)],
      Date.parse("2026-10-26T08:03:00.000Z"),
      new Map([[ID, { nextTriggerAt: NEXT, attempts: 2, tick: Date.parse("2026-10-26T08:02:00.000Z") }]]),
    );
    expect(settled.read).toBe(false);
  });

  it("stops after the bounded attempts on an occurrence the Server never advances", () => {
    const result = ticks(
      [
        "2026-10-26T08:00:00.000Z",
        "2026-10-26T08:01:00.000Z",
        "2026-10-26T08:02:00.000Z",
        "2026-10-26T08:03:00.000Z",
        "2026-10-26T08:04:00.000Z",
        "2026-10-26T08:05:00.000Z",
      ],
      new Map(),
    );
    expect(result.readFlags).toEqual([false, true, true, true, false, false]);
    expect(result.reads).toBe(DUE_READ_ATTEMPTS);
  });

  it("issues at most one read per minute tick", () => {
    const observations = new Map<string, DueObservation>([
      [ID, { nextTriggerAt: START, attempts: 1, tick: Date.parse("2026-10-26T08:01:00.000Z") }],
    ]);
    const planned = planDueReads([row()], Date.parse("2026-10-26T08:01:00.000Z"), observations);
    expect(planned.read).toBe(false);
    expect(planned.next.get(ID)?.attempts).toBe(1);
  });

  it("keeps a failed read retryable within the same budget", () => {
    let observations = new Map<string, DueObservation>();
    const readFlags: boolean[] = [];
    for (const now of ["08:01", "08:02", "08:03", "08:04"]) {
      const planned = planDueReads([row()], Date.parse(`2026-10-26T${now}:00.000Z`), observations);
      observations = planned.next;
      readFlags.push(planned.read);
    }
    // The attempt is charged when issued, so an error does not consume the whole opportunity.
    expect(readFlags).toEqual([true, true, true, false]);
  });

  it("starts a fresh budget once the Server advances", () => {
    const planned = planDueReads(
      [row(NEXT)],
      Date.parse("2026-10-26T08:04:00.000Z"),
      new Map([
        [ID, { nextTriggerAt: START, attempts: DUE_READ_ATTEMPTS, tick: Date.parse("2026-10-26T08:03:00.000Z") }],
      ]),
    );
    expect(planned.read).toBe(true);
    expect(planned.next.get(ID)?.attempts).toBe(1);
  });

  it("spends no budget on paused or not-yet-due rows", () => {
    const paused = planDueReads([row(START, false)], Date.parse("2026-10-26T08:01:00.000Z"), new Map());
    expect(paused.read).toBe(false);
    expect(paused.next.size).toBe(0);
    const future = planDueReads([row(NEXT)], Date.parse("2026-10-26T08:01:00.000Z"), new Map());
    expect(future.read).toBe(false);
    expect(future.next.size).toBe(0);
  });

  it("merges several due rows into one read and drops rows that left the list", () => {
    const planned = planDueReads(
      [row(), { id: "b", enabled: true, nextTriggerAt: START }],
      Date.parse("2026-10-26T08:01:00.000Z"),
      new Map(),
    );
    expect(planned.read).toBe(true);
    expect([...planned.next.values()].map((entry) => entry.attempts)).toEqual([1, 1]);
    const gone = planDueReads(
      [],
      Date.parse("2026-10-26T08:01:00.000Z"),
      new Map([[ID, { nextTriggerAt: START, attempts: 1, tick: 0 }]]),
    );
    expect(gone.next.size).toBe(0);
  });
});
