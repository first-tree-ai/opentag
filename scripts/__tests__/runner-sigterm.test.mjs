import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const FIXTURE = `
import { writeFileSync } from "node:fs";
import { runProcess } from ${JSON.stringify(pathToFileURL(join(process.cwd(), "scripts/runner/async-process.mjs")).href)};
import { registerCleanup } from ${JSON.stringify(pathToFileURL(join(process.cwd(), "scripts/runner/cleanup.mjs")).href)};
registerCleanup(() => writeFileSync(process.env.FIXTURE_MARKER, "cleaned"));
writeFileSync(process.env.FIXTURE_READY, String(process.pid));
runProcess("sh", ["-c", "sleep 300 & wait"], { timeoutMs: 600000 })
  .then(() => { process.exitCode = 0; })
  .catch(() => { process.exitCode = 42; });
`;

async function childrenOf(pid) {
  const { stdout } = await execFileAsync("ps", ["ax", "-o", "pid=,ppid=,comm="], { encoding: "utf8" });
  const found = [];
  for (const line of stdout.split("\n")) {
    const parts = line.trim().split(/\s+/);
    if (Number(parts[1]) === pid) found.push({ pid: Number(parts[0]), comm: parts[2] ?? "" });
  }
  return found;
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForNestedChild(fixturePid) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const shell = (await childrenOf(fixturePid)).find((child) => child.comm.endsWith("sh"));
    if (shell) {
      const sleep = (await childrenOf(shell.pid)).find((child) => child.comm.endsWith("sleep"));
      if (sleep) return { ownedPid: shell.pid, sleepPid: sleep.pid };
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("fixture never spawned the nested sleep process");
}

function killIfPresent(pid) {
  if (!pid) return;
  try {
    process.kill(pid, "SIGKILL");
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

test("SIGTERM interrupts an owned process group including nested children and runs cleanup", async () => {
  const dir = await mkdtemp(join(tmpdir(), "opentag-sigterm-"));
  let fixture;
  let ownedPid;
  let sleepPid;
  try {
    const fixturePath = join(dir, "fixture.mjs");
    const marker = join(dir, "marker.txt");
    await writeFile(fixturePath, FIXTURE);
    fixture = spawn("node", [fixturePath], {
      env: { ...process.env, FIXTURE_MARKER: marker, FIXTURE_READY: join(dir, "ready.txt") },
      stdio: "ignore",
    });
    ({ ownedPid, sleepPid } = await waitForNestedChild(fixture.pid));
    const exited = new Promise((resolve) => {
      const timer = setTimeout(() => resolve("timeout"), 15_000);
      fixture.on("exit", (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal });
      });
    });
    fixture.kill("SIGTERM");
    const exit = await exited;
    assert.notEqual(exit, "timeout", "fixture ignored SIGTERM");
    assert.equal(exit.code, 143, "fixture must exit 128+15 after its SIGTERM handler");
    assert.equal((await readFile(marker, "utf8")).trim(), "cleaned", "registered cleanup did not run");
    const goneDeadline = Date.now() + 10_000;
    while ((alive(sleepPid) || alive(ownedPid)) && Date.now() < goneDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    assert.equal(alive(sleepPid), false, "nested long-lived child survived the interrupted parent");
    assert.equal(alive(ownedPid), false, "owned process survived the interrupted parent");
  } finally {
    killIfPresent(ownedPid ? -ownedPid : undefined);
    killIfPresent(sleepPid);
    killIfPresent(fixture?.pid);
    await rm(dir, { recursive: true, force: true });
  }
});
