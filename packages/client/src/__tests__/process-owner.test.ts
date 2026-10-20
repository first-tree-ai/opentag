import { type ChildProcessWithoutNullStreams, execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { ClaudeCodeProcess } from "../providers/claude-code/process-wire.js";
import { signalWatchedProcess, spawnWatchedProcess } from "../providers/process-owner.js";

const fixture = fileURLToPath(new URL("./fixtures/process-owner.mjs", import.meta.url));
const groups = new Map<number, number[]>();
let cwd: string;

describe.skipIf(process.platform === "win32")("Provider process group shutdown", () => {
  beforeAll(async () => {
    cwd = await mkdtemp(join(tmpdir(), "opentag-process-owner-"));
  });

  afterEach(async () => {
    for (const [group, pids] of groups) {
      try {
        process.kill(-group, "SIGKILL");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
      await expectStopped(pids);
    }
    groups.clear();
  });

  afterAll(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  it.each(["SIGINT", "SIGTERM"] as const)("stops an uncooperative process group after %s", async (signal) => {
    const child = spawnFixture("ignore");
    const exited = processExit(child);
    const pids = await readIdentity(child);

    signalWatchedProcess(child, signal);
    await exited;

    await expectStopped(pids);
  });

  it("keeps escalation alive after stdin closes and the Provider exits before its tool", async () => {
    const child = spawnFixture("exit-on-eof");
    const exited = processExit(child);
    const pids = await readIdentity(child);

    child.stdin.end();
    await exited;

    await expectStopped(pids);
  });

  it.each(["stdout", "stderr"] as const)("cleans the owned group when the parent %s pipe closes", async (stream) => {
    const child = spawnFixture("chatty");
    const exited = processExit(child);
    const pids = await readIdentity(child);

    child[stream].destroy();
    await exited;

    await expectStopped(pids);
  });

  it.each(["interrupt", "close", "completed"] as const)(
    "stops the owned process group through the Claude Code %s path",
    async (action) => {
      let groupId: number | undefined;
      let identify: (pids: number[]) => void = () => undefined;
      const identity = new Promise<number[]>((resolve) => {
        identify = resolve;
      });
      const wire = new ClaudeCodeProcess({
        command: process.execPath,
        args: [fixture, action === "completed" ? "completed" : "ignore"],
        cwd,
        env: {},
        spawnProcess: (command, args, options) => {
          const child = track(spawnWatchedProcess(command, args, options));
          groupId = child.pid;
          return child;
        },
      });
      const controller = new AbortController();
      const execution = wire
        .execute(
          { type: "user", text: "synthetic process lifecycle test" },
          (message) => {
            if (typeof message.providerPid !== "number" || typeof message.descendantPid !== "number") return;
            const pids = [message.providerPid, message.descendantPid];
            if (groupId) groups.set(groupId, pids);
            identify(pids);
          },
          controller.signal,
        )
        .then(
          () => "completed",
          (error: { code: string }) => error.code,
        );
      const pids = await identity;
      if (action === "interrupt") {
        controller.abort();
        await wire.interrupt();
      } else if (action === "close") {
        await wire.close();
      }

      expect(await execution).toBe(action === "completed" ? "completed" : "aborted");
      await wire.close();
      await expectStopped(pids);
    },
  );
});

function track(child: ChildProcessWithoutNullStreams): ChildProcessWithoutNullStreams {
  if (!child.pid) throw new Error("The synthetic watchdog did not start");
  groups.set(child.pid, []);
  return child;
}

function spawnFixture(mode: string): ChildProcessWithoutNullStreams {
  return track(spawnWatchedProcess(process.execPath, [fixture, mode], { cwd, detached: true, env: {} }));
}

function processExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once("exit", () => resolve());
    child.once("error", reject);
  });
}

function readIdentity(child: ChildProcessWithoutNullStreams): Promise<number[]> {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString();
      if (!buffer.includes("\n")) return;
      const identity = JSON.parse(buffer.split("\n")[0] ?? "{}") as Record<string, number>;
      const pids = [Number(identity.providerPid), Number(identity.descendantPid)];
      if (!pids.every((pid) => Number.isSafeInteger(pid) && pid > 1))
        return reject(new Error("Missing synthetic process identity"));
      if (child.pid) groups.set(child.pid, pids);
      child.stdout.off("data", onData);
      child.stdout.resume();
      resolve(pids);
    };
    child.stdout.on("data", onData);
    child.once("error", reject);
  });
}

function running(pid: number): boolean {
  try {
    const state = execFileSync("ps", ["-o", "stat=", "-p", String(pid)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return state.length > 0 && !state.startsWith("Z");
  } catch (error) {
    if ((error as { status?: number }).status === 1) return false;
    throw error;
  }
}

async function expectStopped(pids: number[]): Promise<void> {
  await vi.waitFor(() => expect(pids.map(running)).toEqual(pids.map(() => false)), { timeout: 2_000 });
}
