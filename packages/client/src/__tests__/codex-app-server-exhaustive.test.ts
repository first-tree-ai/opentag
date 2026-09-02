import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  CODEX_APP_SERVER_MAX_LINE_BYTES,
  CODEX_APP_SERVER_MAX_STDERR_BYTES,
  CODEX_APP_SERVER_REQUEST_TIMEOUT_MS,
  CodexAppServerError,
  CodexAppServerProcess,
} from "../providers/codex/app-server-wire.js";

describe("CodexAppServerProcess exhaustive behavior", () => {
  it("validates constructor limits and wraps synchronous spawn failures", () => {
    for (const maxLineBytes of [0, 1023, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => processWith(new FakeChild(), { maxLineBytes })).toThrowError(
        "maxLineBytes must be a safe integer of at least 1024",
      );
    }
    for (const requestTimeoutMs of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => processWith(new FakeChild(), { requestTimeoutMs })).toThrowError(
        "requestTimeoutMs must be a positive safe integer",
      );
    }
    expect(CODEX_APP_SERVER_MAX_STDERR_BYTES).toBe(64 * 1024);
    expect(() => processWith(new FakeChild(), { maxStderrBytes: -1 })).toThrowError(
      "maxStderrBytes must be a non-negative safe integer",
    );
    expect(
      () =>
        new CodexAppServerProcess({
          cwd: "/tmp",
          env: {},
          spawnProcess: () => {
            throw new Error("spawn exploded");
          },
        }),
    ).toThrowError(expect.objectContaining({ code: "spawn", message: "spawn exploded" }));
    expect(
      () =>
        new CodexAppServerProcess({
          cwd: "/tmp",
          env: {},
          spawnProcess: () => {
            throw "non-error spawn";
          },
        }),
    ).toThrowError(expect.objectContaining({ code: "spawn", message: "Codex could not be started" }));
    expect(
      () =>
        new CodexAppServerProcess({
          cwd: "/tmp",
          env: {},
          spawnProcess: () => {
            throw Object.assign(new Error("again"), { code: "EAGAIN" });
          },
        }),
    ).toThrowError(expect.objectContaining({ code: "spawn", errno: "EAGAIN" }));
  });

  it("retains a bounded stderr tail on abnormal exit without parsing stderr as protocol", async () => {
    const child = new FakeChild({ exitOnEnd: false });
    const process = processWith(child, { maxStderrBytes: 8 });
    const failure = processFailure(process);
    child.stderr.write('{"id":999,"result":"not stdout"}');
    child.stderr.write("-extra-diagnostics");
    child.exit(23, null);

    await expect(failure).resolves.toMatchObject({
      code: "exited",
      exitCode: 23,
      message: 'Codex App Server exited: {"id":99',
    });
    await process.close();
  });

  it("uses default process options, exposes pid, initializes, notifies, interrupts, and rejects request errors", async () => {
    const child = new FakeChild();
    const spawn = vi.fn((_command, _args, _options) => child.asChildProcess());
    const process = new CodexAppServerProcess({ cwd: "/tmp", env: { TEST: "one" }, spawnProcess: spawn });
    child.handle = (message) => {
      if (message.method === "initialize") child.respond(message.id, initializeResult());
      else if (message.method === "turn/interrupt") child.respond(message.id, {});
      else if (message.method === "fixture/error") child.respondError(message.id);
      else if (message.method === "fixture/error-raw") child.send({ id: message.id, error: true });
    };

    expect(spawn).toHaveBeenCalledWith(
      "codex",
      ["app-server", "--stdio"],
      expect.objectContaining({ cwd: "/tmp", env: { TEST: "one" }, detached: globalThis.process.platform !== "win32" }),
    );
    expect(process.pid).toBe(child.pid);
    await process.initialize("1.2.3");
    expect(child.messages[0]).toMatchObject({
      method: "initialize",
      params: { capabilities: { experimentalApi: true } },
    });
    expect(child.messages.at(-1)).toEqual({ method: "initialized", params: {} });
    await process.interrupt("thread", "turn");
    await expect(process.request("fixture/error", {})).rejects.toMatchObject({
      code: "protocol",
      message: "Codex returned a request error: request failed",
    });
    await expect(process.request("fixture/error-raw", {})).rejects.toMatchObject({
      message: "Codex returned a request error",
    });
    await process.close();
    await process.close();
  });

  it("validates every initialize response field and expected Home", async () => {
    const invalidResults = [
      null,
      {},
      { ...initializeResult(), userAgent: "" },
      { ...initializeResult(), platformFamily: 1 },
      { ...initializeResult(), platformOs: "" },
      { ...initializeResult(), codexHome: "x".repeat(4097) },
    ];
    for (const result of invalidResults) {
      const child = new FakeChild();
      child.handle = (message) => child.respond(message.id, result);
      const process = processWith(child);
      await expect(process.initialize("test")).rejects.toMatchObject({ code: "protocol" });
      await process.close();
    }

    const child = new FakeChild();
    child.handle = (message) => child.respond(message.id, initializeResult());
    const process = processWith(child, { expectedCodexHome: "/different" });
    await expect(process.initialize("test")).rejects.toMatchObject({ code: "protocol" });
    await process.close();
  });

  it("handles pre-aborted, in-flight aborted, timed-out, and close-cancelled requests", async () => {
    const child = new FakeChild();
    const process = processWith(child, { requestTimeoutMs: 15 });
    const preAborted = new AbortController();
    preAborted.abort();
    await expect(process.request("fixture/pre-abort", {}, preAborted.signal)).rejects.toMatchObject({
      code: "aborted",
    });

    const controller = new AbortController();
    const inFlight = process.request("fixture/abort", {}, controller.signal);
    controller.abort();
    await expect(inFlight).rejects.toMatchObject({ code: "aborted" });
    await expect(process.request("fixture/timeout", {})).rejects.toMatchObject({ code: "timeout" });

    const closing = process.request("fixture/closing", {});
    const close = process.close();
    await expect(closing).rejects.toMatchObject({ code: "aborted" });
    await close;
    await expect(process.request("fixture/closed", {})).rejects.toMatchObject({ code: "exited" });
    await expect(process.notify("fixture/closed", {})).rejects.toMatchObject({ code: "write" });
  });

  it("handles unavailable stdin, oversized requests, and write callback errors", async () => {
    const unavailable = new FakeChild();
    const unavailableProcess = processWith(unavailable);
    unavailable.stdin.destroy();
    await expect(unavailableProcess.notify("fixture/write", {})).rejects.toMatchObject({ code: "write" });
    unavailable.exit();
    await unavailableProcess.close();

    const oversized = new FakeChild();
    const oversizedProcess = processWith(oversized, { maxLineBytes: 1024 });
    await expect(oversizedProcess.notify("fixture/large", { value: "x".repeat(2048) })).rejects.toMatchObject({
      code: "protocol",
    });
    await oversizedProcess.close();

    const failedWrite = new FakeChild();
    failedWrite.failWrites = true;
    const failedWriteProcess = processWith(failedWrite);
    await expect(failedWriteProcess.request("fixture/write", {})).rejects.toMatchObject({ code: "write" });
    await failedWriteProcess.close();
  });

  it("fails closed for every malformed stdout framing and message shape", async () => {
    const chunks = [
      Buffer.from("x".repeat(1025)),
      Buffer.from(`${"x".repeat(1025)}\n`),
      Buffer.from("not-json\n"),
      Buffer.from("null\n"),
      Buffer.from("[]\n"),
      Buffer.from("{}\n"),
      Buffer.from(`\n${"x".repeat(1025)}`),
    ];
    for (const chunk of chunks) {
      const child = new FakeChild();
      const process = processWith(child, { maxLineBytes: 1024 });
      const failure = processFailure(process);
      child.stdout.write(chunk);
      await expect(failure).resolves.toMatchObject({ code: "protocol" });
      child.stdout.write(Buffer.from("ignored-after-failure\n"));
      await process.close().catch(() => undefined);
    }
  });

  it("rejects unknown, duplicate, and errored response IDs", async () => {
    const unknownChild = new FakeChild();
    const unknownProcess = processWith(unknownChild);
    const unknownFailure = processFailure(unknownProcess);
    unknownChild.send({ id: 999, result: {} });
    await expect(unknownFailure).resolves.toMatchObject({ code: "protocol" });
    await unknownProcess.close();

    const duplicateChild = new FakeChild();
    const duplicateProcess = processWith(duplicateChild);
    const request = duplicateProcess.request("fixture/one", {});
    const id = duplicateChild.messages[0]?.id;
    duplicateChild.respond(id, { ok: true });
    await expect(request).resolves.toEqual({ ok: true });
    const duplicateFailure = processFailure(duplicateProcess);
    duplicateChild.respond(id, { ok: true });
    await expect(duplicateFailure).resolves.toMatchObject({ code: "protocol" });
    await duplicateProcess.close();
  });

  it("handles explicit interactive responses, rejections, duplicates, and listener failures", async () => {
    const child = new FakeChild();
    const process = processWith(child);
    const requests: CodexAppServerRequest[] = [];
    const unsubscribe = process.subscribeServerRequests((request) => requests.push(request));
    child.send({ id: "request-1", method: "item/tool/requestUserInput", params: { question: true } });
    expect(requests).toEqual([{ id: "request-1", method: "item/tool/requestUserInput", params: { question: true } }]);
    await process.rejectServerRequest("request-1", -32000, "declined");
    expect(child.messages.at(-1)).toEqual({ id: "request-1", error: { code: -32000, message: "declined" } });
    await expect(process.rejectServerRequest("request-1", -32000, "again")).rejects.toMatchObject({
      code: "protocol",
    });

    child.send({ id: 2, method: "item/tool/requestUserInput", params: {} });
    const failure = processFailure(process);
    child.send({ id: 2, method: "item/tool/requestUserInput", params: {} });
    await expect(failure).resolves.toMatchObject({ code: "protocol" });
    unsubscribe();
    await process.close();

    const listenerChild = new FakeChild();
    const listenerProcess = processWith(listenerChild);
    listenerProcess.subscribeServerRequests(() => {
      throw new Error("listener failed");
    });
    const listenerFailure = processFailure(listenerProcess);
    listenerChild.send({ id: "listener", method: "item/tool/requestUserInput", params: {} });
    await expect(listenerFailure).resolves.toMatchObject({ code: "protocol" });
    await listenerProcess.close();
  });

  it("retains dynamic request IDs across active and completed duplicate calls", async () => {
    const activeChild = new FakeChild();
    const activeProcess = processWith(activeChild);
    const activeHandler = vi.fn();
    let releaseHandler!: () => void;
    const handlerGate = new Promise<void>((resolveHandler) => {
      releaseHandler = resolveHandler;
    });
    activeProcess.setDynamicToolHandler(async (call) => {
      activeHandler(call);
      await handlerGate;
      return { success: true, text: "active result" };
    });
    const activeFailure = processFailure(activeProcess);
    activeChild.send(dynamicToolRequest("dynamic-active", "call-1"));
    await vi.waitFor(() => expect(activeHandler).toHaveBeenCalledTimes(1));
    activeChild.send(dynamicToolRequest("dynamic-active", "call-2"));
    expect(activeHandler).toHaveBeenCalledTimes(1);
    releaseHandler();
    await vi.waitFor(() =>
      expect(activeChild.messages.filter((message) => message.id === "dynamic-active")).toHaveLength(1),
    );
    await expect(activeFailure).resolves.toMatchObject({ code: "protocol" });
    expect(activeHandler).toHaveBeenCalledTimes(1);
    await activeProcess.close();

    const completedChild = new FakeChild();
    const completedProcess = processWith(completedChild);
    const completedHandler = vi.fn(async () => ({ success: true, text: "completed result" }));
    completedProcess.setDynamicToolHandler(completedHandler);
    completedChild.send(dynamicToolRequest("dynamic-completed", "call-1"));
    await vi.waitFor(() =>
      expect(completedChild.messages.filter((message) => message.id === "dynamic-completed")).toHaveLength(1),
    );
    await new Promise<void>((resolveTurn) => setImmediate(resolveTurn));
    const completedFailure = processFailure(completedProcess);
    completedChild.stdout.write(
      `${JSON.stringify(dynamicToolRequest("dynamic-completed", "call-2"))}\n${JSON.stringify(
        dynamicToolRequest("dynamic-completed", "call-3"),
      )}\n`,
    );
    await expect(completedFailure).resolves.toMatchObject({ code: "protocol" });
    expect(completedHandler).toHaveBeenCalledTimes(1);
    expect(completedChild.messages.filter((message) => message.id === "dynamic-completed")).toHaveLength(1);
    await completedProcess.close();
  });

  it("retains interactive request ownership across response write failures", async () => {
    const child = new FakeChild();
    const process = processWith(child);
    process.subscribeServerRequests(() => undefined);

    child.send({ id: "response-retry", method: "item/tool/requestUserInput", params: {} });
    child.failWrites = true;
    await expect(process.respondServerRequest("response-retry", { answer: "first" })).rejects.toMatchObject({
      code: "write",
    });
    child.failWrites = false;
    await process.respondServerRequest("response-retry", { answer: "retry" });
    expect(child.messages.at(-1)).toEqual({ id: "response-retry", result: { answer: "retry" } });

    child.send({ id: "rejection-retry", method: "item/tool/requestUserInput", params: {} });
    child.failWrites = true;
    await expect(process.rejectServerRequest("rejection-retry", -32000, "first")).rejects.toMatchObject({
      code: "write",
    });
    child.failWrites = false;
    await process.rejectServerRequest("rejection-retry", -32000, "retry");
    expect(child.messages.at(-1)).toEqual({
      id: "rejection-retry",
      error: { code: -32000, message: "retry" },
    });

    child.send({ id: "in-flight", method: "item/tool/requestUserInput", params: {} });
    child.holdWrites = true;
    const first = process.respondServerRequest("in-flight", { answer: "only" });
    await expect(process.respondServerRequest("in-flight", { answer: "duplicate" })).rejects.toMatchObject({
      code: "protocol",
    });
    child.releaseWrites();
    await first;
    await process.close();
  });

  it("handles unattended file approvals, questions, and unsupported requests", async () => {
    const child = new FakeChild();
    const process = processWith(child);
    child.send({ id: "file", method: "item/fileChange/requestApproval", params: {} });
    await vi.waitFor(() => expect(child.messages).toContainEqual({ id: "file", result: { decision: "cancel" } }));
    child.send({ id: "question", method: "item/tool/requestUserInput", params: {} });
    await vi.waitFor(() => expect(child.messages).toContainEqual({ id: "question", result: { answers: {} } }));
    const failure = processFailure(process);
    child.send({ id: "unknown", method: "unknown/request", params: {} });
    await expect(failure).resolves.toMatchObject({ code: "protocol" });
    await process.close();
  });

  it("fails closed for unavailable and malformed dynamic tools while accepting a string namespace", async () => {
    const child = new FakeChild();
    const process = processWith(child);
    const params = {
      arguments: { text: "hello" },
      callId: "call-1",
      namespace: null,
      threadId: "thread-1",
      tool: "example_tool",
      turnId: "turn-1",
    };

    child.send({ id: "unavailable", method: "item/tool/call", params });
    await vi.waitFor(() =>
      expect(child.messages).toContainEqual({
        id: "unavailable",
        result: {
          contentItems: [{ type: "inputText", text: "OpenTag tool is unavailable." }],
          success: false,
        },
      }),
    );

    const handler = vi.fn(async () => ({ success: true, text: "handled" }));
    process.setDynamicToolHandler(handler);
    child.send({ id: "malformed", method: "item/tool/call", params: { ...params, namespace: 42 } });
    await vi.waitFor(() =>
      expect(child.messages).toContainEqual({
        id: "malformed",
        result: {
          contentItems: [{ type: "inputText", text: "OpenTag tool request failed." }],
          success: false,
        },
      }),
    );

    child.send({ id: "namespaced", method: "item/tool/call", params: { ...params, namespace: "opentag" } });
    await vi.waitFor(() =>
      expect(child.messages).toContainEqual({
        id: "namespaced",
        result: { contentItems: [{ type: "inputText", text: "handled" }], success: true },
      }),
    );
    expect(handler).toHaveBeenCalledWith(expect.objectContaining({ namespace: "opentag" }));
    await process.close();
  });

  it("fails when notification listeners throw and tolerates failure listeners throwing", async () => {
    const child = new FakeChild();
    const process = processWith(child);
    process.subscribe(() => {
      throw new Error("notification listener failed");
    });
    child.send({ method: "notification", params: {} });
    await vi.waitFor(() => expect(child.kills).toContain("SIGTERM"));
    await process.close();

    const failureChild = new FakeChild();
    const failureProcess = processWith(failureChild);
    failureProcess.subscribe(() => {
      throw new Error("failure listener failed");
    });
    failureChild.send({ invalid: true });
    failureChild.emit("error", new Error("second failure"));
    await vi.waitFor(() => expect(failureChild.kills).toContain("SIGTERM"));
    await failureProcess.close();
  });

  it("records exit code, crash signal, and spawn errno on App Server failures", async () => {
    const exited = new FakeChild({ exitOnEnd: false });
    const exitedProcess = processWith(exited);
    const exitedFailure = processFailure(exitedProcess);
    exited.exit(1, null);
    await expect(exitedFailure).resolves.toMatchObject({ code: "exited", exitCode: 1, signal: null });
    await exitedProcess.close();

    const crashed = new FakeChild({ exitOnEnd: false });
    const crashedProcess = processWith(crashed);
    const crashedFailure = processFailure(crashedProcess);
    crashed.exit(null, "SIGSEGV");
    await expect(crashedFailure).resolves.toMatchObject({ code: "exited", signal: "SIGSEGV" });
    await crashedProcess.close();

    const busy = new FakeChild({ exitOnEnd: false });
    const busyProcess = processWith(busy);
    const busyFailure = processFailure(busyProcess);
    busy.emit("error", Object.assign(new Error("again"), { code: "ENOMEM" }));
    await expect(busyFailure).resolves.toMatchObject({ code: "spawn", errno: "ENOMEM" });
    busy.exit();
    await busyProcess.close();
  });

  it("distinguishes clean exit, truncated exit, child errors, forced kill, and unkillable process trees", async () => {
    for (const truncated of [false, true]) {
      const child = new FakeChild({ exitOnEnd: false });
      const process = processWith(child);
      const failure = processFailure(process);
      if (truncated) child.stdout.write("partial");
      child.exit();
      await expect(failure).resolves.toMatchObject({ code: truncated ? "protocol" : "exited" });
      await process.close();
    }

    const errored = new FakeChild({ exitOnEnd: false });
    const erroredProcess = processWith(errored);
    const erroredFailure = processFailure(erroredProcess);
    errored.emit("error", new Error("child error"));
    await expect(erroredFailure).resolves.toMatchObject({ code: "spawn", message: "child error" });
    errored.exit();
    await erroredProcess.close();

    const forceKilled = new FakeChild({ exitOnEnd: false, exitOnSignal: "SIGKILL" });
    const forceKilledProcess = processWith(forceKilled);
    await forceKilledProcess.close(5);
    expect(forceKilled.kills).toEqual(["SIGTERM", "SIGKILL"]);

    const unkillable = new FakeChild({ exitOnEnd: false });
    const unkillableProcess = processWith(unkillable);
    await expect(unkillableProcess.close(5)).rejects.toMatchObject({ code: "exited" });
  });

  it("escalates a failed process from TERM to KILL after the failure grace period", async () => {
    vi.useFakeTimers();
    try {
      const child = new FakeChild({ exitOnEnd: false });
      const process = processWith(child);
      child.send({ invalid: true });
      await vi.advanceTimersByTimeAsync(1_001);
      expect(child.kills).toEqual(["SIGTERM", "SIGKILL"]);
      child.exit();
      await process.close();
    } finally {
      vi.useRealTimers();
    }
  });
});

interface FakeChildOptions {
  readonly exitOnEnd?: boolean;
  readonly exitOnSignal?: "SIGTERM" | "SIGKILL";
}

class FakeChild extends EventEmitter {
  readonly pid = 999_999_999;
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly messages: Array<Record<string, unknown>> = [];
  readonly kills: NodeJS.Signals[] = [];
  readonly #options: Required<Pick<FakeChildOptions, "exitOnEnd">> & Pick<FakeChildOptions, "exitOnSignal">;
  #buffer = "";
  #exited = false;
  readonly #heldWrites: Array<() => void> = [];
  failWrites = false;
  holdWrites = false;
  handle?: (message: Record<string, unknown>) => void;

  constructor(options: FakeChildOptions = {}) {
    super();
    this.#options = { exitOnEnd: options.exitOnEnd ?? true, exitOnSignal: options.exitOnSignal };
    const originalWrite = this.stdin.write.bind(this.stdin);
    this.stdin.write = ((chunk: string | Uint8Array, callback?: (error?: Error | null) => void) => {
      if (this.failWrites) {
        queueMicrotask(() => callback?.(new Error("write failed")));
        return false;
      }
      if (this.holdWrites) {
        this.#heldWrites.push(() => {
          originalWrite(chunk);
          callback?.(null);
        });
        return false;
      }
      const result = originalWrite(chunk);
      queueMicrotask(() => callback?.(null));
      return result;
    }) as typeof this.stdin.write;
    this.stdin.on("data", (chunk: Buffer) => this.#read(chunk));
    this.stdin.on("finish", () => {
      if (this.#options.exitOnEnd) queueMicrotask(() => this.exit());
    });
  }

  asChildProcess(): ChildProcessWithoutNullStreams {
    return this as unknown as ChildProcessWithoutNullStreams;
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.kills.push(signal);
    if (this.#options.exitOnSignal === signal) queueMicrotask(() => this.exit());
    return true;
  }

  releaseWrites(): void {
    this.holdWrites = false;
    for (const write of this.#heldWrites.splice(0)) write();
  }

  exit(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
    if (this.#exited) return;
    this.#exited = true;
    this.emit("exit", code, signal);
  }

  send(message: unknown): void {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }

  respond(id: unknown, result: unknown): void {
    this.send({ id, result });
  }

  respondError(id: unknown): void {
    this.send({ id, error: { code: -32000, message: "request failed" } });
  }

  #read(chunk: Buffer): void {
    this.#buffer += chunk.toString("utf8");
    while (true) {
      const newline = this.#buffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line) as Record<string, unknown>;
      this.messages.push(message);
      this.handle?.(message);
    }
  }
}

function processWith(
  child: FakeChild,
  options: {
    expectedCodexHome?: string;
    maxLineBytes?: number;
    requestTimeoutMs?: number;
  } = {},
): CodexAppServerProcess {
  return new CodexAppServerProcess({
    cwd: "/tmp",
    env: {},
    ...options,
    spawnProcess: () => child.asChildProcess(),
  });
}

function initializeResult() {
  return {
    userAgent: "codex-test",
    platformFamily: "unix",
    platformOs: "macos",
    codexHome: "/codex-home",
  };
}

function processFailure(process: CodexAppServerProcess): Promise<CodexAppServerError> {
  return new Promise((resolve) => {
    process.subscribe((message) => {
      if (message.method !== "opentag/processError") return;
      const error = (message.params as { error?: unknown }).error;
      if (error instanceof CodexAppServerError) resolve(error);
    });
  });
}

function dynamicToolRequest(id: string, callId: string): Record<string, unknown> {
  return {
    id,
    method: "item/tool/call",
    params: {
      arguments: { text: callId },
      callId,
      namespace: null,
      threadId: "thread-1",
      tool: "example_tool",
      turnId: "turn-1",
    },
  };
}

type CodexAppServerRequest = import("../providers/codex/app-server-wire.js").CodexAppServerRequest;

expect(CODEX_APP_SERVER_MAX_LINE_BYTES).toBe(1024 * 1024);
expect(CODEX_APP_SERVER_REQUEST_TIMEOUT_MS).toBe(60_000);
