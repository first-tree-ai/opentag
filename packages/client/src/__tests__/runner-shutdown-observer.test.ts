import { describe, expect, it, vi } from "vitest";
import type { CloudTurnScope } from "../runner/cloud-turns.js";
import { RunnerShutdownObserver, type RunnerShutdownRecord } from "../runner/shutdown-observer.js";

const sessionId = "22222222-2222-4222-8222-222222222222";
const scope: CloudTurnScope = {
  sessionId,
  sandboxId: "11111111-1111-4111-8111-111111111111",
  environmentGeneration: 2,
  resourceName: "must-not-be-logged",
};
const selected = {
  OPENTAG_ENV: "staging",
  OPENTAG_CLOUD_LATENCY_DIAGNOSTICS: "true",
  OPENTAG_CLOUD_LATENCY_SESSION_IDS: sessionId,
  OPENTAG_REVISION: "a".repeat(40),
};

function fixture(
  input: {
    env?: Record<string, string | undefined>;
    assignment?: () => CloudTurnScope | undefined;
    write?: (record: RunnerShutdownRecord) => void;
  } = {},
) {
  const records: RunnerShutdownRecord[] = [];
  let now = 100;
  const observer = new RunnerShutdownObserver({
    env: input.env ?? selected,
    assignment: input.assignment ?? (() => scope),
    write: (record) => {
      input.write?.(record);
      records.push(record);
    },
    now: () => now,
    utc: () => "2026-11-03T00:00:00.000Z",
  });
  return { observer, records, advance: (ms: number) => (now += ms) };
}

async function complete(observer: RunnerShutdownObserver): Promise<void> {
  await observer.measure("controller_drain", async () => undefined);
  await observer.measure("native_cleanup", async () => true, { falseIsFailure: true });
  await observer.measure("gateway_health_close", async () => undefined);
  observer.finish(true);
}

describe("Runner shutdown diagnostics", () => {
  it.each([
    {},
    { ...selected, OPENTAG_ENV: "production" },
    { ...selected, OPENTAG_CLOUD_LATENCY_DIAGNOSTICS: "false" },
    { ...selected, OPENTAG_CLOUD_LATENCY_SESSION_IDS: "invalid" },
    { ...selected, OPENTAG_CLOUD_LATENCY_SESSION_IDS: Array(17).fill(sessionId).join(",") },
    { ...selected, OPENTAG_CLOUD_LATENCY_SESSION_IDS: scope.sandboxId },
  ])("keeps work unchanged without valid explicit Staging selection: %j", async (env) => {
    const { observer, records } = fixture({ env });
    const action = vi.fn(async () => 42);
    observer.start("request");
    expect(await observer.measure("native_cleanup", action)).toBe(42);
    await complete(observer);
    expect(action).toHaveBeenCalledOnce();
    expect(records).toEqual([]);
  });

  it("requires a prior authenticated welcome and never adopts a later one after stopping", async () => {
    let current: CloudTurnScope | undefined;
    const { observer, records } = fixture({ assignment: () => current });
    observer.start("request");
    current = scope;
    observer.start("exit");
    await complete(observer);
    expect(records).toEqual([]);
  });

  it("captures only explicit correlation fields and measures delayed work in one process clock", async () => {
    let current: CloudTurnScope | undefined = scope;
    const { observer, records, advance } = fixture({
      assignment: () => current,
      env: { ...selected, OPENTAG_REVISION: "secret-invalid-revision", TOKEN: "secret-token" },
    });
    observer.start("request");
    current = { ...scope, sessionId: "33333333-3333-4333-8333-333333333333" };
    await observer.measure("controller_drain", async () => advance(30));
    await observer.measure("native_cleanup", async () => advance(250));
    await observer.measure("gateway_health_close", async () => advance(20));
    observer.finish(true);
    expect(records.map((record) => record.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(records.filter((record) => record.event === "end").map((record) => record.durationMs)).toEqual([
      30, 250, 20,
    ]);
    expect(records.at(-1)).toMatchObject({
      outcome: "completed",
      diagnosticIncomplete: false,
      elapsedMs: 300,
      durationMs: 300,
    });
    expect(new Set(records.map((record) => record.clockId)).size).toBe(1);
    expect(records.every((record) => record.sessionId === sessionId && record.revision === "unknown")).toBe(true);
    expect(JSON.stringify(records)).not.toMatch(/secret|must-not-be-logged|resourceName|turnId|messageId/);
  });

  it("does not mask the original rejection when a diagnostic writer fails", async () => {
    let fail = true;
    const { observer, records } = fixture({
      write: () => {
        if (fail) throw new Error("sink failed");
      },
    });
    observer.start("request");
    fail = false;
    const original = new Error("private cleanup failure");
    await expect(
      observer.measure("native_cleanup", async () => {
        throw original;
      }),
    ).rejects.toBe(original);
    observer.finish(false);
    expect(records.at(-1)).toMatchObject({ outcome: "failed", diagnosticIncomplete: true });
    expect(records[0]?.seq).toBe(2);
    expect(JSON.stringify(records)).not.toContain(original.message);
  });

  it("keeps false cleanup results and failures distinct from a successful complete shutdown", async () => {
    const { observer, records } = fixture();
    observer.start("exit");
    await observer.measure("controller_drain", async () => undefined);
    expect(await observer.measure("native_cleanup", async () => false, { falseIsFailure: true })).toBe(false);
    await observer.measure("gateway_health_close", async () => undefined);
    observer.finish(true);
    expect(records.find((record) => record.event === "failure")).toMatchObject({ phase: "native_cleanup" });
    expect(records.at(-1)).toMatchObject({ trigger: "exit", outcome: "failed", diagnosticIncomplete: false });
  });

  it("finalizes interrupted cleanup without replacing its exception", async () => {
    const { observer, records } = fixture();
    const original = new Error("original cleanup failure");
    await expect(
      observer.cleanup(async () => {
        await observer.measure("controller_drain", async () => {
          throw original;
        });
      }),
    ).rejects.toBe(original);
    expect(records.at(-1)).toMatchObject({ trigger: "exit", outcome: "failed", diagnosticIncomplete: true });
  });

  it("never reopens budgets on repeated stop, phase, or finish calls", async () => {
    const { observer, records } = fixture();
    observer.start("request");
    observer.start("request");
    const action = vi.fn(async () => true);
    for (let i = 0; i < 100; i++) await observer.measure("native_cleanup", action);
    await observer.measure("controller_drain", async () => undefined);
    await observer.measure("gateway_health_close", async () => undefined);
    observer.finish(true);
    observer.finish(true);
    await observer.measure("native_cleanup", action);
    expect(action).toHaveBeenCalledTimes(101);
    expect(records).toHaveLength(8);
    expect(Buffer.byteLength(JSON.stringify(records))).toBeLessThan(16 * 1024);
    expect(records.at(-1)).toMatchObject({ outcome: "incomplete", diagnosticIncomplete: true });
  });

  it("marks an unfinished phase as incomplete and emits nothing after the summary", async () => {
    const { observer, records } = fixture();
    observer.start("request");
    let resolve: (() => void) | undefined;
    const pending = observer.measure(
      "native_cleanup",
      () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
    );
    observer.finish(false);
    expect(records.at(-1)).toMatchObject({ outcome: "incomplete", diagnosticIncomplete: true });
    resolve?.();
    await pending;
    expect(records).toHaveLength(3);
  });
});
