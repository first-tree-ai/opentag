import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildSandboxRunArgv,
  MAX_RESOLVER_BYTES,
  NativeSandbox,
  NativeSandboxError,
  SANDBOX_NODE,
  SANDBOX_PI,
  SANDBOX_ROOTFS,
  type SpawnProcess,
} from "../runner/native-sandbox.js";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((close) => close()));
});

async function temporaryDirectory(prefix: string) {
  const directory = await mkdtemp(join(tmpdir(), prefix));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function resolverSourceFixture(contents = "nameserver 192.0.2.53\nsearch example.internal\n") {
  const directory = await temporaryDirectory("opentag-resolver-source-");
  const source = join(directory, "platform-resolv.conf");
  await writeFile(source, contents, { mode: 0o644 });
  return source;
}

/** Fake child matching the ChildProcessWithoutNullStreams surface the sandbox supervisor uses. */
function fakeChild(result: { code: number; stdout?: string; stderr?: string }) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    stdin: { write(chunk: string, cb?: () => void): void; end(): void; on(event: string, cb: () => void): void };
    kill: (signal?: string) => boolean;
    pid: number;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = 4321;
  child.stdin = {
    write(_chunk: string, cb?: () => void) {
      cb?.();
    },
    end() {
      queueMicrotask(() => {
        if (result.stdout) child.stdout.emit("data", Buffer.from(result.stdout));
        if (result.stderr) child.stderr.emit("data", Buffer.from(result.stderr));
        child.emit("close", result.code);
      });
    },
    on: () => child.stdin,
  } as never;
  child.kill = () => {
    queueMicrotask(() => child.emit("close", -1));
    return true;
  };
  return child;
}

interface RecordedSpawn {
  command: string;
  args: readonly string[];
  env?: NodeJS.ProcessEnv;
}

/** Spawn stub that records every argv/env and answers each sandbox subcommand deterministically. */
function recordingSpawn(respond: (args: readonly string[]) => { code: number; stdout?: string; stderr?: string }): {
  spawn: SpawnProcess;
  calls: RecordedSpawn[];
} {
  const calls: RecordedSpawn[] = [];
  const spawn: SpawnProcess = (command, args, options) => {
    calls.push({ command, args: [...args], ...(options?.env ? { env: options.env } : {}) });
    return fakeChild(respond(args)) as never;
  };
  return { spawn, calls };
}

function resolverMountSource(args: readonly string[]): string | undefined {
  const mount = args.find((argument) => argument.endsWith(",destination=/etc/resolv.conf,readonly"));
  return mount?.match(/^type=bind,source=(.+),destination=\/etc\/resolv\.conf,readonly$/)?.[1];
}

function recordedCall(calls: readonly RecordedSpawn[], index: number): RecordedSpawn {
  const call = calls[index];
  if (!call) throw new Error(`sandbox spawn call ${index} is missing`);
  return call;
}

function requiredResolverCopy(args: readonly string[]): string {
  const copy = resolverMountSource(args);
  if (!copy) throw new Error("sandbox launch did not mount a resolver copy");
  return copy;
}

/** Probe answers for the canary test: version commands, identity, then the isolation exec. */
function respondToProbe(args: readonly string[], onCanary: (canary: string) => void) {
  if (args[0] !== "exec") return { code: 0 };
  const command = args[3];
  const commandArgs = args.slice(4);
  if (command === SANDBOX_NODE && commandArgs[0] === "--version") return { code: 0, stdout: "v24.19.0\n" };
  if (command === SANDBOX_PI) return { code: 0, stdout: "0.84.2\n" };
  if (command !== SANDBOX_NODE || commandArgs[0] !== "-e") return { code: 0 };
  const code = commandArgs[1] ?? "";
  if (code.includes("identity.json")) return { code: 0, stdout: "1.0.0" };
  const canary = /opentag-rootfs-[0-9a-f-]+/.exec(code)?.[0];
  if (canary !== undefined) onCanary(canary);
  return { code: 0, stdout: "isolated" };
}

describe("native sandbox resolver snapshot", () => {
  it("requires an explicit resolver copy and never defaults to the sensitive platform path", () => {
    const argv = buildSandboxRunArgv({
      name: "ots-x",
      workspace: "/tmp/ws/ots-x",
      resolverCopy: "/tmp/opentag-resolver-test/resolv.conf",
    });
    expect(resolverMountSource(argv)).toBe("/tmp/opentag-resolver-test/resolv.conf");
    expect(argv.join(" ")).not.toContain("source=/etc/resolv.conf");
    expect(() => buildSandboxRunArgv({ name: "ots-x", workspace: "/tmp/ws", resolverCopy: "relative" })).toThrow(
      /resolver/i,
    );
    expect(() =>
      buildSandboxRunArgv({ name: "ots-x", workspace: "/tmp/ws", resolverCopy: "/tmp/a,b/resolv.conf" }),
    ).toThrow(/resolver/i);
    expect(() =>
      buildSandboxRunArgv({ name: "ots-x", workspace: "/tmp/ws", resolverCopy: "/tmp/../etc/resolv.conf" }),
    ).toThrow(/resolver/i);
  });

  it("snapshots bounded resolver bytes into a private directory outside workspace and rootfs", async () => {
    const workspace = await temporaryDirectory("opentag-native-sandbox-");
    const source = await resolverSourceFixture();
    const sourceBytes = await readFile(source, "utf8");
    const { spawn, calls } = recordingSpawn(() => ({ code: 0 }));
    const sandbox = new NativeSandbox({ name: "ots-x", workspace, resolverSource: source, spawnProcess: spawn });
    await sandbox.launch();
    expect(calls).toHaveLength(1);
    const copy = requiredResolverCopy(recordedCall(calls, 0).args);
    expect(copy).not.toBe(source);
    expect(copy).not.toBe("/etc/resolv.conf");
    const directory = dirname(copy);
    expect(directory.startsWith(workspace)).toBe(false);
    expect(directory.startsWith(SANDBOX_ROOTFS)).toBe(false);
    expect((await stat(directory)).mode & 0o777).toBe(0o700);
    expect((await stat(copy)).mode & 0o777).toBe(0o600);
    expect(await readFile(copy, "utf8")).toBe(sourceBytes);
    // Minimal env: PATH only, never the parent token or resolver bytes.
    expect(Object.keys(recordedCall(calls, 0).env ?? {})).toEqual(["PATH"]);
    await sandbox.destroy();
  });

  it("rejects a resolver source that exceeds the bound before writing or spawning", async () => {
    const workspace = await temporaryDirectory("opentag-native-sandbox-");
    const source = await resolverSourceFixture("x".repeat(MAX_RESOLVER_BYTES + 1));
    const { spawn, calls } = recordingSpawn(() => ({ code: 0 }));
    const sandbox = new NativeSandbox({ name: "ots-x", workspace, resolverSource: source, spawnProcess: spawn });
    await expect(sandbox.launch()).rejects.toMatchObject({ code: "launch_failed" });
    expect(calls).toHaveLength(0);
  });

  it("rejects a resolver source that is not a regular file before spawning", async () => {
    const workspace = await temporaryDirectory("opentag-native-sandbox-");
    const { spawn, calls } = recordingSpawn(() => ({ code: 0 }));
    const sandbox = new NativeSandbox({
      name: "ots-x",
      workspace,
      resolverSource: workspace,
      spawnProcess: spawn,
    });
    await expect(sandbox.launch()).rejects.toMatchObject({ code: "launch_failed" });
    expect(calls).toHaveLength(0);
  });

  it("removes the snapshot when the sandbox launch fails", async () => {
    const workspace = await temporaryDirectory("opentag-native-sandbox-");
    const source = await resolverSourceFixture();
    const { spawn, calls } = recordingSpawn((args) =>
      args[0] === "run" ? { code: 1, stderr: "sandbox create failed" } : { code: 0 },
    );
    const sandbox = new NativeSandbox({ name: "ots-x", workspace, resolverSource: source, spawnProcess: spawn });
    await expect(sandbox.launch()).rejects.toMatchObject({ code: "launch_failed" });
    const copy = requiredResolverCopy(recordedCall(calls, 0).args);
    await expect(stat(copy)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(dirname(copy))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps the snapshot until destroy succeeds and snapshots freshly on relaunch", async () => {
    const workspace = await temporaryDirectory("opentag-native-sandbox-");
    const source = await resolverSourceFixture();
    const { spawn, calls } = recordingSpawn(() => ({ code: 0 }));
    const sandbox = new NativeSandbox({ name: "ots-x", workspace, resolverSource: source, spawnProcess: spawn });
    await sandbox.launch();
    const firstCopy = requiredResolverCopy(recordedCall(calls, 0).args);
    await expect(stat(firstCopy)).resolves.toBeDefined();
    await sandbox.destroy();
    await expect(stat(firstCopy)).rejects.toMatchObject({ code: "ENOENT" });
    await sandbox.launch();
    const runCalls = calls.filter((call) => call.args[0] === "run");
    const secondCopy = requiredResolverCopy(recordedCall(runCalls, 1).args);
    expect(secondCopy).not.toBe(firstCopy);
    await expect(stat(secondCopy)).resolves.toBeDefined();
    await sandbox.destroy();
  });

  it("retains the snapshot when deletion fails and removes it on the retry", async () => {
    const workspace = await temporaryDirectory("opentag-native-sandbox-");
    const source = await resolverSourceFixture();
    let deletes = 0;
    const { spawn, calls } = recordingSpawn((args) => {
      if (args[0] === "delete") {
        deletes += 1;
        return deletes === 1 ? { code: 1, stderr: "sandbox busy" } : { code: 0 };
      }
      return { code: 0 };
    });
    const sandbox = new NativeSandbox({
      name: "ots-x",
      workspace,
      resolverSource: source,
      spawnProcess: spawn,
      sleep: () => Promise.resolve(),
    });
    await sandbox.launch();
    const copy = requiredResolverCopy(recordedCall(calls, 0).args);
    await expect(sandbox.destroy({ attempts: 1 })).rejects.toMatchObject({ code: "delete_failed" });
    await expect(stat(copy)).resolves.toBeDefined();
    await sandbox.destroy({ attempts: 1 });
    await expect(stat(copy)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("keeps the native rootfs canary stable across delete and relaunch", async () => {
    const workspace = await temporaryDirectory("opentag-native-sandbox-");
    const rootfs = await temporaryDirectory("opentag-native-rootfs-");
    const source = await resolverSourceFixture();
    const canaries: string[] = [];
    const { spawn } = recordingSpawn((args) => respondToProbe(args, (canary) => canaries.push(canary)));
    const sandbox = new NativeSandbox({
      name: "ots-x",
      workspace,
      rootfs,
      resolverSource: source,
      spawnProcess: spawn,
    });
    await sandbox.launch();
    await sandbox.probe();
    await sandbox.destroy();
    await sandbox.launch();
    await sandbox.probe();
    await sandbox.destroy();
    expect(canaries).toHaveLength(2);
    expect(canaries[1]).toBe(canaries[0]);
  });
});

describe("native sandbox duplex pipe", () => {
  /** A Sandbox whose exec argv runs under the local Node runtime with real stdio pipes. */
  function realChildSandbox(onSpawn?: () => void): NativeSandbox {
    const spawnProcess: SpawnProcess = (_command, args) => {
      const separator = args.indexOf("--");
      const [binary, ...rest] = args.slice(separator + 1);
      expect(binary).toBe(SANDBOX_NODE);
      onSpawn?.();
      return spawn(process.execPath, rest, { stdio: "pipe" });
    };
    return new NativeSandbox({
      name: "ots-duplex-epipe",
      workspace: join(tmpdir(), "opentag-duplex-epipe-ws"),
      spawnProcess,
    });
  }

  it("delivers a child closed-stdin EPIPE to onError exactly once instead of crashing", async () => {
    const uncaught: string[] = [];
    const onUncaught = (error: Error) => {
      uncaught.push(error.message);
    };
    process.on("uncaughtException", onUncaught);
    try {
      const duplex = realChildSandbox().openDuplex(SANDBOX_NODE, [
        "-e",
        "require('node:fs').closeSync(0);console.log('ready');setTimeout(()=>{},250)",
      ]);
      const errors: Error[] = [];
      const firstError = new Promise<Error>((resolve) => {
        duplex.onError((error) => {
          errors.push(error);
          resolve(error);
        });
      });
      duplex.onData(() => duplex.write(Buffer.alloc(1024 * 1024)));
      const error = await firstError;
      expect(error).toBeInstanceOf(NativeSandboxError);
      expect((error as NativeSandboxError).code).toBe("exec_failed");
      // Later writes and teardown must neither crash nor re-classify the same failure.
      duplex.write(Buffer.alloc(64));
      duplex.end();
      await new Promise<void>((resolve) => duplex.onExit(() => resolve()));
      expect(errors).toHaveLength(1);
      expect(uncaught).toEqual([]);
    } finally {
      process.off("uncaughtException", onUncaught);
    }
  });
});
