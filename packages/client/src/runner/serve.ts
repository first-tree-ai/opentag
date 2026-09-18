import { createHash, randomInt, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RUNNER_CLOUD_DELIVERY_VERSION,
  RUNNER_WORKSPACE_VERSION,
  RUNNER_WS_PROTOCOL_VERSION,
  RunnerAcceptanceReportWireSchema,
  type RunnerAcceptanceRunFrame,
  type RunnerClientFrame,
  type RunnerServerFrame,
  RunnerServerFrameSchema,
  type RunnerWelcomeFrame,
  type RunnerWorkspaceSealFrame,
  type RuntimeCredentialServerFrame,
  serializeRunnerAcceptanceWorkerStdin,
} from "@opentag/shared";
import WebSocket, { type ClientOptions } from "ws";
import { CLOUD_EXECUTION_MOUNT } from "../cloud-runtime/sandbox-entry.js";
import type { CloudCredentialChannel } from "./cloud-credential-connection.js";
import { CloudJournal } from "./cloud-journal.js";
import { CloudTurnRunner, type CloudTurnRunnerOptions, type CloudTurnScope } from "./cloud-turns.js";
import { CloudWorkspace } from "./cloud-workspace.js";
import { type RunnerHealthListener, startRunnerHealthListener } from "./health.js";
import {
  NativeSandbox,
  NativeSandboxError,
  SANDBOX_NODE,
  SANDBOX_ROOTFS,
  SANDBOX_WORKER_ENTRY,
  type SandboxProbeResult,
} from "./native-sandbox.js";
import { redactAcceptanceRecord } from "./redact.js";
import { ServeWorkspace } from "./serve-workspace.js";
import {
  NativeSandboxWebGateway,
  type NativeWebExecutionAuthority,
  type NativeWebExecutionChannel,
} from "./web-gateway.js";

/**
 * Runner serve mode: the long-lived process a Cloud Run Instance runs. It launches the native
 * sandbox from the immutable image-built rootfs, dials the Server over an outbound WSS control
 * channel, authenticates with the first-frame bootstrap token, reports native readiness, and
 * executes bounded acceptance commands inside the sandbox (credentials via stdin only).
 *
 * Safety properties:
 * - TLS verification is never disabled; ws:// is accepted only for loopback integration tests.
 * - The bootstrap token lives in this process's env/memory only: never in sandbox env/argv/mounts,
 *   never logged.
 * - Reconnects are bounded; the runner never evicts another Session's runner (the Server scopes
 *   connections by sandbox and replaces only the same scope).
 * - Shutdown (signal or server close) always tears the sandbox down with `delete --force`, and
 *   deletion success is required for a clean exit.
 */

export interface RunnerServeConfig {
  readonly backendUrl: string;
  readonly bootstrapToken: string;
  readonly sandboxName: string;
  readonly workspace: string;
  /**
   * E4 trusted state root (durable delivery journal + per-turn credential bridge material).
   * Always outside the Session workspace and every Sandbox mount.
   */
  readonly stateDir: string;
  /** Declared platform container port for the startup probe; absent means no health listener. */
  readonly healthPort?: number;
  /** Set by a persistence-enabled Server; legacy E3 acceptance does not negotiate storage. */
  readonly workspacePersistence?: boolean;
  /**
   * Web tools opt-in: enable the fail-closed native web gateway boundary. Off by default; no
   * listener exists until a trusted parent execution opens its own dedicated channel.
   */
  readonly webTools?: boolean;
}

export interface RunnerServeOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly stderr: { write(chunk: string): void };
  readonly webSocketFactory?: (url: string, options: ClientOptions) => WebSocket;
  readonly sandboxFactory?: (name: string, workspace: string) => NativeSandbox;
  /** Test seam: immediate-return sleep and zero jitter. */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly randomJitter?: (maxExclusive: number) => number;
  readonly authTimeoutMs?: number;
  readonly maxReconnectAttempts?: number;
  readonly installSignalHandlers?: boolean;
  /** Graceful stop (the SIGTERM analog); production uses process signals, tests use this. */
  readonly signal?: AbortSignal;
  /** Test seam: capture the started web gateway for authority injection. */
  readonly onWebGateway?: (gateway: NativeSandboxWebGateway) => void;
  /**
   * Acceptance-harness seam: a trusted, Server-authorized execution authority supplied by the
   * caller. Production never sets it, so the gateway stays closed for business; no bootstrap
   * credential is ever treated as an authority.
   */
  readonly webAuthority?: NativeWebExecutionAuthority;
  /** Acceptance-harness observation of the opened per-execution channel descriptor. */
  readonly onWebExecution?: (channel: NativeWebExecutionChannel) => void;
  /**
   * Local acceptance harness seams for the Cloud Turn worker pipeline. Production never sets
   * these; the real native Sandbox/credential bridge path stays the only production execution.
   */
  readonly cloudTurnSeams?: Pick<CloudTurnRunnerOptions, "openExecution" | "runWorker">;
  readonly workspaceFetchImpl?: typeof fetch;
}

const DEFAULT_AUTH_TIMEOUT_MS = 5_000;
const PERSISTENT_AUTH_TIMEOUT_MS = 45_000;
const DEFAULT_MAX_RECONNECT_ATTEMPTS = 8;

function logLine(io: { write(chunk: string): void }, message: string): void {
  io.write(`[opentag-runner serve] ${message}\n`);
}

function isLoopbackHostname(hostname: string): boolean {
  const value = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return value === "localhost" || value === "::1" || (isIP(value) === 4 && value.startsWith("127."));
}

/** wss only outside loopback; TLS verification is the library default and is never relaxed. */
export function resolveRunnerBackendUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("OPENTAG_RUNNER_BACKEND_URL is not a valid URL");
  }
  if (url.protocol === "https:") url.protocol = "wss:";
  if (url.protocol === "ws:" && !isLoopbackHostname(url.hostname)) {
    throw new Error("OPENTAG_RUNNER_BACKEND_URL must use wss:// outside loopback");
  }
  if (url.protocol !== "wss:" && url.protocol !== "ws:") {
    throw new Error("OPENTAG_RUNNER_BACKEND_URL must be a WebSocket URL");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("OPENTAG_RUNNER_BACKEND_URL must not carry credentials, query, or fragment");
  }
  return url.toString();
}

export function loadRunnerServeConfig(env: NodeJS.ProcessEnv): RunnerServeConfig {
  const backendRaw = env.OPENTAG_RUNNER_BACKEND_URL;
  if (!backendRaw) throw new Error("OPENTAG_RUNNER_BACKEND_URL is required for serve mode");
  const token = env.OPENTAG_RUNNER_BOOTSTRAP_TOKEN;
  if (!token) throw new Error("OPENTAG_RUNNER_BOOTSTRAP_TOKEN is required for serve mode (env only, never argv)");
  const sandboxName = env.OPENTAG_RUNNER_SANDBOX_NAME ?? "ots-runner";
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(sandboxName)) {
    throw new Error("OPENTAG_RUNNER_SANDBOX_NAME is not a safe sandbox name");
  }
  const healthPort = parseRunnerHealthPort(env.PORT);
  const persistence = env.OPENTAG_RUNNER_WORKSPACE_PERSISTENCE;
  if (persistence !== undefined && persistence !== "1" && persistence !== "0") {
    throw new Error("OPENTAG_RUNNER_WORKSPACE_PERSISTENCE must be 1 or 0");
  }
  return {
    backendUrl: resolveRunnerBackendUrl(backendRaw),
    bootstrapToken: token,
    sandboxName,
    workspace: env.OPENTAG_RUNNER_WORKSPACE ?? join(tmpdir(), "opentag-runner-workspaces", sandboxName),
    stateDir: env.OPENTAG_RUNNER_STATE_DIR ?? defaultRunnerStateDir(sandboxName),
    ...(healthPort !== undefined ? { healthPort } : {}),
    ...(persistence === "1" ? { workspacePersistence: true } : {}),
    ...parseRunnerWebTools(env.OPENTAG_RUNNER_WEB_TOOLS),
  };
}

/**
 * The native web boundary opt-in accepts only the exact strings `true`/`false` (or absence).
 * Any other value is a configuration error instead of a silent posture change.
 */
function parseRunnerWebTools(value: string | undefined): { readonly webTools?: boolean } {
  if (value === undefined || value === "false") return {};
  if (value === "true") return { webTools: true };
  throw new Error("OPENTAG_RUNNER_WEB_TOOLS must be true or false");
}

/**
 * The platform sets PORT because the Instance declares its single container port. Only an exact
 * integer 1..65535 is accepted; 0 and out-of-range values are configuration errors (the helper
 * itself accepts 0 so tests can request an ephemeral port directly).
 */
function parseRunnerHealthPort(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || String(port) !== value) {
    throw new Error("PORT must be an integer between 1 and 65535");
  }
  return port;
}

/** Bound on queued Cloud control work per connection; overflow is a protocol anomaly, not memory. */
const MAX_PENDING_CLOUD_CONTROL = 128;

/**
 * Trusted E4 state layout. The public root is the ONLY directory that becomes a Sandbox mount;
 * the journal and per-turn private material (adapter CA private key) stay disjoint from it.
 */
export function cloudRunnerDirectories(stateDir: string): {
  journalDir: string;
  privateTurnRoot: string;
  publicRoot: string;
} {
  return {
    journalDir: join(stateDir, "journal"),
    privateTurnRoot: join(stateDir, "turn-material"),
    publicRoot: join(stateDir, "bridge-public"),
  };
}

/**
 * Longest per-Sandbox state directory segment. Long names keep the first 32 characters plus a
 * `-<8 hex digest>` suffix (41 characters), so the published public Unix socket stays under the
 * bridge's 100-byte limit even for the 63-character maximum valid Sandbox name.
 */
const RUNNER_STATE_SEGMENT_MAX = 32;

/**
 * Per-Sandbox state directory segment. Bounded so the published public Unix socket path stays
 * under the bridge's 100-byte limit for any accepted Sandbox name, while the deterministic hash
 * keeps one distinct durable journal/private root per Sandbox.
 */
export function runnerStateDirectorySegment(sandboxName: string): string {
  if (sandboxName.length <= RUNNER_STATE_SEGMENT_MAX) return sandboxName;
  const digest = createHash("sha256").update(sandboxName).digest("hex").slice(0, 8);
  return `${sandboxName.slice(0, RUNNER_STATE_SEGMENT_MAX)}-${digest}`;
}

/**
 * Default trusted Runner state root. `temporaryRoot` is injectable so tests can compute the exact
 * production path length; production always uses the platform temp root.
 */
export function defaultRunnerStateDir(sandboxName: string, temporaryRoot: string = tmpdir()): string {
  return join(temporaryRoot, "ots", runnerStateDirectorySegment(sandboxName));
}

interface WorkState {
  active?: { requestId: string; abort: AbortController; done: Promise<void> };
  probe: SandboxProbeResult;
  stopping: boolean;
  fatal: boolean;
  present: boolean;
  token: string;
  /** Per-connection hook surfacing durable-boundary failures instead of swallowing them. */
  persistenceFailure?: (error: unknown) => void;
  workspace?: ServeWorkspace;
  /** One acceptance execution, opened only after its final restored namespace exists. */
  afterWorkspaceRestore?: () => Promise<void>;
}

/**
 * The single per-process Cloud Turn controller. `canStart` composes the shared native occupation
 * boundary with the E3 acceptance run so Cloud Turns wait instead of racing a destroy/relaunch.
 */
function createCloudTurnRunner(input: {
  bridge: RunnerChannelBridge;
  journal: CloudJournal;
  options: RunnerServeOptions;
  privateTurnRoot: string;
  publicRoot: string;
  sandbox: NativeSandbox;
  serverUrl: string;
  state: () => WorkState | undefined;
  workspacePersistence: boolean;
}): CloudTurnRunner {
  return new CloudTurnRunner({
    canStart: () => {
      const current = input.state();
      return (
        current !== undefined &&
        !current.stopping &&
        current.active === undefined &&
        (!input.workspacePersistence || current.workspace?.ready === true)
      );
    },
    credentialChannel: () => input.bridge,
    journal: input.journal,
    onPersistenceError: (error) => input.state()?.persistenceFailure?.(error),
    publicDirectory: input.publicRoot,
    sandbox: input.sandbox,
    // A non-completed Cloud Turn may leave native processes behind; only a verified
    // delete/relaunch/probe reopens the single-Sandbox occupation boundary.
    sandboxReset: async () => {
      const current = input.state();
      if (!current) throw new Error("The Runner sandbox state is not established");
      await recycleNativeSandbox(input.sandbox, current);
    },
    ...(input.workspacePersistence
      ? {
          checkpoint: async () => {
            const workspace = input.state()?.workspace;
            if (!workspace) throw new Error("Workspace persistence is not initialized");
            await workspace.checkpoint();
          },
        }
      : {}),
    scope: () => input.bridge.scope,
    send: (frame) => input.bridge.sendFrame(frame),
    serverUrl: input.serverUrl,
    stateDirectory: input.privateTurnRoot,
    log: (message) => logLine(input.options.stderr, message),
    ...(input.options.cloudTurnSeams ?? {}),
  });
}

/**
 * Per-process E4 channel bridge: the current connection's send function plus the credential
 * tunnel dispatch. A dropped connection removes its send function; journal-backed retransmission
 * happens on the next welcome, so a frame written to a dead connection is never lost silently —
 * it simply waits for the next reconcile.
 */
class RunnerChannelBridge implements CloudCredentialChannel {
  sendFn?: (frame: RunnerClientFrame) => void;
  scope?: CloudTurnScope;
  /** True only after a negotiated `cloudDeliveryVersion: 1` welcome. Legacy E3 stays Cloud-free. */
  cloudEnabled = false;
  readonly credentialListeners = new Set<(frame: RuntimeCredentialServerFrame) => void>();
  readonly stateListeners = new Set<(state: "registered" | "closed") => void>();

  sendFrame(frame: RunnerClientFrame): void {
    if (!this.sendFn) throw new Error("The Runner control channel is not connected");
    this.sendFn(frame);
  }

  onCredentialFrame(listener: (frame: RuntimeCredentialServerFrame) => void): () => void {
    this.credentialListeners.add(listener);
    return () => this.credentialListeners.delete(listener);
  }

  onChannelState(listener: (state: "registered" | "closed") => void): () => void {
    this.stateListeners.add(listener);
    return () => this.stateListeners.delete(listener);
  }

  emitCredential(frame: RuntimeCredentialServerFrame): void {
    for (const listener of [...this.credentialListeners]) listener(frame);
  }

  emitState(state: "registered" | "closed"): void {
    for (const listener of [...this.stateListeners]) listener(state);
  }
}

function attachWorkspace(
  config: RunnerServeConfig,
  options: RunnerServeOptions,
  current: WorkState,
  sandbox: NativeSandbox,
  turns: CloudTurnRunner,
  bridge: RunnerChannelBridge,
): void {
  if (!config.workspacePersistence) return;
  current.workspace = new ServeWorkspace({
    workspace: new CloudWorkspace({
      backendUrl: config.backendUrl,
      workspace: config.workspace,
      stateDirectory: join(config.stateDir, "workspace-private"),
      token: () => current.token,
      environmentGeneration: () => bridge.scope?.environmentGeneration,
      ...(options.workspaceFetchImpl ? { fetchImpl: options.workspaceFetchImpl } : {}),
    }),
    sandbox,
    state: () => current,
    turns,
  });
}

export async function runRunnerServe(config: RunnerServeConfig, options: RunnerServeOptions): Promise<number> {
  const webStartup = await startServeWebGateway(config, options);
  if (webStartup.exitCode !== undefined) return webStartup.exitCode;
  const webGateway = webStartup.gateway;
  // E4 trusted state root: PRIVATE journal + per-turn credential material roots that are NEVER
  // mounted, plus the public-only root that becomes the read-only Sandbox mount.
  const { journalDir, privateTurnRoot, publicRoot } = cloudRunnerDirectories(config.stateDir);
  await mkdir(privateTurnRoot, { recursive: true, mode: 0o700 });
  await mkdir(publicRoot, { recursive: true, mode: 0o700 });
  const journal = await CloudJournal.open(journalDir);
  const bridge = new RunnerChannelBridge();
  let sandbox: NativeSandbox;
  try {
    // ONLY the public per-turn subtree is mounted read-only at the fixed execution mount. The
    // journal, adapter CA private key, and per-turn private material stay outside every mount.
    sandbox = (
      options.sandboxFactory ??
      ((name, workspace) =>
        new NativeSandbox({
          name,
          workspace,
          extraMounts: [{ source: publicRoot, destination: CLOUD_EXECUTION_MOUNT }],
        }))
    )(config.sandboxName, config.workspace);
  } catch (error) {
    await webGateway?.close();
    reportStartupError(error, options);
    return startupExitCode(error);
  }
  let state: WorkState | undefined;
  // Per-connection hook: a durable-boundary failure surfaces through the current channel, never
  // through an empty catch that would silently drop a received delivery.
  const turns = createCloudTurnRunner({
    bridge,
    journal,
    options,
    privateTurnRoot,
    publicRoot,
    sandbox,
    serverUrl: config.backendUrl,
    state: () => state,
    workspacePersistence: config.workspacePersistence === true,
  });

  let health: RunnerHealthListener | undefined;
  let stopping = false,
    exitCode = 143,
    launchAttempted = false;
  const stopListeners = new Set<() => void>();
  const requestStop = (code: number) => {
    stopping = true;
    exitCode = code;
    if (state) {
      state.stopping = true;
      state.active?.abort.abort();
    }
    turns.onChannelClosed();
    for (const listener of stopListeners) listener();
  };
  const removeSignals = installRunnerSignals(requestStop, options);
  let result = 1;
  try {
    await mkdir(config.workspace, { recursive: true, mode: 0o700 });
    if (stopping) return exitCode;
    launchAttempted = true;
    await sandbox.launch();
    state = { probe: await sandbox.probe(), stopping, fatal: false, present: true, token: config.bootstrapToken };
    attachWorkspace(config, options, state, sandbox, turns, bridge);
    await prepareServeWebExecution(state, webGateway, sandbox, options);
    // The platform's default TCP startup probe needs a listening socket on the declared port.
    // Start it only after native readiness is proven, and only when the platform provided PORT.
    health = await startServeHealthListener(config, options, stopping);
    await maintainConnections(config, state, sandbox, options, stopListeners, turns, bridge);
    result = stopping ? exitCode : state.fatal ? 5 : 1;
  } catch (error) {
    reportStartupError(error, options);
    if (error instanceof NativeSandboxError && error.code === "unavailable") launchAttempted = false;
    result = startupExitCode(error);
  } finally {
    // Any exit is a stop, including non-signal exits (auth failure, reconnect exhaustion, fatal).
    // Mark it before settling the controller so an interrupted turn's verified reset can only
    // delete the namespace, never relaunch it ahead of cleanup; then await the live worker and
    // abort it before any sandbox deletion.
    await settleCloudController(turns, state);
    // The probe listener and process handlers are released even when sandbox cleanup throws.
    try {
      if (!(await cleanupRunner(sandbox, state, launchAttempted, options))) result = 5;
    } finally {
      await webGateway?.close();
      await health?.close();
      removeSignals();
    }
  }
  return result;
}

/** Acceptance-harness path only: production never supplies an authority, so no channel opens. */
async function prepareServeWebExecution(
  state: WorkState,
  webGateway: NativeSandboxWebGateway | undefined,
  sandbox: NativeSandbox,
  options: RunnerServeOptions,
): Promise<void> {
  const open = () => openServeWebExecution(webGateway, sandbox, options, state.stopping);
  if (state.workspace) state.afterWorkspaceRestore = open;
  else await open();
}

async function openServeWebExecution(
  webGateway: NativeSandboxWebGateway | undefined,
  sandbox: NativeSandbox,
  options: RunnerServeOptions,
  stopping: boolean,
): Promise<void> {
  if (stopping || !webGateway || !options.webAuthority) return;
  const channel = await webGateway.openExecution({ sandbox, authority: options.webAuthority });
  options.onWebExecution?.(channel);
}

/** Platform TCP startup probe: started only after native readiness, only when PORT was declared. */
async function startServeHealthListener(
  config: RunnerServeConfig,
  options: RunnerServeOptions,
  stopping: boolean,
): Promise<RunnerHealthListener | undefined> {
  if (stopping || config.healthPort === undefined) return undefined;
  const health = await startRunnerHealthListener({
    port: config.healthPort,
    onError: (message) => logLine(options.stderr, `startup health listener error: ${message}`),
  });
  logLine(options.stderr, `startup health listener ready on port ${health.port}`);
  return health;
}

interface WebGatewayStartup {
  readonly gateway?: NativeSandboxWebGateway;
  readonly exitCode?: number;
}

/** No listener exists until an execution opens its own channel; opt-in only marks the boundary. */
async function startServeWebGateway(
  config: RunnerServeConfig,
  options: RunnerServeOptions,
): Promise<WebGatewayStartup> {
  if (!config.webTools) return {};
  try {
    const gateway = await NativeSandboxWebGateway.start({ sandboxName: config.sandboxName });
    options.onWebGateway?.(gateway);
    return { gateway };
  } catch (error) {
    reportStartupError(error, options);
    return { exitCode: 4 };
  }
}
interface ConnectionOutcome {
  /**
   * Persistent Runners retain their only unsaved copy even after explicit auth rejection.
   * A renewal-only reply requires a fresh ordinary handshake before any work or storage I/O.
   */
  kind: "closed" | "auth_failed" | "auth_timeout" | "renewed";
  healthy: boolean;
}
async function serveOnce(
  config: RunnerServeConfig,
  state: WorkState,
  sandbox: NativeSandbox,
  options: RunnerServeOptions,
  stopListeners: Set<() => void>,
  turns: CloudTurnRunner,
  bridge: RunnerChannelBridge,
): Promise<ConnectionOutcome> {
  const socket = (options.webSocketFactory ?? ((url, settings) => new WebSocket(url, settings)))(config.backendUrl, {
    maxPayload: 256 * 1024,
    handshakeTimeout: options.authTimeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS,
  });
  return new Promise((resolve) => {
    let closed = false,
      authenticated = false,
      welcome: RunnerWelcomeFrame | undefined,
      healthy = false;
    let heartbeatTimer: ReturnType<typeof setInterval> | undefined,
      silenceTimer: ReturnType<typeof setTimeout> | undefined;
    let welcomeAt = 0;
    // Cloud control work is serialized per connection: one durable state mutation at a time,
    // while heartbeat/credential replies/cancel stay on the synchronous path. Overflow is a
    // protocol anomaly, not unbounded memory.
    let controlTail: Promise<void> = Promise.resolve();
    let controlPending = 0;
    const enqueueCloudControl = (label: string, operation: () => Promise<void>): void => {
      if (closed) return;
      if (controlPending >= MAX_PENDING_CLOUD_CONTROL) {
        logLine(options.stderr, `too many queued cloud control operations (${label})`);
        finish();
        return;
      }
      controlPending += 1;
      // The invocation gate is re-checked when this queued operation reaches the head: a frame
      // accepted from a connection that has since closed must not run its handler (an old
      // verified grant would otherwise be handled after the channel generation moved on).
      controlTail = controlTail
        .then(async () => {
          if (closed) {
            logLine(options.stderr, `skipping cloud ${label} queued on a closed connection`);
            return;
          }
          await operation();
        })
        .then(
          () => {
            controlPending -= 1;
          },
          (error: unknown) => {
            controlPending -= 1;
            logLine(
              options.stderr,
              `cloud delivery ${label} failed: ${error instanceof Error ? error.message : String(error)}`,
            );
            finish();
          },
        );
    };
    // A durable-boundary failure (journal/report store) is never swallowed: the frame that failed
    // is visible in the log and the connection cycles so durable reconciliation runs again.
    state.persistenceFailure = (error: unknown) => {
      logLine(
        options.stderr,
        `cloud delivery durable boundary failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      finish();
    };
    const finish = (kind: ConnectionOutcome["kind"] = "closed") => {
      if (closed) return;
      closed = true;
      state.persistenceFailure = undefined;
      clearTimeout(authTimer);
      clearInterval(heartbeatTimer);
      clearTimeout(silenceTimer);
      stopListeners.delete(stop);
      bridge.sendFn = undefined;
      bridge.scope = undefined;
      bridge.cloudEnabled = false;
      bridge.emitState("closed");
      turns.onChannelClosed();
      state.active?.abort.abort();
      socket.terminate();
      // Work owns its own cleanup promise. Reconnect only after it settles.
      void Promise.resolve(state.active?.done).then(() => resolve({ kind, healthy }));
    };
    const send = (frame: unknown) => {
      if (closed || socket.readyState !== WebSocket.OPEN) return;
      try {
        socket.send(JSON.stringify(frame), (error) => {
          if (error) finish();
        });
      } catch {
        finish();
      }
    };
    const armSilence = () => {
      if (!welcome) return;
      clearTimeout(silenceTimer);
      silenceTimer = setTimeout(() => finish(), welcome.heartbeatTimeoutMs);
    };
    const stop = () => finish();
    stopListeners.add(stop);
    // The handshake deadline spans TCP+TLS+upgrade AND the Server's token/database checks, so a
    // slow connect (Server restart, cold ingress) is a transport failure, never a permanent
    // rejection: finish with "auth_timeout" and let the backoff path reconnect.
    const authTimer = setTimeout(
      () => finish("auth_timeout"),
      options.authTimeoutMs ?? (config.workspacePersistence ? PERSISTENT_AUTH_TIMEOUT_MS : DEFAULT_AUTH_TIMEOUT_MS),
    );
    const ready = () => {
      if (state.workspace && !state.workspace.ready) return;
      send({
        type: "runner:ready",
        requestId: randomUUID(),
        readiness: { sandboxName: config.sandboxName, rootfs: SANDBOX_ROOTFS, ...state.probe },
        ...(state.workspace?.ready ? { workspaceRestored: true } : {}),
      });
    };
    socket.on("open", () =>
      send({
        type: "auth",
        requestId: randomUUID(),
        token: state.token,
        cloudDeliveryVersion: RUNNER_CLOUD_DELIVERY_VERSION,
        ...(config.workspacePersistence ? { workspaceVersion: RUNNER_WORKSPACE_VERSION, renewExpired: true } : {}),
      }),
    );
    const onWelcome = (data: RunnerWelcomeFrame) => {
      if (
        welcome ||
        data.protocolVersion !== RUNNER_WS_PROTOCOL_VERSION ||
        !data.resourceName.endsWith(`/instances/${config.sandboxName}`)
      ) {
        finish();
        return;
      }
      const cloudCapable = data.cloudDeliveryVersion === RUNNER_CLOUD_DELIVERY_VERSION;
      if (config.workspacePersistence && data.workspaceVersion !== RUNNER_WORKSPACE_VERSION) {
        logLine(options.stderr, "Server does not support required workspace persistence");
        finish("auth_failed");
        return;
      }
      // A Cloud-capable welcome must carry the verified current allocation UID. A null UID means
      // the create caller has not tracked it yet: retry transiently instead of running Cloud
      // journal reconciliation against an unbound allocation.
      if (cloudCapable && !data.resourceUid) {
        logLine(options.stderr, "cloud welcome has no tracked allocation UID; retrying attachment");
        finish();
        return;
      }
      welcome = data;
      welcomeAt = Date.now();
      clearTimeout(authTimer);
      bridge.scope = {
        sandboxId: data.sandboxId,
        sessionId: data.sessionId,
        environmentGeneration: data.environmentGeneration,
        resourceName: data.resourceName,
        resourceUid: data.resourceUid ?? null,
      };
      bridge.cloudEnabled = cloudCapable;
      bridge.sendFn = send;
      bridge.emitState("registered");
      armSilence();
      heartbeatTimer = setInterval(
        () => send({ type: "heartbeat", requestId: randomUUID() }),
        data.heartbeatIntervalMs,
      );
      // Journal-driven retransmission of durable Cloud delivery state on every (re)attach, for
      // NEGOTIATED Cloud connections only. A legacy E3 channel never touches Cloud state.
      prepareRunnerConnection(state, turns, cloudCapable, {
        ready,
        isClosed: () => closed,
        enqueue: enqueueCloudControl,
      });
      logLine(options.stderr, "authenticated control channel ready");
      return;
    };
    const onAcceptance = (data: RunnerAcceptanceRunFrame) => {
      if (state.active || turns.hasPendingWork || (state.workspace && !state.workspace.ready)) {
        send({
          type: "acceptance:result",
          requestId: data.requestId,
          outcome: "failed",
          failure: { code: "runner_busy", message: "A Cloud Turn or acceptance run already owns the sandbox" },
        });
        return;
      }
      if (data.deadlineAtMs <= Date.now()) {
        send({ type: "acceptance:result", requestId: data.requestId, outcome: "cancelled" });
        return;
      }
      startAcceptance(data, state, sandbox, {
        send,
        ready,
        finish,
        isClosed: () => closed,
        turnSlotAvailable: () => turns.notifyAvailable(),
      });
      return;
    };
    const handle = (data: RunnerServerFrame) =>
      dispatchFrame(data, {
        closed,
        authenticated,
        welcomed: welcome !== undefined,
        renewExpired: config.workspacePersistence === true,
        finish,
        armSilence,
        onWelcome,
        onAcceptance,
        onWorkspaceSeal: (frame) => {
          const workspace = state.workspace;
          if (!workspace) {
            finish();
            return;
          }
          // Report acks and credential traffic must keep flowing while drainForRelease waits.
          // This promise deliberately does not occupy enqueueCloudControl's receive queue.
          void workspace.seal().then(
            () => send({ type: "workspace:seal:result", requestId: frame.requestId, ok: true }),
            () =>
              send({
                type: "workspace:seal:result",
                requestId: frame.requestId,
                ok: false,
                code: "workspace_save_failed",
              }),
          );
        },
        turns,
        bridge,
        enqueueCloudControl,
        authResult: (ok) => {
          // Rejection never opens execution; persistent mode retains local state while retrying.
          if (!ok) finish("auth_failed");
          else authenticated = true;
        },
        heartbeat: () => {
          if (welcome && Date.now() - welcomeAt >= welcome.heartbeatTimeoutMs) healthy = true;
        },
        credential: (token) => {
          state.token = token;
        },
        cancel: (requestId) => {
          if (state.active?.requestId === requestId) state.active.abort.abort();
        },
        error: () => logLine(options.stderr, "Server reported a control protocol error"),
      });
    socket.on("message", (raw, isBinary) => {
      if (closed) return;
      if (isBinary) {
        finish();
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(raw));
      } catch {
        finish();
        return;
      }
      const frame = RunnerServerFrameSchema.safeParse(parsed);
      if (!frame.success) {
        finish();
        return;
      }
      handle(frame.data);
    });
    socket.on("close", () => finish());
    socket.on("error", () => finish());
    if (state.stopping) finish();
  });
}
function prepareRunnerConnection(
  state: WorkState,
  turns: CloudTurnRunner,
  cloudCapable: boolean,
  callbacks: {
    ready: () => void;
    isClosed: () => boolean;
    enqueue: (label: string, operation: () => Promise<void>) => void;
  },
): void {
  const workspace = state.workspace;
  if (!workspace) {
    callbacks.ready();
    if (cloudCapable) callbacks.enqueue("reconcile", () => turns.reconcile());
    return;
  }
  callbacks.enqueue("restore", async () => {
    // A failed save must never hide an already-journaled result behind another restore attempt.
    // Admission remains blocked by workspace.ready while custody/report acknowledgments flow.
    if (cloudCapable) await turns.reconcile();
    if (!(await workspace.prepare()) || callbacks.isClosed()) return;
    await state.afterWorkspaceRestore?.();
    state.afterWorkspaceRestore = undefined;
    callbacks.ready();
    if (cloudCapable) await turns.reconcile();
    turns.notifyAvailable();
  });
}

interface AcceptanceRunResult {
  outcome: "passed" | "failed" | "cancelled";
  report?: unknown;
  failure?: { code: string; message: string };
}
async function runAcceptanceInSandbox(
  sandbox: NativeSandbox,
  command: RunnerAcceptanceRunFrame,
  signal: AbortSignal,
): Promise<AcceptanceRunResult> {
  const remaining = Math.min(command.deadlineAtMs - Date.now(), 1_800_000);
  if (remaining <= 0 || signal.aborted) return { outcome: "cancelled" };
  let exec: Awaited<ReturnType<NativeSandbox["exec"]>>;
  try {
    exec = await sandbox.exec(SANDBOX_NODE, [SANDBOX_WORKER_ENTRY, "worker"], {
      timeoutMs: remaining,
      signal,
      stdin: serializeRunnerAcceptanceWorkerStdin({
        mode: command.mode,
        ...(command.piConfig ? { piConfig: command.piConfig } : {}),
      }),
    });
  } catch {
    return signal.aborted
      ? { outcome: "cancelled" }
      : {
          outcome: "failed",
          failure: { code: "worker_exec_failed", message: "The in-sandbox worker did not complete" },
        };
  }
  if (signal.aborted) return { outcome: "cancelled" };
  const line = exec.stdout
    .split("\n")
    .filter((l) => l.startsWith("{"))
    .at(-1);
  let raw: unknown;
  try {
    raw = JSON.parse(line ?? "");
  } catch {
    return {
      outcome: "failed",
      failure: { code: "worker_output_invalid", message: "The worker produced no valid result" },
    };
  }
  if (typeof raw !== "object" || raw === null || !("kind" in raw) || raw.kind !== "result" || !("report" in raw))
    return { outcome: "failed", failure: { code: "worker_failed", message: "The in-sandbox worker failed" } };
  const text = sanitizeWorkerReport(raw.report, command);
  const report = RunnerAcceptanceReportWireSchema.safeParse(JSON.parse(text));
  if (!report.success)
    return {
      outcome: "failed",
      failure: { code: "worker_report_invalid", message: "The worker report failed validation" },
    };
  return { outcome: exec.code === 0 && !report.data.failed ? "passed" : "failed", report: report.data };
}

async function maintainConnections(
  config: RunnerServeConfig,
  state: WorkState,
  sandbox: NativeSandbox,
  options: RunnerServeOptions,
  stopListeners: Set<() => void>,
  turns: CloudTurnRunner,
  bridge: RunnerChannelBridge,
): Promise<void> {
  let failures = 0;
  while (!state.stopping && !state.fatal) {
    const outcome = await serveOnce(config, state, sandbox, options, stopListeners, turns, bridge);
    // This barrier covers worker exit AND native deletion/recreation. No successor connection
    // can dispatch work into a sandbox still owned by the prior connection.
    await state.active?.done;
    if (state.stopping || state.fatal) break;
    // Renewal also uses bounded backoff: repeated unusable renewal replies must not hot-loop.
    if (shouldExitRejectedRunner(config, options, outcome)) break;
    failures = outcome.healthy ? 0 : failures + 1;
    // Storage outages must not turn a bounded reconnect policy into destruction of the only
    // unsaved local workspace. Keep the parent and health listener alive at bounded backoff.
    if (reconnectLimitReached(config, options, failures)) break;
    const delay = Math.min(1_000 * 2 ** failures, 30_000) + (options.randomJitter ?? randomInt)(500);
    await waitReconnect(delay, state, options, stopListeners);
  }
}

function shouldExitRejectedRunner(
  config: RunnerServeConfig,
  options: RunnerServeOptions,
  outcome: ConnectionOutcome,
): boolean {
  if (outcome.kind === "auth_timeout") logLine(options.stderr, "Runner authentication timed out; reconnecting");
  if (outcome.kind !== "auth_failed") return false;
  logLine(options.stderr, "Runner authentication rejected");
  // Rejection never authorizes destruction of the only unsaved copy. The control plane owns
  // permanent revocation and physical cleanup; persistent mode stays closed to work and retries.
  return !config.workspacePersistence;
}

function reconnectLimitReached(config: RunnerServeConfig, options: RunnerServeOptions, failures: number): boolean {
  return !config.workspacePersistence && failures >= (options.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS);
}

async function waitReconnect(
  delay: number,
  state: WorkState,
  options: RunnerServeOptions,
  stopListeners: Set<() => void>,
): Promise<void> {
  await new Promise<void>((resolve) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      clearTimeout(timer);
      stopListeners.delete(finish);
      resolve();
    };
    stopListeners.add(finish);
    if (state.stopping) finish();
    else if (options.sleep) void options.sleep(delay).then(finish);
    else timer = setTimeout(finish, delay);
  });
}

/** Mark the exit as a stop, then settle (abort + await) the live Cloud controller first. */
async function settleCloudController(turns: CloudTurnRunner, state: WorkState | undefined): Promise<void> {
  if (state) state.stopping = true;
  await turns.close().catch(() => undefined);
}

async function cleanupRunner(
  sandbox: NativeSandbox,
  state: WorkState | undefined,
  launchAttempted: boolean,
  options: RunnerServeOptions,
): Promise<boolean> {
  if (state) {
    state.stopping = true;
    state.active?.abort.abort();
    await state.active?.done;
  }
  if (launchAttempted && (!state || state.present)) {
    try {
      await sandbox.destroy();
      logLine(options.stderr, "native sandbox deleted");
    } catch {
      logLine(options.stderr, "FATAL: native sandbox deletion failed");
      return false;
    }
  }

  return true;
}

interface WorkCallbacks {
  send: (frame: unknown) => void;
  ready: () => void;
  finish: () => void;
  isClosed: () => boolean;
  turnSlotAvailable: () => void;
}

/**
 * Verified native namespace cleanup shared by E3 acceptance and E4 Cloud Turns: native
 * `delete --force`, relaunch, and a fresh readiness probe. Killing the `sandbox exec` wrapper
 * proves nothing about the process tree it started, so only this reset may reopen the single
 * Sandbox occupation boundary. A failure marks the Runner fatal instead of reusing the namespace.
 */
async function recycleNativeSandbox(sandbox: NativeSandbox, state: WorkState): Promise<void> {
  try {
    await sandbox.destroy();
    state.present = false;
    if (state.stopping) return;
    state.present = true;
    await sandbox.launch();
    state.probe = await sandbox.probe();
  } catch (error) {
    state.fatal = true;
    throw error;
  }
}

function startAcceptance(
  data: RunnerAcceptanceRunFrame,
  state: WorkState,
  sandbox: NativeSandbox,
  callbacks: WorkCallbacks,
): void {
  const abort = new AbortController();
  const deadline = setTimeout(() => abort.abort(), Math.min(data.deadlineAtMs - Date.now(), 1_800_000));
  const done = (async () => {
    let result: AcceptanceRunResult;
    try {
      result = await runAcceptanceInSandbox(sandbox, data, abort.signal);
    } catch {
      result = { outcome: "failed", failure: { code: "worker_failed", message: "The sandbox worker failed" } };
    }
    clearTimeout(deadline);
    // Reclaim every descendant and the disposable credential filesystem on ALL outcomes.
    // Keep only the Session workspace mount, then validate a fresh native environment.
    try {
      if (state.workspace) await state.workspace.checkpoint();
      else await recycleNativeSandbox(sandbox, state);
    } catch {
      result = {
        outcome: "failed",
        failure: { code: "sandbox_cleanup_failed", message: "Native sandbox cleanup could not be verified" },
      };
    }
    if (!callbacks.isClosed()) {
      callbacks.send({ type: "acceptance:result", requestId: data.requestId, ...result });
      if (!state.fatal && !state.stopping) callbacks.ready();
    }
    state.active = undefined;
    if (state.fatal || (state.workspace && !state.workspace.ready && !state.workspace.sealing)) callbacks.finish();
    // The native occupation boundary reopened: queued Cloud turns can use the sandbox again.
    callbacks.turnSlotAvailable();
  })();
  state.active = { requestId: data.requestId, abort, done };
}

function sanitizeWorkerReport(value: unknown, command: RunnerAcceptanceRunFrame): string {
  // Never relay credential strings even when a provider tool includes one in its error text.
  const secrets: string[] = [];
  const collect = (v: unknown): void => {
    if (typeof v === "string" && v.length >= 8) secrets.push(v);
    else if (v && typeof v === "object") for (const x of Object.values(v)) collect(x);
  };
  for (const document of Object.values(command.piConfig ?? {})) {
    try {
      collect(JSON.parse(document));
    } catch {
      /* Worker validates documents. */
    }
  }
  let text = JSON.stringify(redactAcceptanceRecord(value));
  for (const secret of secrets) text = text.split(secret).join("[redacted]");

  return text;
}

function reportStartupError(error: unknown, options: RunnerServeOptions): void {
  logLine(
    options.stderr,
    `Runner unavailable (${error instanceof NativeSandboxError ? error.code : "startup_failed"})`,
  );
}
function startupExitCode(error: unknown): number {
  return error instanceof NativeSandboxError && error.code === "unavailable" ? 3 : 4;
}

function installRunnerSignals(requestStop: (code: number) => void, options: RunnerServeOptions): () => void {
  const term = () => requestStop(143),
    int = () => requestStop(130);
  if (options.installSignalHandlers !== false) {
    process.on("SIGTERM", term);
    process.on("SIGINT", int);
  }
  options.signal?.addEventListener("abort", term, { once: true });
  if (options.signal?.aborted) term();

  return () => {
    process.off("SIGTERM", term);
    process.off("SIGINT", int);
    options.signal?.removeEventListener("abort", term);
  };
}

interface FrameDispatch {
  closed: boolean;
  authenticated: boolean;
  welcomed: boolean;
  renewExpired: boolean;
  finish: (kind?: ConnectionOutcome["kind"]) => void;
  armSilence: () => void;
  onWelcome: (frame: RunnerWelcomeFrame) => void;
  onAcceptance: (frame: RunnerAcceptanceRunFrame) => void;
  onWorkspaceSeal: (frame: RunnerWorkspaceSealFrame) => void;
  turns: CloudTurnRunner;
  bridge: RunnerChannelBridge;
  enqueueCloudControl: (label: string, operation: () => Promise<void>) => void;
  authResult: (ok: boolean) => void;
  heartbeat: () => void;
  credential: (token: string) => void;
  cancel: (id: string) => void;
  error: () => void;
}
function dispatchFrame(data: RunnerServerFrame, c: FrameDispatch): void {
  if (c.closed) return;
  if (data.type === "auth:renewed") {
    if (c.authenticated || !c.renewExpired) c.finish();
    else {
      c.credential(data.token);
      c.finish("renewed");
    }
    return;
  }
  if (data.type === "auth:result") {
    c.authResult(data.ok);
    return;
  }
  if (!c.authenticated) {
    // A server that speaks before completing authentication is a transport/protocol anomaly,
    // not an explicit rejection: reconnect rather than exiting permanently.
    c.finish();
    return;
  }
  if (data.type === "server:welcome") {
    c.onWelcome(data);
    return;
  }
  if (!c.welcomed) {
    c.finish();
    return;
  }
  c.armSilence();
  if (isCloudServerFrame(data)) {
    dispatchCloudFrame(data, c);
    return;
  }
  switch (data.type) {
    case "workspace:seal":
      c.onWorkspaceSeal(data);
      break;
    case "server:heartbeat":
      c.heartbeat();
      break;
    case "server:credential":
      c.credential(data.token);
      break;
    case "acceptance:cancel":
      c.cancel(data.requestId);
      break;
    case "acceptance:run":
      c.onAcceptance(data);
      break;
    case "error":
      c.error();
      break;
  }
}

type CloudServerFrame = Extract<
  RunnerServerFrame,
  {
    type:
      | "delivery:run"
      | "delivery:verified"
      | "delivery:cancel"
      | "delivery:report:ack"
      | "delivery:query"
      | "credential:frame";
  }
>;

function isCloudServerFrame(frame: RunnerServerFrame): frame is CloudServerFrame {
  return (
    frame.type === "delivery:run" ||
    frame.type === "delivery:verified" ||
    frame.type === "delivery:cancel" ||
    frame.type === "delivery:report:ack" ||
    frame.type === "delivery:query" ||
    frame.type === "credential:frame"
  );
}

/**
 * Cloud delivery frames exist only on a negotiated `cloudDeliveryVersion: 1` channel. On a legacy
 * E3 channel they are a protocol violation: the connection cycles instead of touching Cloud state.
 * Cancellation stays synchronous so it never waits behind queued durable work.
 */
function dispatchCloudFrame(data: CloudServerFrame, c: FrameDispatch): void {
  if (!c.bridge.cloudEnabled) {
    c.finish();
    return;
  }
  switch (data.type) {
    case "delivery:run":
      c.enqueueCloudControl("delivery:run", () => c.turns.handleDeliveryRun(data));
      break;
    case "delivery:verified":
      c.enqueueCloudControl("delivery:verified", () => c.turns.handleVerified(data));
      break;
    case "delivery:cancel":
      c.turns.handleCancel(data.deliveryId);
      break;
    case "delivery:report:ack":
      c.enqueueCloudControl("delivery:report:ack", () => c.turns.handleReportAck(data));
      break;
    case "delivery:query":
      c.enqueueCloudControl("delivery:query", () => c.turns.handleQuery(data));
      break;
    case "credential:frame":
      c.bridge.emitCredential(data.frame);
      break;
  }
}
