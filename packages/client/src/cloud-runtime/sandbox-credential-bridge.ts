import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import { chmod, copyFile, lstat, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { connect, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import {
  type RuntimeCredentialExecutionSubject,
  RuntimeCredentialRelay,
  type RuntimeCredentialRelayOptions,
} from "../runtime/runtime-credential-relay.js";
import {
  RuntimeProxyLoopbackAdapter,
  type RuntimeProxyLoopbackCaMaterial,
} from "../runtime/runtime-proxy-loopback-adapter.js";
import {
  buildRuntimeProxyEnvironment,
  type RuntimeProxyExecutionLayout,
  renderRuntimeProxyGitCredentialHelper,
} from "../runtime/runtime-proxy-material.js";
import {
  CLOUD_CONNECT_PROXY_PORT,
  CLOUD_EXECUTION_MOUNT,
  CLOUD_SANDBOX_CA_FILE,
  CLOUD_SANDBOX_CA_PROGRAM,
  CLOUD_SANDBOX_ENTRY_PROGRAM,
  CLOUD_SLACK_API_PORT,
} from "./sandbox-entry.js";

const IMAGE = /^(?:[a-zA-Z0-9][a-zA-Z0-9_.:/-]*)(?:@sha256:[a-f0-9]{64})?$/;
const MAX_PROXY_SOCKETS = 64;
const MAX_PIPE_BYTES = 4 * 1024 * 1024;
const SOCKET_PATH_MAX_BYTES = 100;

export interface CloudSandboxCommandOptions {
  /** Trusted deployment image selection, not a value read from Agent content. */
  image: string;
  workspace: string;
  command: readonly [string, ...string[]];
  signal?: AbortSignal;
  /** Defaults to direct inherited stdio, preserving native command semantics. */
  stdio?: "inherit" | "pipe";
}

export interface CloudSandboxCredentialBridgeOpenOptions extends RuntimeCredentialRelayOptions {
  readonly subject: RuntimeCredentialExecutionSubject;
  readonly temporaryRoot?: string;
  /** Host cancellation; an already-aborted signal never allocates execution material. */
  readonly signal?: AbortSignal;
  /** Client-owned CA seam; production uses the per-execution OpenSSL CA. */
  readonly generateCa?: (materialDir: string) => Promise<RuntimeProxyLoopbackCaMaterial>;
  /** Test seam. Production always requires the real Linux platform. */
  readonly platform?: NodeJS.Platform;
  /** Test seam. Production always spawns the real Docker CLI. */
  readonly spawnProcess?: typeof spawn;
}

interface BridgeResources {
  adapter?: RuntimeProxyLoopbackAdapter;
  readonly closing: { value: boolean };
  readonly directory: string;
  public?: string;
  relay?: RuntimeCredentialRelay;
  readonly servers: Server[];
  readonly sockets: Set<Socket>;
}

interface ReadyBridgeResources extends BridgeResources {
  adapter: RuntimeProxyLoopbackAdapter;
  public: string;
  relay: RuntimeCredentialRelay;
}

/**
 * Trusted Linux Runner entry for one Cloud execution. The relay and control token remain outside
 * the Agent container; only an execution-specific socket directory is mounted into the container.
 * This is a command execution boundary for the Cloud orchestrator, not a Local daemon trust mode.
 */
export class CloudSandboxCredentialBridge {
  readonly #containerName: string;
  readonly #public: string;
  readonly #relay: RuntimeCredentialRelay;
  readonly #resources: ReadyBridgeResources;
  readonly #spawnProcess: typeof spawn;
  #child?: ChildProcess;
  #closed = false;
  #closePromise?: Promise<void>;
  #containerExited = false;
  #containerStopped = false;
  #ran = false;

  private constructor(resources: ReadyBridgeResources, spawnProcess: typeof spawn) {
    this.#resources = resources;
    this.#public = resources.public;
    this.#relay = resources.relay;
    this.#containerName = `opentag-execution-${resources.relay.executionId}`;
    this.#spawnProcess = spawnProcess;
  }

  get executionId(): string {
    return this.#relay.executionId;
  }

  get signal(): AbortSignal {
    return this.#relay.signal;
  }

  /** Only this subdirectory is Sandbox-visible. Never mount the containing trusted directory. */
  get publicMountPath(): string {
    return this.#public;
  }

  static async open(options: CloudSandboxCredentialBridgeOpenOptions): Promise<CloudSandboxCredentialBridge> {
    if ((options.platform ?? process.platform) !== "linux") {
      throw new Error("The Cloud credential bridge requires a Linux trusted Runner");
    }
    if (!options.subject.sandbox) throw new Error("Cloud execution requires Server-assigned Sandbox facts");
    options.signal?.throwIfAborted();

    const directory = await createBridgeDirectory(options.temporaryRoot);
    const resources: BridgeResources = { closing: { value: false }, directory, servers: [], sockets: new Set() };
    try {
      const relay = await RuntimeCredentialRelay.open(options, options.subject, options.signal);
      resources.relay = relay;
      options.signal?.throwIfAborted();
      resources.adapter = await RuntimeProxyLoopbackAdapter.start({
        executionId: relay.executionId,
        ...(options.generateCa ? { generateCa: options.generateCa } : {}),
        ...(options.logger ? { logger: options.logger } : {}),
        localHandleFor: (provider) =>
          relay.providers.some((entry) => entry.provider === provider) ? relay.localHandleFor(provider) : undefined,
        materialDir: join(directory, "private"),
        openStream: (request) => relay.openProviderStream(request),
        verifyHandle: (provider, handle) => relay.verifyLocalHandle(provider, handle),
      });
      resources.public = await publishBridgeMaterial(resources);
      const bridge = new CloudSandboxCredentialBridge(resources as ReadyBridgeResources, options.spawnProcess ?? spawn);
      const abort = () => void bridge.close();
      relay.signal.addEventListener("abort", abort, { once: true });
      options.signal?.addEventListener("abort", abort, { once: true });
      if (relay.signal.aborted || options.signal?.aborted) {
        await bridge.close();
        throw new Error("Cloud execution was aborted while opening");
      }
      return bridge;
    } catch (error) {
      await disposeBridgeResources(resources);
      throw error;
    }
  }

  /** Deployment controller executes this argument vector. No token, Agent shell, host HOME, or Docker socket enters it. */
  async dockerArguments(options: CloudSandboxCommandOptions): Promise<string[]> {
    if (this.#closed || this.signal.aborted) throw new Error("Cloud execution is unavailable");
    if (!IMAGE.test(options.image)) throw new Error("Cloud execution image is invalid");
    const workspace = await assertSandboxWorkspace(options.workspace, this.#resources);
    return [
      "run",
      "-i",
      "--rm",
      "--init",
      "--name",
      this.#containerName,
      "--user",
      "10000:10000",
      "--network",
      "none",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges",
      "--read-only",
      "--pids-limit",
      "128",
      "--memory",
      "1g",
      "--cpus",
      "2",
      "--tmpfs",
      "/tmp:rw,nosuid,nodev,size=128m,uid=10000,gid=10000,mode=1777",
      "--tmpfs",
      "/home/runner:rw,nosuid,nodev,size=64m,uid=10000,gid=10000,mode=700",
      "--mount",
      `type=bind,src=${workspace},dst=/workspace`,
      "--mount",
      `type=bind,src=${this.#public},dst=${CLOUD_EXECUTION_MOUNT},readonly`,
      "--workdir",
      "/workspace",
      "--entrypoint",
      "node",
      options.image,
      `${CLOUD_EXECUTION_MOUNT}/entry.mjs`,
      ...options.command,
    ];
  }

  /** Exactly one command lifetime per execution; control loss kills the container and never replays it. */
  async run(options: CloudSandboxCommandOptions): Promise<{ code: number; stdout?: string; stderr?: string }> {
    if (this.#ran) throw new Error("A Cloud execution cannot be replayed");
    this.#ran = true;
    try {
      return await this.#execute(options);
    } catch (error) {
      // An aborted or invalid single-shot execution is over: release the trusted material.
      await this.close().catch(() => undefined);
      throw error;
    }
  }

  async #execute(options: CloudSandboxCommandOptions): Promise<{ code: number; stdout?: string; stderr?: string }> {
    const signal = options.signal ? AbortSignal.any([this.signal, options.signal]) : this.signal;
    signal.throwIfAborted();
    const args = await this.dockerArguments(options);
    const piped = options.stdio === "pipe";
    const child = this.#spawnProcess("docker", args, {
      stdio: piped ? ["ignore", "pipe", "pipe"] : "inherit",
      env: { PATH: process.env.PATH },
    });
    this.#child = child;
    this.#containerExited = false;
    const stop = () => this.#stopContainer();
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
    const capture = captureDockerOutput(child, stop);
    try {
      const code = await waitForDockerExit(child);
      this.#containerExited = true;
      return { code, ...(piped ? capture.snapshot() : {}) };
    } finally {
      signal.removeEventListener("abort", stop);
      await this.close();
    }
  }

  async close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closed = true;
    this.#stopContainer();
    this.#closePromise = disposeBridgeResources(this.#resources);
    return this.#closePromise;
  }

  #stopContainer(): void {
    const child = this.#child;
    if (!child || this.#containerStopped || this.#containerExited) return;
    this.#containerStopped = true;
    const kill = this.#spawnProcess("docker", ["kill", this.#containerName], {
      stdio: "ignore",
      env: { PATH: process.env.PATH },
    });
    kill.on("error", () => child.kill("SIGTERM"));
  }
}

/** Public per-execution material only: handles, public CA, CLI config, and opaque local endpoints. */
async function publishBridgeMaterial(resources: BridgeResources): Promise<string> {
  const adapter = resources.adapter;
  const relay = resources.relay;
  if (!adapter || !relay) throw new Error("Cloud execution material cannot be published");
  const published = join(resources.directory, "public");
  await mkdir(published, { mode: 0o755 });
  const caFile = join(published, CLOUD_SANDBOX_CA_FILE);
  await copyFile(adapter.caCertPath, caFile);
  await chmod(caFile, 0o444);
  await listenProxySocket(resources, "connect", adapter.connectProxyUrl, join(published, "connect.sock"));
  await listenProxySocket(resources, "slack", adapter.slackApiHost, join(published, "slack.sock"));
  const handles = new Map(relay.providers.map((entry) => [entry.provider, relay.localHandleFor(entry.provider)]));
  const layout: RuntimeProxyExecutionLayout = {
    adapterCaCertPath: `${CLOUD_EXECUTION_MOUNT}/${CLOUD_SANDBOX_CA_FILE}`,
    executionDir: CLOUD_EXECUTION_MOUNT,
    gitCredentialHelperPath: `${CLOUD_EXECUTION_MOUNT}/git-credential-helper`,
    gitConfigPath: `${CLOUD_EXECUTION_MOUNT}/gitconfig`,
    larkConfigDir: "/tmp/opentag/lark",
    slackConfigDir: "/tmp/opentag/slack",
  };
  const environment = buildRuntimeProxyEnvironment({
    adapterCaCertPath: layout.adapterCaCertPath,
    cliMetadata: (provider) => relay.cliMetadataFor(provider),
    connectProxyUrl: `http://127.0.0.1:${CLOUD_CONNECT_PROXY_PORT}`,
    handles,
    layout,
    slackApiHost: `https://127.0.0.1:${CLOUD_SLACK_API_PORT}`,
  });
  await writePublicFile(
    join(published, "environment.json"),
    JSON.stringify({ executionId: relay.executionId, environment }),
  );
  await writePublicFile(join(published, "entry.mjs"), CLOUD_SANDBOX_ENTRY_PROGRAM);
  await writePublicFile(join(published, "sandbox-ca.mjs"), CLOUD_SANDBOX_CA_PROGRAM);
  await writePublicFile(join(published, "gitconfig"), "");
  await writePublicFile(
    join(published, "git-credential-helper"),
    renderRuntimeProxyGitCredentialHelper(handles.get("github") ?? "unavailable"),
    0o555,
  );
  await mkdir(join(published, "bin"), { mode: 0o755 });
  await writePublicFile(
    join(published, "bin", "slack"),
    `#!/bin/sh\nexec /opt/opentag/tools/bin/slack --apihost https://127.0.0.1:${CLOUD_SLACK_API_PORT} "$@"\n`,
    0o555,
  );
  return published;
}

async function listenProxySocket(
  resources: BridgeResources,
  name: string,
  endpoint: string,
  socketPath: string,
): Promise<void> {
  const target = new URL(endpoint);
  const port = Number(target.port);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) throw new Error("Invalid loopback endpoint");
  if (Buffer.byteLength(socketPath) > SOCKET_PATH_MAX_BYTES) {
    throw new Error(`The trusted ${name} socket path is too long`);
  }
  const server = createServer();
  server.on("connection", (client) => proxyLoopbackConnection(client, port, resources));
  resources.servers.push(server);
  server.listen(socketPath);
  await once(server, "listening");
  await chmod(socketPath, 0o666);
}

/** Bridges one in-container loopback connection to the trusted per-execution Unix socket. */
function proxyLoopbackConnection(client: Socket, port: number, resources: BridgeResources): void {
  resources.sockets.add(client);
  client.once("close", () => resources.sockets.delete(client));
  if (resources.closing.value || resources.sockets.size > MAX_PROXY_SOCKETS) {
    client.destroy();
    return;
  }
  const remote = connect({ host: "127.0.0.1", port });
  resources.sockets.add(remote);
  const close = () => {
    client.destroy();
    remote.destroy();
    resources.sockets.delete(client);
    resources.sockets.delete(remote);
  };
  client.once("error", close);
  remote.once("error", close);
  client.once("close", close);
  remote.once("close", close);
  client.pipe(remote);
  remote.pipe(client);
}

async function createBridgeDirectory(temporaryRoot?: string): Promise<string> {
  const root = await realpath(temporaryRoot ?? tmpdir());
  const directory = await mkdtemp(join(root, "ot-bridge-"));
  if (/[,:\n\r]/.test(directory)) throw new Error("Unsafe bridge directory path");
  await chmod(directory, 0o700);
  return directory;
}

/** A dedicated workspace must never expose the trusted bridge directory or the host HOME. */
async function assertSandboxWorkspace(workspace: string, resources: BridgeResources): Promise<string> {
  const resolved = await realpath(workspace);
  if (!(await lstat(resolved)).isDirectory()) throw new Error("A dedicated Sandbox workspace is required");
  const home = resolve(process.env.HOME ?? "/");
  if (resolved === "/" || resolved === home) throw new Error("A dedicated Sandbox workspace is required");
  for (const trusted of [resources.directory, resources.public]) {
    if (!trusted) continue;
    if (isSameOrWithin(resolved, trusted) || isSameOrWithin(trusted, resolved)) {
      throw new Error("The Sandbox workspace must not contain trusted execution material");
    }
  }
  if (/[,:\n\r]/.test(resolved)) throw new Error("Unsafe container mount path");
  return resolved;
}

function isSameOrWithin(parent: string, child: string): boolean {
  return child === parent || child.startsWith(`${parent}${sep}`);
}

async function writePublicFile(path: string, content: string, mode = 0o444): Promise<void> {
  await writeFile(path, content, { mode });
  await chmod(path, mode);
}

function captureDockerOutput(
  child: ChildProcess,
  onOverflow: () => void,
): { snapshot(): { stderr: string; stdout: string } } {
  let stdout = "";
  let stderr = "";
  let bytes = 0;
  let overflowed = false;
  const append = (target: "stdout" | "stderr", chunk: Buffer) => {
    bytes += chunk.byteLength;
    if (bytes > MAX_PIPE_BYTES) {
      if (!overflowed) {
        overflowed = true;
        onOverflow();
      }
      return;
    }
    if (target === "stdout") stdout += chunk.toString();
    else stderr += chunk.toString();
  };
  child.stdout?.on("data", (chunk: Buffer) => append("stdout", chunk));
  child.stderr?.on("data", (chunk: Buffer) => append("stderr", chunk));
  return { snapshot: () => ({ stdout, stderr }) };
}

function waitForDockerExit(child: ChildProcess): Promise<number> {
  return new Promise((resolve) => {
    child.once("error", () => resolve(127));
    child.once("close", (code) => resolve(typeof code === "number" ? code : 1));
  });
}

async function disposeBridgeResources(resources: BridgeResources): Promise<void> {
  resources.closing.value = true;
  for (const socket of [...resources.sockets]) socket.destroy();
  resources.sockets.clear();
  await Promise.all(resources.servers.map((server) => new Promise<void>((done) => server.close(() => done()))));
  await resources.adapter?.close().catch(() => undefined);
  await resources.relay?.close("cloud_bridge_closed").catch(() => undefined);
  await rm(resources.directory, { recursive: true, force: true }).catch(() => undefined);
}
