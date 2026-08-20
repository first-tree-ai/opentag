import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PiRpcError, PiRpcProcess } from "../providers/pi/rpc-wire.js";

const fixture = fileURLToPath(new URL("./fixtures/pi-rpc.mjs", import.meta.url));
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("PiRpcProcess", () => {
  it("exchanges correlated strict JSONL responses and events", async () => {
    const process = await rpcProcess("normal");
    const events: Readonly<Record<string, unknown>>[] = [];
    process.subscribe((event) => events.push(event));
    await expect(process.request({ type: "get_state" })).resolves.toMatchObject({
      sessionId: "11111111-1111-4111-8111-111111111111",
    });
    await expect(process.request({ type: "custom", value: "ok" })).resolves.toMatchObject({
      type: "custom",
      value: "ok",
    });
    await expect(process.request({ type: "prompt", message: "hello" })).resolves.toBeUndefined();
    await vi.waitFor(() => expect(events.at(-1)?.type).toBe("agent_settled"));
    await process.close();
    await process.close();
  });

  it.each(["malformed", "non-object", "missing-type", "invalid-utf8", "oversized", "truncated"])(
    "fails closed for %s output",
    async (scenario) => {
      const process = await rpcProcess(scenario, { maxLineBytes: 1024 });
      await expect(process.request({ type: "get_state" })).rejects.toBeInstanceOf(PiRpcError);
      await process.close().catch(() => undefined);
    },
  );

  it.each(["unknown-id", "missing-id", "wrong-command", "invalid-response"])(
    "rejects the %s response protocol violation",
    async (scenario) => {
      const process = await rpcProcess(scenario);
      await expect(process.request({ type: "get_state" })).rejects.toMatchObject({ code: "protocol" });
      await process.close().catch(() => undefined);
    },
  );

  it("reports command rejection without corrupting the wire", async () => {
    const process = await rpcProcess("command-error");
    await expect(process.request({ type: "get_state" })).rejects.toMatchObject({ code: "command" });
    await expect(process.request({ type: "get_state" })).rejects.toMatchObject({ code: "command" });
    await process.close();
  });

  it("includes bounded stderr when Pi exits unexpectedly", async () => {
    const process = await rpcProcess("exit", { maxStderrBytes: 7 });
    await expect(process.request({ type: "get_state" })).rejects.toMatchObject({
      code: "exited",
      message: expect.stringContaining("fixture"),
    });
    await process.close();
  });

  it("validates bounds, commands, pre-aborted requests, and synchronous spawn failures", async () => {
    const spawn = () => fakeChild();
    expect(() => new PiRpcProcess({ args: [], cwd: "/", env: {}, maxLineBytes: 1023, spawnProcess: spawn })).toThrow(
      "maxLineBytes",
    );
    expect(() => new PiRpcProcess({ args: [], cwd: "/", env: {}, maxStderrBytes: -1, spawnProcess: spawn })).toThrow(
      "maxStderrBytes",
    );
    expect(() => new PiRpcProcess({ args: [], cwd: "/", env: {}, requestTimeoutMs: 0, spawnProcess: spawn })).toThrow(
      "requestTimeoutMs",
    );
    expect(
      () =>
        new PiRpcProcess({
          args: [],
          cwd: "/",
          env: {},
          spawnProcess: () => {
            throw new Error("spawn failed");
          },
        }),
    ).toThrow("spawn failed");
    expect(
      () =>
        new PiRpcProcess({
          args: [],
          cwd: "/",
          env: {},
          spawnProcess: () => {
            throw 42;
          },
        }),
    ).toThrow("Pi could not be started");

    const process = fakeProcess(fakeChild());
    await expect(process.request({ value: "missing type" })).rejects.toMatchObject({ code: "protocol" });
    const cyclic: Record<string, unknown> = { type: "prompt" };
    cyclic.self = cyclic;
    await expect(process.request(cyclic)).rejects.toMatchObject({ code: "protocol" });
    const controller = new AbortController();
    controller.abort();
    await expect(process.request({ type: "get_state" }, controller.signal)).rejects.toMatchObject({ code: "aborted" });
    const close = process.close(100);
    processChild(process).emit("close", 0, null);
    await close;
    await expect(process.request({ type: "get_state" })).rejects.toMatchObject({ code: "exited" });
  });

  it("handles request timeout, AbortSignal, oversized input, and stdin write failure", async () => {
    const timeoutChild = fakeChild();
    const timedOut = fakeProcess(timeoutChild, { requestTimeoutMs: 1 });
    await expect(timedOut.request({ type: "get_state" })).rejects.toMatchObject({ code: "timeout" });
    timeoutChild.emit("close", 0, null);
    await timedOut.close();

    const abortChild = fakeChild();
    const aborted = fakeProcess(abortChild);
    const controller = new AbortController();
    const request = aborted.request({ type: "get_state" }, controller.signal);
    controller.abort();
    await expect(request).rejects.toMatchObject({ code: "aborted" });
    abortChild.emit("close", 0, null);
    await aborted.close();

    const oversizedChild = fakeChild();
    const oversized = fakeProcess(oversizedChild, { maxLineBytes: 1024 });
    await expect(oversized.request({ type: "prompt", message: "x".repeat(2048) })).rejects.toMatchObject({
      code: "protocol",
    });
    oversizedChild.emit("close", 0, null);
    await oversized.close();

    const writeChild = fakeChild();
    writeChild.stdin.write = ((_chunk: unknown, callback: (error?: Error | null) => void) => {
      callback(new Error("write failed"));
      return false;
    }) as typeof writeChild.stdin.write;
    const writeFailure = fakeProcess(writeChild);
    await expect(writeFailure.request({ type: "get_state" })).rejects.toMatchObject({ code: "write" });
    writeChild.emit("close", 0, null);
    await writeFailure.close();
  });

  it("propagates child and listener failures", async () => {
    const erroredChild = fakeChild();
    const errored = fakeProcess(erroredChild);
    erroredChild.emit("error", new Error("child failed"));
    erroredChild.emit("error", new Error("ignored"));
    await expect(errored.request({ type: "get_state" })).rejects.toMatchObject({ code: "spawn" });
    erroredChild.emit("close", 1, null);
    await errored.close();

    const listenerChild = fakeChild();
    const listenerFailure = fakeProcess(listenerChild);
    listenerFailure.subscribe(() => {
      throw new Error("listener failed");
    });
    const failure = processFailure(listenerFailure);
    listenerChild.stdout.write('{"type":"event"}\n');
    await expect(failure).resolves.toMatchObject({ code: "protocol" });
    listenerChild.emit("close", 1, null);
    await listenerFailure.close();
  });

  it("waits for close so a response emitted after exit can drain from stdout", async () => {
    const child = fakeChild();
    const process = fakeProcess(child);
    const request = process.request({ type: "get_state" });
    child.emit("exit", 0, null);
    child.stdout.write(
      `${JSON.stringify({
        id: "opentag-1",
        type: "response",
        command: "get_state",
        success: true,
        data: { drained: true },
      })}\n`,
    );
    await expect(request).resolves.toEqual({ drained: true });
    const close = process.close(100);
    child.emit("close", 0, null);
    await close;
  });

  it("escalates close and reports a process tree that never exits", async () => {
    const child = fakeChild();
    const process = fakeProcess(child);
    await expect(process.close(1)).rejects.toMatchObject({ code: "exited" });
    child.emit("close", 1, null);
    await process.close();

    const pendingChild = fakeChild();
    const pendingProcess = fakeProcess(pendingChild);
    const pending = pendingProcess.request({ type: "get_state" });
    const pendingClose = pendingProcess.close(100);
    await expect(pending).rejects.toMatchObject({ code: "aborted" });
    pendingChild.emit("close", 0, null);
    await pendingClose;
  });

  it("covers passive stream bounds, PID exposure, and delayed failure escalation", async () => {
    const closedInputChild = fakeChild();
    Object.assign(closedInputChild, { pid: 12345 });
    const closedInput = fakeProcess(closedInputChild, { maxStderrBytes: 0 });
    expect(closedInput.pid).toBe(12345);
    closedInputChild.stderr.write("ignored");
    closedInputChild.stdout.write("\n");
    closedInputChild.stdin.end();
    await expect(closedInput.request({ type: "get_state" })).rejects.toMatchObject({ code: "write" });
    closedInputChild.emit("close", 0, null);
    await closedInput.close();

    const oversizedChild = fakeChild();
    const oversized = fakeProcess(oversizedChild, { maxLineBytes: 1024 });
    const failure = processFailure(oversized);
    oversizedChild.stdout.write("x".repeat(1025));
    await expect(failure).resolves.toMatchObject({ code: "protocol" });
    oversizedChild.stdout.write("ignored after failure");
    await new Promise((resolve) => setTimeout(resolve, 1_050));
    oversizedChild.emit("close", 1, null);
    await oversized.close();
  });

  it("closes watched provider descendants on normal and unexpected exits", async () => {
    for (const scenario of ["process-tree", "process-tree-exit"]) {
      const process = await rpcProcess(scenario);
      const pid = await processEventPid(process);
      if (scenario === "process-tree-exit") await expect(processFailure(process)).resolves.toBeInstanceOf(PiRpcError);
      await process.close().catch(() => undefined);
      await vi.waitFor(() => expect(processExists(pid)).toBe(false), { timeout: 3_000 });
    }
  });
});

async function rpcProcess(
  scenario: string,
  options: { maxLineBytes?: number; maxStderrBytes?: number } = {},
): Promise<PiRpcProcess> {
  const cwd = await mkdtemp(join(tmpdir(), "opentag-pi-rpc-"));
  directories.push(cwd);
  return new PiRpcProcess({
    command: process.execPath,
    args: [fixture, scenario],
    cwd,
    env: { PATH: process.env.PATH },
    maxLineBytes: options.maxLineBytes,
    maxStderrBytes: options.maxStderrBytes,
    requestTimeoutMs: 2_000,
  });
}

function processFailure(process: PiRpcProcess): Promise<Error> {
  return new Promise((resolve) => {
    const unsubscribe = process.subscribe((message) => {
      if (message.type !== "opentag/process_error" || !(message.error instanceof Error)) return;
      unsubscribe();
      resolve(message.error);
    });
  });
}

function processEventPid(process: PiRpcProcess): Promise<number> {
  return new Promise((resolve) => {
    const unsubscribe = process.subscribe((message) => {
      if (message.type !== "fixture_process_tree" || typeof message.pid !== "number") return;
      unsubscribe();
      resolve(message.pid);
    });
  });
}

function processExists(pid: number): boolean {
  try {
    globalThis.process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

type FakeChildProcess = ChildProcessWithoutNullStreams & {
  readonly stdin: PassThrough;
  readonly stdout: PassThrough;
  readonly stderr: PassThrough;
};

const fakeChildren = new WeakMap<PiRpcProcess, FakeChildProcess>();

function fakeChild(): FakeChildProcess {
  const child = new EventEmitter() as FakeChildProcess;
  Object.assign(child, {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid: undefined,
    kill: () => true,
  });
  return child;
}

function fakeProcess(
  child: FakeChildProcess,
  options: { maxLineBytes?: number; maxStderrBytes?: number; requestTimeoutMs?: number } = {},
): PiRpcProcess {
  const process = new PiRpcProcess({
    args: [],
    cwd: "/",
    env: {},
    maxLineBytes: options.maxLineBytes,
    maxStderrBytes: options.maxStderrBytes,
    requestTimeoutMs: options.requestTimeoutMs,
    spawnProcess: () => child,
  });
  fakeChildren.set(process, child);
  return process;
}

function processChild(process: PiRpcProcess): FakeChildProcess {
  return fakeChildren.get(process) as FakeChildProcess;
}
