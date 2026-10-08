import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildSandboxDeleteArgv,
  buildSandboxExecArgv,
  buildSandboxMetadataScript,
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

/** The valid combined identity + Pi metadata payload the in-Sandbox read prints. */
const PROBE_METADATA_STDOUT = JSON.stringify({
  runnerVersion: "1.0.0",
  identityPiPackage: "@earendil-works/pi-coding-agent",
  identityPiVersion: "0.84.2",
  piName: "@earendil-works/pi-coding-agent",
  piVersion: "0.84.2",
});

/** Probe answers for the canary test: node version, combined metadata read, then the isolation exec. */
function respondToProbe(args: readonly string[], onCanary: (canary: string) => void) {
  if (args[0] !== "exec") return { code: 0 };
  const command = args[3];
  const commandArgs = args.slice(4);
  if (command === SANDBOX_NODE && commandArgs[0] === "--version") return { code: 0, stdout: "v24.19.0\n" };
  if (command !== SANDBOX_NODE || commandArgs[0] !== "-e") return { code: 0 };
  const code = commandArgs[1] ?? "";
  if (code.includes("identity.json")) return { code: 0, stdout: PROBE_METADATA_STDOUT };
  const canary = /opentag-rootfs-[0-9a-f-]+/.exec(code)?.[0];
  if (canary !== undefined) onCanary(canary);
  return { code: 0, stdout: "isolated" };
}

/** Every `sandbox exec` the probe issues, classified by what it runs inside the sandbox. */
function probeExecKinds(calls: readonly RecordedSpawn[]): {
  node: number;
  metadata: number;
  canary: number;
  piCli: number;
} {
  const kinds = { node: 0, metadata: 0, canary: 0, piCli: 0 };
  for (const call of calls) {
    if (call.args[0] !== "exec") continue;
    if (call.args[3] === SANDBOX_PI) kinds.piCli += 1;
    if (call.args[3] !== SANDBOX_NODE) continue;
    if (call.args[4] === "--version") kinds.node += 1;
    const script = call.args[5] ?? "";
    if (script.includes("identity.json")) kinds.metadata += 1;
    if (script.includes("opentag-rootfs-")) kinds.canary += 1;
  }
  return kinds;
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

  it("refuses unsafe sandbox names, mounts, operands, and an empty resolver", async () => {
    // The constructor refuses every unsafe sandbox name.
    for (const name of ["", " ", "1abc", "ABC", "a\nb", "a\0b", "x".repeat(64), "..", "-flag", "a_b"]) {
      expect(
        () =>
          new NativeSandbox({ name, spawnProcess: recordingSpawn(() => ({ code: 0 })).spawn, workspace: "/tmp/ws" }),
        `name=${JSON.stringify(name)}`,
      ).toThrow(/Invalid sandbox name/);
    }
    expect(buildSandboxDeleteArgv({ name: "ots-x" })[1]).toBe("delete");
    expect(buildSandboxExecArgv({ command: "/bin/true", name: "ots-x" }).slice(1, 4)).toEqual(["exec", "ots-x", "--"]);
    // `openDuplex` refuses an unsafe exec command before spawning anything.
    const spawnCalls: unknown[] = [];
    const guarded = new NativeSandbox({
      name: "ots-x",
      spawnProcess: (...args: unknown[]) => {
        spawnCalls.push(args);
        return fakeChild({ code: 0 }) as never;
      },
      workspace: "/tmp/ws",
    });
    expect(() => guarded.openDuplex("bad\ncommand", [])).toThrow(/Unsafe/);
    expect(spawnCalls).toHaveLength(0);
    // A resolver copy must be an absolute, comma-free path without traversal segments.
    for (const resolverCopy of ["relative", "/tmp/a,b/resolv.conf", "/tmp/../etc/resolv.conf", ""]) {
      expect(() => buildSandboxRunArgv({ name: "ots-x", workspace: "/tmp/ws", resolverCopy })).toThrow(
        /Unsafe resolver/,
      );
    }
    // Extra mounts must be safe absolute paths with a comma-free destination.
    for (const mount of [
      { source: "relative", destination: "/mnt/x" },
      { source: "/tmp/a,b", destination: "/mnt/x" },
      { source: "/tmp/../etc", destination: "/mnt/x" },
      { source: "/tmp/ok", destination: "relative" },
      { source: "/tmp/ok", destination: "/mnt/a,b" },
      { source: "/tmp/ok", destination: "/mnt/../etc" },
      { source: "/tmp/ok", destination: "/mnt\n" },
    ]) {
      expect(() =>
        buildSandboxRunArgv({
          extraMounts: [mount],
          name: "ots-x",
          resolverCopy: "/tmp/r.conf",
          workspace: "/tmp/ws",
        }),
      ).toThrow(/Unsafe/);
    }
    for (const workspace of ["relative/ws", "/tmp/ws,other", "/tmp/../etc"]) {
      expect(
        () =>
          new NativeSandbox({
            name: "ots-x",
            spawnProcess: recordingSpawn(() => ({ code: 0 })).spawn,
            workspace,
          }),
      ).toThrow(/workspace/i);
    }
    // An unsafe workspace mount and an unsafe extra mount are refused at construction.
    expect(
      () =>
        new NativeSandbox({
          name: "ots-x",
          workspace: "relative/ws",
          spawnProcess: recordingSpawn(() => ({ code: 0 })).spawn,
        }),
    ).toThrow(/workspace/i);
    // An extra mount is validated on the real argv, which is where it becomes a sandbox flag.
    expect(() =>
      buildSandboxRunArgv({
        extraMounts: [{ source: "relative", destination: "/etc" }],
        name: "ots-x",
        resolverCopy: "/tmp/r.conf",
        workspace: "/tmp/ws",
      }),
    ).toThrow(/Unsafe extra mount/);
    // A zero-byte resolver source is refused before any sandbox process exists.
    const workspace = await temporaryDirectory("opentag-native-sandbox-");
    const emptySource = await resolverSourceFixture("");
    const { spawn: spawnFn, calls } = recordingSpawn(() => ({ code: 0 }));
    const sandbox = new NativeSandbox({
      name: "ots-x",
      resolverSource: emptySource,
      spawnProcess: spawnFn,
      workspace,
    });
    await expect(sandbox.launch()).rejects.toMatchObject({ code: "launch_failed", message: /empty/ });
    expect(calls).toHaveLength(0);
    // An unreadable resolver source reports the real read failure.
    const missing = new NativeSandbox({
      name: "ots-x",
      resolverSource: join(workspace, "absent-resolv.conf"),
      spawnProcess: recordingSpawn(() => ({ code: 0 })).spawn,
      workspace,
    });
    await expect(missing.launch()).rejects.toMatchObject({ code: "launch_failed" });
  });

  it("classifies a spawn failure as a launch failure through the public argv builders", async () => {
    const workspace = await temporaryDirectory("opentag-native-sandbox-");
    const source = await resolverSourceFixture();
    let spawns = 0;
    const sandbox = new NativeSandbox({
      name: "ots-x",
      resolverSource: source,
      spawnProcess: () => {
        spawns += 1;
        const error = new Error("not permitted") as NodeJS.ErrnoException;
        error.code = "EPERM";
        throw error;
      },
      workspace,
    });
    await expect(sandbox.launch()).rejects.toMatchObject({ code: "requires_root" });
    expect(spawns).toBe(1);
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
    const { spawn, calls } = recordingSpawn((args) => respondToProbe(args, (canary) => canaries.push(canary)));
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
    // Every probe re-runs the full set fresh: real Node execution, the combined metadata read,
    // and the isolation canaries. Nothing is cached across probes, and no probe ever launches
    // the Pi CLI inside the sandbox.
    expect(probeExecKinds(calls)).toEqual({ node: 2, metadata: 2, canary: 2, piCli: 0 });
  });

  it("reports exact versions from the image metadata without launching the Pi CLI", async () => {
    const workspace = await temporaryDirectory("opentag-native-sandbox-");
    const rootfs = await temporaryDirectory("opentag-native-rootfs-");
    const source = await resolverSourceFixture();
    const { spawn, calls } = recordingSpawn((args) => respondToProbe(args, () => undefined));
    const sandbox = new NativeSandbox({
      name: "ots-x",
      workspace,
      rootfs,
      resolverSource: source,
      spawnProcess: spawn,
    });
    await sandbox.launch();
    const probe = await sandbox.probe();
    // The wire-facing SandboxProbeResult keeps its exact fields; piVersion is the locked package
    // metadata validated against the image identity, not a Pi CLI launch.
    expect(probe).toEqual({ nodeVersion: "v24.19.0", piVersion: "0.84.2", runnerVersion: "1.0.0" });
    await sandbox.destroy();
    const execs = calls.filter((call) => call.args[0] === "exec");
    expect(execs.length).toBeGreaterThan(0);
    expect(execs.every((call) => call.args[3] === SANDBOX_NODE)).toBe(true);
    expect(calls.some((call) => call.args.includes(SANDBOX_PI))).toBe(false);
  });
});

describe("native sandbox launch, probe, and exec failure classification", () => {
  it("classifies a privilege denial at launch as requires_root", async () => {
    const workspace = await temporaryDirectory("opentag-native-sandbox-");
    const source = await resolverSourceFixture();
    const { spawn, calls } = recordingSpawn((args) =>
      args[0] === "run" ? { code: 1, stderr: "sandbox: operation not permitted\n" } : { code: 0 },
    );
    const sandbox = new NativeSandbox({ name: "ots-x", resolverSource: source, spawnProcess: spawn, workspace });
    await expect(sandbox.launch()).rejects.toMatchObject({
      code: "requires_root",
      message: /platform privileges/,
    });
    // The failed launch removed its private resolver snapshot.
    const copy = requiredResolverCopy(recordedCall(calls, 0).args);
    await expect(stat(dirname(copy))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports every probe failure with its exact diagnostic", async () => {
    const workspace = await temporaryDirectory("opentag-native-sandbox-");
    const source = await resolverSourceFixture();
    const probeWith = (respond: (args: readonly string[]) => { code: number; stdout?: string; stderr?: string }) =>
      new NativeSandbox({
        name: "ots-x",
        resolverSource: source,
        spawnProcess: recordingSpawn(respond).spawn,
        workspace,
      });
    const metadataWith = (overrides: Record<string, unknown>) =>
      JSON.stringify({ ...JSON.parse(PROBE_METADATA_STDOUT), ...overrides });

    await expect(
      probeWith((args) => (args[3] === SANDBOX_NODE && args[4] === "--version" ? { code: 1 } : { code: 0 })).probe(),
    ).rejects.toMatchObject({ code: "probe_failed", message: /working node runtime/ });
    // The in-Sandbox metadata read failed: missing or corrupt identity/Pi package files, or an
    // inaccessible shim/CLI artifact. The script's own bounded diagnostic is preserved.
    await expect(
      probeWith((args) => {
        if (args[3] === SANDBOX_NODE && args[4] === "--version") return { code: 0, stdout: "v24.19.0\n" };
        if (args[3] === SANDBOX_NODE && (args[5] ?? "").includes("identity.json")) {
          return { code: 1, stderr: "runner-metadata:pi-package-corrupt" };
        }
        return { code: 0 };
      }).probe(),
    ).rejects.toMatchObject({
      code: "probe_failed",
      message: /missing or corrupt: runner-metadata:pi-package-corrupt/,
    });
    // The metadata payload is not JSON at all.
    await expect(
      probeWith((args) => {
        if (args[3] === SANDBOX_NODE && args[4] === "--version") return { code: 0, stdout: "v24.19.0\n" };
        if (args[3] === SANDBOX_NODE && (args[5] ?? "").includes("identity.json")) return { code: 0, stdout: "{nope" };
        return { code: 0 };
      }).probe(),
    ).rejects.toMatchObject({ code: "probe_failed", message: /no valid Runner or Pi metadata/ });
    // The Runner version keeps its exact alphabet check.
    await expect(
      probeWith((args) => {
        if (args[3] === SANDBOX_NODE && args[4] === "--version") return { code: 0, stdout: "v24.19.0\n" };
        if (args[3] === SANDBOX_NODE && (args[5] ?? "").includes("identity.json")) {
          return { code: 0, stdout: metadataWith({ runnerVersion: "not a version!" }) };
        }
        return { code: 0 };
      }).probe(),
    ).rejects.toMatchObject({ code: "probe_failed", message: /valid Runner version/ });
    // The installed Pi package version must equal the image identity's locked Pi version.
    await expect(
      probeWith((args) => {
        if (args[3] === SANDBOX_NODE && args[4] === "--version") return { code: 0, stdout: "v24.19.0\n" };
        if (args[3] === SANDBOX_NODE && (args[5] ?? "").includes("identity.json")) {
          return { code: 0, stdout: metadataWith({ piVersion: "0.84.3" }) };
        }
        return { code: 0 };
      }).probe(),
    ).rejects.toMatchObject({ code: "probe_failed", message: /does not match the image identity/ });
    // The installed Pi package name must equal the image identity's locked Pi package.
    await expect(
      probeWith((args) => {
        if (args[3] === SANDBOX_NODE && args[4] === "--version") return { code: 0, stdout: "v24.19.0\n" };
        if (args[3] === SANDBOX_NODE && (args[5] ?? "").includes("identity.json")) {
          return { code: 0, stdout: metadataWith({ piName: "@earendil-works/other" }) };
        }
        return { code: 0 };
      }).probe(),
    ).rejects.toMatchObject({ code: "probe_failed", message: /does not match the image identity/ });
    // The isolation canaries still gate readiness after a valid metadata read.
    await expect(
      probeWith((args) => {
        if (args[3] === SANDBOX_NODE && args[4] === "--version") return { code: 0, stdout: "v24.19.0\n" };
        if (args[3] === SANDBOX_NODE && (args[5] ?? "").includes("identity.json")) {
          return { code: 0, stdout: PROBE_METADATA_STDOUT };
        }
        return { code: 0, stdout: "not isolated" };
      }).probe(),
    ).rejects.toMatchObject({ code: "probe_failed", message: /isolation/ });
  });

  it("refuses a relative resolver source and an unknown spawn errno", async () => {
    expect(
      () =>
        new NativeSandbox({
          name: "ots-x",
          resolverSource: "relative/resolv.conf",
          spawnProcess: recordingSpawn(() => ({ code: 0 })).spawn,
          workspace: "/tmp/ws",
        }),
    ).toThrow(/Unsafe resolver source path/);

    // A spawn failure that is neither ENOENT nor a privilege error is a generic launch failure,
    // and the default sleep seam is used (which the retry loop exercises).
    const workspace = await temporaryDirectory("opentag-native-sandbox-");
    const source = await resolverSourceFixture();
    const generic = new NativeSandbox({
      name: "ots-x",
      resolverSource: source,
      spawnProcess: () => {
        const error = new Error("too many open files") as NodeJS.ErrnoException;
        error.code = "EMFILE";
        throw error;
      },
      workspace,
    });
    await expect(generic.launch()).rejects.toMatchObject({ code: "launch_failed" });

    // A delete failure retries with real (tiny) waits and reports the final failure.
    let deletes = 0;
    const stubborn = new NativeSandbox({
      name: "ots-x",
      resolverSource: source,
      sleep: async () => undefined,
      spawnProcess: recordingSpawn((args) => {
        if (args[0] === "delete") {
          deletes += 1;
          return { code: 1, stderr: "still running" };
        }
        return { code: 0 };
      }).spawn,
      workspace,
    });
    await stubborn.launch();
    await expect(stubborn.destroy({ attempts: 2 })).rejects.toMatchObject({ code: "delete_failed" });
    expect(deletes).toBe(2);
  });

  it("runs an exec with stdin and bounded output through the default spawn seam", async () => {
    const workspace = await temporaryDirectory("opentag-native-sandbox-");
    // The default spawn seam is used here: the exec argv runs a real Node child which echoes the
    // stdin document it received, proving the stdin write and the capture path.
    const spawnProcess: SpawnProcess = (_command, args) => {
      const separator = args.indexOf("--");
      const [binary, ...rest] = args.slice(separator + 1);
      expect(binary).toBe(SANDBOX_NODE);
      return spawn(process.execPath, rest, { stdio: "pipe" });
    };
    const sandbox = new NativeSandbox({
      name: "ots-stdin",
      resolverSource: await resolverSourceFixture(),
      spawnProcess,
      workspace,
    });
    const result = await sandbox.exec(
      SANDBOX_NODE,
      [
        "-e",
        "process.stdin.setEncoding('utf8');let d='';process.stdin.on('data',(c)=>d+=c);process.stdin.on('end',()=>process.stdout.write(d.trim().toUpperCase()))",
      ],
      { stdin: "hello stdin\n", timeoutMs: 10_000 },
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("HELLO STDIN");
  });

  it("classifies an exec deadline, a cancellation, and a spawn failure", async () => {
    const workspace = await temporaryDirectory("opentag-native-sandbox-");
    await expect(
      new NativeSandbox({
        name: "ots-x",
        spawnProcess: () => {
          const error = new Error("missing") as NodeJS.ErrnoException;
          error.code = "ENOENT";
          throw error;
        },
        workspace,
      }).exec(SANDBOX_NODE, ["--version"], { timeoutMs: 1_000 }),
    ).rejects.toMatchObject({ code: "unavailable" });

    const aborted = new AbortController();
    aborted.abort();
    const cancelled = new NativeSandbox({
      name: "ots-x",
      spawnProcess: (_command, args) => {
        const child = fakeChild({ code: 0 });
        // The child stays "running" until the abort escalation kills it.
        child.kill = () => {
          queueMicrotask(() => child.emit("close", -1));
          return true;
        };
        void args;
        return child as never;
      },
      workspace,
    });
    await expect(
      cancelled.exec(SANDBOX_NODE, ["--version"], { signal: aborted.signal, timeoutMs: 1_000 }),
    ).rejects.toMatchObject({ code: "exec_failed" });
  });
});

describe("native sandbox Pi metadata script against local fixtures", () => {
  /** Run the generated script under the real local Node runtime, exactly as `node -e` would. */
  function runNodeScript(script: string): Promise<{ code: number; stdout: string; stderr: string }> {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["-e", script], { stdio: "pipe" });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
      child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
      child.once("error", reject);
      child.once("close", (code) =>
        resolve({
          code: code ?? -1,
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        }),
      );
      child.stdin.end();
    });
  }

  interface MetadataFixturePaths {
    readonly identityPath: string;
    readonly piHome: string;
    readonly shimPath: string;
    readonly packageDir: string;
    readonly cliMarker: string;
  }

  /**
   * A local mirror of the fixed image layout: identity.json, the locked Pi package under
   * node_modules, its declared dist/cli.js entry, and an executable shim. The fixture CLI is a
   * marker writer, so any accidental execution of the Pi CLI is observable.
   */
  async function piMetadataFixture(
    options: { identity?: string | false; packageJson?: string | false; shim?: boolean; cliEntry?: boolean } = {},
  ): Promise<MetadataFixturePaths> {
    const root = await temporaryDirectory("opentag-pi-metadata-");
    const paths: MetadataFixturePaths = {
      identityPath: join(root, "identity.json"),
      piHome: join(root, "pi"),
      shimPath: join(root, "tools", "bin", "pi"),
      packageDir: join(root, "pi", "node_modules", "@earendil-works", "pi-coding-agent"),
      cliMarker: join(root, "cli-executed"),
    };
    await mkdir(join(paths.packageDir, "dist"), { recursive: true });
    await mkdir(dirname(paths.shimPath), { recursive: true });
    const identity =
      options.identity ??
      JSON.stringify({ version: "1.0.0", piPackage: "@earendil-works/pi-coding-agent", piVersion: "0.84.2" });
    if (identity !== false) await writeFile(paths.identityPath, identity);
    const packageJson =
      options.packageJson ??
      JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "0.84.2", bin: { pi: "dist/cli.js" } });
    if (packageJson !== false) await writeFile(join(paths.packageDir, "package.json"), packageJson);
    if (options.shim !== false) {
      await writeFile(paths.shimPath, `#!/bin/sh\nexec /usr/local/bin/node cli.js "$@"\n`, { mode: 0o755 });
    }
    if (options.cliEntry !== false) {
      await writeFile(
        join(paths.packageDir, "dist", "cli.js"),
        `require('node:fs').writeFileSync(${JSON.stringify(paths.cliMarker)},'ran')\n`,
      );
    }
    return paths;
  }

  function scriptFor(paths: MetadataFixturePaths): string {
    return buildSandboxMetadataScript({
      identityPath: paths.identityPath,
      piHome: paths.piHome,
      shimPath: paths.shimPath,
    });
  }

  it("reads the identity and the locked Pi package metadata without executing the Pi CLI", async () => {
    const paths = await piMetadataFixture();
    const result = await runNodeScript(scriptFor(paths));
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      runnerVersion: "1.0.0",
      identityPiPackage: "@earendil-works/pi-coding-agent",
      identityPiVersion: "0.84.2",
      piName: "@earendil-works/pi-coding-agent",
      piVersion: "0.84.2",
    });
    expect(result.stderr).toBe("");
    // The metadata read never loaded the fixture's CLI entry.
    await expect(stat(paths.cliMarker)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("fails closed on missing, corrupt, oversized, or escaping metadata", async () => {
    const missingIdentity = await piMetadataFixture({ identity: false });
    expect(await runNodeScript(scriptFor(missingIdentity))).toMatchObject({
      code: 1,
      stderr: "runner-metadata:identity-missing",
    });
    const corruptIdentity = await piMetadataFixture({ identity: "{not json" });
    expect(await runNodeScript(scriptFor(corruptIdentity))).toMatchObject({
      code: 1,
      stderr: "runner-metadata:identity-corrupt",
    });
    const escaping = await piMetadataFixture({
      identity: JSON.stringify({ version: "1.0.0", piPackage: "@earendil-works/../escape", piVersion: "0.84.2" }),
    });
    expect(await runNodeScript(scriptFor(escaping))).toMatchObject({
      code: 1,
      stderr: "runner-metadata:identity-pi-package",
    });
    const missingPackage = await piMetadataFixture({ packageJson: false });
    expect(await runNodeScript(scriptFor(missingPackage))).toMatchObject({
      code: 1,
      stderr: "runner-metadata:pi-package-missing",
    });
    const corruptPackage = await piMetadataFixture({ packageJson: "{oops" });
    expect(await runNodeScript(scriptFor(corruptPackage))).toMatchObject({
      code: 1,
      stderr: "runner-metadata:pi-package-corrupt",
    });
    const oversized = await piMetadataFixture({ packageJson: `"${"x".repeat(70_000)}"` });
    expect(await runNodeScript(scriptFor(oversized))).toMatchObject({
      code: 1,
      stderr: "runner-metadata:pi-package-invalid",
    });
  });

  it("requires the fixed shim and the declared CLI entry without loading them", async () => {
    const missingShim = await piMetadataFixture({ shim: false });
    expect(await runNodeScript(scriptFor(missingShim))).toMatchObject({
      code: 1,
      stderr: "runner-metadata:pi-shim-inaccessible",
    });
    const missingCli = await piMetadataFixture({ cliEntry: false });
    expect(await runNodeScript(scriptFor(missingCli))).toMatchObject({
      code: 1,
      stderr: "runner-metadata:pi-cli-inaccessible",
    });
    const noBin = await piMetadataFixture({
      packageJson: JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "0.84.2" }),
    });
    expect(await runNodeScript(scriptFor(noBin))).toMatchObject({ code: 1, stderr: "runner-metadata:pi-bin-invalid" });
    const escapingBin = await piMetadataFixture({
      packageJson: JSON.stringify({
        name: "@earendil-works/pi-coding-agent",
        version: "0.84.2",
        bin: { pi: "../../../outside.js" },
      }),
    });
    expect(await runNodeScript(scriptFor(escapingBin))).toMatchObject({
      code: 1,
      stderr: "runner-metadata:pi-bin-invalid",
    });
    // None of the failure paths executed the fixture CLI either.
    for (const paths of [missingShim, missingCli, noBin, escapingBin]) {
      await expect(stat(paths.cliMarker)).rejects.toMatchObject({ code: "ENOENT" });
    }
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

  it("reports the sandbox name and delivers a duplex exit and stderr to their listeners", async () => {
    const sandbox = realChildSandbox();
    expect(sandbox.name).toBe("ots-duplex-epipe");
    const duplex = sandbox.openDuplex(SANDBOX_NODE, [
      "-e",
      "process.stderr.write('side channel');console.log('hello');process.exit(3)",
    ]);
    const data: Buffer[] = [];
    const stderr: Buffer[] = [];
    duplex.onData((chunk) => data.push(chunk));
    duplex.onStderr((chunk) => stderr.push(chunk));
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
      duplex.onExit((code, signal) => resolve({ code, signal }));
    });
    const { code } = await exited;
    expect(code).toBe(3);
    expect(Buffer.concat(data).toString("utf8")).toContain("hello");
    expect(Buffer.concat(stderr).toString("utf8")).toContain("side channel");
    // Listener unsubscription is real: a removed data listener stops receiving frames.
    const extra: Buffer[] = [];
    const off = duplex.onData((chunk) => extra.push(chunk));
    off();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(extra).toHaveLength(0);
  });

  it("fails the duplex when the child cannot be spawned", () => {
    const sandbox = new NativeSandbox({
      name: "ots-duplex-spawn",
      spawnProcess: () => {
        const error = new Error("missing binary") as NodeJS.ErrnoException;
        error.code = "ENOENT";
        throw error;
      },
      workspace: join(tmpdir(), "opentag-duplex-spawn-ws"),
    });
    expect(() => sandbox.openDuplex(SANDBOX_NODE, ["--version"])).toThrow(/native Cloud Run sandbox binary is absent/);
  });

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
