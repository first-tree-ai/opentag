import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { runWithCleanup } from "../runner/cleanup.mjs";

const execFileAsync = promisify(execFile);
const dockerStub = (log) => `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
if (args[0] === "container") {
  process.stderr.write("No such container");
  process.exitCode = 1;
}
`;

test("guard outlives the real accept budget, starts through the entrypoint, and is removed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "opentag-guard-stub-"));
  const log = join(dir, "docker-args.log");
  const previousPath = process.env.PATH;
  try {
    await writeFile(join(dir, "docker"), dockerStub(log));
    await chmod(join(dir, "docker"), 0o755);
    await writeFile(join(dir, "sleep"), '#!/bin/sh\nprintf "%s" "$1"\n', { mode: 0o755 });
    process.env.PATH = dir;
    await runWithCleanup(async () => {
      const { startGuardContainer, removeContainer } = await import("../e2e/runner-toolchain/harness.mjs");
      const { REAL_ACCEPT_TIMEOUT_MS } = await import("../e2e/runner-toolchain/real-smoke.mjs");
      await startGuardContainer({ image: "opentag-runner:test", name: "stub-guard" });
      const args = JSON.parse((await readFile(log, "utf8")).trim());
      const command = args.slice(args.indexOf("opentag-runner:test") + 1);
      assert.deepEqual(command, ["sleep", "infinity"]);
      // Docker init owns PID 1 and reaps orphaned children; a zombie is not a gone process.
      assert.ok(args.includes("--init"), "guard must run with Docker --init so orphans are reaped");
      assert.ok(args.indexOf("--init") < args.indexOf("opentag-runner:test"));
      assert.ok(Number.isFinite(REAL_ACCEPT_TIMEOUT_MS) && REAL_ACCEPT_TIMEOUT_MS > 0);
      const keepaliveMs = command[1] === "infinity" ? Infinity : Number(command[1]) * 1000;
      assert.ok(keepaliveMs >= REAL_ACCEPT_TIMEOUT_MS, "keepalive covers the entire accept budget");
      for (const [flag, value] of [
        ["--cpus", "1"],
        ["--memory", "1g"],
        ["--memory-swap", "1g"],
        ["--platform", "linux/amd64"],
      ]) {
        assert.equal(args[args.indexOf(flag) + 1], value);
      }
      // Execute the real entrypoint with a controlled sleep shim. A shell builtin passed as
      // an executable (e.g. ["exec", "sleep", "infinity"]) must fail this path.
      const entrypoint = fileURLToPath(new URL("../runner/entrypoint.sh", import.meta.url));
      const { stdout } = await execFileAsync("/bin/sh", [entrypoint, ...command], {
        env: { PATH: dir, HOME: dir, OPENTAG_WORKSPACE: dir },
        timeout: 5_000,
      });
      assert.equal(stdout, "infinity");
      await removeContainer("stub-guard");
      const lines = (await readFile(log, "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      assert.ok(lines.some((line) => line.join(" ") === "rm -f stub-guard"));
      assert.ok(lines.some((line) => line.join(" ") === "container inspect stub-guard"));
    });
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await rm(dir, { recursive: true, force: true });
  }
});
