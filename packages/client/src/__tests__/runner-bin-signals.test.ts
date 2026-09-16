import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket as WsSocket } from "ws";

/**
 * Real-child regression for the production `runner/bin.ts` signal lifecycle.
 *
 * The bug: `bin.ts` installs the process-level signal owner unconditionally, but serve mode
 * registers no scoped cleanup; the owner therefore exits (`process.exit(143/130)`) while
 * `runRunnerServe` is still inside its `finally` (`sandbox.destroy()`), so `docker stop`
 * escalation can kill a sandbox that was never deleted.
 *
 * The child runs the real bin/CLI/global-handler wiring through tsx. Only the platform
 * boundary is faked: a Node loader redirects `native-sandbox.js` to a module whose `destroy()`
 * is delayed and writes a marker. No production source learns a test-only bypass.
 */

const repositoryRoot = resolve(fileURLToPath(new URL("../../../../", import.meta.url)));
const SANDBOX_NAME = "ots-s-bin-signal-1";
const fakeNativeSandboxSource = String.raw`
import { appendFileSync } from "node:fs";

export class NativeSandboxError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "NativeSandboxError";
    this.code = code;
  }
}

export const SANDBOX_NODE = "/usr/local/bin/node";
export const SANDBOX_ROOTFS = "/opt/sandbox-root";
export const SANDBOX_WORKER_ENTRY = "/opt/opentag/client/dist/runner/bin.mjs";

const marker = process.env.FAKE_SANDBOX_MARKER ?? "/dev/null";
const execs = process.env.FAKE_SANDBOX_EXECS ?? "/dev/null";
const aborts = process.env.FAKE_SANDBOX_ABORTS ?? "/dev/null";
const launchMs = Number(process.env.FAKE_SANDBOX_LAUNCH_MS ?? "0");
const destroyMs = Number(process.env.FAKE_SANDBOX_DESTROY_MS ?? "0");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export class NativeSandbox {
  constructor(_options) {}
  async launch() {
    appendFileSync(marker, "launch\n");
    await sleep(launchMs);
  }
  async probe() {
    return { nodeVersion: "v24.19.0", piVersion: "0.84.2", runnerVersion: "0.0.5" };
  }
  async exec(_command, _args, options = {}) {
    appendFileSync(execs, "exec\n");
    const signal = options.signal;
    await new Promise((_resolve, reject) => {
      const cancel = () => {
        appendFileSync(aborts, "abort\n");
        reject(new Error("sandbox execution cancelled"));
      };
      if (signal?.aborted) cancel();
      else signal?.addEventListener("abort", cancel, { once: true });
    });
  }
  async destroy() {
    await sleep(destroyMs);
    appendFileSync(marker, "destroy\n");
  }
}
`;

const redirectSource = String.raw`
const FAKE = new URL("./fake-native-sandbox.mjs", import.meta.url).href;

export async function resolve(specifier, context, nextResolve) {
  if (/native-sandbox\.(js|ts)$/.test(specifier) && context.parentURL?.includes("/runner/")) {
    return { url: FAKE, shortCircuit: true, format: "module" };
  }
  return nextResolve(specifier, context);
}
`;

const directories: string[] = [];
const children: ChildProcess[] = [];
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGKILL");
      await Promise.race([
        new Promise((resolve) => child.once("exit", resolve)),
        new Promise((resolve) => setTimeout(resolve, 2_000)),
      ]);
    }
  }
  await Promise.all(closers.splice(0).map((close) => close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function readIfExists(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return "";
    throw error;
  }
}

async function waitForFileContent(path: string, expected: string, timeoutMs = 15_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const text = await readIfExists(path);
    if (text.includes(expected)) return text;
    if (Date.now() >= deadline)
      throw new Error(`Timed out waiting for ${JSON.stringify(expected)} in ${path}: ${JSON.stringify(text)}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

interface RunnerChild {
  readonly child: ChildProcess;
  readonly marker: string;
  readonly execs: string;
  readonly aborts: string;
  readonly diagnostics: () => string;
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
}

async function spawnRunnerBin(options: {
  backendUrl: string;
  launchMs: number;
  destroyMs: number;
}): Promise<RunnerChild> {
  const directory = await mkdtemp(join(tmpdir(), "opentag-runner-bin-"));
  directories.push(directory);
  const marker = join(directory, "sandbox-events.log");
  const execs = join(directory, "execs.log");
  const aborts = join(directory, "aborts.log");
  await writeFile(join(directory, "fake-native-sandbox.mjs"), fakeNativeSandboxSource);
  const redirect = join(directory, "redirect.mjs");
  await writeFile(redirect, redirectSource);
  const hooks = join(directory, "hooks.mjs");
  await writeFile(
    hooks,
    `import { register } from "node:module";\nregister(${JSON.stringify(pathToFileURL(redirect).href)});\n`,
  );
  const bin = join(repositoryRoot, "packages/client/src/runner/bin.ts");
  const tsx = createRequire(import.meta.url).resolve("tsx");
  const child = spawn(
    process.execPath,
    ["--import", pathToFileURL(tsx).href, "--import", pathToFileURL(hooks).href, bin, "serve"],
    {
      cwd: repositoryRoot,
      env: {
        ...process.env,
        OPENTAG_RUNNER_BACKEND_URL: options.backendUrl,
        OPENTAG_RUNNER_BOOTSTRAP_TOKEN: "bin-signal-bootstrap-token",
        OPENTAG_RUNNER_SANDBOX_NAME: SANDBOX_NAME,
        OPENTAG_RUNNER_WORKSPACE: join(directory, "workspace"),
        FAKE_SANDBOX_MARKER: marker,
        FAKE_SANDBOX_EXECS: execs,
        FAKE_SANDBOX_ABORTS: aborts,
        FAKE_SANDBOX_LAUNCH_MS: String(options.launchMs),
        FAKE_SANDBOX_DESTROY_MS: String(options.destroyMs),
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  children.push(child);
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit, rejectExit) => {
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
    child.once("error", rejectExit);
  });
  return { child, marker, execs, aborts, diagnostics: () => stderr, exited };
}

async function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolvePort(port));
    });
  });
}

interface ControlServer {
  readonly url: string;
  readonly frames: Record<string, unknown>[];
  send(frame: unknown): void;
  waitFor(type: string, timeoutMs?: number): Promise<Record<string, unknown>>;
}

async function startControlServer(): Promise<ControlServer> {
  const port = await freePort();
  const wss = new WebSocketServer({ host: "127.0.0.1", port });
  closers.push(async () => {
    for (const socket of wss.clients) socket.terminate();
    await new Promise<void>((close) => wss.close(() => close()));
  });
  const frames: Record<string, unknown>[] = [];
  const sockets: WsSocket[] = [];
  const waiters: { type: string; resolve: (frame: Record<string, unknown>) => void }[] = [];
  wss.on("connection", (socket) => {
    sockets.push(socket);
    socket.on("message", (raw) => {
      const frame = JSON.parse(String(raw)) as Record<string, unknown>;
      frames.push(frame);
      const index = waiters.findIndex((waiter) => waiter.type === frame.type);
      if (index >= 0) {
        const [waiter] = waiters.splice(index, 1);
        waiter?.resolve(frame);
      }
      if (frame.type === "auth") {
        socket.send(
          JSON.stringify({ type: "auth:result", ok: true, ...(frame.requestId ? { requestId: frame.requestId } : {}) }),
        );
        socket.send(
          JSON.stringify({
            type: "server:welcome",
            protocolVersion: 1,
            sandboxId: "11111111-1111-4111-8111-111111111111",
            sessionId: "22222222-2222-4222-8222-222222222222",
            environmentGeneration: 1,
            resourceName: `projects/p/locations/r/instances/${SANDBOX_NAME}`,
            heartbeatIntervalMs: 50,
            heartbeatTimeoutMs: 300_000,
          }),
        );
      }
      if (frame.type === "heartbeat") socket.send(JSON.stringify({ type: "server:heartbeat" }));
    });
  });
  return {
    url: `ws://127.0.0.1:${port}/api/v1/sandbox-runners/ws`,
    frames,
    send(frame) {
      for (const socket of sockets) if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(frame));
    },
    waitFor(type, timeoutMs = 15_000) {
      const existing = frames.find((frame) => frame.type === type);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolveFrame, reject) => {
        const timer = setTimeout(() => reject(new Error(`timed out waiting for ${type}`)), timeoutMs);
        waiters.push({
          type,
          resolve: (frame) => {
            clearTimeout(timer);
            resolveFrame(frame);
          },
        });
      });
    },
  };
}

describe("runner bin signal lifecycle (real child)", () => {
  it("SIGTERM during startup waits for the delayed destroy and exits 143", async () => {
    const fixture = await spawnRunnerBin({ backendUrl: "ws://127.0.0.1:1/ws", launchMs: 400, destroyMs: 250 });
    await waitForFileContent(fixture.marker, "launch");
    fixture.child.kill("SIGTERM");
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 30));
    fixture.child.kill("SIGTERM");
    const exit = await fixture.exited;
    expect(exit.signal, fixture.diagnostics()).toBeNull();
    expect(exit.code, fixture.diagnostics()).toBe(143);
    expect(await readFile(fixture.marker, "utf8")).toContain("destroy");
  }, 30_000);

  it("SIGINT during an active acceptance aborts exactly once and waits for destroy before exiting 130", async () => {
    const control = await startControlServer();
    const fixture = await spawnRunnerBin({ backendUrl: control.url, launchMs: 0, destroyMs: 250 });
    try {
      await control.waitFor("runner:ready");
    } catch (error) {
      throw new Error(`${error instanceof Error ? error.message : String(error)}\n${fixture.diagnostics()}`);
    }
    control.send({
      type: "acceptance:run",
      requestId: "bin-signal",
      mode: "offline",
      deadlineAtMs: Date.now() + 60_000,
    });
    await waitForFileContent(fixture.execs, "exec");
    fixture.child.kill("SIGINT");
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 30));
    fixture.child.kill("SIGINT");
    const exit = await fixture.exited;
    expect(exit.signal, fixture.diagnostics()).toBeNull();
    expect(exit.code, fixture.diagnostics()).toBe(130);
    expect(await readFile(fixture.marker, "utf8")).toContain("destroy");
    expect((await readIfExists(fixture.aborts)).match(/abort/g)?.length).toBe(1);
  }, 30_000);
});
