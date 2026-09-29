import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseClient } from "../db/client.js";
import { type ScheduleClaimOutcome, ScheduleScheduler, scheduledMessageId } from "../services/schedules/index.js";
import type { ScheduledMessageSnapshot } from "../services/sessions/session-collaboration-service.js";

/*
 * Loop mechanics of the five-second scanner with fully fake ports (no database): non-reentrancy
 * and the 100-per-scan / 100-in-flight bounds (D01), slot starvation and recovery (D14), a hung
 * hand-off never blocking later scans (D15 loop half), and stop semantics (D18 loop half). The
 * claim and dispatch internals are covered by the PGlite and PostgreSQL suites.
 */

const T0 = new Date("2026-09-28T01:00:00.000Z");

function makeSnapshot(scheduleId: string, scheduledFor = T0): ScheduledMessageSnapshot {
  return {
    scheduleId,
    revision: 1,
    agentId: randomUUID(),
    targetSessionId: randomUUID(),
    messageId: scheduledMessageId(scheduleId, scheduledFor),
    content: "Check the build.",
    origin: {
      scheduleId,
      scheduledFor: scheduledFor.toISOString(),
      timezone: "Asia/Shanghai",
      name: "Daily check",
    },
    attemptedAt: scheduledFor,
    detailUrl: `https://opentag.example.com/agents/x?schedule=${scheduleId}`,
  };
}

interface LoopFixture {
  scheduler: ScheduleScheduler;
  claim: ReturnType<typeof vi.fn>;
  dispatch: ReturnType<typeof vi.fn>;
  listDue: ReturnType<typeof vi.fn>;
  outcomes: ScheduledMessageSnapshot[];
}

function makeLoop(options: { maxInFlight?: number; scanLimit?: number; scanIntervalMs?: number } = {}): LoopFixture {
  const claim = vi.fn();
  const listDue = vi.fn<(limit: number) => Promise<readonly string[]>>().mockResolvedValue([]);
  const dispatch = vi.fn();
  const scheduler = new ScheduleScheduler({
    database: {} as DatabaseClient,
    dispatch: { dispatchScheduledMessage: dispatch },
    sessions: { resolveScheduledMessageRoute: vi.fn() },
    publicUrl: "https://opentag.example.com",
    listDue,
    claimOccurrence: claim,
    scanIntervalMs: options.scanIntervalMs ?? 5_000,
    scanLimit: options.scanLimit ?? 100,
    maxInFlight: options.maxInFlight ?? 100,
  });
  return { scheduler, claim, dispatch, listDue, outcomes: [] };
}

function claimed(id: string): ScheduleClaimOutcome {
  return { kind: "claimed", snapshot: makeSnapshot(id) };
}

describe("scheduledMessageId", () => {
  it("matches the documented UUIDv5 gold sample (D12)", () => {
    expect(scheduledMessageId("00000000-0000-4000-8000-000000000001", new Date("2026-09-28T01:00:00.000Z"))).toBe(
      "ad15e84d-8ed3-571f-a526-e220550ca6a0",
    );
  });

  it("is stable per schedule and occurrence and distinct across them", () => {
    const id = randomUUID();
    const first = scheduledMessageId(id, T0);
    expect(scheduledMessageId(id, T0)).toBe(first);
    expect(scheduledMessageId(id, new Date(T0.getTime() + 60_000))).not.toBe(first);
    expect(scheduledMessageId(randomUUID(), T0)).not.toBe(first);
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe("ScheduleScheduler scan loop", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("never re-enters the claim phase and checks at most 100 due rows in order (D01)", async () => {
    const fixture = makeLoop();
    const ids = Array.from({ length: 101 }, () => randomUUID());
    fixture.listDue.mockResolvedValue(ids.slice(0, 100));
    let releaseFirst: (value: ScheduleClaimOutcome) => void = () => undefined;
    let first = true;
    fixture.claim.mockImplementation(() => {
      if (first) {
        first = false;
        return new Promise<ScheduleClaimOutcome>((resolve) => (releaseFirst = resolve));
      }
      return Promise.resolve<ScheduleClaimOutcome>({ kind: "none" });
    });
    fixture.dispatch.mockResolvedValue({ outcome: "accepted", code: null });

    fixture.scheduler.start();
    // The immediate scan is mid-claim; five-second ticks pile up but none re-enter.
    await vi.advanceTimersByTimeAsync(15_000);
    expect(fixture.claim).toHaveBeenCalledTimes(1);
    expect(fixture.listDue).toHaveBeenCalledTimes(1);

    releaseFirst({ kind: "none" });
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.claim).toHaveBeenCalledTimes(100);
    for (const [index, id] of ids.slice(0, 100).entries()) {
      expect(fixture.claim.mock.calls[index]).toEqual([id, true]);
    }
    // The 101st due row waits for a later scan (the fake due list only ever exposes 100).
    await vi.advanceTimersByTimeAsync(5_000);
    expect(fixture.listDue).toHaveBeenCalledTimes(2);
    await fixture.scheduler.stop();
  });

  it("claims deliverable rows only with a free slot and recovers when one opens (D14)", async () => {
    const fixture = makeLoop({ maxInFlight: 2 });
    const [a, b, c] = [randomUUID(), randomUUID(), randomUUID()];
    fixture.listDue.mockResolvedValue([a, b, c]);
    fixture.claim.mockImplementation(async (id: string, allow: boolean) =>
      allow ? claimed(id) : ({ kind: "deferred" } as const),
    );
    const gates: (() => void)[] = [];
    fixture.dispatch.mockImplementation(
      () => new Promise((resolve) => gates.push(() => resolve({ outcome: "accepted", code: null }))),
    );

    await fixture.scheduler.scanNow();
    // Two slots: the third deliverable row was claimed in skip-only mode and left untouched.
    expect(fixture.claim.mock.calls).toEqual([
      [a, true],
      [b, true],
      [c, false],
    ]);
    expect(fixture.dispatch).toHaveBeenCalledTimes(2);
    expect(fixture.scheduler.inFlightCount).toBe(2);

    // While the slots stay occupied the next scan keeps deferring the row.
    await fixture.scheduler.scanNow();
    expect(fixture.claim.mock.calls.at(-3)).toEqual([a, false]);

    // A settled hand-off frees its slot without waiting for the business result.
    gates[0]?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.scheduler.inFlightCount).toBe(1);
    await fixture.scheduler.scanNow();
    expect(fixture.claim.mock.calls.at(-3)).toEqual([a, true]);
    expect(fixture.dispatch).toHaveBeenCalledTimes(3);
    for (const release of gates.slice(1)) release();
    await vi.advanceTimersByTimeAsync(0);
    await fixture.scheduler.stop();
  });

  it("keeps scanning while a slow hand-off occupies its slot (D15 loop half)", async () => {
    const fixture = makeLoop({ maxInFlight: 1 });
    const [slowId, nextId] = [randomUUID(), randomUUID()];
    fixture.claim.mockImplementation(async (id: string) => claimed(id));
    // The first dispatch never settles (a cold start hanging on the receipt); it occupies the
    // single slot, so the next scan defers — but the scan itself completes and later scans run.
    fixture.dispatch.mockImplementationOnce(
      (_snapshot: ScheduledMessageSnapshot, signal: AbortSignal) =>
        new Promise((resolve) => {
          signal.addEventListener("abort", () => resolve({ outcome: "unreachable", code: "delivery_timeout" }), {
            once: true,
          });
        }),
    );
    fixture.dispatch.mockResolvedValue({ outcome: "accepted", code: null });

    fixture.listDue.mockResolvedValueOnce([slowId]).mockResolvedValueOnce([nextId]).mockResolvedValue([]);
    await fixture.scheduler.scanNow();
    expect(fixture.scheduler.inFlightCount).toBe(1);
    await fixture.scheduler.scanNow();
    expect(fixture.claim.mock.calls[1]).toEqual([nextId, false]);

    // Stopping aborts the hung hand-off, which converges and releases the slot.
    await fixture.scheduler.stop();
    expect(fixture.scheduler.inFlightCount).toBe(0);
  });

  it("survives claim failures per row and never lets a dispatch rejection escape (D07 loop half)", async () => {
    const fixture = makeLoop();
    const [badId, goodId] = [randomUUID(), randomUUID()];
    fixture.listDue.mockResolvedValue([badId, goodId]);
    fixture.claim
      .mockRejectedValueOnce(new Error("connection reset"))
      .mockImplementation(async (id: string) => claimed(id));
    // A dispatch that rejects unexpectedly is converged and logged, never unhandled.
    fixture.dispatch.mockRejectedValueOnce(new Error("boom"));
    await fixture.scheduler.scanNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.scheduler.inFlightCount).toBe(0);
    expect(fixture.claim).toHaveBeenCalledTimes(2);
    await fixture.scheduler.stop();
  });

  it("frees the slot even when the dispatch throws synchronously (slot-leak regression)", async () => {
    const fixture = makeLoop();
    const id = randomUUID();
    fixture.listDue.mockResolvedValue([id]);
    fixture.claim.mockImplementation(async (claimId: string) => claimed(claimId));
    // A synchronous throw from the dispatch entry must still release the slot it was given.
    fixture.dispatch.mockImplementation(() => {
      throw new Error("synchronous dispatch failure");
    });
    await fixture.scheduler.scanNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(fixture.scheduler.inFlightCount).toBe(0);
    // No leak: the next scan claims with a free slot again.
    await fixture.scheduler.scanNow();
    expect(fixture.claim).toHaveBeenCalledTimes(2);
    expect(fixture.dispatch).toHaveBeenCalledTimes(2);
    await fixture.scheduler.stop();
  });

  it("stops claiming and cancels not-yet-settled hand-offs on stop (D18 loop half)", async () => {
    const fixture = makeLoop();
    const ids = [randomUUID(), randomUUID(), randomUUID()];
    fixture.listDue.mockResolvedValue(ids);
    const seenSignals: AbortSignal[] = [];
    fixture.claim.mockImplementation(async (id: string, allow: boolean) => {
      if (id === ids[1]) void fixture.scheduler.stop();
      return allow ? claimed(id) : ({ kind: "deferred" } as const);
    });
    fixture.dispatch.mockImplementation((_snapshot: ScheduledMessageSnapshot, signal: AbortSignal) => {
      seenSignals.push(signal);
      return new Promise((resolve) => {
        signal.addEventListener("abort", () => resolve({ outcome: "unreachable", code: "delivery_timeout" }), {
          once: true,
        });
      });
    });

    await fixture.scheduler.scanNow();
    // Stop landed mid-scan: the first dispatch was aborted, the third row was never claimed.
    expect(seenSignals).toHaveLength(1);
    expect(seenSignals[0]?.aborted).toBe(true);
    expect(fixture.claim).toHaveBeenCalledTimes(2);
    await fixture.scheduler.scanNow();
    expect(fixture.listDue).toHaveBeenCalledTimes(1);
  });
});
