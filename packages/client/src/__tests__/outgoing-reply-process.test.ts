import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  flushStdout,
  spawnCapturedProcess,
  spawnInheritedProcess,
  truncateUtf8,
} from "../runtime/provider-cli/outgoing-reply-process.js";

// Real child processes need headroom under parallel CI load.
vi.setConfig({ testTimeout: 30_000 });

const originalStdout = Object.getOwnPropertyDescriptor(process, "stdout");

afterEach(() => {
  if (originalStdout) Object.defineProperty(process, "stdout", originalStdout);
  vi.restoreAllMocks();
});

interface FakeStdout extends EventEmitter {
  writable: boolean;
  destroyed: boolean;
  writableLength: number;
  writableNeedDrain: boolean;
  write: ReturnType<typeof vi.fn>;
}

function installFakeStdout(overrides: Partial<Omit<FakeStdout, keyof EventEmitter>> = {}): FakeStdout {
  const fake = Object.assign(new EventEmitter(), {
    writable: true,
    destroyed: false,
    writableLength: 0,
    writableNeedDrain: false,
    write: vi.fn(() => true),
    ...overrides,
  }) as FakeStdout;
  Object.defineProperty(process, "stdout", { value: fake, configurable: true, enumerable: true });
  return fake;
}

/** Returns the signal listener that `spawn` registered on the current process. */
function capturedListener(signal: NodeJS.Signals, before: readonly unknown[]): () => void {
  const added = process.listeners(signal).filter((listener) => !before.includes(listener));
  expect(added).toHaveLength(1);
  return added[0] as () => void;
}

function nodeScript(source: string): { file: string; args: string[] } {
  return { file: process.execPath, args: ["-e", source] };
}

describe("truncateUtf8", () => {
  it("returns short values untouched", () => {
    expect(truncateUtf8("hello", 5)).toEqual({ text: "hello", truncated: false });
    expect(truncateUtf8("", 0)).toEqual({ text: "", truncated: false });
  });

  it("never splits a multi-byte sequence", () => {
    expect(truncateUtf8("你好", 4)).toEqual({ text: "你", truncated: true });
    expect(truncateUtf8("你好", 5)).toEqual({ text: "你", truncated: true });
    expect(truncateUtf8("你好", 3)).toEqual({ text: "你", truncated: true });
    expect(truncateUtf8("你好", 2)).toEqual({ text: "", truncated: true });
    expect(truncateUtf8("a你", 3)).toEqual({ text: "a", truncated: true });
  });

  it("truncates ASCII exactly at the byte limit", () => {
    expect(truncateUtf8("abcdef", 4)).toEqual({ text: "abcd", truncated: true });
  });
});

describe("spawnInheritedProcess", () => {
  it("resolves the child exit code", async () => {
    await expect(spawnInheritedProcess({ ...nodeScript("process.exit(7)"), env: process.env })).resolves.toBe(7);
  });

  it.each([
    ["SIGTERM", 143],
    ["SIGINT", 130],
    ["SIGKILL", 1],
  ] as const)("maps a child killed by %s to exit code %d", async (signal, expected) => {
    await expect(
      spawnInheritedProcess({ ...nodeScript(`process.kill(process.pid, '${signal}')`), env: process.env }),
    ).resolves.toBe(expected);
  });

  it("rejects when the executable cannot be spawned and unregisters its signal listeners", async () => {
    const before = process.listeners("SIGTERM");
    await expect(
      spawnInheritedProcess({ file: "/definitely/missing/executable", args: [], env: process.env }),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(process.listeners("SIGTERM")).toEqual(before);
  });

  it("forwards SIGTERM once to a live child and ignores repeats after it is killed", async () => {
    const beforeTerm = process.listeners("SIGTERM");
    const beforeInt = process.listeners("SIGINT");
    const exit = spawnInheritedProcess({ ...nodeScript("setTimeout(() => {}, 30_000)"), env: process.env });
    const onSigterm = capturedListener("SIGTERM", beforeTerm);
    capturedListener("SIGINT", beforeInt);
    onSigterm();
    onSigterm();
    await expect(exit).resolves.toBe(143);
    expect(process.listeners("SIGTERM")).toEqual(beforeTerm);
    expect(process.listeners("SIGINT")).toEqual(beforeInt);
  });
});

describe("spawnCapturedProcess", () => {
  it("captures stdout up to the byte limit and flags truncation", async () => {
    const result = await spawnCapturedProcess({
      ...nodeScript("process.stdout.write('a'.repeat(15))"),
      env: process.env,
      maxBytes: 10,
      forward: false,
    });
    expect(result).toMatchObject({ code: 0, truncated: true, timedOut: false });
    expect(result.stdout.toString()).toBe("aaaaaaaaaa");
  });

  it("stops capturing after the limit is reached even when later chunks arrive", async () => {
    const script = [
      "process.stdout.write('a'.repeat(10));",
      "setTimeout(() => process.stdout.write('b'), 30);",
      "setTimeout(() => process.stdout.write('c'), 60);",
    ].join("");
    const result = await spawnCapturedProcess({
      ...nodeScript(script),
      env: process.env,
      maxBytes: 10,
      forward: false,
    });
    expect(result.truncated).toBe(true);
    expect(result.stdout.toString()).toBe("aaaaaaaaaa");
  });

  it.each([
    ["SIGTERM", 143],
    ["SIGINT", 130],
    ["SIGKILL", 1],
  ] as const)("maps a child killed by %s to exit code %d", async (signal, expected) => {
    const result = await spawnCapturedProcess({
      ...nodeScript(`process.kill(process.pid, '${signal}')`),
      env: process.env,
      maxBytes: 1024,
      forward: false,
    });
    expect(result.code).toBe(expected);
  });

  it("rejects when the executable cannot be spawned", async () => {
    await expect(
      spawnCapturedProcess({
        file: "/definitely/missing/executable",
        args: [],
        env: process.env,
        maxBytes: 16,
        forward: false,
      }),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("kills a child that outlives the timeout and reports timedOut", async () => {
    const result = await spawnCapturedProcess({
      ...nodeScript("process.stdout.write('partial'); setTimeout(() => {}, 30_000)"),
      env: process.env,
      timeoutMs: 100,
      maxBytes: 1024,
      forward: false,
    });
    expect(result.timedOut).toBe(true);
    expect(result.code).toBe(1);
    expect(result.stdout.toString()).toBe("partial");
  });

  it("does not register signal listeners when not forwarding", async () => {
    const before = process.listeners("SIGTERM");
    const pending = spawnCapturedProcess({
      ...nodeScript("setTimeout(() => {}, 50)"),
      env: process.env,
      maxBytes: 16,
      forward: false,
    });
    expect(process.listeners("SIGTERM")).toEqual(before);
    await pending;
  });

  it("forwards stdout to the parent and relays SIGINT while forwarding", async () => {
    const stdout = installFakeStdout();
    const beforeInt = process.listeners("SIGINT");
    const beforeTerm = process.listeners("SIGTERM");
    const pending = spawnCapturedProcess({
      ...nodeScript("process.stdout.write('forwarded'); setTimeout(() => {}, 30_000)"),
      env: process.env,
      maxBytes: 1024,
      forward: true,
    });
    const onSigint = capturedListener("SIGINT", beforeInt);
    capturedListener("SIGTERM", beforeTerm);
    await vi.waitFor(() => expect(stdout.write).toHaveBeenCalled());
    onSigint();
    onSigint();
    const result = await pending;
    expect(result.code).toBe(130);
    expect(result.stdout.toString()).toBe("forwarded");
    expect(Buffer.concat(stdout.write.mock.calls.map(([chunk]) => chunk as Buffer)).toString()).toBe("forwarded");
    expect(process.listeners("SIGINT")).toEqual(beforeInt);
    expect(process.listeners("SIGTERM")).toEqual(beforeTerm);
  });

  it("pauses the child while the parent stdout is saturated and resumes on drain", async () => {
    const stdout = installFakeStdout();
    stdout.write.mockImplementationOnce(() => false).mockImplementation(() => true);
    const script = ["process.stdout.write('first');", "setTimeout(() => process.stdout.write('second'), 40);"].join("");
    const pending = spawnCapturedProcess({
      ...nodeScript(script),
      env: process.env,
      maxBytes: 1024,
      forward: true,
    });
    await vi.waitFor(() => expect(stdout.listenerCount("drain")).toBe(1));
    stdout.emit("drain");
    const result = await pending;
    expect(result.code).toBe(0);
    expect(result.stdout.toString()).toBe("firstsecond");
    expect(stdout.listenerCount("drain")).toBe(0);
  });
});

describe("flushStdout", () => {
  it("returns immediately when stdout is not writable or is destroyed", async () => {
    const closed = installFakeStdout({ writable: false });
    await flushStdout();
    expect(closed.write).not.toHaveBeenCalled();
    const destroyed = installFakeStdout({ destroyed: true });
    await flushStdout();
    expect(destroyed.write).not.toHaveBeenCalled();
  });

  it("returns immediately when nothing is buffered", async () => {
    const idle = installFakeStdout();
    await flushStdout();
    expect(idle.write).not.toHaveBeenCalled();
  });

  it("writes an empty probe and resolves at once when the buffer accepts it", async () => {
    const busy = installFakeStdout({ writableLength: 3 });
    await flushStdout();
    expect(busy.write).toHaveBeenCalledOnce();
    expect(busy.listenerCount("drain")).toBe(0);
  });

  it("waits for drain when the buffer is saturated", async () => {
    const saturated = installFakeStdout({ writableNeedDrain: true, write: vi.fn(() => false) });
    let flushed = false;
    const pending = flushStdout().then(() => {
      flushed = true;
    });
    await Promise.resolve();
    expect(flushed).toBe(false);
    expect(saturated.listenerCount("drain")).toBe(1);
    saturated.emit("drain");
    await pending;
    expect(flushed).toBe(true);
  });
});
