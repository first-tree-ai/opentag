import assert from "node:assert/strict";

export const phases = [
  "ingress_queue",
  "runtime_assembly",
  "sandbox_provision",
  "workspace_restore",
  "pi_startup",
  "mcp_startup",
  "model_ttft",
  "tool_call",
  "im_outbound",
  "terminal_cleanup",
  "checkpoint",
  "report_ack",
];

export const endpoints = {
  ingress_to_first_receipt: ["ingress", "firstReceipt"],
  ingress_to_terminal: ["ingress", "terminal"],
  ingress_to_checkpoint: ["ingress", "checkpoint"],
  ingress_to_report_ack: ["ingress", "reportAck"],
};

function number(value) {
  assert.ok(Number.isFinite(value) && value >= 0, "Expected a finite nonnegative measurement");
}

export function validateSample(sample) {
  assert.ok(typeof sample.scenario === "string" && sample.scenario.length > 0);
  assert.ok(Number.isInteger(sample.iteration) && sample.iteration >= 0);
  assert.ok(["success", "failed", "timeout", "incomplete"].includes(sample.outcome));
  assert.ok(Array.isArray(sample.spans));
  for (const span of sample.spans) {
    assert.ok(phases.includes(span.phase), `Unknown phase: ${span.phase}`);
    number(span.startMs);
    number(span.endMs);
    assert.ok(span.endMs >= span.startMs, "Reversed span");
  }
  for (const phase of phases) {
    const spans = sample.spans.filter((span) => span.phase === phase).sort((a, b) => a.startMs - b.startMs);
    for (let index = 1; index < spans.length; index++) {
      assert.ok(spans[index].startMs >= spans[index - 1].endMs, "Overlapping calls in one phase");
    }
  }
  number(sample.marks.ingress);
  for (const value of Object.values(sample.marks)) number(value);
  for (const [start, end] of Object.values(endpoints)) {
    if (sample.marks[end] !== undefined) assert.ok(sample.marks[end] >= sample.marks[start], "Reversed endpoint");
  }
  for (const value of Object.values(sample.resources)) number(value);
  if (sample.outcome === "success") {
    for (const [, end] of Object.values(endpoints)) number(sample.marks[end]);
    assert.ok(sample.marks.firstReceipt <= sample.marks.terminal);
    assert.ok(sample.marks.terminal <= sample.marks.checkpoint);
    assert.ok(sample.marks.checkpoint <= sample.marks.reportAck);
  }
}

export function validateDataset(data) {
  assert.equal(data.schemaVersion, 1);
  assert.equal(data.scope, "offline-synthetic-orchestration");
  assert.ok(/^[a-f0-9]{64}$/.test(data.workloadSha256));
  assert.ok(data.environment && data.source && data.protocol);
  assert.ok(Array.isArray(data.samples) && data.samples.length > 0);
  const seen = new Set();
  for (const sample of data.samples) {
    validateSample(sample);
    const key = `${sample.scenario}/${sample.iteration}`;
    assert.ok(!seen.has(key), `Duplicate attempt: ${key}`);
    seen.add(key);
  }
  const expected = data.protocol.scenarios;
  assert.ok(Array.isArray(expected) && expected.length > 0);
  assert.ok(Number.isInteger(data.protocol.iterations) && data.protocol.iterations > 0);
  const names = [...expected, ...data.protocol.failureScenarios].map((scenario) => scenario.name);
  assert.equal(new Set(names).size, names.length, "Duplicate scenario definition");
  const wanted = expected.length * data.protocol.iterations + data.protocol.failureScenarios.length;
  assert.equal(data.samples.length, wanted, "Missing or extra attempts");
  for (const scenario of expected) {
    for (let index = 0; index < data.protocol.iterations; index++)
      assert.ok(seen.has(`${scenario.name}/${index}`), "Missing planned attempt");
  }
  for (const scenario of data.protocol.failureScenarios)
    assert.ok(seen.has(`${scenario.name}/0`), "Missing failure injection");
  return data;
}

export function distribution(values) {
  const sorted = [...values].sort((a, b) => a - b);
  for (const value of sorted) number(value);
  const rank = (q, minimum) => (sorted.length >= minimum ? sorted[Math.ceil(q * sorted.length) - 1] : null);
  return {
    n: sorted.length,
    p50: rank(0.5, 1),
    p90: rank(0.9, 100),
    p95: rank(0.95, 100),
    p99: rank(0.99, 1000),
    max: sorted.at(-1) ?? null,
  };
}

function summarizeGroup(samples) {
  const success = samples.filter((sample) => sample.outcome === "success");
  const counts = Object.fromEntries(
    ["success", "failed", "timeout", "incomplete"].map((outcome) => [
      outcome,
      samples.filter((sample) => sample.outcome === outcome).length,
    ]),
  );
  const metrics = Object.fromEntries(
    Object.entries(endpoints).map(([name, [start, end]]) => [
      name,
      distribution(success.map((sample) => sample.marks[end] - sample.marks[start])),
    ]),
  );
  const stages = Object.fromEntries(
    phases.map((phase) => {
      const values = success.flatMap((sample) => {
        const spans = sample.spans.filter((span) => span.phase === phase);
        return spans.length ? [spans.reduce((sum, span) => sum + span.endMs - span.startMs, 0)] : [];
      });
      return [phase, { ...distribution(values), missing: success.length - values.length }];
    }),
  );
  const resources = Object.fromEntries(
    ["parentCpuMs", "workerCpuMs", "logicalReadBytes", "logicalWriteBytes"].map((key) => [
      key,
      distribution(samples.flatMap((sample) => (sample.resources[key] === undefined ? [] : [sample.resources[key]]))),
    ]),
  );
  return {
    attempted: samples.length,
    ...counts,
    timeoutRate: counts.timeout / samples.length,
    metrics,
    stages,
    resources,
  };
}

export function summarize(data) {
  validateDataset(data);
  return Object.fromEntries(
    [...new Set(data.samples.map((sample) => sample.scenario))].map((name) => [
      name,
      summarizeGroup(data.samples.filter((sample) => sample.scenario === name)),
    ]),
  );
}

function identity(data) {
  const { platform, arch, node, image, cpuLimit, memoryLimit, executionOrder } = data.environment;
  return {
    scope: data.scope,
    workloadSha256: data.workloadSha256,
    protocol: data.protocol,
    platform,
    arch,
    node,
    image,
    cpuLimit,
    memoryLimit,
    executionOrder,
  };
}

function metricRegressions(name, previous, next) {
  const regressions = [];
  for (const [metric, value] of Object.entries(next.metrics)) {
    for (const quantile of ["p50", "p95"]) {
      const old = previous.metrics[metric][quantile];
      const current = value[quantile];
      if (old === null || current === null) {
        regressions.push(`${name}/${metric}: insufficient samples for ${quantile}`);
      } else if (current > old * 1.05 + 5) {
        regressions.push(`${name}/${metric}/${quantile}: ${current.toFixed(2)} > ${(old * 1.05 + 5).toFixed(2)} ms`);
      }
    }
  }
  return regressions;
}

function groupRegressions(name, previous, next) {
  assert.equal(next.attempted, previous.attempted, `Attempt count differs: ${name}`);
  const regressions = ["failed", "timeout", "incomplete"]
    .filter((count) => next[count] > previous[count])
    .map((count) => `${name}: ${count} increased`);
  if (next.success < previous.success) regressions.push(`${name}: successful attempts decreased`);
  if (next.success > 0) regressions.push(...metricRegressions(name, previous, next));
  for (const phase of phases) {
    if (next.stages[phase].missing > previous.stages[phase].missing)
      regressions.push(`${name}/${phase}: coverage decreased`);
  }
  return regressions;
}

export function compare(before, after) {
  const baseline = summarize(before);
  const candidate = summarize(after);
  assert.ok(
    before.environment.image && before.environment.cpuLimit && before.environment.memoryLimit,
    "Unrecorded image or resource controls; comparison refused",
  );
  assert.deepEqual(identity(after), identity(before), "Environment or workload differs; comparison refused");
  assert.deepEqual(Object.keys(candidate).sort(), Object.keys(baseline).sort(), "Scenario set differs");
  const regressions = Object.entries(baseline).flatMap(([name, previous]) =>
    groupRegressions(name, previous, candidate[name]),
  );
  if (Object.values(candidate).every((group) => group.success === 0)) regressions.push("No successful measurement");
  return { comparable: true, passed: regressions.length === 0, regressions, baseline, candidate };
}

const cell = (value) => (value === null ? "—" : value.toFixed(2));

export function markdownReport(data) {
  const groups = summarize(data);
  const lines = [
    "# Offline synthetic orchestration results",
    "",
    "These timings measure a local fixture with stub Pi/MCP/model/IM, not OpenTag Cloud or user-perceived latency.",
    "Successful-attempt quantiles use nearest rank. P90/P95 require 100 successes; P99 requires 1,000.",
    "All attempts remain in the denominators. Stage durations must not be summed into endpoint percentiles.",
    `Environment: ${data.environment.platform}/${data.environment.arch}, Node ${data.environment.node}; CPU quota ${data.environment.cpuLimit ?? "unrestricted/unknown"}; memory limit ${data.environment.memoryLimit ?? "unrestricted/unknown"}.`,
    `Workload SHA-256: \`${data.workloadSha256}\`. Image: \`${data.environment.image ?? "unrecorded"}\`.`,
    "",
    "| Scenario | Attempts | Success | Failed | Timeout | Incomplete | Timeout rate |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const [name, group] of Object.entries(groups)) {
    lines.push(
      `| ${name} | ${group.attempted} | ${group.success} | ${group.failed} | ${group.timeout} | ${group.incomplete} | ${(group.timeoutRate * 100).toFixed(2)}% |`,
    );
  }
  for (const [name, group] of Object.entries(groups)) {
    lines.push(
      "",
      `## ${name}`,
      "",
      "Milliseconds; stage rows aggregate repeated calls within each successful attempt.",
      "",
      "| Metric | n | Missing | P50 | P90 | P95 | P99 | Max |",
      "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    );
    for (const [metric, value] of Object.entries({ ...group.metrics, ...group.stages })) {
      lines.push(
        `| ${metric} | ${value.n} | ${value.missing ?? group.success - value.n} | ${cell(value.p50)} | ${cell(value.p90)} | ${cell(value.p95)} | ${cell(value.p99)} | ${cell(value.max)} |`,
      );
    }
    lines.push(
      "",
      "Resource profiles include failed attempts when the counter was observed. CPU is milliseconds; I/O is logical fixture bytes, not physical disk I/O.",
      "",
      "| Resource | n | P50 | P95 | Max |",
      "| --- | ---: | ---: | ---: | ---: |",
    );
    for (const [metric, value] of Object.entries(group.resources)) {
      lines.push(`| ${metric} | ${value.n} | ${cell(value.p50)} | ${cell(value.p95)} | ${cell(value.max)} |`);
    }
  }
  lines.push(
    "",
    `Whole-process peak RSS: ${data.processResources?.maxRSS ?? "unavailable"} KiB. This is cumulative, excludes child RSS and cannot be attributed to a scenario.`,
    "Linux cgroup cpu.stat, memory.peak, memory.events and io.stat snapshots are retained in the raw result for the whole container, including fixture setup and cleanup. Null means unavailable; memory.peak is not a per-sample delta.",
  );
  return `${lines.join("\n")}\n`;
}
