import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  type CloudLatencyRecord,
  CloudLatencyRecorder,
  CloudLatencyRecordSchema,
  cloudLatencySessions,
} from "../cloud-latency.js";

const sessionId = randomUUID();
const enabled = {
  OPENTAG_ENV: "staging",
  OPENTAG_CLOUD_LATENCY_DIAGNOSTICS: "true",
  OPENTAG_CLOUD_LATENCY_SESSION_IDS: sessionId,
};

function fixture(write?: (record: CloudLatencyRecord) => void) {
  const records: CloudLatencyRecord[] = [];
  let time = 0;
  const recorder = new CloudLatencyRecorder({
    context: { sessionId, turnId: randomUUID() },
    clockId: randomUUID(),
    service: "runner",
    revision: "secret:invalid",
    now: () => time,
    utc: () => "2026-11-03T03:00:00.000Z",
    write: write ?? ((record) => records.push(record)),
  });
  return {
    records,
    recorder,
    advance: (value: number) => {
      time += value;
    },
  };
}

describe("bounded Cloud latency diagnostics", () => {
  it("requires staging, an explicit flag and at most 16 valid Session selectors", () => {
    expect([...cloudLatencySessions(enabled)]).toEqual([sessionId]);
    for (const env of [
      {},
      { ...enabled, OPENTAG_ENV: "production" },
      { ...enabled, OPENTAG_CLOUD_LATENCY_DIAGNOSTICS: "1" },
      { ...enabled, OPENTAG_CLOUD_LATENCY_SESSION_IDS: "" },
      { ...enabled, OPENTAG_CLOUD_LATENCY_SESSION_IDS: "secret" },
      { ...enabled, OPENTAG_CLOUD_LATENCY_SESSION_IDS: Array(17).fill(sessionId).join(",") },
    ]) {
      expect(cloudLatencySessions(env).size).toBe(0);
    }
  });

  it("records monotonic phases and preserves the original operation result and rejection", async () => {
    const f = fixture();
    expect(
      await f.recorder.measure("checkpoint", async () => {
        f.advance(25);
        return 42;
      }),
    ).toBe(42);
    const failure = new Error("private provider body");
    await expect(
      f.recorder.measure("report_ack", async () => {
        f.advance(5);
        throw failure;
      }),
    ).rejects.toBe(failure);
    f.recorder.finish("failed");
    expect(f.records.map((record) => record.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(f.records[1]).toMatchObject({
      phase: "checkpoint",
      durationMs: 25,
      event: "end",
      revision: "unknown",
      severity: "INFO",
    });
    expect(f.records[3]).toMatchObject({ event: "failure", durationMs: 5 });
    expect(f.records[4]).toMatchObject({ event: "summary", outcome: "failed", durationMs: 30 });
    expect(JSON.stringify(f.records)).not.toMatch(/secret|private provider body/);
    for (const record of f.records) expect(CloudLatencyRecordSchema.safeParse(record).success).toBe(true);
  });

  it("reserves a summary within 32 records and 64 KiB, then stops permanently", () => {
    const f = fixture();
    for (let index = 0; index < 100; index++) {
      f.recorder.start("worker_execution");
      f.advance(1);
      f.recorder.end("worker_execution");
    }
    f.recorder.finish("completed");
    f.recorder.finish("completed");
    f.recorder.start("checkpoint");
    f.recorder.end("checkpoint");
    expect(f.records).toHaveLength(32);
    expect(f.records.at(-1)).toMatchObject({ event: "summary", diagnosticIncomplete: true });
    expect(Buffer.byteLength(f.records.map((record) => JSON.stringify(record)).join("\n"))).toBeLessThan(64 * 1024);
  });

  it("classifies an unavailable boolean result without changing it into an exception", async () => {
    const f = fixture();
    expect(await f.recorder.measure("allocation_wait", async () => false, { falseIsFailure: true })).toBe(false);
    f.recorder.finish("incomplete");
    expect(f.records[1]).toMatchObject({ event: "failure", phase: "allocation_wait", outcome: "failed" });
    expect(f.records.at(-1)).toMatchObject({ outcome: "incomplete", diagnosticIncomplete: true });
  });

  it("marks missing/duplicate phases and explicit truncation without inventing duration", () => {
    const f = fixture();
    f.recorder.end("checkpoint");
    f.recorder.start("report_ack");
    f.recorder.start("report_ack");
    f.recorder.markIncomplete();
    f.recorder.finish("incomplete");
    expect(f.records.at(-1)?.diagnosticIncomplete).toBe(true);
    expect(f.records.some((record) => record.phase === "checkpoint")).toBe(false);
  });

  it("logging throws and invalid clocks cannot replace an operation result", async () => {
    const f = fixture(() => {
      throw new Error("EPIPE");
    });
    expect(await f.recorder.measure("checkpoint", async () => "unchanged")).toBe("unchanged");
    expect(() => f.recorder.finish("completed")).not.toThrow();
    const skewed = fixture();
    skewed.recorder.start("checkpoint");
    skewed.advance(-1);
    skewed.recorder.end("checkpoint");
    skewed.advance(2);
    skewed.recorder.finish("completed");
    expect(skewed.records.at(-1)?.diagnosticIncomplete).toBe(true);
  });

  it("rejects arbitrary payload fields, unsafe revisions and invalid identities", () => {
    const f = fixture();
    f.recorder.finish("completed");
    expect(CloudLatencyRecordSchema.safeParse({ ...f.records[0], prompt: "secret" }).success).toBe(false);
    expect(CloudLatencyRecordSchema.safeParse({ ...f.records[0], revision: "Bearer_secret" }).success).toBe(false);
    expect(
      () =>
        new CloudLatencyRecorder({
          context: { sessionId: "not-a-session" },
          clockId: randomUUID(),
          service: "server",
          revision: undefined,
          write: () => undefined,
        }),
    ).toThrow();
  });
});
