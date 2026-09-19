import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { connect, createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer, type WebSocket as WsSocket } from "ws";
import { CloudJournal } from "../runner/cloud-journal.js";
import {
  buildSandboxDeleteArgv,
  buildSandboxExecArgv,
  buildSandboxRunArgv,
  NativeSandbox,
  NativeSandboxError,
  SANDBOX_BINARY,
  SANDBOX_ROOTFS,
} from "../runner/native-sandbox.js";
import {
  cloudRunnerDirectories,
  loadRunnerServeConfig,
  type RunnerServeConfig,
  resolveRunnerBackendUrl,
  runRunnerServe,
} from "../runner/serve.js";
import type { RunnerAcceptanceReport } from "../runner/types.js";
import { runRunnerWorker, WORKER_STDIN_MAX_BYTES } from "../runner/worker.js";
import { cloudDeliveryFixture } from "./cloud-turns.fixture.js";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(cleanup.splice(0).map((close) => close()));
});

const BOOTSTRAP_TOKEN = "unit-bootstrap-token-secret";
/** Fixed welcome Session identity the WSS harness uses; Cloud deliveries must match it. */
const WSS_SESSION_ID = "5f9a1c3e-2d4b-4e6f-8a1b-9c0d1e2f3a4b";

function io() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    stdout: {
      write(chunk: string) {
        stdout.push(chunk);
      },
    },
    stderr: {
      write(chunk: string) {
        stderr.push(chunk);
      },
    },
    chunks: { stdout, stderr },
  };
}

describe("resolveRunnerBackendUrl", () => {
  it("accepts wss/https and loopback ws only", () => {
    expect(resolveRunnerBackendUrl("https://api.example.com/api/v1/sandbox-runners/ws")).toBe(
      "wss://api.example.com/api/v1/sandbox-runners/ws",
    );
    expect(resolveRunnerBackendUrl("wss://api.example.com/ws")).toBe("wss://api.example.com/ws");
    expect(resolveRunnerBackendUrl("ws://127.0.0.1:9000/ws")).toBe("ws://127.0.0.1:9000/ws");
    expect(resolveRunnerBackendUrl("ws://localhost:9000/ws")).toBe("ws://localhost:9000/ws");
    expect(() => resolveRunnerBackendUrl("ws://api.example.com/ws")).toThrow(/wss/);
    expect(() => resolveRunnerBackendUrl("http://api.example.com/ws")).toThrow();
    const credentialUrl = new URL("wss://api.example.com/ws");
    credentialUrl.username = "synthetic-user";
    credentialUrl.password = "synthetic-password";
    expect(() => resolveRunnerBackendUrl(credentialUrl.toString())).toThrow();
    expect(() => resolveRunnerBackendUrl("wss://api.example.com/ws?token=abc")).toThrow();
    expect(() => resolveRunnerBackendUrl("not a url")).toThrow();
  });
});

describe("loadRunnerServeConfig", () => {
  const base = {
    OPENTAG_RUNNER_BACKEND_URL: "wss://api.example.com/api/v1/sandbox-runners/ws",
    OPENTAG_RUNNER_BOOTSTRAP_TOKEN: BOOTSTRAP_TOKEN,
    OPENTAG_RUNNER_SANDBOX_NAME: "ots-s-abcdef123456-1",
  };

  it("loads from the environment only and rejects unsafe values", () => {
    const config = loadRunnerServeConfig(base);
    expect(config.backendUrl).toBe(base.OPENTAG_RUNNER_BACKEND_URL);
    expect(config.bootstrapToken).toBe(BOOTSTRAP_TOKEN);
    expect(config.sandboxName).toBe(base.OPENTAG_RUNNER_SANDBOX_NAME);
    expect(() => loadRunnerServeConfig({ ...base, OPENTAG_RUNNER_BACKEND_URL: undefined as never })).toThrow(
      /BACKEND_URL/,
    );
    expect(() => loadRunnerServeConfig({ ...base, OPENTAG_RUNNER_BOOTSTRAP_TOKEN: undefined as never })).toThrow(
      /BOOTSTRAP_TOKEN.*never argv/,
    );
    expect(() => loadRunnerServeConfig({ ...base, OPENTAG_RUNNER_SANDBOX_NAME: "../escape" })).toThrow(/SANDBOX_NAME/);
    expect(() => loadRunnerServeConfig({ ...base, OPENTAG_RUNNER_SANDBOX_NAME: "9bad" })).toThrow(/SANDBOX_NAME/);
  });

  it("defaults the declared 8080 health port and accepts only an exact PORT override", () => {
    // Cloud Run's default TCP startup probe targets the declared 8080 even when the platform does
    // not inject PORT; the runtime must not silently ship without the probe listener.
    expect(loadRunnerServeConfig(base).healthPort).toBe(8080);
    expect(loadRunnerServeConfig({ ...base, PORT: "8080" }).healthPort).toBe(8080);
    expect(loadRunnerServeConfig({ ...base, PORT: "65535" }).healthPort).toBe(65535);
    for (const PORT of ["0", "-1", "65536", "1.5", "abc", "", " 8080", "08080"]) {
      expect(() => loadRunnerServeConfig({ ...base, PORT }), `PORT=${JSON.stringify(PORT)}`).toThrow(/PORT/);
    }
  });

  it("accepts only exact booleans for the web tools opt-in", () => {
    expect(loadRunnerServeConfig(base).webTools).toBeUndefined();
    expect(loadRunnerServeConfig({ ...base, OPENTAG_RUNNER_WEB_TOOLS: "false" }).webTools).toBeUndefined();
    expect(loadRunnerServeConfig({ ...base, OPENTAG_RUNNER_WEB_TOOLS: "true" }).webTools).toBe(true);
    for (const value of ["1", "yes", "TRUE", "on", ""]) {
      expect(() => loadRunnerServeConfig({ ...base, OPENTAG_RUNNER_WEB_TOOLS: value })).toThrow(/WEB_TOOLS/);
    }
  });
});

describe("native sandbox argv construction", () => {
  it("builds the exact PoC argv arrays with the clean image-built rootfs", () => {
    expect(
      buildSandboxRunArgv({
        name: "ots-x",
        workspace: "/tmp/ws/ots-x",
        resolverCopy: "/tmp/opentag-resolver-ots-x/resolv.conf",
      }),
    ).toEqual([
      SANDBOX_BINARY,
      "run",
      "ots-x",
      "--detach",
      "--write",
      "--allow-egress",
      "--rootfs",
      SANDBOX_ROOTFS,
      "--mount",
      "type=bind,source=/tmp/ws/ots-x,destination=/workspace",
      "--mount",
      "type=bind,source=/tmp/opentag-resolver-ots-x/resolv.conf,destination=/etc/resolv.conf,readonly",
      "--env",
      "PATH=/usr/local/bin:/opt/opentag/tools/bin:/usr/bin:/bin",
      "--",
      "/usr/local/bin/opentag-init",
      "/bin/sleep",
      "infinity",
    ]);
    expect(buildSandboxExecArgv({ name: "ots-x", command: "/usr/local/bin/node", args: ["/w", "worker"] })).toEqual([
      SANDBOX_BINARY,
      "exec",
      "ots-x",
      "--",
      "/usr/local/bin/node",
      "/w",
      "worker",
    ]);
    expect(buildSandboxDeleteArgv({ name: "ots-x" })).toEqual([SANDBOX_BINARY, "delete", "--force", "ots-x"]);
  });
});

/** Fake child process over EventEmitter matching ChildProcessWithoutNullStreams behavior we use. */
function fakeChild(handler: (stdin: string) => { code: number; stdout?: string; stderr?: string }) {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    stdin: { write(chunk: string, cb?: () => void): void; end(): void; on(event: string, cb: () => void): void };
    kill: (signal?: string) => boolean;
    killed: boolean;
    pid: number;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.pid = 4321;
  let stdin = "";
  child.stdin = {
    write(chunk: string, cb?: () => void) {
      stdin += chunk;
      cb?.();
    },
    end() {
      queueMicrotask(() => {
        const result = handler(stdin);
        if (result.stdout) child.stdout.emit("data", Buffer.from(result.stdout));
        if (result.stderr) child.stderr.emit("data", Buffer.from(result.stderr));
        child.emit("close", result.code);
      });
    },
    on: () => child.stdin,
  } as never;
  child.kill = () => {
    child.killed = true;
    queueMicrotask(() => child.emit("close", -1));
    return true;
  };
  return child;
}

/** Hermetic private resolver source so launch() never depends on the host /etc/resolv.conf. */
async function resolverSourceFixture() {
  const directory = await mkdtemp(join(tmpdir(), "opentag-resolver-source-"));
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, "resolv.conf");
  await writeFile(source, "nameserver 192.0.2.53\nsearch example.internal\n");
  return source;
}

describe("NativeSandbox", () => {
  it("classifies a missing sandbox binary as unavailable and EACCES as requires_root", async () => {
    const enoent = new NativeSandbox({
      name: "ots-x",
      workspace: "/tmp/ws",
      resolverSource: await resolverSourceFixture(),
      spawnProcess: () => {
        throw Object.assign(new Error("spawn /usr/local/gcp/bin/sandbox ENOENT"), { code: "ENOENT" });
      },
    });
    await expect(enoent.launch()).rejects.toMatchObject({ code: "unavailable" });
    const eacces = new NativeSandbox({
      name: "ots-x",
      workspace: "/tmp/ws",
      resolverSource: await resolverSourceFixture(),
      spawnProcess: () => {
        throw Object.assign(new Error("spawn EACCES"), { code: "EACCES" });
      },
    });
    await expect(eacces.launch()).rejects.toMatchObject({ code: "requires_root" });
  });

  it("requires deletion success and retries before failing", async () => {
    let deletes = 0;
    const failing = new NativeSandbox({
      name: "ots-x",
      workspace: "/tmp/ws",
      sleep: () => Promise.resolve(),
      spawnProcess: (_command, args) => {
        if (args[0] === "delete") {
          deletes += 1;
          return fakeChild(() => ({ code: 1, stderr: "sandbox busy" })) as never;
        }
        return fakeChild(() => ({ code: 0 })) as never;
      },
    });
    await expect(failing.destroy()).rejects.toMatchObject({ code: "delete_failed" });
    expect(deletes).toBe(3);
    const ok = new NativeSandbox({
      name: "ots-x",
      workspace: "/tmp/ws",
      sleep: () => Promise.resolve(),
      spawnProcess: () => fakeChild(() => ({ code: 0 })) as never,
    });
    await expect(ok.destroy()).resolves.toBeUndefined();
  });

  it("passes only a minimal env (never the parent token) to the supervisor CLI", async () => {
    const seen: { env?: NodeJS.ProcessEnv }[] = [];
    const sandbox = new NativeSandbox({
      name: "ots-x",
      workspace: "/tmp/ws",
      resolverSource: await resolverSourceFixture(),
      spawnProcess: (_command, _args, options) => {
        seen.push(options);
        return fakeChild(() => ({ code: 0, stdout: "v24.19.0" })) as never;
      },
    });
    const controlToken = "unit-control-token-secret";
    process.env.OPENTAG_RUNNER_BOOTSTRAP_TOKEN = BOOTSTRAP_TOKEN;
    process.env.OPENTAG_RUNNER_CONTROL_TOKEN = controlToken;
    await sandbox.launch();
    for (const env of seen) {
      expect(JSON.stringify(env)).not.toContain(BOOTSTRAP_TOKEN);
      expect(JSON.stringify(env)).not.toContain(controlToken);
      expect(Object.keys(env.env ?? {})).toEqual(["PATH"]);
    }
    await sandbox.destroy();
    delete process.env.OPENTAG_RUNNER_BOOTSTRAP_TOKEN;
    delete process.env.OPENTAG_RUNNER_CONTROL_TOKEN;
  });
});

describe("runRunnerWorker (in-sandbox worker)", () => {
  function stdinOf(payload: string) {
    const stream = new EventEmitter() as NodeJS.ReadStream;
    (stream as { destroy?: () => void }).destroy = () => undefined;
    queueMicrotask(() => {
      if (payload.length > 0) stream.emit("data", Buffer.from(payload));
      stream.emit("end");
    });
    return stream;
  }

  const passingReport: RunnerAcceptanceReport = { events: [], failed: false, model: "skipped", offline: "passed" };

  it("runs acceptance from a bounded stdin document and emits one result line", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "opentag-worker-test-"));
    cleanup.push(() => rm(workspace, { recursive: true, force: true }));
    const output = io();
    const runAcceptance = vi.fn(async () => passingReport);
    const code = await runRunnerWorker(
      { stdin: stdinOf(JSON.stringify({ kind: "acceptance", mode: "offline" })), ...output },
      { workspace, runAcceptance: runAcceptance as never },
    );
    expect(code).toBe(0);
    expect(runAcceptance).toHaveBeenCalledWith(expect.objectContaining({ mode: "offline", workspace }));
    const line = output.chunks.stdout.join("");
    expect(JSON.parse(line)).toEqual({ kind: "result", report: passingReport });
  });

  it("writes real-mode piConfig into a disposable 0600 home and removes it", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "opentag-worker-test-"));
    cleanup.push(() => rm(workspace, { recursive: true, force: true }));
    const output = io();
    let observed: { piHome?: string; authMode?: string } = {};
    const runAcceptance = vi.fn(async (options: { piHome: string }) => {
      const auth = await stat(join(options.piHome, "auth.json"));
      observed = { piHome: options.piHome, authMode: (auth.mode & 0o777).toString(8) };
      return passingReport;
    });
    const code = await runRunnerWorker(
      {
        stdin: stdinOf(
          JSON.stringify({
            kind: "acceptance",
            mode: "real",
            piConfig: { authJson: '{"deepseek":{}}', settingsJson: "{}" },
          }),
        ),
        ...output,
      },
      { workspace, runAcceptance: runAcceptance as never },
    );
    expect(code).toBe(0);
    expect(observed.authMode).toBe("600");
    await expect(stat(observed.piHome as string)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("deletes the raw unfiltered Pi config before any model or user tool runs", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "opentag-worker-test-"));
    cleanup.push(() => rm(workspace, { recursive: true, force: true }));
    const output = io();
    const observed: { filteredAuth?: string; rawGone?: boolean } = {};
    const runAcceptance = vi.fn(async (options: { piHome: string }) => {
      observed.filteredAuth = await readFile(join(options.piHome, "auth.json"), "utf8");
      const rawHome = join(dirname(options.piHome), "pi-agent");
      observed.rawGone = await stat(rawHome).then(
        () => false,
        () => true,
      );
      return passingReport;
    });
    const code = await runRunnerWorker(
      {
        stdin: stdinOf(
          JSON.stringify({
            kind: "acceptance",
            mode: "real",
            piConfig: { authJson: '{"deepseek":{"token":"unit-deepseek"},"other":{"token":"unit-other-secret"}}' },
          }),
        ),
        ...output,
      },
      { workspace, runAcceptance: runAcceptance as never },
    );
    expect(code).toBe(0);
    // Only the whitelisted provider survived filtering…
    expect(observed.filteredAuth).toContain("unit-deepseek");
    expect(observed.filteredAuth).not.toContain("unit-other-secret");
    // …and the raw, unfiltered copy was already gone before the acceptance run started.
    expect(observed.rawGone).toBe(true);
  });

  it("rejects invalid or oversized stdin without running acceptance", async () => {
    const output = io();
    const runAcceptance = vi.fn(async () => passingReport);
    const bad = await runRunnerWorker(
      { stdin: stdinOf("{not json"), ...output },
      { runAcceptance: runAcceptance as never },
    );
    expect(bad).toBe(2);
    expect(JSON.parse(output.chunks.stdout.join(""))).toMatchObject({ kind: "error", code: "worker_request_invalid" });
    const tooBig = io();
    const huge = await runRunnerWorker(
      { stdin: stdinOf(" ".repeat(WORKER_STDIN_MAX_BYTES + 1)), ...tooBig },
      { runAcceptance: runAcceptance as never },
    );
    expect(huge).toBe(1);
    expect(JSON.parse(tooBig.chunks.stdout.join("")).kind).toBe("error");
    const realWithoutConfig = io();
    expect(
      await runRunnerWorker(
        { stdin: stdinOf(JSON.stringify({ kind: "acceptance", mode: "real" })), ...realWithoutConfig },
        { runAcceptance: runAcceptance as never },
      ),
    ).toBe(2);
    expect(runAcceptance).not.toHaveBeenCalled();
  });

  it("rejects a non-ASCII config document that fits characters but not UTF-8 bytes", async () => {
    const output = io();
    const runAcceptance = vi.fn(async () => passingReport);
    // 11,012 characters (under the 32K character bound) but 33,012 UTF-8 bytes (over 32 KiB).
    const oversizedDocument = JSON.stringify({ token: "密钥".repeat(5_500) });
    const code = await runRunnerWorker(
      {
        stdin: stdinOf(JSON.stringify({ kind: "acceptance", mode: "real", piConfig: { authJson: oversizedDocument } })),
        ...output,
      },
      { runAcceptance: runAcceptance as never },
    );
    expect(code).toBe(2);
    expect(JSON.parse(output.chunks.stdout.join(""))).toMatchObject({
      kind: "error",
      code: "worker_request_invalid",
    });
    expect(runAcceptance).not.toHaveBeenCalled();
  });
});

/* ----------------------------------------------------------------------------------------------
 * serve end-to-end against a real loopback WSS server, with a fake native sandbox
 * ------------------------------------------------------------------------------------------- */

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

/** Real loopback TCP probe: resolves when the health listener ends the connection. */
function probeHealthPort(port: number): Promise<{ bytes: number }> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port });
    let bytes = 0;
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("health listener did not answer"));
    }, 5_000);
    socket.on("data", (chunk: Buffer) => {
      bytes += chunk.byteLength;
    });
    socket.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    socket.on("close", () => {
      clearTimeout(timer);
      resolve({ bytes });
    });
  });
}

interface FakeSandbox {
  launches: number;
  destroys: number;
  execs: { command: string; args: readonly string[]; stdin?: string }[];
  failDestroy: boolean;
  destroyResult: () => Promise<void>;
}

function fakeSandboxFactory(
  execs: FakeSandbox["execs"] = [],
  state: { destroys: number; launches: number; failDestroy: boolean } = {
    destroys: 0,
    launches: 0,
    failDestroy: false,
  },
) {
  return (_name: string, _workspace: string) => {
    state.launches += 1;
    const sandbox = {
      launch: vi.fn(async () => undefined),
      probe: vi.fn(async () => ({ nodeVersion: "v24.19.0", piVersion: "0.84.2", runnerVersion: "1.0.0" })),
      exec: vi.fn(async (command: string, args: readonly string[], options: { stdin?: string }) => {
        execs.push({ command, args, ...(options.stdin !== undefined ? { stdin: options.stdin } : {}) });
        return {
          code: 0,
          stdout: `${JSON.stringify({ kind: "result", report: { events: [], failed: false, model: "skipped", offline: "passed" } })}\n`,
          stderr: "",
        };
      }),
      destroy: vi.fn(async () => {
        state.destroys += 1;
        if (state.failDestroy) throw new NativeSandboxError("delete_failed", "sandbox busy");
      }),
    };
    return sandbox as unknown as NativeSandbox;
  };
}

interface WssHarness {
  url: string;
  frames: Record<string, unknown>[];
  sockets: WsSocket[];
  send(type: Record<string, unknown>): void;
  closeSocket(): void;
  waitFor(type: string, timeoutMs?: number): Promise<Record<string, unknown>>;
}

interface WssBehavior {
  /** The first N connections receive no auth reply at all (a slow/stuck Server). */
  dropAuthConnections?: number;
  /** The first N connections get an out-of-turn error frame instead of an auth:result. */
  errorAuthConnections?: number;
}

async function startWss(
  onAuth?: (frame: Record<string, unknown>) => boolean,
  timing = { interval: 50, timeout: 100_000 },
  behavior: WssBehavior = {},
  cloud: {
    readonly capability?: 1;
    readonly resourceUid?: string | null;
    readonly sessionCollaboration?: 1;
  } = {},
): Promise<WssHarness> {
  const port = await freePort();
  const wss = new WebSocketServer({ host: "127.0.0.1", port });
  // Bind before any caller asks for another free port: otherwise an ephemeral probe can hand
  // out this same port to the startup health listener and fail its bind.
  await new Promise<void>((resolve, reject) => {
    wss.once("listening", () => resolve());
    wss.once("error", reject);
  });
  cleanup.push(async () => {
    for (const socket of wss.clients) socket.terminate();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  });
  const frames: Record<string, unknown>[] = [];
  const sockets: WsSocket[] = [];
  const waiters: { type: string; resolve: (frame: Record<string, unknown>) => void }[] = [];
  const welcomeFrame = () => ({
    type: "server:welcome",
    protocolVersion: 1,
    sandboxId: "2b63a21e-f6c7-4474-91ea-4dabf0566a24",
    sessionId: WSS_SESSION_ID,
    environmentGeneration: 1,
    resourceName: "projects/p/locations/r/instances/ots-s-2b63a21ef6c7-1",
    ...(cloud.capability ? { cloudDeliveryVersion: cloud.capability } : {}),
    ...(cloud.sessionCollaboration ? { sessionCollaborationVersion: cloud.sessionCollaboration } : {}),
    ...(cloud.capability ? { resourceUid: cloud.resourceUid ?? null } : {}),
    heartbeatIntervalMs: timing.interval,
    heartbeatTimeoutMs: timing.timeout,
  });
  const replyAuth = (socket: WsSocket, frame: Record<string, unknown>) => {
    const ok = onAuth?.(frame) ?? frame.token === BOOTSTRAP_TOKEN;
    socket.send(
      JSON.stringify({ type: "auth:result", ok, ...(frame.requestId ? { requestId: frame.requestId } : {}) }),
    );
    if (ok) socket.send(JSON.stringify(welcomeFrame()));
    else socket.close(4401, "auth failed");
  };
  const replyByBehavior = (socket: WsSocket, frame: Record<string, unknown>, connectionIndex: number) => {
    if (connectionIndex < (behavior.dropAuthConnections ?? 0)) return;
    if (connectionIndex < (behavior.errorAuthConnections ?? 0)) {
      socket.send(JSON.stringify({ type: "error", code: "SERVER_STUCK", message: "Server not ready" }));
      return;
    }
    replyAuth(socket, frame);
  };
  wss.on("connection", (socket) => {
    sockets.push(socket);
    const connectionIndex = sockets.length - 1;
    socket.on("message", (raw) => {
      const frame = JSON.parse(String(raw)) as Record<string, unknown>;
      frames.push(frame);
      const index = waiters.findIndex((waiter) => waiter.type === frame.type);
      if (index >= 0) {
        const [waiter] = waiters.splice(index, 1);
        waiter?.resolve(frame);
      }
      if (frame.type === "heartbeat") socket.send(JSON.stringify({ type: "server:heartbeat" }));
      if (frame.type === "auth") replyByBehavior(socket, frame, connectionIndex);
    });
  });
  return {
    url: `ws://127.0.0.1:${port}/api/v1/sandbox-runners/ws`,
    frames,
    sockets,
    send(frame) {
      sockets.at(-1)?.send(JSON.stringify(frame));
    },
    closeSocket() {
      sockets.at(-1)?.close(1001, "server cycling");
    },
    waitFor(type, timeoutMs = 5_000) {
      const existing = frames.find((frame) => frame.type === type);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out waiting for ${type}`)), timeoutMs);
        waiters.push({
          type,
          resolve: (frame) => {
            clearTimeout(timer);
            resolve(frame);
          },
        });
      });
    },
  };
}

function serveConfig(url: string): RunnerServeConfig {
  return {
    backendUrl: url,
    bootstrapToken: BOOTSTRAP_TOKEN,
    sandboxName: "ots-s-2b63a21ef6c7-1",
    workspace: "/tmp/opentag-runner-test-ws",
    stateDir: "/tmp/opentag-runner-test-state",
  };
}

/** The delivery id carried by a report frame, if it is a report frame. */
function frameReportDeliveryId(frame: Record<string, unknown>): string | undefined {
  if (frame.type !== "delivery:report") return undefined;
  return (frame.report as { deliveryId?: string } | undefined)?.deliveryId;
}

/** Exact delivery-identity report lookup; never a transient frame count. */
function reportFor(
  wss: { readonly frames: Record<string, unknown>[] },
  deliveryId: string,
): { outcome?: string } | undefined {
  const frame = wss.frames.find((candidate) => frameReportDeliveryId(candidate) === deliveryId);
  return frame ? (frame.report as { outcome?: string }) : undefined;
}

function modelGrantFor(
  delivery: ReturnType<typeof cloudDeliveryFixture>,
  token = "unit-execution-token-0123456789abcdef",
) {
  return {
    baseUrl: "https://server.example.com/api/v1/cloud-model",
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
    model: delivery.runtime.model,
    token,
  };
}

/** Bounded explicit completion waiter for real-socket assertions. */
async function waitFor(check: () => boolean | Promise<boolean>, description: string, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("runRunnerServe", () => {
  it("fails closed when the native sandbox binary is absent (never pretends local is native Cloud)", async () => {
    const output = io();
    const code = await runRunnerServe(serveConfig("ws://127.0.0.1:1/ws"), {
      stderr: output.stderr,
      installSignalHandlers: false,
      sandboxFactory: () => {
        throw new NativeSandboxError("unavailable", "The native Cloud Run sandbox binary is absent");
      },
    });
    expect(code).toBe(3);
    expect(output.chunks.stderr.join("")).toMatch(/unavailable/);
  });

  it("authenticates first-frame, reports native readiness, and heartbeats", async () => {
    const wss = await startWss();
    const output = io();
    const state = { destroys: 0, launches: 0, failDestroy: false };
    const stop = new AbortController();
    const running = runRunnerServe(serveConfig(wss.url), {
      stderr: output.stderr,
      installSignalHandlers: false,
      sandboxFactory: fakeSandboxFactory([], state),
      randomJitter: () => 0,
      signal: stop.signal,
    });
    const auth = (await wss.waitFor("auth")) as { token?: string };
    expect(auth.token).toBe(BOOTSTRAP_TOKEN);
    // The token never travels in the URL.
    expect(wss.url).not.toContain(BOOTSTRAP_TOKEN);
    const ready = (await wss.waitFor("runner:ready")) as { readiness: { rootfs: string; piVersion: string } };
    expect(ready.readiness.rootfs).toBe("/opt/sandbox-root");
    expect(ready.readiness.piVersion).toBe("0.84.2");
    await wss.waitFor("heartbeat");
    stop.abort();
    expect(await running).toBe(143);
    expect(state.destroys).toBe(1);
  }, 30_000);

  it("executes an acceptance command inside the sandbox with stdin-only config and reports the result", async () => {
    const wss = await startWss();
    const output = io();
    const state = { destroys: 0, launches: 0, failDestroy: false };
    const execs: FakeSandbox["execs"] = [];
    const stop = new AbortController();
    const running = runRunnerServe(serveConfig(wss.url), {
      stderr: output.stderr,
      installSignalHandlers: false,
      sandboxFactory: fakeSandboxFactory(execs, state),
      randomJitter: () => 0,
      signal: stop.signal,
    });
    await wss.waitFor("runner:ready");
    wss.send({
      type: "acceptance:run",
      requestId: "req-1",
      mode: "real",
      deadlineAtMs: Date.now() + 60_000,
      piConfig: { authJson: '{"deepseek":{"token":"unit-secret"}}' },
    });
    const result = (await wss.waitFor("acceptance:result")) as {
      requestId: string;
      outcome: string;
      report?: { offline: string };
    };
    expect(result.requestId).toBe("req-1");
    expect(result.outcome).toBe("passed");
    expect(result.report?.offline).toBe("passed");
    // The worker ran inside the native sandbox with stdin-only credential transfer…
    expect(execs).toHaveLength(1);
    expect(execs[0]?.command).toBe("/usr/local/bin/node");
    expect(execs[0]?.args[1]).toBe("worker");
    const payload = JSON.parse(execs[0]?.stdin ?? "{}");
    expect(payload).toMatchObject({ kind: "acceptance", mode: "real" });
    expect(payload.piConfig.authJson).toContain("unit-secret");
    // …and the parent control credential never reaches the sandbox env/argv/stdin.
    expect(execs[0]?.stdin).not.toContain(BOOTSTRAP_TOKEN);
    expect(execs[0]?.args.join(" ")).not.toContain(BOOTSTRAP_TOKEN);
    stop.abort();
    expect(await running).toBe(143);
  }, 30_000);

  it("exits nonzero without retrying forever when the token is rejected", async () => {
    const wss = await startWss(() => false);
    const output = io();
    const state = { destroys: 0, launches: 0, failDestroy: false };
    const code = await runRunnerServe(serveConfig(wss.url), {
      stderr: output.stderr,
      installSignalHandlers: false,
      sandboxFactory: fakeSandboxFactory([], state),
      maxReconnectAttempts: 3,
      sleep: () => Promise.resolve(),
      randomJitter: () => 0,
    });
    expect(code).toBe(1);
    expect(wss.frames.filter((frame) => frame.type === "auth")).toHaveLength(1);
    expect(state.destroys).toBe(1);
    expect(output.chunks.stderr.join("")).toMatch(/rejected/);
  }, 30_000);

  it("treats an authentication timeout as a transport failure and reconnects", async () => {
    // The first connection never answers auth (a slow Server); only an explicit in-band
    // auth:result ok:false may be terminal, so the Runner must back off and dial again.
    const wss = await startWss(undefined, { interval: 50, timeout: 100_000 }, { dropAuthConnections: 1 });
    const output = io();
    const state = { destroys: 0, launches: 0, failDestroy: false };
    const stop = new AbortController();
    const running = runRunnerServe(serveConfig(wss.url), {
      stderr: output.stderr,
      installSignalHandlers: false,
      sandboxFactory: fakeSandboxFactory([], state),
      authTimeoutMs: 120,
      sleep: () => Promise.resolve(),
      randomJitter: () => 0,
      signal: stop.signal,
    });
    await wss.waitFor("runner:ready");
    expect(wss.frames.filter((frame) => frame.type === "auth").length).toBeGreaterThanOrEqual(2);
    expect(output.chunks.stderr.join("")).toMatch(/timed out/);
    stop.abort();
    expect(await running).toBe(143);
  }, 30_000);

  it("reconnects when the server speaks out of turn before auth completes", async () => {
    const wss = await startWss(undefined, { interval: 50, timeout: 100_000 }, { errorAuthConnections: 1 });
    const output = io();
    const state = { destroys: 0, launches: 0, failDestroy: false };
    const stop = new AbortController();
    const running = runRunnerServe(serveConfig(wss.url), {
      stderr: output.stderr,
      installSignalHandlers: false,
      sandboxFactory: fakeSandboxFactory([], state),
      sleep: () => Promise.resolve(),
      randomJitter: () => 0,
      signal: stop.signal,
    });
    await wss.waitFor("runner:ready");
    expect(wss.frames.filter((frame) => frame.type === "auth").length).toBeGreaterThanOrEqual(2);
    stop.abort();
    expect(await running).toBe(143);
  }, 30_000);

  it("reconnects after a server-side close and re-reports readiness", async () => {
    const wss = await startWss();
    const output = io();
    const state = { destroys: 0, launches: 0, failDestroy: false };
    const stop = new AbortController();
    const running = runRunnerServe(serveConfig(wss.url), {
      stderr: output.stderr,
      installSignalHandlers: false,
      sandboxFactory: fakeSandboxFactory([], state),
      sleep: () => Promise.resolve(),
      randomJitter: () => 0,
      signal: stop.signal,
    });
    await wss.waitFor("runner:ready");
    wss.closeSocket();
    // Second connection: readiness is re-reported on the new connection.
    await vi.waitFor(() => {
      expect(wss.frames.filter((frame) => frame.type === "runner:ready").length).toBeGreaterThanOrEqual(2);
    });
    expect(wss.frames.filter((frame) => frame.type === "auth").length).toBeGreaterThanOrEqual(2);
    stop.abort();
    expect(await running).toBe(143);
  }, 30_000);

  it("requires sandbox deletion for a clean exit", async () => {
    const wss = await startWss();
    const output = io();
    const state = { destroys: 0, launches: 0, failDestroy: true };
    const running = runRunnerServe(serveConfig(wss.url), {
      stderr: output.stderr,
      installSignalHandlers: false,
      sandboxFactory: fakeSandboxFactory([], state),
      sleep: () => Promise.resolve(),
      randomJitter: () => 0,
      maxReconnectAttempts: 1,
    });
    await wss.waitFor("runner:ready");
    wss.closeSocket();
    expect(await running).toBe(5);
    expect(state.destroys).toBe(1);
    expect(output.chunks.stderr.join("")).toMatch(/deletion failed/);
  }, 30_000);

  it("serves the declared platform health port with a zero-data listener until shutdown", async () => {
    const wss = await startWss();
    const output = io();
    const state = { destroys: 0, launches: 0, failDestroy: false };
    const stop = new AbortController();
    const healthPort = await freePort();
    const running = runRunnerServe(
      { ...serveConfig(wss.url), healthPort },
      {
        stderr: output.stderr,
        installSignalHandlers: false,
        sandboxFactory: fakeSandboxFactory([], state),
        signal: stop.signal,
      },
    );
    // Readiness means native probe succeeded AND the startup-probe listener is bound.
    await wss.waitFor("runner:ready");
    expect(await probeHealthPort(healthPort)).toEqual({ bytes: 0 });
    stop.abort();
    expect(await running).toBe(143);
    await expect(probeHealthPort(healthPort)).rejects.toThrow();
  }, 30_000);

  it("closes the health listener when authentication is fatally rejected", async () => {
    const wss = await startWss(() => false);
    const healthPort = await freePort();
    const state = { destroys: 0, launches: 0, failDestroy: false };
    const code = await runRunnerServe(
      { ...serveConfig(wss.url), healthPort },
      {
        stderr: io().stderr,
        installSignalHandlers: false,
        sandboxFactory: fakeSandboxFactory([], state),
        maxReconnectAttempts: 1,
        randomJitter: () => 0,
      },
    );
    expect(code).toBe(1);
    await expect(probeHealthPort(healthPort)).rejects.toThrow();
  }, 30_000);

  it("never opens the health port when native startup fails", async () => {
    const healthPort = await freePort();
    const code = await runRunnerServe(
      { ...serveConfig("ws://127.0.0.1:1/ws"), healthPort },
      {
        stderr: io().stderr,
        installSignalHandlers: false,
        sandboxFactory: () => {
          throw new NativeSandboxError("unavailable", "The native Cloud Run sandbox binary is absent");
        },
      },
    );
    expect(code).toBe(3);
    await expect(probeHealthPort(healthPort)).rejects.toThrow();
  });
});

describe("Runner cancellation and connection lifetime", () => {
  it("does not spawn already-cancelled work", async () => {
    const spawnProcess = vi.fn();
    const stop = new AbortController();
    stop.abort();
    const sandbox = new NativeSandbox({ name: "probe", workspace: "/tmp/probe", spawnProcess });
    await expect(sandbox.exec("node", [], { timeoutMs: 100, signal: stop.signal })).rejects.toMatchObject({
      code: "exec_failed",
    });
    expect(spawnProcess).not.toHaveBeenCalled();
  });
  it("waits for exit and escalates a real supervisor process that ignores TERM", async () => {
    const stop = new AbortController();
    let pid: number | undefined;
    const sandbox = new NativeSandbox({
      name: "probe",
      workspace: "/tmp/probe",
      spawnProcess: () => {
        const child = spawn(
          process.execPath,
          ["-e", "process.on('SIGTERM',()=>{});console.log('ready');setInterval(()=>{},1000)"],
          { stdio: "pipe" },
        );
        pid = child.pid;
        child.stdout.once("data", () => stop.abort());
        return child;
      },
    });
    const started = Date.now();
    await expect(sandbox.exec("node", [], { timeoutMs: 10_000, signal: stop.signal })).rejects.toMatchObject({
      code: "exec_failed",
    });
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_900);
    expect(pid).toBeTypeOf("number");
    expect(() => process.kill(pid as number, 0)).toThrow();
  }, 15_000);
  it("keeps a healthy idle socket and reconnects with the renewed token", async () => {
    const renewed = "renewed-unit-token";
    const wss = await startWss((frame) => frame.token === BOOTSTRAP_TOKEN || frame.token === renewed, {
      interval: 20,
      timeout: 100,
    });
    const output = io(),
      stop = new AbortController();
    const running = runRunnerServe(serveConfig(wss.url), {
      stderr: output.stderr,
      installSignalHandlers: false,
      signal: stop.signal,
      sandboxFactory: fakeSandboxFactory(),
      sleep: async () => {},
      randomJitter: () => 0,
    });
    await wss.waitFor("runner:ready");
    wss.send({ type: "server:credential", token: renewed });
    await new Promise((r) => setTimeout(r, 350));
    expect(wss.sockets).toHaveLength(1);
    expect(wss.frames.filter((f) => f.type === "heartbeat").length).toBeGreaterThan(2);
    wss.closeSocket();
    await vi.waitFor(() => expect(wss.frames.filter((f) => f.type === "auth").at(-1)?.token).toBe(renewed));
    stop.abort();
    expect(await running).toBe(143);
    expect(output.chunks.stderr.join("")).not.toContain(renewed);
  });
  it("waits for native deletion before reconnecting after an interrupted run", async () => {
    const wss = await startWss();
    const stop = new AbortController(),
      output = io();
    let deleteResolve: () => void = () => {};
    let deletes = 0,
      aborted = false;
    const deleting = new Promise<void>((r) => {
      deleteResolve = r;
    });
    const factory = fakeSandboxFactory();
    const sandbox = factory("probe", "/tmp/probe");
    sandbox.exec = vi.fn(
      async (_command, _args, options) =>
        new Promise<Awaited<ReturnType<NativeSandbox["exec"]>>>((_resolve, reject) => {
          options.signal?.addEventListener(
            "abort",
            () => {
              aborted = true;
              reject(new Error("cancel"));
            },
            { once: true },
          );
        }),
    );
    sandbox.destroy = vi.fn(async () => {
      deletes++;
      if (deletes === 1) await deleting;
    });
    const running = runRunnerServe(serveConfig(wss.url), {
      stderr: output.stderr,
      installSignalHandlers: false,
      signal: stop.signal,
      sandboxFactory: () => sandbox,
      sleep: async () => {},
      randomJitter: () => 0,
    });
    await wss.waitFor("runner:ready");
    wss.send({ type: "acceptance:run", requestId: "old", mode: "offline", deadlineAtMs: Date.now() + 30_000 });
    await vi.waitFor(() => expect(sandbox.exec).toHaveBeenCalledOnce());
    wss.send({ type: "acceptance:cancel", requestId: "another" });
    await new Promise((r) => setTimeout(r, 20));
    expect(aborted).toBe(false);
    wss.closeSocket();
    await vi.waitFor(() => expect(deletes).toBe(1));
    expect(aborted).toBe(true);
    await new Promise((r) => setTimeout(r, 30));
    expect(wss.sockets).toHaveLength(1);
    deleteResolve();
    await vi.waitFor(() => expect(wss.sockets).toHaveLength(2));
    stop.abort();
    expect(await running).toBe(143);
  });
  it("mounts only the public state root and keeps the journal/private material disjoint", () => {
    const dirs = cloudRunnerDirectories("/tmp/opentag-runner-state-layout");
    expect(dirs.publicRoot).toBe("/tmp/opentag-runner-state-layout/bridge-public");
    for (const privatePath of [dirs.journalDir, dirs.privateTurnRoot]) {
      expect(privatePath === dirs.publicRoot || privatePath.startsWith(`${dirs.publicRoot}/`)).toBe(false);
      expect(dirs.publicRoot.startsWith(`${privatePath}/`)).toBe(false);
    }
  });

  it("negotiates E4 Cloud delivery and runs a real loopback duplicate-verify burst exactly once", async () => {
    const wss = await startWss(
      undefined,
      { interval: 50, timeout: 100_000 },
      {},
      { capability: 1, resourceUid: "uid-1" },
    );
    const output = io();
    const stateDir = await mkdtemp(join(tmpdir(), "opentag-runner-cloud-"));
    cleanup.push(() => rm(stateDir, { recursive: true, force: true }));
    const stop = new AbortController();
    const workerInputs: { stdin: string; timeoutMs: number }[] = [];
    const running = runRunnerServe(
      { ...serveConfig(wss.url), stateDir },
      {
        cloudTurnSeams: {
          openExecution: async () => ({
            close: async () => undefined,
            executionDir: "/run/opentag-execution/unit",
            sessionCliProof: {
              proofId: "11111111-1111-4111-8111-111111111111",
              token: "ephemeral-proof-0123456789abcdef0123456789",
            },
          }),
          runWorker: async (input) => {
            workerInputs.push(input);
            return {
              code: 0,
              stderr: "",
              stdout: `${JSON.stringify({
                kind: "result",
                completion: { executionEffects: "completed", finalText: "burst", outcome: "completed" },
              })}\n`,
            };
          },
        },
        installSignalHandlers: false,
        randomJitter: () => 0,
        sandboxFactory: fakeSandboxFactory(),
        signal: stop.signal,
        stderr: output.stderr,
      },
    );
    const auth = await wss.waitFor("auth");
    expect(auth.cloudDeliveryVersion).toBe(1);
    await wss.waitFor("runner:ready");
    const delivery = cloudDeliveryFixture({ sessionId: WSS_SESSION_ID });
    wss.send({ type: "delivery:run", requestId: delivery.requestId, delivery });
    const received = (await wss.waitFor("delivery:received")) as { deliveryId?: string };
    expect(received.deliveryId).toBe(delivery.deliveryId);
    const verified = {
      type: "delivery:verified",
      requestId: delivery.requestId,
      status: "verified",
      model: {
        baseUrl: "https://server.example.com/api/v1/cloud-model",
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
        model: delivery.runtime.model,
        token: "unit-execution-token-0123456789abcdef",
      },
    };
    // Burst duplicate verifies concurrently over the real socket: exactly one worker may start.
    for (let index = 0; index < 4; index += 1) wss.send(verified);
    const reportFrame = (await wss.waitFor("delivery:report")) as {
      report: { outcome: string; resultHash: string; turnId: string };
    };
    expect(reportFrame.report.outcome).toBe("completed");
    await waitFor(() => workerInputs.length === 1, "single cloud worker");
    // The worker stdin never carries any trusted (private/journal) host path from the Runner state root.
    expect(workerInputs[0]?.stdin).not.toContain(stateDir);
    expect(JSON.parse(workerInputs[0]?.stdin ?? "{}").sessionCollaboration.serverUrl).toBe(
      new URL(wss.url.replace("ws:", "http:")).origin,
    );
    expect(wss.frames.filter((frame) => frame.type === "delivery:report")).toHaveLength(1);
    wss.send({
      type: "delivery:report:ack",
      requestId: "ack-1",
      resultHash: reportFrame.report.resultHash,
      status: "recorded",
      turnId: reportFrame.report.turnId,
    });
    await waitFor(async () => (await readdir(join(stateDir, "journal"))).length === 0, "durable ack retirement");
    stop.abort();
    expect(await running).toBe(143);
  }, 30_000);

  it("surfaces a durable-receive store failure instead of swallowing it", async () => {
    const wss = await startWss(
      undefined,
      { interval: 50, timeout: 100_000 },
      {},
      { capability: 1, resourceUid: "uid-1" },
    );
    const output = io();
    const stateDir = await mkdtemp(join(tmpdir(), "opentag-runner-storefail-"));
    cleanup.push(() => rm(stateDir, { recursive: true, force: true }));
    const delivery = cloudDeliveryFixture({ sessionId: WSS_SESSION_ID });
    const stop = new AbortController();
    const running = runRunnerServe(
      { ...serveConfig(wss.url), stateDir },
      {
        cloudTurnSeams: {
          openExecution: async () => ({ close: async () => undefined, executionDir: "/run/opentag-execution/unit" }),
          runWorker: async () => ({ code: 0, stderr: "", stdout: "" }),
        },
        installSignalHandlers: false,
        randomJitter: () => 0,
        sandboxFactory: fakeSandboxFactory(),
        signal: stop.signal,
        stderr: output.stderr,
      },
    );
    await wss.waitFor("runner:ready");
    // The initial reconnect reconcile owns the serialized control queue. A query frame queued
    // behind it is answered only after that reconcile finished, so wait for the answer before
    // injecting the fault; otherwise the corrupt directory would race reconciliation itself.
    const queryRequestId = `storefail-query-${randomUUID()}`;
    wss.send({
      type: "delivery:query",
      requestId: queryRequestId,
      deliveryId: delivery.deliveryId,
      turnId: randomUUID(),
    });
    const query = await wss.waitFor("delivery:query:result");
    expect(query.requestId).toBe(queryRequestId);
    expect(query.phase).toBe("none");
    // A directory squatting on the journal entry path makes the durable write fail for real.
    await mkdir(join(stateDir, "journal", `${delivery.deliveryId}.json`), { recursive: true });
    wss.send({ type: "delivery:run", requestId: delivery.requestId, delivery });
    const socket = wss.sockets[0] as WsSocket;
    await new Promise<void>((resolve) => {
      if (socket.readyState === socket.CLOSED) resolve();
      else socket.once("close", () => resolve());
    });
    // The failure is reported after the connection cycles; wait briefly for the surfaced log
    // instead of racing the socket close event.
    await vi.waitFor(
      () => {
        expect(output.chunks.stderr.join("")).toMatch(/durable boundary failed|delivery:run failed/);
      },
      { timeout: 5_000 },
    );
    expect(wss.frames.some((frame) => frame.type === "delivery:received")).toBe(false);
    stop.abort();
    expect(await running).toBe(143);
  }, 30_000);

  it("cleans the native namespace immediately after an interrupted turn and blocks queued turns and acceptance until verified", async () => {
    const wss = await startWss(
      undefined,
      { interval: 50, timeout: 100_000 },
      {},
      { capability: 1, resourceUid: "uid-1" },
    );
    const output = io();
    const stateDir = await mkdtemp(join(tmpdir(), "opentag-runner-reset-"));
    cleanup.push(() => rm(stateDir, { recursive: true, force: true }));
    let markResetStarted: () => void = () => undefined;
    const resetStarted = new Promise<void>((resolve) => {
      markResetStarted = resolve;
    });
    let releaseReset: () => void = () => undefined;
    const resetGate = new Promise<void>((resolve) => {
      releaseReset = resolve;
    });
    let destroyCalls = 0;
    let launchCalls = 0;
    let probeCalls = 0;
    let child: ReturnType<typeof spawn> | undefined;
    let markChildExited: () => void = () => undefined;
    const childExited = new Promise<void>((resolve) => {
      markChildExited = resolve;
    });
    const workerCalls: string[] = [];
    const sandboxFactory = () =>
      ({
        destroy: async () => {
          destroyCalls += 1;
          markResetStarted();
          await resetGate;
          // Emulate the native `delete --force` reclaiming the whole namespace process tree. Only
          // wait for a child that actually exists, so cleanup cannot hang before the worker spawn.
          if (child && child.exitCode === null && child.signalCode === null) {
            child.kill("SIGKILL");
            await childExited;
          }
        },
        exec: async () => {
          throw new Error("unexpected native exec");
        },
        launch: async () => {
          launchCalls += 1;
        },
        probe: async () => {
          probeCalls += 1;
          return { nodeVersion: "v24.19.0", piVersion: "0.84.2", runnerVersion: "1.0.0" };
        },
      }) as unknown as NativeSandbox;
    const stop = new AbortController();
    const running = runRunnerServe(
      { ...serveConfig(wss.url), stateDir },
      {
        cloudTurnSeams: {
          openExecution: async () => ({ close: async () => undefined, executionDir: "/run/opentag-execution/unit" }),
          runWorker: async (input) => {
            const deliveryId = (JSON.parse(input.stdin) as { delivery: { deliveryId: string } }).delivery.deliveryId;
            workerCalls.push(deliveryId);
            if (workerCalls.length === 1) {
              // The exec wrapper exits while its owned child keeps running: a cancelled report
              // must wait for the verified namespace cleanup.
              child = spawn(process.execPath, ["-e", "setInterval(() => undefined, 1_000)"], { stdio: "ignore" });
              child.once("exit", () => markChildExited());
              return {
                code: 1,
                stderr: "",
                stdout: `${JSON.stringify({
                  kind: "result",
                  completion: {
                    errorReason: "client_shutdown",
                    executionEffects: "may_have_occurred",
                    outcome: "cancelled",
                  },
                })}\n`,
              };
            }
            return {
              code: 0,
              stderr: "",
              stdout: `${JSON.stringify({
                kind: "result",
                completion: { executionEffects: "completed", finalText: "after-reset", outcome: "completed" },
              })}\n`,
            };
          },
        },
        installSignalHandlers: false,
        randomJitter: () => 0,
        sandboxFactory,
        signal: stop.signal,
        stderr: output.stderr,
      },
    );
    try {
      await wss.waitFor("runner:ready");
      // Startup already launched/probed once; the reset must add exactly one more verified cycle.
      const launchesBefore = launchCalls;
      const probesBefore = probeCalls;
      const first = cloudDeliveryFixture({ sessionId: WSS_SESSION_ID });
      wss.send({ type: "delivery:run", requestId: first.requestId, delivery: first });
      await wss.waitFor("delivery:received");
      wss.send({
        type: "delivery:verified",
        requestId: first.requestId,
        status: "verified",
        model: modelGrantFor(first),
      });
      // NO next delivery is sent: cleanup starts immediately, while the turn occupation is reserved.
      await resetStarted;
      expect(destroyCalls).toBe(1);
      expect(child?.exitCode).toBeNull();
      expect(wss.frames.filter((frame) => frame.type === "delivery:report")).toHaveLength(0);
      // A queued second turn and E3 acceptance stay blocked through the pending cleanup.
      wss.send({ type: "acceptance:run", requestId: "busy-1", mode: "offline", deadlineAtMs: Date.now() + 60_000 });
      const busy = (await wss.waitFor("acceptance:result")) as { failure?: { code?: string } };
      expect(busy.failure?.code).toBe("runner_busy");
      const second = cloudDeliveryFixture({ sessionId: WSS_SESSION_ID });
      wss.send({ type: "delivery:run", requestId: second.requestId, delivery: second });
      await waitFor(
        () => wss.frames.filter((frame) => frame.type === "delivery:received").length === 2,
        "second receipt",
      );
      wss.send({
        type: "delivery:verified",
        requestId: second.requestId,
        status: "verified",
        model: modelGrantFor(second),
      });
      const secondReceipt = wss.frames.find(
        (frame) => frame.type === "delivery:received" && frame.deliveryId === second.deliveryId,
      ) as { turnId?: string } | undefined;
      // The query result is serialized behind the second verified frame: observing it proves that
      // frame was processed and only queued, never started before cleanup completed.
      wss.send({
        type: "delivery:query",
        requestId: "probe-q",
        deliveryId: second.deliveryId,
        turnId: secondReceipt?.turnId,
      });
      await waitFor(
        () => wss.frames.some((frame) => frame.type === "delivery:query:result" && frame.requestId === "probe-q"),
        "second verified processed",
      );
      expect(workerCalls).toHaveLength(1);
      expect(wss.frames.filter((frame) => frame.type === "delivery:report")).toHaveLength(0);
      releaseReset();
      // Match the exact delivery identity. Two reports can arrive between polls, so a transient
      // count (=== 1) is never a valid observation; every predicate below is monotonic.
      await waitFor(() => reportFor(wss, first.deliveryId) !== undefined, "first report");
      expect(reportFor(wss, first.deliveryId)?.outcome).toBe("cancelled");
      expect(child?.signalCode).toBe("SIGKILL");
      await waitFor(() => reportFor(wss, second.deliveryId) !== undefined, "second report");
      expect(reportFor(wss, second.deliveryId)?.outcome).toBe("completed");
      // Exact final delivery order and count: cancelled first, completed second, nothing else.
      expect(wss.frames.filter((frame) => frame.type === "delivery:report").map(frameReportDeliveryId)).toEqual([
        first.deliveryId,
        second.deliveryId,
      ]);
      expect(workerCalls).toEqual([first.deliveryId, second.deliveryId]);
      expect(destroyCalls).toBe(1);
      expect(launchCalls - launchesBefore).toBe(1);
      expect(probeCalls - probesBefore).toBe(1);
      stop.abort();
      expect(await running).toBe(143);
    } finally {
      // Always release the gated cleanup, settle the runner, and reap the owned child even when an
      // assertion failed earlier. Reap before awaiting the runner so a stuck cleanup cannot hang.
      releaseReset();
      stop.abort();
      if (child) {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        await childExited;
      }
      await running.catch(() => undefined);
    }
  }, 30_000);

  it("settles the Cloud controller before destroying the sandbox on shutdown", async () => {
    const wss = await startWss(
      undefined,
      { interval: 50, timeout: 100_000 },
      {},
      { capability: 1, resourceUid: "uid-1" },
    );
    const output = io();
    const stateDir = await mkdtemp(join(tmpdir(), "opentag-runner-shutdown-"));
    cleanup.push(() => rm(stateDir, { recursive: true, force: true }));
    let workerSettled = false;
    let destroySawSettled: boolean | undefined;
    let destroyCalls = 0;
    let markWorkerStarted: () => void = () => undefined;
    const workerStarted = new Promise<void>((resolve) => {
      markWorkerStarted = resolve;
    });
    const sandboxFactory = () =>
      ({
        destroy: async () => {
          destroyCalls += 1;
          destroySawSettled = workerSettled;
        },
        exec: async () => {
          throw new Error("unexpected native exec");
        },
        launch: async () => undefined,
        probe: async () => ({ nodeVersion: "v24.19.0", piVersion: "0.84.2", runnerVersion: "1.0.0" }),
      }) as unknown as NativeSandbox;
    const stop = new AbortController();
    const running = runRunnerServe(
      { ...serveConfig(wss.url), stateDir },
      {
        cloudTurnSeams: {
          openExecution: async () => ({ close: async () => undefined, executionDir: "/run/opentag-execution/unit" }),
          runWorker: async (_input, signal) =>
            new Promise((resolve) => {
              signal.addEventListener(
                "abort",
                () => {
                  workerSettled = true;
                  resolve({ code: 143, stderr: "", stdout: "" });
                },
                { once: true },
              );
              markWorkerStarted();
            }),
        },
        installSignalHandlers: false,
        randomJitter: () => 0,
        sandboxFactory,
        signal: stop.signal,
        stderr: output.stderr,
      },
    );
    await wss.waitFor("runner:ready");
    const delivery = cloudDeliveryFixture({ sessionId: WSS_SESSION_ID });
    wss.send({ type: "delivery:run", requestId: delivery.requestId, delivery });
    await wss.waitFor("delivery:received");
    wss.send({
      type: "delivery:verified",
      requestId: delivery.requestId,
      status: "verified",
      model: modelGrantFor(delivery),
    });
    await workerStarted;
    stop.abort();
    expect(await running).toBe(143);
    // The controller aborted and awaited the live worker before the namespace was destroyed.
    expect(destroyCalls).toBe(1);
    expect(destroySawSettled).toBe(true);
  }, 30_000);

  it("skips a verified frame queued on a connection that closed before its control turn", async () => {
    const wss = await startWss(
      undefined,
      { interval: 50, timeout: 100_000 },
      {},
      { capability: 1, resourceUid: "uid-1" },
    );
    const output = io();
    const stateDir = await mkdtemp(join(tmpdir(), "opentag-runner-stale-frame-"));
    cleanup.push(() => rm(stateDir, { recursive: true, force: true }));
    let markReadEntered: () => void = () => undefined;
    const readEntered = new Promise<void>((resolve) => {
      markReadEntered = resolve;
    });
    let releaseRead: () => void = () => undefined;
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    let readArmed = false;
    let readConsumed = false;
    const realRead = CloudJournal.prototype.read;
    const readSpy = vi.spyOn(CloudJournal.prototype, "read").mockImplementation(async function (
      this: CloudJournal,
      deliveryId: string,
    ) {
      if (readArmed && !readConsumed) {
        readConsumed = true;
        markReadEntered();
        await readGate;
      }
      return realRead.call(this, deliveryId);
    });
    const tokens: string[] = [];
    const stop = new AbortController();
    const running = runRunnerServe(
      { ...serveConfig(wss.url), stateDir },
      {
        cloudTurnSeams: {
          openExecution: async () => ({ close: async () => undefined, executionDir: "/run/opentag-execution/unit" }),
          runWorker: async (input) => {
            tokens.push((JSON.parse(input.stdin) as { model: { token: string } }).model.token);
            return {
              code: 0,
              stderr: "",
              stdout: `${JSON.stringify({
                kind: "result",
                completion: { executionEffects: "completed", finalText: "stale", outcome: "completed" },
              })}\n`,
            };
          },
        },
        installSignalHandlers: false,
        randomJitter: () => 0,
        sandboxFactory: fakeSandboxFactory(),
        signal: stop.signal,
        sleep: async () => undefined,
        stderr: output.stderr,
      },
    );
    try {
      await wss.waitFor("runner:ready");
      const delivery = cloudDeliveryFixture({ sessionId: WSS_SESSION_ID });
      wss.send({ type: "delivery:run", requestId: delivery.requestId, delivery });
      await wss.waitFor("delivery:received");
      // A query handler blocks this connection's control queue inside the real journal read.
      readArmed = true;
      wss.send({
        type: "delivery:query",
        requestId: "block-1",
        deliveryId: "blocked-delivery",
        turnId: "blocked-turn",
      });
      await readEntered;
      // The old connection's verified frame queues behind the blocked handler, then the socket closes.
      wss.send({
        type: "delivery:verified",
        requestId: delivery.requestId,
        status: "verified",
        model: modelGrantFor(delivery),
      });
      wss.closeSocket();
      // The closing connection drains its control tail before the reconnect, so release the
      // blocked journal read first; the queued verified frame must still be skipped because the
      // connection is already closed when it reaches the head of the queue.
      releaseRead();
      await waitFor(() => wss.sockets.length >= 2, "replacement connection");
      await waitFor(() => wss.frames.filter((frame) => frame.type === "runner:ready").length >= 2, "replacement ready");
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      // The queued verified frame from the old socket must never have started a worker.
      expect(tokens).toEqual([]);
      const reopened = await CloudJournal.open(join(stateDir, "journal"));
      expect((await reopened.list()).map((entry) => entry.phase)).toEqual(["received"]);
      // Only a fresh verification on the replacement connection starts it, once and with the new grant.
      wss.send({
        type: "delivery:verified",
        requestId: delivery.requestId,
        status: "verified",
        model: modelGrantFor(delivery, "fresh-connection-token-0123456789"),
      });
      await waitFor(() => tokens.length === 1, "fresh connection worker");
      expect(tokens).toEqual(["fresh-connection-token-0123456789"]);
    } finally {
      readSpy.mockRestore();
      stop.abort();
      expect(await running).toBe(143);
    }
  }, 30_000);

  it("marks a non-signal exit as stopping before settling the controller so no relaunch follows", async () => {
    let authCalls = 0;
    const wss = await startWss(
      () => {
        authCalls += 1;
        return authCalls === 1; // the replacement connection is explicitly rejected
      },
      { interval: 50, timeout: 100_000 },
      {},
      { capability: 1, resourceUid: "uid-1" },
    );
    const output = io();
    const stateDir = await mkdtemp(join(tmpdir(), "opentag-runner-nonsignal-"));
    cleanup.push(() => rm(stateDir, { recursive: true, force: true }));
    let launchCalls = 0;
    let probeCalls = 0;
    let destroyCalls = 0;
    let destroySawSettled: boolean | undefined;
    let workerSettled = false;
    let markWorkerStarted: () => void = () => undefined;
    const workerStarted = new Promise<void>((resolve) => {
      markWorkerStarted = resolve;
    });
    const sandboxFactory = () =>
      ({
        destroy: async () => {
          destroyCalls += 1;
          destroySawSettled = workerSettled;
        },
        exec: async () => {
          throw new Error("unexpected native exec");
        },
        launch: async () => {
          launchCalls += 1;
        },
        probe: async () => {
          probeCalls += 1;
          return { nodeVersion: "v24.19.0", piVersion: "0.84.2", runnerVersion: "1.0.0" };
        },
      }) as unknown as NativeSandbox;
    const stop = new AbortController();
    const running = runRunnerServe(
      { ...serveConfig(wss.url), stateDir },
      {
        cloudTurnSeams: {
          openExecution: async () => ({ close: async () => undefined, executionDir: "/run/opentag-execution/unit" }),
          runWorker: async (_input, signal) =>
            new Promise((resolve) => {
              signal.addEventListener(
                "abort",
                () => {
                  workerSettled = true;
                  resolve({ code: 143, stderr: "", stdout: "" });
                },
                { once: true },
              );
              markWorkerStarted();
            }),
        },
        installSignalHandlers: false,
        randomJitter: () => 0,
        sandboxFactory,
        signal: stop.signal,
        sleep: async () => undefined,
        stderr: output.stderr,
      },
    );
    await wss.waitFor("runner:ready");
    const delivery = cloudDeliveryFixture({ sessionId: WSS_SESSION_ID });
    wss.send({ type: "delivery:run", requestId: delivery.requestId, delivery });
    await wss.waitFor("delivery:received");
    wss.send({
      type: "delivery:verified",
      requestId: delivery.requestId,
      status: "verified",
      model: modelGrantFor(delivery),
    });
    await workerStarted;
    // Non-signal exit: the replacement connection's auth is rejected in-band.
    wss.closeSocket();
    expect(await running).toBe(1);
    expect(authCalls).toBeGreaterThanOrEqual(2);
    // One initial launch/probe, one namespace delete, and cleanup only after the worker settled.
    expect(launchCalls).toBe(1);
    expect(probeCalls).toBe(1);
    expect(destroyCalls).toBe(1);
    expect(destroySawSettled).toBe(true);
    // The interrupted turn keeps a truthful durable cancellation.
    const journal = await CloudJournal.open(join(stateDir, "journal"));
    const entries = await journal.list();
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    if (entry?.kind !== "delivery") throw new Error("expected a delivery journal entry");
    expect(entry.phase).toBe("reported");
    expect(entry.report?.outcome).toBe("cancelled");
    expect(entry.report?.executionEffects).toBe("may_have_occurred");
    expect(entry.report?.errorReason).toBe("client_shutdown");
  }, 30_000);

  it("keeps a legacy E3 welcome Cloud-free and still runs E3 acceptance", async () => {
    const wss = await startWss();
    const output = io();
    const stateDir = await mkdtemp(join(tmpdir(), "opentag-runner-legacy-"));
    cleanup.push(() => rm(stateDir, { recursive: true, force: true }));
    const execs: FakeSandbox["execs"] = [];
    const stop = new AbortController();
    const running = runRunnerServe(
      { ...serveConfig(wss.url), stateDir },
      {
        installSignalHandlers: false,
        randomJitter: () => 0,
        sandboxFactory: fakeSandboxFactory(execs),
        signal: stop.signal,
        sleep: async () => undefined,
        stderr: output.stderr,
      },
    );
    await wss.waitFor("runner:ready");
    const delivery = cloudDeliveryFixture({ sessionId: WSS_SESSION_ID });
    wss.send({ type: "delivery:run", requestId: delivery.requestId, delivery });
    const firstSocket = wss.sockets[0] as WsSocket;
    await new Promise<void>((resolve) => {
      if (firstSocket.readyState === firstSocket.CLOSED) resolve();
      else firstSocket.once("close", () => resolve());
    });
    // A Cloud frame on a legacy channel is a protocol violation and never reaches Cloud handlers.
    expect(wss.frames.some((frame) => String(frame.type).startsWith("delivery:"))).toBe(false);
    await waitFor(() => wss.frames.filter((frame) => frame.type === "runner:ready").length >= 2, "legacy reconnect");
    wss.send({ type: "acceptance:run", requestId: "e3-1", mode: "offline", deadlineAtMs: Date.now() + 60_000 });
    const result = await wss.waitFor("acceptance:result");
    expect(["passed", "failed"]).toContain(result.outcome);
    stop.abort();
    expect(await running).toBe(143);
  }, 30_000);

  it("requests the E8 capability and handles Session frames only when the Server echoed it", async () => {
    const wss = await startWss(
      undefined,
      { interval: 50, timeout: 100_000 },
      {},
      { capability: 1, resourceUid: "uid-1", sessionCollaboration: 1 },
    );
    const stop = new AbortController();
    const output = io();
    const stateDir = await mkdtemp(join(tmpdir(), "opentag-runner-session-"));
    cleanup.push(() => rm(stateDir, { recursive: true, force: true }));
    const running = runRunnerServe(
      { ...serveConfig(wss.url), stateDir },
      {
        installSignalHandlers: false,
        randomJitter: () => 0,
        sandboxFactory: fakeSandboxFactory(),
        signal: stop.signal,
        stderr: output.stderr,
      },
    );
    await wss.waitFor("runner:ready");
    const auth = wss.frames.find((frame) => frame.type === "auth") as
      | { sessionCollaborationVersion?: number }
      | undefined;
    expect(auth?.sessionCollaborationVersion).toBe(1);
    const runtime = cloudDeliveryFixture().runtime;
    const messageId = randomUUID();
    wss.send({
      type: "session:message:run",
      requestId: messageId,
      message: {
        type: "session:message:deliver",
        requestId: messageId,
        messageId,
        sourceSessionId: randomUUID(),
        targetSessionId: WSS_SESSION_ID,
        agentId: runtime.agentId,
        placementGeneration: 1,
        content: { kind: "text", text: "child task" },
        runtime,
      },
      sessionKind: "internal",
    });
    const receipt = await wss.waitFor("session:message:received");
    expect(receipt).toMatchObject({ status: "accepted", phase: "received", messageId });
    stop.abort();
    expect(await running).toBe(143);
  }, 30_000);

  it("treats a Session frame without the E8 echo as a protocol violation", async () => {
    const wss = await startWss(
      undefined,
      { interval: 50, timeout: 100_000 },
      {},
      { capability: 1, resourceUid: "uid-1" },
    );
    const stop = new AbortController();
    const output = io();
    const stateDir = await mkdtemp(join(tmpdir(), "opentag-runner-session-legacy-"));
    cleanup.push(() => rm(stateDir, { recursive: true, force: true }));
    const running = runRunnerServe(
      { ...serveConfig(wss.url), stateDir },
      {
        installSignalHandlers: false,
        randomJitter: () => 0,
        sandboxFactory: fakeSandboxFactory(),
        signal: stop.signal,
        stderr: output.stderr,
      },
    );
    await wss.waitFor("runner:ready");
    const runtime = cloudDeliveryFixture().runtime;
    const messageId = randomUUID();
    wss.send({
      type: "session:message:run",
      requestId: messageId,
      message: {
        type: "session:message:deliver",
        requestId: messageId,
        messageId,
        sourceSessionId: randomUUID(),
        targetSessionId: WSS_SESSION_ID,
        agentId: runtime.agentId,
        placementGeneration: 1,
        content: { kind: "text", text: "child task" },
        runtime,
      },
      sessionKind: "internal",
    });
    const firstSocket = wss.sockets[0] as WsSocket;
    await new Promise<void>((resolve) => {
      if (firstSocket.readyState === firstSocket.CLOSED) resolve();
      else firstSocket.once("close", () => resolve());
    });
    expect(wss.frames.some((frame) => frame.type === "session:message:received")).toBe(false);
    stop.abort();
    expect(await running).toBe(143);
  }, 30_000);

  it("retries transiently when a Cloud welcome has no tracked allocation UID", async () => {
    const wss = await startWss(undefined, { interval: 50, timeout: 100_000 }, {}, { capability: 1, resourceUid: null });
    const stop = new AbortController();
    const output = io();
    // Real backoff: the first UID-less welcome cycles the connection and the backoff path
    // reconnects; the Runner must never publish runner:ready or Cloud state on that connection.
    const running = runRunnerServe(serveConfig(wss.url), {
      installSignalHandlers: false,
      randomJitter: () => 0,
      sandboxFactory: fakeSandboxFactory(),
      signal: stop.signal,
      stderr: output.stderr,
    });
    await waitFor(() => wss.sockets.length >= 2, "transient UID reattach");
    expect(wss.frames.filter((frame) => frame.type === "runner:ready")).toHaveLength(0);
    stop.abort();
    expect(await running).toBe(143);
  }, 30_000);

  it("rejects expired commands without running a worker", async () => {
    const wss = await startWss(),
      stop = new AbortController(),
      output = io(),
      execs: FakeSandbox["execs"] = [];
    const running = runRunnerServe(serveConfig(wss.url), {
      stderr: output.stderr,
      installSignalHandlers: false,
      signal: stop.signal,
      sandboxFactory: fakeSandboxFactory(execs),
    });
    await wss.waitFor("runner:ready");
    wss.send({ type: "acceptance:run", requestId: "expired", mode: "offline", deadlineAtMs: Date.now() - 1 });
    expect((await wss.waitFor("acceptance:result")).outcome).toBe("cancelled");
    expect(execs).toHaveLength(0);
    stop.abort();
    expect(await running).toBe(143);
  });
});
