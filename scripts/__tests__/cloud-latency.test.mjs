import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { serializeDataset } from "../e2e/cloud-latency/benchmark.mjs";
import { failureScenarios, runSample, scenarios } from "../e2e/cloud-latency/fixture.mjs";
import {
  compare,
  distribution,
  markdownReport,
  phases,
  summarize,
  validateDataset,
} from "../e2e/cloud-latency/metrics.mjs";

function dataset(count = 100) {
  return {
    schemaVersion: 1,
    scope: "offline-synthetic-orchestration",
    workloadSha256: "a".repeat(64),
    environment: {
      node: "v24",
      platform: "linux",
      arch: "arm64",
      cpuLimit: "100000 100000",
      memoryLimit: "1073741824",
      image: "fixture",
      executionOrder: "serial",
    },
    source: { revision: "fixture" },
    protocol: { iterations: count, scenarios: [{ name: "unit" }], failureScenarios: [] },
    samples: Array.from({ length: count }, (_, iteration) => ({
      scenario: "unit",
      iteration,
      outcome: "success",
      marks: { ingress: 0, firstReceipt: 50, terminal: 60, checkpoint: 80, reportAck: 100 },
      spans: phases.map((phase, index) => ({ phase, startMs: index, endMs: index + 1 })),
      resources: { parentCpuMs: 1, workerCpuMs: 2, logicalReadBytes: 100, logicalWriteBytes: 200 },
    })),
  };
}

test("nearest-rank quantiles retain outliers and suppress unsupported tails", () => {
  const values = Array.from({ length: 100 }, (_, index) => index + 1);
  assert.deepEqual(distribution(values), { n: 100, p50: 50, p90: 90, p95: 95, p99: null, max: 100 });
  assert.equal(distribution([...values, 100000]).max, 100000);
  assert.equal(distribution(values.slice(0, 99)).p95, null);
  assert.equal(distribution(Array.from({ length: 1000 }, (_, index) => index + 1)).p99, 990);
  assert.equal(distribution([]).p50, null);
});

test("failed, timed-out and incomplete attempts stay in denominators; missing stages are not zero", () => {
  const data = dataset();
  data.samples[0].outcome = "failed";
  data.samples[1].outcome = "timeout";
  data.samples[2].outcome = "incomplete";
  data.samples[3].spans = [];
  const result = summarize(data).unit;
  assert.deepEqual(
    [result.attempted, result.success, result.failed, result.timeout, result.incomplete],
    [100, 97, 1, 1, 1],
  );
  assert.equal(result.timeoutRate, 0.01);
  assert.equal(result.metrics.ingress_to_report_ack.n, 97);
  assert.equal(result.metrics.ingress_to_report_ack.p95, null);
  assert.equal(result.stages.checkpoint.missing, 1);
  assert.equal(result.stages.checkpoint.n, 96);
});

test("endpoint latency comes from marks rather than the sum of phase percentiles", () => {
  const data = dataset();
  data.samples[0].spans.push({ phase: "tool_call", startMs: 15, endMs: 30 });
  const result = summarize(data).unit;
  assert.equal(result.metrics.ingress_to_report_ack.max, 100);
  assert.equal(result.stages.tool_call.max, 16);
});

test("malformed, duplicated, omitted and inconsistent attempts fail closed", () => {
  for (const mutate of [
    (data) => {
      data.samples[0].marks.reportAck = -1;
    },
    (data) => {
      data.samples[0].spans[0].endMs = Number.NaN;
    },
    (data) => {
      data.samples[0].spans[0].endMs = -1;
    },
    (data) => {
      data.samples[0].spans[0].phase = "invented";
    },
    (data) => {
      delete data.samples[0].marks.checkpoint;
    },
    (data) => {
      data.samples[0].marks.terminal = 90;
    },
    (data) => {
      data.samples[1] = data.samples[0];
    },
    (data) => {
      data.samples.pop();
    },
    (data) => {
      data.samples[0].spans.push(data.samples[0].spans[0]);
    },
  ]) {
    const data = dataset();
    mutate(data);
    assert.throws(() => validateDataset(data));
  }
});

test("comparison rejects incompatible controls, too few samples and regressions", () => {
  const baseline = dataset();
  assert.equal(compare(baseline, structuredClone(baseline)).passed, true);
  const uncontrolled = structuredClone(baseline);
  uncontrolled.environment.cpuLimit = null;
  assert.throws(() => compare(uncontrolled, uncontrolled), /resource controls/);
  for (const [key, value] of [
    ["cpuLimit", "max 100000"],
    ["arch", "x64"],
    ["image", "other"],
    ["node", "v26"],
  ]) {
    const candidate = structuredClone(baseline);
    candidate.environment[key] = value;
    assert.throws(() => compare(baseline, candidate), /differs/);
  }
  const changedWorkload = structuredClone(baseline);
  changedWorkload.workloadSha256 = "b".repeat(64);
  assert.throws(() => compare(baseline, changedWorkload), /differs/);
  assert.equal(compare(dataset(2), dataset(2)).passed, false);
  const slower = structuredClone(baseline);
  for (const sample of slower.samples) sample.marks.reportAck = 200;
  assert.ok(compare(baseline, slower).regressions.some((value) => value.includes("p95")));
  const failed = structuredClone(baseline);
  failed.samples[0].outcome = "timeout";
  assert.ok(compare(baseline, failed).regressions.some((value) => value.includes("timeout increased")));
  const uncovered = structuredClone(baseline);
  uncovered.samples[0].spans = [];
  assert.ok(compare(baseline, uncovered).regressions.some((value) => value.includes("coverage decreased")));
});

test("serialization and report retain scope, resources, counts and withheld P99", () => {
  const data = dataset();
  assert.deepEqual(JSON.parse(serializeDataset(data)), data);
  const report = markdownReport(data);
  assert.match(report, /stub Pi\/MCP\/model\/IM/);
  assert.match(report, /P99 requires 1,000/);
  assert.match(report, /parentCpuMs/);
  assert.match(report, /\| unit \| 100 \| 100 \| 0 \| 0 \| 0 \|/);
});

test("offline subprocess, exact-marker, restore and checkpoint fixture runs without network", async () => {
  for (const scenario of [scenarios[0], scenarios[1], scenarios[2], scenarios[3]]) {
    const sample = await runSample(scenario, 0);
    assert.equal(sample.outcome, "success", scenario.name);
    assert.deepEqual(
      sample.spans.map((span) => span.phase),
      phases,
    );
    assert.ok(sample.marks.firstReceipt < sample.marks.checkpoint);
    assert.ok(sample.resources.workerCpuMs > 0);
    if (scenario.restore) assert.ok(sample.resources.logicalReadBytes > scenario.bytes);
  }
  const rejected = await runSample(failureScenarios[0], 0);
  const timedOut = await runSample(failureScenarios[1], 0);
  assert.equal(rejected.outcome, "failed");
  assert.equal(rejected.failurePhase, "model_ttft");
  assert.equal(rejected.failureCode, "injected_model_rejection");
  assert.equal(timedOut.outcome, "timeout");
  assert.equal(timedOut.failureCode, "fixture_deadline");
  assert.equal(timedOut.failurePhase, "model_ttft");
  assert.equal(timedOut.marks.firstReceipt, undefined);
});

test("CLI rejects invalid sample counts without starting fixtures", () => {
  const entry = new URL("../e2e/cloud-latency/benchmark.mjs", import.meta.url);
  const result = spawnSync(process.execPath, [entry.pathname, "run", "0"], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Samples must be an integer/);
});

test("CLI reports task-owned serialized datasets without a committed run baseline", async () => {
  const data = dataset();
  data.samples[0].outcome = "failed";
  data.samples[1].outcome = "timeout";
  data.samples[2].outcome = "incomplete";
  data.samples[2].spans = [];
  const directory = await mkdtemp(join(tmpdir(), "opentag-latency-report-"));
  try {
    const path = join(directory, "results.json");
    await writeFile(path, serializeDataset(data));
    const entry = new URL("../e2e/cloud-latency/benchmark.mjs", import.meta.url);
    const result = spawnSync(process.execPath, [entry.pathname, "report", path], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, markdownReport(data));
    assert.match(result.stdout, /\| unit \| 100 \| 97 \| 1 \| 1 \| 1 \|/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
