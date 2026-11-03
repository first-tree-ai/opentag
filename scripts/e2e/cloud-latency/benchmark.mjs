import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { release } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { failureScenarios, runSample, scenarios } from "./fixture.mjs";
import { compare, markdownReport, validateDataset } from "./metrics.mjs";

async function optionalFile(path) {
  try {
    return (await readFile(path, "utf8")).trim();
  } catch (error) {
    if (["ENOENT", "ENOTDIR", "EACCES"].includes(error.code)) return null;
    throw error;
  }
}

async function cgroupCounters() {
  return Object.fromEntries(
    await Promise.all(
      ["cpu.stat", "memory.current", "memory.peak", "memory.events", "io.stat"].map(async (name) => [
        name,
        await optionalFile(`/sys/fs/cgroup/${name}`),
      ]),
    ),
  );
}

async function workloadHash() {
  const hash = createHash("sha256");
  for (const name of ["benchmark.mjs", "fixture.mjs", "fixture-worker.mjs", "metrics.mjs"]) {
    hash.update(name);
    hash.update(await readFile(new URL(name, import.meta.url)));
  }
  return hash.digest("hex");
}

function sourceIdentity() {
  const revision = process.env.OPENTAG_LATENCY_FIXTURE_REVISION;
  if (revision) {
    assert.ok(/^[a-f0-9]{40}$/.test(revision), "Explicit fixture revision must be a full Git SHA");
    assert.ok(["true", "false"].includes(process.env.OPENTAG_LATENCY_FIXTURE_SOURCE_DIRTY));
    return {
      revision,
      trackedDirty: process.env.OPENTAG_LATENCY_FIXTURE_SOURCE_DIRTY === "true",
      method: "explicit-container-source",
    };
  }
  const cwd = fileURLToPath(new URL("../../../", import.meta.url));
  const git = (args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  return {
    revision: git(["rev-parse", "HEAD"]),
    trackedDirty: git(["status", "--porcelain", "--untracked-files=no"]) !== "",
  };
}

export async function runBenchmark(iterations) {
  assert.ok(
    Number.isInteger(iterations) && iterations > 0 && iterations <= 10000,
    "Samples must be an integer from 1 to 10000",
  );
  const data = {
    schemaVersion: 1,
    scope: "offline-synthetic-orchestration",
    workloadSha256: await workloadHash(),
    source: sourceIdentity(),
    protocol: { iterations, queueDelayMs: 2, rpcTimeoutMs: 5000, injectedTimeoutMs: 25, scenarios, failureScenarios },
    environment: {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      kernel: release(),
      image: process.env.OPENTAG_LATENCY_FIXTURE_IMAGE ?? null,
      cpuLimit: await optionalFile("/sys/fs/cgroup/cpu.max"),
      memoryLimit: await optionalFile("/sys/fs/cgroup/memory.max"),
      executionOrder: "rotating-scenarios-serial-v1",
    },
    startedAt: new Date().toISOString(),
    resourcesBefore: await cgroupCounters(),
    samples: [],
  };
  for (let iteration = 0; iteration < iterations; iteration++) {
    for (let offset = 0; offset < scenarios.length; offset++) {
      const scenario = scenarios[(iteration + offset) % scenarios.length];
      data.samples.push(await runSample(scenario, iteration));
    }
  }
  for (const scenario of failureScenarios) data.samples.push(await runSample(scenario, 0));
  data.resourcesAfter = await cgroupCounters();
  data.processResources = process.resourceUsage();
  data.finishedAt = new Date().toISOString();
  return validateDataset(data);
}

export function serializeDataset(data) {
  const { samples, ...metadata } = data;
  return `${JSON.stringify(metadata, null, 2).slice(0, -2)},\n  "samples": [\n${samples.map((sample) => `    ${JSON.stringify(sample)}`).join(",\n")}\n  ]\n}\n`;
}

export async function main(args) {
  const [command, ...paths] = args;
  if (command === "run") {
    assert.ok(paths.length <= 1, "Usage: benchmark.mjs run [samples-per-scenario]");
    const data = await runBenchmark(Number(paths[0] ?? 100));
    process.stdout.write(serializeDataset(data));
    const unexpected = data.samples.some((sample) => {
      if (sample.cleanupFailed) return true;
      if (sample.scenario === "injected-timeout")
        return (
          sample.outcome !== "timeout" ||
          sample.failurePhase !== "model_ttft" ||
          sample.failureCode !== "fixture_deadline"
        );
      if (sample.scenario === "injected-rejection")
        return (
          sample.outcome !== "failed" ||
          sample.failurePhase !== "model_ttft" ||
          sample.failureCode !== "injected_model_rejection"
        );
      return sample.outcome !== "success";
    });
    if (unexpected) process.exitCode = 1;
    return;
  }
  if (command === "report") {
    assert.equal(paths.length, 1, "Usage: benchmark.mjs report fixture-results.json");
    process.stdout.write(markdownReport(JSON.parse(await readFile(paths[0], "utf8"))));
    return;
  }
  assert.equal(command, "compare", "Usage: benchmark.mjs run|report|compare");
  assert.equal(paths.length, 2, "Usage: benchmark.mjs compare before.json after.json");
  const [before, after] = await Promise.all(paths.map(async (path) => JSON.parse(await readFile(path, "utf8"))));
  const result = compare(before, after);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.passed) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
