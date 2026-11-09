import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { type CloudLatencyRecord, CloudLatencyRecorder } from "@opentag/shared";
import { describe, expect, it } from "vitest";
import { aggregateLatency, type LatencyReportOptions } from "../cloud-latency-report.js";

const sessionId = randomUUID();
const sandboxId = randomUUID();
const utc = "2026-11-03T03:00:00.000Z";
const options: LatencyReportOptions = {
  from: "2026-11-03T00:00:00.000Z",
  to: "2026-11-04T00:00:00.000Z",
  expectedTurns: 1,
  cohort: "cold",
  sessions: [sessionId],
};

function trace(outcome: "completed" | "failed" | "unknown" | "cancelled" = "completed") {
  const records: CloudLatencyRecord[] = [];
  let time = 0;
  const recorder = new CloudLatencyRecorder({
    context: { sessionId, sandboxId, environmentGeneration: 1, turnId: randomUUID() },
    clockId: randomUUID(),
    service: "runner",
    revision: "a".repeat(40),
    now: () => time,
    utc: () => utc,
    write: (record) => records.push(record),
  });
  for (const phase of ["worker_execution", "checkpoint", "report_ack"] as const) {
    recorder.start(phase);
    time += 10;
    recorder.end(phase);
  }
  recorder.finish(outcome);
  return records;
}
const lines = (records: unknown[]) => records.map((record) => JSON.stringify(record)).join("\n");

describe("read-only Staging latency aggregation", () => {
  it("keeps the declared population, phase quantiles and true observation boundary separate", () => {
    const records = Array.from({ length: 100 }, () => trace()).flat();
    const result = aggregateLatency(lines(records), { ...options, expectedTurns: 102 });
    expect(result.population).toMatchObject({
      declared: 102,
      observed: 100,
      completed: 100,
      missing: 2,
      timeout: null,
      timeoutRate: null,
    });
    expect(result.endToEnd.available).toBe(false);
    expect(result.metrics[`opentag-runner/${"a".repeat(40)}/2026-11-03/checkpoint`]).toEqual({
      n: 100,
      p50: 10,
      p90: 10,
      p95: 10,
      p99: null,
    });
    expect(result.metrics[`opentag-runner/${"a".repeat(40)}/2026-11-03/worker_observation_to_ack`]?.p50).toBe(30);
    expect(JSON.stringify(result)).not.toContain(sessionId);
    expect(JSON.stringify(result)).not.toContain(sandboxId);
    expect(JSON.stringify(result)).not.toContain(records[0]?.turnId);
  });

  it("counts the first Turn observation once using the Runner receive duration", () => {
    const record = {
      module: "cloud-pi",
      operation: "pi.diagnostic",
      sessionId,
      sandboxId,
      environmentGeneration: 1,
      turnId: randomUUID(),
      phase: "prompt_acceptance",
      event: "milestone",
      milestone: "first_turn_start",
      timestamp: utc,
      seq: 8,
      receivedElapsedMs: 72,
      elapsedMs: 50,
    };
    const result = aggregateLatency(lines([record, { ...record, seq: 9 }]), options);
    expect(result.metrics["pi/2026-11-03/native_exec_to_first_turn_observed"]).toMatchObject({ n: 1, p50: 72 });
    expect(result.evidence.duplicatePi).toBe(1);
    expect(result.endToEnd.available).toBe(false);
  });

  it("supports P99 only for at least 1,000 valid measurements", () => {
    const records = Array.from({ length: 1000 }, () => trace()).flat();
    const result = aggregateLatency(lines(records), { ...options, expectedTurns: 1000 });
    expect(result.metrics[`opentag-runner/${"a".repeat(40)}/2026-11-03/checkpoint`]?.p99).toBe(10);
  });

  it("excludes non-dispatch allocation failures while retaining a later successful attempt", async () => {
    const records: CloudLatencyRecord[] = [];
    const deliveryId = randomUUID();
    const clockId = randomUUID();
    let time = 0;
    const make = (attempt: number) =>
      new CloudLatencyRecorder({
        context: { sessionId, deliveryId, attempt },
        clockId,
        service: "server",
        revision: "a".repeat(40),
        now: () => time,
        utc: () => utc,
        write: (record) => records.push(record),
      });
    const waiting = make(1);
    await waiting.measure("allocation_wait", async () => false, { falseIsFailure: true });
    waiting.finish("incomplete");
    const retry = make(2);
    retry.start("allocation_wait");
    time += 50;
    retry.end("allocation_wait");
    retry.finish("completed");
    const result = aggregateLatency(lines(records), options);
    expect(result.metrics[`opentag-server/${"a".repeat(40)}/2026-11-03/allocation_wait`]).toMatchObject({
      n: 1,
      p50: 50,
    });
    expect(result.evidence.incompleteTraces).toBe(1);
    expect(result.evidence.failedPhaseObservations).toBe(1);
  });

  it("reports incomplete evidence for gaps, duplicates, reversed clocks, missing starts or summary", () => {
    for (const mutate of [
      (records: CloudLatencyRecord[]) => records.splice(0, 1),
      (records: CloudLatencyRecord[]) => records.splice(2, 0, records[1] as CloudLatencyRecord),
      (records: CloudLatencyRecord[]) => {
        (records[2] as CloudLatencyRecord).elapsedMs = 1;
      },
      (records: CloudLatencyRecord[]) => {
        (records[1] as CloudLatencyRecord).durationMs = 10000;
      },
      (records: CloudLatencyRecord[]) => records.pop(),
      (records: CloudLatencyRecord[]) => {
        (records[0] as CloudLatencyRecord).diagnosticIncomplete = true;
      },
    ]) {
      const records = trace();
      mutate(records);
      const result = aggregateLatency(lines(records), options);
      expect(result.population.completed).toBe(0);
      expect(result.population.unsettledOrIncomplete).toBe(1);
      expect(result.evidence.incompleteTraces).toBe(1);
      expect(result.metrics).toEqual({});
    }
  });

  it("does not join independent process clocks or cross-allocation Turn identities", () => {
    const records = trace();
    for (const record of records.slice(3)) record.clockId = randomUUID();
    expect(aggregateLatency(lines(records), options).population.completed).toBe(0);
    const a = trace();
    const b = structuredClone(a);
    for (const record of b) record.environmentGeneration = 2;
    const result = aggregateLatency(lines([...a, ...b]), options);
    expect(result.population.completed).toBe(0);
    expect(result.evidence.allocationConflicts).toBe(1);
  });

  it("preserves unknown and cancelled outcomes instead of inferring failures or timeouts", () => {
    for (const outcome of ["failed", "unknown", "cancelled"] as const) {
      const result = aggregateLatency(lines(trace(outcome)), options);
      expect(result.population[outcome]).toBe(1);
      expect(result.population.completed).toBe(0);
      expect(result.population.timeout).toBeNull();
    }
    const a = trace();
    const b = trace("failed");
    for (const record of b) record.turnId = a[0]?.turnId;
    const result = aggregateLatency(lines([...a, ...b]), options);
    expect(result.evidence.outcomeConflicts).toBe(1);
    expect(result.population.completed).toBe(0);
    expect(result.population.failed).toBe(0);
  });

  it("accepts Cloud Logging and Docker wrappers while omitting unrelated Pino payloads", () => {
    const records = trace();
    const array = records.map((record) => ({
      timestamp: utc,
      jsonPayload: { ...record, level: 30, pid: 1, msg: "private-message" },
    }));
    expect(aggregateLatency(JSON.stringify(array), options).population.completed).toBe(1);
    const extracted = records.map(({ severity, ...record }) => ({ severity, timestamp: utc, jsonPayload: record }));
    expect(aggregateLatency(JSON.stringify(extracted), options).population.completed).toBe(1);
    const docker = records.map((record) => ({ time: utc, stream: "stderr", log: JSON.stringify(record) }));
    expect(aggregateLatency(lines(docker), options).population.completed).toBe(1);
    const server = records.map((record) => ({
      ...record,
      service: "opentag-server",
      module: "im-delivery",
      msg: "provider-secret",
    }));
    const report = aggregateLatency(lines(server), options);
    expect(report.population.completed).toBe(0);
    expect(Object.keys(report.metrics)).toContain(
      `opentag-server/${"a".repeat(40)}/2026-11-03/runtime_assembly`.replace("runtime_assembly", "worker_execution"),
    );
    expect(JSON.stringify(report)).not.toMatch(/provider-secret|private-message/);
  });

  it("reuses existing Pi phase-end durations and exposes duplicate evidence", () => {
    const turnId = randomUUID();
    const record = {
      module: "cloud-pi",
      operation: "pi.diagnostic",
      sessionId,
      sandboxId,
      environmentGeneration: 1,
      turnId,
      event: "end",
      phase: "get_state",
      seq: 2,
      durationMs: 123,
      error: { message: "private-source" },
    };
    const row = { timestamp: utc, jsonPayload: record };
    const result = aggregateLatency(
      lines([row, row, { timestamp: utc, jsonPayload: { ...record, environment: "production" } }]),
      options,
    );
    expect(result.metrics["pi/2026-11-03/get_state"]?.p50).toBe(123);
    expect(result.population).toMatchObject({ observed: 1, completed: 0, unsettledOrIncomplete: 1 });
    expect(result.evidence.duplicatePi).toBe(1);
    expect(result.evidence.invalid).toBe(1);
    const docker = aggregateLatency(lines([{ time: utc, stream: "stderr", log: JSON.stringify(record) }]), options);
    expect(docker.metrics["pi/2026-11-03/get_state"]?.p50).toBe(123);
    expect(JSON.stringify(result)).not.toMatch(/private-source/);
  });

  it("counts malformed and invalid records without reflecting their text", () => {
    const record = trace()[0] as CloudLatencyRecord;
    const rows = [
      null,
      { log: "not JSON" },
      { operation: "unrelated" },
      { ...record, sessionId: randomUUID() },
      { ...record, utc: "invalid" },
      { ...record, version: 9 },
      { ...record, utc: "2026-11-05T00:00:00.000Z" },
      { ...record, service: "secret-credential" },
    ];
    const result = aggregateLatency(`${lines(rows)}\nnot-json-secret`, options);
    expect(result.evidence.malformed).toBe(3);
    expect(result.evidence.invalid).toBe(3);
    expect(result.evidence.ignored).toBe(3);
    expect(JSON.stringify(result)).not.toMatch(/secret-credential|not-json-secret/);
  });

  it("rejects oversized exports, inconsistent populations and invalid or long windows", () => {
    expect(() => aggregateLatency("x".repeat(16 * 1024 * 1024 + 1), options)).toThrow(/16 MiB/);
    expect(() => aggregateLatency(Array(10001).fill("{}").join("\n"), options)).toThrow(/10,000/);
    expect(() => aggregateLatency(lines([...trace(), ...trace()]), options)).toThrow(/population/);
    expect(() => aggregateLatency("[]", { ...options, to: "2026-11-05T00:00:00.000Z" })).toThrow(/24 hours/);
    expect(() => aggregateLatency("[]", { ...options, to: options.from })).toThrow(/24 hours/);
    expect(() => aggregateLatency("[]", { ...options, sessions: [] })).toThrow();
  });

  it("CLI rejects invalid input without writing raw data or echoing arguments", () => {
    const entry = new URL("../cloud-latency-report.ts", import.meta.url);
    const result = spawnSync(process.execPath, ["--import", "tsx", entry.pathname, "secret-invalid"], {
      encoding: "utf8",
      input: "private-source",
    });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("No raw data was saved");
    expect(result.stderr).not.toMatch(/secret-invalid|private-source/);
  });
});
