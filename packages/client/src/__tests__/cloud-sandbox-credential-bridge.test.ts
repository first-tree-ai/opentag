import type { ChildProcess, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { PassThrough } from "node:stream";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";

// Real per-execution OpenSSL CA generation needs headroom under parallel CI load.
vi.setConfig({ testTimeout: 30_000 });

import { CLOUD_SANDBOX_CA_DESTINATION, CLOUD_SANDBOX_CA_PROGRAM } from "../cloud-runtime/sandbox-entry.js";
import { CloudSandboxCredentialBridge } from "../index.js";
import type { RuntimeBusinessFrame, RuntimeConnectionState } from "../runtime/runtime-connection.js";
import type { RuntimeProxyDataConnectionLike } from "../runtime/runtime-credential-relay.js";
import type { RuntimeProxyStreamResponse } from "../runtime/runtime-proxy-data-client.js";
import { RUNTIME_PROXY_PROVIDER_CA_KEY, RUNTIME_PROXY_PROVIDER_URL_KEY } from "../runtime/runtime-proxy-material.js";

const CAPABILITY = "c".repeat(43);
const TICKET = "t".repeat(43);
const EXECUTION_ID = "11111111-1111-4111-8111-111111111111";
const GRANT_IDS = {
  github: "22222222-2222-4222-8222-222222222222",
  slack: "33333333-3333-4333-8333-333333333333",
};
const homes: string[] = [];
const bridges: CloudSandboxCredentialBridge[] = [];

afterEach(async () => {
  await Promise.all(bridges.splice(0).map((bridge) => bridge.close().catch(() => undefined)));
  await Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true })));
});

const tick = async (times = 4): Promise<void> => {
  for (let index = 0; index < times; index += 1) await Promise.resolve();
};

class FakeControlConnection {
  readonly requests: Array<Record<string, unknown>> = [];
  #business = new Set<(frame: RuntimeBusinessFrame) => void>();
  #states = new Set<(state: RuntimeConnectionState) => void>();

  capabilityVersion(): number {
    return 1;
  }

  async send(frame: RuntimeBusinessFrame): Promise<void> {
    this.requests.push({ ...frame });
    const response = this.#respond(frame);
    if (response === undefined) return;
    queueMicrotask(() => this.emit(response));
  }

  subscribeBusinessFrames(listener: (frame: RuntimeBusinessFrame) => void): () => void {
    this.#business.add(listener);
    return () => this.#business.delete(listener);
  }

  subscribeState(listener: (state: RuntimeConnectionState) => void): () => void {
    this.#states.add(listener);
    return () => this.#states.delete(listener);
  }

  emit(frame: RuntimeBusinessFrame): void {
    for (const listener of [...this.#business]) listener(frame);
  }

  emitState(state: RuntimeConnectionState): void {
    for (const listener of [...this.#states]) listener(state);
  }

  #respond(frame: RuntimeBusinessFrame): RuntimeBusinessFrame | undefined {
    if (frame.type === "runtime:execution:open") {
      return {
        type: "runtime:execution:result",
        requestId: frame.requestId,
        status: "succeeded",
        executionId: EXECUTION_ID,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        providers: [
          {
            provider: "github",
            bindingId: "binding-github",
            cli: { provider: "github", connectionId: "connection-1", repositories: [] },
          },
          { provider: "slack", bindingId: "binding-slack", cli: { provider: "slack", teamId: "T1", botUserId: "U1" } },
        ],
      } as RuntimeBusinessFrame;
    }
    if (frame.type === "runtime:credential:acquire") {
      const provider = frame.provider as "github" | "slack";
      return {
        type: "runtime:credential:result",
        requestId: frame.requestId,
        status: "succeeded",
        executionId: EXECUTION_ID,
        grantId: GRANT_IDS[provider],
        provider,
        bindingId: `binding-${provider}`,
        opaqueToken: CAPABILITY,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        refreshAfter: new Date(Date.now() + 30_000).toISOString(),
        scopeHash: "a".repeat(64),
        authorizationRevision: "rev-1",
        credentialGeneration: "gen-1",
        cli:
          provider === "github"
            ? { provider: "github", connectionId: "connection-1", repositories: [] }
            : { provider: "slack", teamId: "T1", botUserId: "U1" },
      } as RuntimeBusinessFrame;
    }
    if (frame.type === "runtime:proxy:ticket") {
      return {
        type: "runtime:proxy:ticket:result",
        requestId: frame.requestId,
        status: "succeeded",
        executionId: EXECUTION_ID,
        ticket: TICKET,
        expiresAt: new Date(Date.now() + 15_000).toISOString(),
        path: "/api/v1/runtime/provider-proxy",
      } as RuntimeBusinessFrame;
    }
    if (frame.type === "runtime:execution:close") {
      return {
        type: "runtime:execution:closed",
        requestId: frame.requestId,
        executionId: EXECUTION_ID,
        status: "succeeded",
      } as RuntimeBusinessFrame;
    }
    return undefined;
  }
}

class FakeDataConnection implements RuntimeProxyDataConnectionLike {
  closed = false;
  #settle!: () => void;
  readonly #settled = new Promise<void>((resolve) => {
    this.#settle = resolve;
  });

  async close(): Promise<void> {
    this.closed = true;
    this.#settle();
  }

  settled(): Promise<void> {
    return this.#settled;
  }

  async openStream(): Promise<RuntimeProxyStreamResponse> {
    return {
      status: 200,
      headers: { "content-type": "text/plain" },
      body: (async function* () {
        yield new TextEncoder().encode("ok");
      })(),
    };
  }
}

class FakeDockerChild extends EventEmitter {
  readonly stderr?: PassThrough;
  readonly stdout?: PassThrough;
  #exitEmitted = false;

  constructor(piped: boolean) {
    super();
    if (piped) {
      this.stdout = new PassThrough();
      this.stderr = new PassThrough();
    }
  }

  kill(signal?: NodeJS.Signals): boolean {
    this.exit(143, signal);
    return true;
  }

  exit(code: number, signal?: string): void {
    if (this.#exitEmitted) return;
    this.#exitEmitted = true;
    this.emit("close", code, signal);
  }
}

interface DockerCall {
  args: string[];
  command: string;
  options: { stdio?: string | string[] };
}

function fakeDocker() {
  const calls: DockerCall[] = [];
  let running: FakeDockerChild | undefined;
  const spawnProcess = ((command: string, args: string[], options: DockerCall["options"]) => {
    calls.push({ args, command, options });
    if (args[0] === "kill") {
      const killChild = new FakeDockerChild(false);
      queueMicrotask(() => running?.exit(137, "SIGKILL"));
      killChild.exit(0);
      return killChild as unknown as ChildProcess;
    }
    running = new FakeDockerChild(Array.isArray(options.stdio) && options.stdio[1] === "pipe");
    return running as unknown as ChildProcess;
  }) as unknown as typeof spawn;
  return { calls, running: () => running, spawnProcess };
}

interface BridgeHarness {
  bridge: CloudSandboxCredentialBridge;
  connection: FakeControlConnection;
  docker: ReturnType<typeof fakeDocker>;
  root: string;
  workspace: string;
}

/** Short real path keeps Unix socket names under the 100-byte platform bound. */
async function temporaryRoot(prefix = "otb-"): Promise<string> {
  const root = await mkdtemp(join("/tmp", prefix));
  homes.push(root);
  return root;
}

async function openBridge(options?: {
  generateCa?: Parameters<typeof CloudSandboxCredentialBridge.open>[0]["generateCa"];
  signal?: AbortSignal;
  spawnProcess?: typeof spawn;
}): Promise<BridgeHarness> {
  const root = await temporaryRoot();
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const connection = new FakeControlConnection();
  const dataConnection = new FakeDataConnection();
  const docker = fakeDocker();
  const bridge = await CloudSandboxCredentialBridge.open({
    connection,
    dataConnectionFactory: async () => dataConnection,
    platform: "linux",
    serverUrl: "https://runtime.example",
    spawnProcess: options?.spawnProcess ?? docker.spawnProcess,
    subject: {
      agentId: "agent-1",
      placementGeneration: 1,
      runId: "44444444-4444-4444-8444-444444444444",
      sessionId: "session-1",
      sandbox: {
        sandboxId: "55555555-5555-4555-8555-555555555555",
        resourceUid: "sandbox-1",
        environmentGeneration: 1,
      },
      source: { kind: "delivery", deliveryId: "delivery-1", turnId: "66666666-6666-4666-8666-666666666666" },
    },
    temporaryRoot: root,
    ...(options?.generateCa ? { generateCa: options.generateCa } : {}),
    ...(options?.signal ? { signal: options.signal } : {}),
  });
  bridges.push(bridge);
  return { bridge, connection, docker, root, workspace };
}

/** `run` awaits fs checks before spawning Docker; wait for the fake child deterministically. */
async function awaitDockerRun(harness: BridgeHarness): Promise<FakeDockerChild> {
  await vi.waitFor(() => {
    if (!harness.docker.running()) throw new Error("docker run has not started");
  });
  const child = harness.docker.running();
  if (!child) throw new Error("docker run has not started");
  return child;
}

function command(
  workspace: string,
  image = "node:24-slim",
  args: string[] = ["run", "check"],
): {
  image: string;
  workspace: string;
  command: readonly [string, ...string[]];
} {
  return { image, workspace, command: args as [string, ...string[]] };
}

const RUNNER_CONTAINER_TMPFS = "/home/runner:rw,nosuid,nodev,size=64m,uid=10000,gid=10000,mode=700";

interface DockerMount {
  readonly destination: string;
  readonly readonly: boolean;
  readonly source: string;
  readonly type: string;
}

/**
 * Parse `--mount` specifications so host sources are inspected separately from container
 * destinations. On CI the runner HOME (`/home/runner`) legitimately equals the empty container
 * tmpfs destination, but must never appear as a host bind source.
 */
function dockerMounts(args: readonly string[]): DockerMount[] {
  const mounts: DockerMount[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "--mount") continue;
    const fields = (args[index + 1] ?? "").split(",");
    const value = (key: string): string =>
      fields.find((field) => field.startsWith(`${key}=`))?.slice(key.length + 1) ?? "";
    mounts.push({
      destination: value("dst"),
      readonly: fields.includes("readonly"),
      source: value("src"),
      type: value("type"),
    });
  }
  return mounts;
}

function volumeBypassViolations(args: readonly string[]): string[] {
  const violations: string[] = [];
  for (const arg of args) {
    if (arg === "-v" || arg === "--volume") violations.push(`volume bypass: ${arg}`);
  }
  return violations;
}

function forbiddenBindViolation(
  source: string,
  input: { readonly hostHome: string; readonly privateDirectory: string },
): string | undefined {
  if (source === input.hostHome || source.startsWith(`${input.hostHome}${sep}`)) {
    return `host HOME bind: ${source}`;
  }
  if (source === input.privateDirectory || source.startsWith(`${input.privateDirectory}${sep}`)) {
    return `private control bind: ${source}`;
  }
  if (basename(source) === "docker.sock") return `docker socket bind: ${source}`;
  return undefined;
}

/**
 * Empty violations mean the argument vector keeps host material outside the container boundary.
 * This inspects bind sources and volume flags structurally instead of matching the whole argv, so
 * a legitimate container destination equal to the runner HOME cannot mask a real host bind.
 */
function hardenedArgvViolations(input: {
  readonly args: readonly string[];
  readonly hostHome: string;
  readonly privateDirectory: string;
  readonly publicMount: string;
  readonly workspace: string;
}): string[] {
  const violations = volumeBypassViolations(input.args);
  const allowedSources = new Set([input.workspace, input.publicMount]);
  for (const mount of dockerMounts(input.args)) {
    if (mount.type !== "bind") violations.push(`non-bind mount: ${mount.type || "unspecified"}`);
    if (!allowedSources.has(mount.source)) violations.push(`bind source outside the allowlist: ${mount.source}`);
    if (mount.source === input.publicMount && !mount.readonly) violations.push("public directory must stay readonly");
    const forbidden = forbiddenBindViolation(mount.source, input);
    if (forbidden) violations.push(forbidden);
  }
  if (!input.args.includes(RUNNER_CONTAINER_TMPFS)) violations.push("container runner tmpfs is missing");
  return violations;
}

describe("CloudSandboxCredentialBridge trust boundary", () => {
  it("publishes only public per-execution material and keeps the private CA outside it", async () => {
    const harness = await openBridge();
    const publicDir = harness.bridge.publicMountPath;
    const entries = await readdir(publicDir);
    expect(entries.sort()).toEqual(
      [
        "bin",
        "ca.pem",
        "connect.sock",
        "entry.mjs",
        "environment.json",
        "git-credential-helper",
        "gitconfig",
        "sandbox-ca.mjs",
        "slack.sock",
      ].sort(),
    );
    const environmentFile = JSON.parse(await readFile(join(publicDir, "environment.json"), "utf8")) as {
      executionId: string;
      environment: Record<string, string>;
    };
    expect(environmentFile.executionId).toBe(EXECUTION_ID);
    expect(environmentFile.environment.GH_TOKEN).toMatch(/^otrh_/);
    expect(environmentFile.environment.SLACK_BOT_TOKEN).toMatch(/^otrh_/);
    // The manifest publishes only the execution-scoped routing inputs; the Agent runtime
    // environment never receives a global proxy or the execution CA.
    expect(environmentFile.environment[RUNTIME_PROXY_PROVIDER_URL_KEY]).toBe("http://127.0.0.1:18080");
    expect(environmentFile.environment[RUNTIME_PROXY_PROVIDER_CA_KEY]).toBe("/run/opentag-execution/ca.pem");
    for (const key of ["HTTPS_PROXY", "https_proxy", "NO_PROXY", "no_proxy", "SSL_CERT_FILE", "GIT_SSL_CAINFO"]) {
      expect(environmentFile.environment).not.toHaveProperty(key);
    }
    const serialized = JSON.stringify(environmentFile);
    expect(serialized).not.toContain(CAPABILITY);
    expect(serialized).not.toContain(TICKET);
    expect(serialized).not.toContain("Bearer ");
    expect(serialized).not.toContain("GH_REPO");
    expect(serialized).not.toContain("GITHUB_TOKEN");

    // The CA key stays in the trusted private directory; only the public cert is Sandbox-visible.
    const privateDir = join(dirname(publicDir), "private");
    expect((await readdir(privateDir)).some((entry) => entry.includes("key"))).toBe(true);
    expect(entries.some((entry) => entry.includes("key"))).toBe(false);
    expect((await stat(join(publicDir, "ca.pem"))).mode & 0o777).toBe(0o444);
    expect((await stat(publicDir)).mode & 0o777 & 0o022).toBe(0);
    expect((await stat(dirname(publicDir))).mode & 0o777).toBe(0o700);

    // The entry program listens on exactly the ports the published environment targets.
    const entry = await readFile(join(publicDir, "entry.mjs"), "utf8");
    expect(entry).toContain("18080");
    expect(entry).toContain("18443");
    expect(entry).toContain("/run/opentag-execution");

    // Provider launchers scope routing/trust to their own process; Git reads the host-scoped
    // configuration instead of any ambient proxy.
    const gitConfig = await readFile(join(publicDir, "gitconfig"), "utf8");
    expect(gitConfig).toContain('[http "https://github.com"]');
    expect(gitConfig).toContain("proxy = http://127.0.0.1:18080");
    expect(gitConfig).toContain("sslCAInfo = /run/opentag-execution/ca.pem");
    const gh = await readFile(join(publicDir, "bin", "gh"), "utf8");
    const slack = await readFile(join(publicDir, "bin", "slack"), "utf8");
    expect(gh).toContain("opentag-runtime-proxy-launcher");
    for (const launcher of [gh, slack]) {
      expect(launcher).toContain("OPENTAG_PROVIDER_PROXY_URL");
      expect(launcher).toContain("OPENTAG_PROVIDER_CA_PATH");
    }
    expect(slack).toContain("--apihost https://127.0.0.1:18443");

    // The generated entry prepares the Sandbox-owned CA copy from the read-only public mount.
    expect(entry).toContain("prepareSandboxCa");
    expect(entry).toContain(CLOUD_SANDBOX_CA_DESTINATION);
    expect(await readFile(join(publicDir, "sandbox-ca.mjs"), "utf8")).toBe(CLOUD_SANDBOX_CA_PROGRAM);
  });

  it("copies the public CA to a Sandbox-owned 0600 file and rewrites every CA path", async () => {
    const root = await temporaryRoot("otb-ca-");
    const mount = join(root, "mount");
    const destination = join(root, "home", ".opentag", "ca.pem");
    await mkdir(mount, { mode: 0o755 });
    const source = join(mount, "ca.pem");
    const pem = "-----BEGIN CERTIFICATE-----\npublic-ca\n-----END CERTIFICATE-----\n";
    await writeFile(source, pem, { mode: 0o444 });
    const sourceStat = await stat(source);
    const modulePath = join(root, "sandbox-ca.mjs");
    await writeFile(modulePath, CLOUD_SANDBOX_CA_PROGRAM, { mode: 0o444 });

    const { prepareSandboxCa } = (await import(pathToFileURL(modulePath).href)) as {
      prepareSandboxCa(input: { destination: string; environment: Record<string, string>; mount: string }): {
        destination: string;
        environment: Record<string, string>;
      };
    };
    const prepared = prepareSandboxCa({
      destination,
      environment: {
        CURL_CA_BUNDLE: source,
        GIT_SSL_CAINFO: source,
        LARKSUITE_CLI_CA_PATH: source,
        NODE_EXTRA_CA_CERTS: source,
        OPENTAG_PROVIDER_CA_PATH: source,
        RETAINED: "/etc/ssl/certs/ca-certificates.crt",
        SSL_CERT_FILE: source,
        UNRELATED: "keep",
      },
      mount,
    });

    expect(prepared.destination).toBe(destination);
    expect(prepared.environment).toEqual({
      CURL_CA_BUNDLE: destination,
      GIT_SSL_CAINFO: destination,
      LARKSUITE_CLI_CA_PATH: destination,
      NODE_EXTRA_CA_CERTS: destination,
      OPENTAG_PROVIDER_CA_PATH: destination,
      RETAINED: "/etc/ssl/certs/ca-certificates.crt",
      SSL_CERT_FILE: destination,
      UNRELATED: "keep",
    });
    const copied = await stat(destination);
    expect(copied.mode & 0o777).toBe(0o600);
    // The copy is owned by the uid that runs the entry (10000 in the Sandbox), not root.
    expect(typeof process.getuid).toBe("function");
    expect(copied.uid).toBe(process.getuid?.());
    expect((await stat(dirname(destination))).mode & 0o777).toBe(0o700);
    expect(await readFile(destination, "utf8")).toBe(pem);
    // The read-only public mount is never mutated by the Sandbox copy step.
    expect(await readFile(source, "utf8")).toBe(pem);
    expect((await stat(source)).mtimeMs).toBe(sourceStat.mtimeMs);
  });

  it("builds a hardened Docker argv with -i, no control material, and one readonly public mount", async () => {
    const harness = await openBridge();
    const args = await harness.bridge.dockerArguments(command(harness.workspace));
    expect(args[0]).toBe("run");
    const workspace = await realpath(harness.workspace);
    const privateDirectory = join(dirname(harness.bridge.publicMountPath), "private");
    expect(dockerMounts(args)).toEqual([
      { destination: "/workspace", readonly: false, source: workspace, type: "bind" },
      {
        destination: "/run/opentag-execution",
        readonly: true,
        source: harness.bridge.publicMountPath,
        type: "bind",
      },
    ]);
    expect(args).toContain("-i");
    expect(args[args.indexOf("--network") + 1]).toBe("none");
    expect(args[args.indexOf("--cap-drop") + 1]).toBe("ALL");
    expect(args[args.indexOf("--security-opt") + 1]).toBe("no-new-privileges");
    expect(args[args.indexOf("--user") + 1]).toBe("10000:10000");
    expect(args).toContain("--read-only");
    expect(args).toContain("--rm");
    expect(args[args.indexOf("--entrypoint") + 1]).toBe("node");
    expect(args[args.indexOf("--entrypoint") + 2]).toBe("node:24-slim");
    expect(args.at(-1)).toBe("check");
    expect(args.join("\n")).not.toContain(privateDirectory);
    // Only host bind sources must exclude the runner HOME and control material; the empty
    // container tmpfs destination is allowed to equal it.
    expect(
      hardenedArgvViolations({
        args,
        hostHome: process.env.HOME ?? "/nonexistent-home",
        privateDirectory,
        publicMount: harness.bridge.publicMountPath,
        workspace,
      }),
    ).toEqual([]);
    // The intended empty container HOME is present as a tmpfs, not as a host mount.
    expect(args).toContain(RUNNER_CONTAINER_TMPFS);
    expect(args.join("\n")).not.toContain("docker.sock");
  });

  it.each(["/home/runner", "/root"])(
    "keeps host HOME %s out of bind sources when it equals the container tmpfs destination",
    async (hostHome) => {
      const harness = await openBridge();
      const args = await harness.bridge.dockerArguments(command(harness.workspace));
      const boundary = {
        args,
        hostHome,
        privateDirectory: join(dirname(harness.bridge.publicMountPath), "private"),
        publicMount: harness.bridge.publicMountPath,
        workspace: await realpath(harness.workspace),
      };
      // `/home/runner` is both the CI runner HOME and the empty container tmpfs destination, so
      // the equality alone must not be treated as a leak.
      expect(hardenedArgvViolations(boundary)).toEqual([]);
      expect(args).toContain(RUNNER_CONTAINER_TMPFS);

      // A real host HOME bind, a volume bypass, control material, or the Docker socket still fail.
      expect(
        hardenedArgvViolations({
          ...boundary,
          args: [...args, "--mount", `type=bind,src=${hostHome}/.ssh,dst=/home/runner/.ssh,readonly`],
        }),
      ).toContain(`host HOME bind: ${hostHome}/.ssh`);
      expect(
        hardenedArgvViolations({ ...boundary, args: [...args, "--volume", `${hostHome}/.ssh:/home/runner/.ssh`] }),
      ).toContainEqual(expect.stringContaining("volume bypass"));
      expect(
        hardenedArgvViolations({
          ...boundary,
          args: [...args, "--mount", `type=bind,src=${boundary.privateDirectory},dst=/private,readonly`],
        }),
      ).toContain(`private control bind: ${boundary.privateDirectory}`);
      expect(
        hardenedArgvViolations({
          ...boundary,
          args: [...args, "--mount", "type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock"],
        }),
      ).toContain("docker socket bind: /var/run/docker.sock");
    },
  );

  it("rejects images, workspaces, and mount paths that would widen the boundary", async () => {
    const harness = await openBridge();
    await expect(harness.bridge.dockerArguments(command(harness.workspace, "../evil"))).rejects.toThrow("image");
    await expect(harness.bridge.dockerArguments(command("/"))).rejects.toThrow("dedicated");
    await expect(harness.bridge.dockerArguments(command(resolve(process.env.HOME ?? "/")))).rejects.toThrow(
      "dedicated",
    );
    await expect(harness.bridge.dockerArguments(command(join(harness.workspace, "missing")))).rejects.toThrow();
    await expect(harness.bridge.dockerArguments(command(resolve(harness.workspace, "..")))).rejects.toThrow("trusted");
    await expect(harness.bridge.dockerArguments(command(harness.bridge.publicMountPath))).rejects.toThrow("trusted");
    const file = join(harness.workspace, "file.txt");
    await writeFile(file, "not-a-directory");
    await expect(harness.bridge.dockerArguments(command(file))).rejects.toThrow("dedicated");
  });

  it("never allocates execution material for an already-aborted open signal", async () => {
    const root = await temporaryRoot("otb-abort-");
    const controller = new AbortController();
    controller.abort();
    await expect(openBridgeInto(root, controller.signal)).rejects.toThrow();
    expect((await readdir(root)).filter((entry) => entry.startsWith("ot-bridge-"))).toEqual([]);
  });

  it("cleans up a failed open and releases the execution", async () => {
    const root = await temporaryRoot("otb-fail-");
    const connection = new FakeControlConnection();
    const docker = fakeDocker();
    const bridge = CloudSandboxCredentialBridge.open({
      connection,
      dataConnectionFactory: async () => new FakeDataConnection(),
      generateCa: async () => {
        throw new Error("ca-generation-secret");
      },
      platform: "linux",
      serverUrl: "https://runtime.example",
      spawnProcess: docker.spawnProcess,
      subject: {
        agentId: "agent-1",
        placementGeneration: 1,
        runId: "44444444-4444-4444-8444-444444444444",
        sessionId: "session-1",
        sandbox: {
          sandboxId: "55555555-5555-4555-8555-555555555555",
          resourceUid: "sandbox-1",
          environmentGeneration: 1,
        },
        source: { kind: "delivery", deliveryId: "delivery-1", turnId: "66666666-6666-4666-8666-666666666666" },
      },
      temporaryRoot: root,
    });
    await expect(bridge).rejects.toThrow("ca-generation-secret");
    expect((await readdir(root)).filter((entry) => entry.startsWith("ot-bridge-"))).toEqual([]);
    expect(connection.requests.some((frame) => frame.type === "runtime:execution:close")).toBe(true);
  });
});

async function openBridgeInto(root: string, signal: AbortSignal): Promise<CloudSandboxCredentialBridge> {
  return CloudSandboxCredentialBridge.open({
    connection: new FakeControlConnection(),
    dataConnectionFactory: async () => new FakeDataConnection(),
    platform: "linux",
    serverUrl: "https://runtime.example",
    signal,
    subject: {
      agentId: "agent-1",
      placementGeneration: 1,
      runId: "44444444-4444-4444-8444-444444444444",
      sessionId: "session-1",
      sandbox: {
        sandboxId: "55555555-5555-4555-8555-555555555555",
        resourceUid: "sandbox-1",
        environmentGeneration: 1,
      },
      source: { kind: "delivery", deliveryId: "delivery-1", turnId: "66666666-6666-4666-8666-666666666666" },
    },
    temporaryRoot: root,
  });
}

describe("CloudSandboxCredentialBridge execution lifecycle", () => {
  it("runs exactly one piped command preserving stdout, stderr, and exit code", async () => {
    const harness = await openBridge();
    const run = harness.bridge.run({
      ...command(harness.workspace, "node:24-slim", ["printf", "hello"]),
      stdio: "pipe",
    });
    const child = await awaitDockerRun(harness);
    if (!child.stdout || !child.stderr) throw new Error("Expected piped child");
    child.stdout.write("hello");
    child.stderr.write("warn");
    child.exit(7);
    await expect(run).resolves.toEqual({ code: 7, stdout: "hello", stderr: "warn" });
    expect(harness.docker.calls).toHaveLength(1);
    expect(harness.docker.calls[0]?.options.stdio).toEqual(["ignore", "pipe", "pipe"]);
    // A replay never reaches Docker again.
    await expect(harness.bridge.run(command(harness.workspace))).rejects.toThrow("replayed");
    await expect(stat(harness.bridge.publicMountPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("inherits stdio by default so Docker -i keeps stdin attached", async () => {
    const harness = await openBridge();
    const run = harness.bridge.run(command(harness.workspace));
    const child = await awaitDockerRun(harness);
    child.exit(0);
    await expect(run).resolves.toEqual({ code: 0 });
    expect(harness.docker.calls[0]?.options.stdio).toBe("inherit");
    expect(harness.docker.calls[0]?.args).toContain("-i");
  });

  it("kills the container when the host signal aborts and still cleans up", async () => {
    const harness = await openBridge();
    const controller = new AbortController();
    const run = harness.bridge.run({ ...command(harness.workspace), signal: controller.signal });
    await awaitDockerRun(harness);
    controller.abort();
    await expect(run).resolves.toMatchObject({ code: 137 });
    expect(harness.docker.calls.some((call) => call.args[0] === "kill")).toBe(true);
    await expect(stat(harness.bridge.publicMountPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("kills the container when the trusted execution is revoked", async () => {
    const harness = await openBridge();
    const run = harness.bridge.run(command(harness.workspace));
    await awaitDockerRun(harness);
    harness.connection.emit({
      type: "runtime:credential:revoked",
      executionId: EXECUTION_ID,
      code: "connection_replaced",
    });
    await tick();
    await expect(run).resolves.toMatchObject({ code: 137 });
    expect(harness.docker.calls.some((call) => call.args[0] === "kill")).toBe(true);
    await expect(stat(harness.bridge.publicMountPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects an already-aborted run signal without spawning Docker", async () => {
    const harness = await openBridge();
    const controller = new AbortController();
    controller.abort();
    await expect(harness.bridge.run({ ...command(harness.workspace), signal: controller.signal })).rejects.toThrow();
    expect(harness.docker.calls).toEqual([]);
  });

  it("never runs after close and reports Docker spawn failures as exit 127", async () => {
    const harness = await openBridge();
    await harness.bridge.close();
    await expect(harness.bridge.run(command(harness.workspace))).rejects.toThrow(/unavailable|Relay is closing/);

    const broken = await openBridge();
    const failing = (() => {
      const child = new FakeDockerChild(false);
      queueMicrotask(() => child.emit("error", new Error("docker missing")));
      return child as unknown as ChildProcess;
    }) as unknown as typeof spawn;
    await broken.bridge.close();
    const reopened = await openBridge({ spawnProcess: failing });
    await expect(reopened.bridge.run(command(reopened.workspace))).resolves.toEqual({ code: 127 });
  });

  it("closes idempotently and tolerates concurrent close calls", async () => {
    const harness = await openBridge();
    await Promise.all([harness.bridge.close(), harness.bridge.close(), harness.bridge.close()]);
    expect(harness.bridge.signal.aborted).toBe(true);
    await expect(stat(harness.bridge.publicMountPath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(harness.bridge.dockerArguments(command(harness.workspace))).rejects.toThrow("unavailable");
  });
});
