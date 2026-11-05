import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { runBenchmark } from "../benchmark/run.js";
import { benchmarkDependencies } from "../benchmark-agent-session.js";

vi.mock("../benchmark/run.js", () => ({ runBenchmark: vi.fn(async () => undefined) }));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  execFileSync: vi.fn(),
}));

const originalArgv = process.argv;
afterEach(() => {
  process.argv = originalArgv;
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

it("keeps Agent/Session results outside the checkout and writes to the selected task directory", () => {
  process.argv = [process.execPath, "benchmark-agent-session.ts"];
  vi.stubEnv("OPENTAG_BENCHMARK_OUT", undefined);
  const deps = benchmarkDependencies();
  expect(deps.resolveOutputDirectory()).toBe(join(tmpdir(), "opentag-benchmarks", "agent-session"));
  const directory = mkdtempSync(join(tmpdir(), "opentag-benchmark-output-"));
  try {
    process.argv.push("--out", join(directory, "task"));
    const output = deps.resolveOutputDirectory();
    deps.writeResults(output, '{"completed":true}\n');
    expect(JSON.parse(readFileSync(join(output, "results.json"), "utf8"))).toEqual({ completed: true });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it("wires task-query output and source identity without starting a benchmark", async () => {
  process.argv = [process.execPath, "benchmark-task-queries.ts", "--phase", "verify"];
  await import("../benchmark-task-queries.js");
  expect(runBenchmark).toHaveBeenCalledOnce();
  const ports = vi.mocked(runBenchmark).mock.calls[0]?.[0];
  if (!ports) throw new Error("Task-query entry did not supply benchmark ports");
  expect(ports.phase).toBe("verify");
  expect(ports.output).toBe(join(tmpdir(), "opentag-benchmarks", "task-queries"));
  expect(execFileSync).not.toHaveBeenCalled();
  vi.mocked(execFileSync).mockReturnValue(" M source.ts\n" as never);
  expect(ports.gitDirty()).toBe(true);
  expect(execFileSync).toHaveBeenLastCalledWith("git", ["status", "--porcelain"], { encoding: "utf8" });
  vi.mocked(execFileSync).mockReturnValue("" as never);
  expect(ports.gitDirty()).toBe(false);
  vi.mocked(execFileSync).mockReturnValue("a".repeat(40) as never);
  expect(ports.gitHead()).toBe("a".repeat(40));
});
