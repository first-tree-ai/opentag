import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function summarizeShardTimings(reports) {
  if (reports.length !== 3 || new Set(reports.map((report) => report.shard)).size !== 3) {
    throw new Error("All three Node 24 shard timings are required");
  }
  for (const report of reports) {
    if (
      !["1/3", "2/3", "3/3"].includes(report.shard) ||
      report.exitCode !== 0 ||
      !Number.isFinite(report.durationMs) ||
      report.durationMs < 0
    ) {
      throw new Error("Invalid or failed unit shard timing");
    }
  }
  return {
    durationMs: Math.max(...reports.map((report) => report.durationMs)),
    note: "Slowest Node 24 workspace unit shard; reused from this CI run. Excludes repository script tests and runner queue time.",
  };
}

export function main(argv = process.argv.slice(2)) {
  if (argv[0] === "--summarize") {
    const [, output, ...files] = argv;
    const reports = files.map((file) => JSON.parse(readFileSync(file, "utf8")));
    writeFileSync(output, `${JSON.stringify(summarizeShardTimings(reports))}\n`);
    return 0;
  }
  const [output, shard, command, ...args] = argv;
  if (!output || !command || !["1/3", "2/3", "3/3"].includes(shard)) {
    throw new Error("Usage: ci-test-timing.mjs OUTPUT SHARD COMMAND [ARGS...]");
  }
  const started = performance.now();
  const result = spawnSync(command, args, { stdio: "inherit" });
  const exitCode = result.status ?? 1;
  writeFileSync(output, `${JSON.stringify({ shard, exitCode, durationMs: performance.now() - started })}\n`);
  if (result.error) console.error(result.error.message);
  if (result.signal) console.error(`Test command terminated by ${result.signal}`);
  return exitCode;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) process.exitCode = main();
