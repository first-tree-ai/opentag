import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ClaudeCodeProcess, ClaudeCodeProcessError } from "../providers/claude-code/process-wire.js";

const fixture = fileURLToPath(new URL("./fixtures/claude-code-stream.mjs", import.meta.url));
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

describe("ClaudeCodeProcess", () => {
  it("exchanges bounded JSONL and closes after the terminal result", async () => {
    const process = await fixtureProcess("normal");
    const messages: Readonly<Record<string, unknown>>[] = [];
    await expect(
      process.execute(
        { type: "user", text: "hello" },
        (message) => messages.push(message),
        new AbortController().signal,
      ),
    ).resolves.toEqual({ stderr: "" });
    expect(messages.map((message) => message.type)).toEqual(["system", "result"]);
    await process.close();
  });

  it.each(["malformed", "non-object", "oversized", "truncated"])(
    "fails closed for %s provider output",
    async (scenario) => {
      const process = await fixtureProcess(scenario, 1024);
      await expect(
        process.execute({ type: "user" }, () => undefined, new AbortController().signal),
      ).rejects.toBeInstanceOf(ClaudeCodeProcessError);
      await process.close();
    },
  );

  it("includes bounded stderr when the Provider exits without a result", async () => {
    const process = await fixtureProcess("exit");
    await expect(process.execute({ type: "user" }, () => undefined, new AbortController().signal)).rejects.toThrow(
      "fixture failure",
    );
    await process.close();
  });

  it("rejects pre-aborted and duplicate executions", async () => {
    const process = await fixtureProcess("normal");
    const controller = new AbortController();
    controller.abort();
    await expect(process.execute({ type: "user" }, () => undefined, controller.signal)).rejects.toMatchObject({
      code: "aborted",
    });

    const run = process.execute({ type: "user" }, () => undefined, new AbortController().signal);
    await expect(
      process.execute({ type: "user" }, () => undefined, new AbortController().signal),
    ).rejects.toMatchObject({ code: "protocol" });
    await run;
    await process.close();
  });

  it("rejects an input above the configured line bound", async () => {
    const process = await fixtureProcess("normal", 1024);
    await expect(
      process.execute({ text: "x".repeat(2048) }, () => undefined, new AbortController().signal),
    ).rejects.toMatchObject({ code: "protocol" });
    await process.close();
  });

  it("validates process bounds and synchronous spawn failures", () => {
    const spawn = () => fakeChild();
    expect(
      () => new ClaudeCodeProcess({ args: [], cwd: "/", env: {}, maxLineBytes: 1023, spawnProcess: spawn }),
    ).toThrow("maxLineBytes");
    expect(
      () => new ClaudeCodeProcess({ args: [], cwd: "/", env: {}, maxStderrBytes: -1, spawnProcess: spawn }),
    ).toThrow("maxStderrBytes");
    expect(
      () =>
        new ClaudeCodeProcess({
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
        new ClaudeCodeProcess({
          args: [],
          cwd: "/",
          env: {},
          spawnProcess: () => {
            throw 42;
          },
        }),
    ).toThrow("Claude Code could not be started");
  });

  it("uses default process options and preserves bounded stderr across blank and CRLF lines", async () => {
    const child = fakeChild();
    let command: string | undefined;
    const process = new ClaudeCodeProcess({
      args: ["arg"],
      cwd: "/",
      env: {},
      maxStderrBytes: 3,
      spawnProcess: (value) => {
        command = value;
        return child;
      },
    });
    const messages: Readonly<Record<string, unknown>>[] = [];
    const run = process.execute({ type: "user" }, (message) => messages.push(message), new AbortController().signal);
    child.stderr.write("abcdef");
    child.stderr.write("ignored");
    child.stdout.write(`\n${JSON.stringify({ type: "status" })}\r\n${JSON.stringify({ type: "result" })}\n`);
    await process.interrupt();
    child.emit("exit", 0, null);

    await expect(run).resolves.toEqual({ stderr: "abc" });
    expect(messages.map((message) => message.type)).toEqual(["status", "result"]);
    expect(command).toBe("claude");
    await process.close();
    await process.interrupt();
  });

  it("propagates listener, child, and stdin write failures", async () => {
    for (const thrown of [new Error("listener failed"), 42]) {
      const child = fakeChild();
      const process = fakeProcess(child);
      const run = process.execute(
        { type: "user" },
        () => {
          throw thrown;
        },
        new AbortController().signal,
      );
      child.stdout.write(`${JSON.stringify({ type: "status" })}\n`);
      child.stdout.write(`${JSON.stringify({ type: "ignored" })}\n`);
      await expect(run).rejects.toBeInstanceOf(Error);
      child.emit("exit", 1, null);
      await process.close();
    }

    const erroredChild = fakeChild();
    const errored = fakeProcess(erroredChild);
    const erroredRun = errored.execute({ type: "user" }, () => undefined, new AbortController().signal);
    erroredChild.emit("error", new Error("child error"));
    erroredChild.emit("error", new Error("second error"));
    await expect(erroredRun).rejects.toMatchObject({ code: "spawn" });
    erroredChild.emit("exit", 1, null);
    await errored.close();

    const failedBeforeExecuteChild = fakeChild();
    const failedBeforeExecute = fakeProcess(failedBeforeExecuteChild);
    failedBeforeExecuteChild.emit("error", new Error("spawn failed before execute"));
    await expect(
      failedBeforeExecute.execute({ type: "user" }, () => undefined, new AbortController().signal),
    ).rejects.toMatchObject({ code: "spawn" });
    failedBeforeExecuteChild.emit("exit", 1, null);
    await failedBeforeExecute.close();

    const startedChild = fakeChild();
    const started = fakeProcess(startedChild);
    startedChild.emit("spawn");
    const startedRun = started.execute({ type: "user" }, () => undefined, new AbortController().signal);
    startedChild.emit("error", new Error("child failed after spawn"));
    await expect(startedRun).rejects.toMatchObject({ code: "exited" });
    startedChild.emit("exit", 1, null);
    await started.close();

    const writeChild = fakeChild();
    writeChild.stdin.write = ((_chunk: unknown, callback: (error?: Error | null) => void) => {
      callback(new Error("write failed"));
      return false;
    }) as typeof writeChild.stdin.write;
    const writeFailure = fakeProcess(writeChild);
    await expect(
      writeFailure.execute({ type: "user" }, () => undefined, new AbortController().signal),
    ).rejects.toMatchObject({ code: "write" });
    writeChild.emit("exit", 1, null);
    await writeFailure.close();
  });

  it("maps active interrupt and close exits to aborted and rejects execution after an early exit", async () => {
    const interruptChild = fakeChild();
    const interrupted = fakeProcess(interruptChild);
    const interruptedRun = interrupted.execute({ type: "user" }, () => undefined, new AbortController().signal);
    await interrupted.interrupt();
    interruptChild.emit("exit", null, "SIGINT");
    await expect(interruptedRun).rejects.toMatchObject({ code: "aborted" });
    await interrupted.close();

    const closingChild = fakeChild();
    const closing = fakeProcess(closingChild);
    const closingRun = closing.execute({ type: "user" }, () => undefined, new AbortController().signal);
    const close = closing.close(100);
    closingChild.emit("exit", null, "SIGTERM");
    await close;
    await expect(closingRun).rejects.toMatchObject({ code: "aborted" });

    const exitedChild = fakeChild();
    const exited = fakeProcess(exitedChild);
    exitedChild.emit("exit", 0, null);
    await expect(exited.execute({ type: "user" }, () => undefined, new AbortController().signal)).rejects.toMatchObject(
      {
        code: "exited",
      },
    );
    await exited.close();

    const emptyExitChild = fakeChild();
    const emptyExit = fakeProcess(emptyExitChild);
    const emptyExitRun = emptyExit.execute({ type: "user" }, () => undefined, new AbortController().signal);
    emptyExitChild.emit("exit", 1, null);
    await expect(emptyExitRun).rejects.toThrow("exited before a result");
    await emptyExit.close();
  });

  it("fails when buffered output exceeds the bound without a newline", async () => {
    const child = fakeChild();
    const process = new ClaudeCodeProcess({
      args: [],
      cwd: "/",
      env: {},
      maxLineBytes: 1024,
      spawnProcess: () => child,
    });
    const run = process.execute({ type: "user" }, () => undefined, new AbortController().signal);
    child.stdout.write("x".repeat(1025));
    await expect(run).rejects.toMatchObject({ code: "protocol" });
    child.emit("exit", 1, null);
    await process.close();
  });

  it("escalates close and reports a process tree that never exits", async () => {
    const child = fakeChild();
    const process = fakeProcess(child);
    await expect(process.close(1)).rejects.toMatchObject({ code: "exited" });
    child.emit("exit", 1, null);
    await process.close();
  });
});

async function fixtureProcess(scenario: string, maxLineBytes?: number): Promise<ClaudeCodeProcess> {
  const cwd = await mkdtemp(join(tmpdir(), "opentag-claude-code-wire-"));
  directories.push(cwd);
  return new ClaudeCodeProcess({
    command: process.execPath,
    args: [fixture],
    cwd,
    env: { PATH: process.env.PATH, CLAUDE_CODE_FIXTURE_SCENARIO: scenario },
    maxLineBytes,
  });
}

function fakeProcess(child: ChildProcessWithoutNullStreams): ClaudeCodeProcess {
  return new ClaudeCodeProcess({ args: [], cwd: "/", env: {}, spawnProcess: () => child });
}

type FakeChildProcess = ChildProcessWithoutNullStreams & {
  readonly stdin: PassThrough;
  readonly stdout: PassThrough;
  readonly stderr: PassThrough;
};

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
