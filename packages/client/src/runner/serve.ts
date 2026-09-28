import { createHash, randomInt, randomUUID } from "node:crypto";
import { mkdir, rm } from "node:fs/promises";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RUNNER_CLOUD_DELIVERY_VERSION,
  RUNNER_REUSE_VERSION,
  RUNNER_SESSION_COLLABORATION_VERSION,
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
import { resolveWebToolsExtensionPath } from "../runtime/web-tools-artifact.js";
import {
  assignmentsMatch,
  hasUnmarkedAssignmentState,
  type RunnerAssignment,
  readRunnerAssignment,
  writeRunnerAssignment,
} from "./assignment-state.js";
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
  /**
   * Declared platform container port for the startup probe. `loadRunnerServeConfig` always
   * supplies it (the declared 8080 unless PORT overrides); direct/test constructions may omit it
   * and then no listener starts.
   */
  readonly healthPort?: number;
  /**
   * E7 physical control credential from the Instance env. Old Runners ignore it; a Runner that
   * has it authenticates the control channel with it and keeps the Session bearer only for
   * workspace HTTP (the Server issues the current assignment's bearer after attach).
   */
  readonly controlToken?: string;
  /** Set by a persistence-enabled Server; legacy E3 acceptance does not negotiate storage. */
  readonly workspacePersistence?: boolean;
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
   * caller for the E3 acceptance run. Cloud turns do not use it; they build their own authority
   * per granted execution from the Server-issued execution bearer, and no bootstrap credential is
   * ever treated as an authority.
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

/**
 * The Runner image and the Cloud Run Instance declare exactly this single container port, and the
 * platform's default startup TCP probe targets it. An injected `PORT` stays the strict override;
 * absence must not disable the listener.
 */
const DECLARED_CONTAINER_PORT = 8080;

export function loadRunnerServeConfig(env: NodeJS.ProcessEnv): RunnerServeConfig {
  const backendRaw = env.OPENTAG_RUNNER_BACKEND_URL;
  if (!backendRaw) throw new Error("OPENTAG_RUNNER_BACKEND_URL is required for serve mode");
  const token = env.OPENTAG_RUNNER_BOOTSTRAP_TOKEN;
  if (!token) throw new Error("OPENTAG_RUNNER_BOOTSTRAP_TOKEN is required for serve mode (env only, never argv)");
  const sandboxName = env.OPENTAG_RUNNER_SANDBOX_NAME ?? "ots-runner";
  if (!/^[a-z][a-z0-9-]{0,62}$/.test(sandboxName)) {
    throw new Error("OPENTAG_RUNNER_SANDBOX_NAME is not a safe sandbox name");
  }
  const healthPort = parseRunnerHealthPort(env.PORT) ?? DECLARED_CONTAINER_PORT;
  const persistence = env.OPENTAG_RUNNER_WORKSPACE_PERSISTENCE;
  if (persistence !== undefined && persistence !== "1" && persistence !== "0") {
    throw new Error("OPENTAG_RUNNER_WORKSPACE_PERSISTENCE must be 1 or 0");
  }
  const controlToken = env.OPENTAG_RUNNER_CONTROL_TOKEN;
  if (controlToken !== undefined && (controlToken.length === 0 || controlToken.length > 8192)) {
    throw new Error("OPENTAG_RUNNER_CONTROL_TOKEN is not a valid credential");
  }
  return {
    backendUrl: resolveRunnerBackendUrl(backendRaw),
    bootstrapToken: token,
    ...(controlToken ? { controlToken } : {}),
    sandboxName,
    workspace: env.OPENTAG_RUNNER_WORKSPACE ?? join(tmpdir(), "opentag-runner-workspaces", sandboxName),
    stateDir: env.OPENTAG_RUNNER_STATE_DIR ?? defaultRunnerStateDir(sandboxName),
    healthPort,
    ...(persistence === "1" ? { workspacePersistence: true } : {}),
  };
}

/**
 * Only an exact integer 1..65535 is accepted; absence falls back to the declared container port
 * in `loadRunnerServeConfig`, while 0 and out-of-range values remain configuration errors (the
 * helper itself accepts 0 so tests can request an ephemeral port directly).
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
 * `-<8 hex digest>` suffix (41 characters), keeping per-turn public material paths short and
 * stable even for the 63-character maximum valid Sandbox name.
 */
const RUNNER_STATE_SEGMENT_MAX = 32;

/**
 * Per-Sandbox state directory segment. Bounded so public material paths stay short and stable
 * for any accepted Sandbox name, while the deterministic hash
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
  /** Session workspace bearer for the CURRENT assignment; replaced by `server:credential`. */
  token: string;
  /** E7 immutable physical control credential; never used for workspace HTTP. */
  controlToken?: string;
  /** Per-connection hook surfacing durable-boundary failures instead of swallowing them. */
  persistenceFailure?: (error: unknown) => void;
  workspace?: ServeWorkspace;
  /** One acceptance execution, opened only after its final restored namespace exists. */
  afterWorkspaceRestore?: () => Promise<void>;
  /** E7 assignment identity bound to the local workspace/journal on disk. */
  assignment?: RunnerAssignment;
  /** Current Cloud Turn controller; rebuilt only on an assignment change. */
  turns: CloudTurnRunner;
  /** Trusted-parent journal; reset and reopened on assignment change. */
  journal: CloudJournal;
  readonly journalDir: string;
  readonly privateTurnRoot: string;
  readonly publicRoot: string;
  /** Active native web execution channel, reopened after an assignment rebind. */
  webExecution?: NativeWebExecutionChannel;
  /** Monotonic receipt counter for `server:credential` frames. */
  credentialEpoch: number;
  /** Assignment key of the current Session bearer; undefined until a credential is received. */
  tokenScope?: string;
  /**
   * True when the Session bearer must be obtained from the Server before the first HTTP claim:
   * set for a process restart that found an assignment marker, and for every changed assignment.
   * A truly fresh first bind may use the bearer minted for it at Instance creation.
   */
  assignmentRequired: boolean;
  /** Waiters for a credential that arrives AFTER they registered. `error` rejects a timeout. */
  credentialWaiters: Array<(error?: Error) => void>;
  /**
   * Set while the closing connection still owns in-flight restore/rebind work: a credential wait
   * started after the close cannot succeed, so it fails fast instead of blocking the drain.
   * Cleared when the next connection starts.
   */
  credentialInterrupt?: Error;
}

/** Assignment identity used to bind a Session bearer to the welcome that produced it. */
function assignmentKey(scope: { sandboxId: string; environmentGeneration: number }): string {
  return `${scope.sandboxId}:${scope.environmentGeneration}`;
}

/** Apply one credential frame: bind the Session bearer to the assignment that received it. */
function applyCredential(
  state: WorkState,
  bridge: RunnerChannelBridge,
  credentials: { token?: string; controlToken?: string },
): void {
  if (credentials.token) {
    state.token = credentials.token;
    state.tokenScope = bridge.scope ? assignmentKey(bridge.scope) : undefined;
  }
  if (credentials.controlToken) state.controlToken = credentials.controlToken;
  state.credentialEpoch += 1;
  for (const waiter of state.credentialWaiters.splice(0)) waiter();
}

/**
 * Wait for a `server:credential` that arrives after `epoch`. A credential received before this
 * call resolves immediately. A timeout REJECTS: preparing against a bearer that is not proven to
 * belong to the current assignment must fail closed, never proceed on the expectation that the
 * old token might still work.
 */
function waitForCredentialAfter(state: WorkState, epoch: number, timeoutMs: number): Promise<void> {
  if (state.credentialEpoch > epoch) return Promise.resolve();
  if (state.credentialInterrupt) return Promise.reject(state.credentialInterrupt);
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      state.credentialWaiters = state.credentialWaiters.filter((waiter) => waiter !== finish);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(
      () => finish(new Error("the assignment credential was not received before the deadline")),
      timeoutMs,
    );
    timer.unref?.();
    state.credentialWaiters.push(finish);
  });
}

/**
 * The Session bearer for the CURRENT assignment. A fresh first bind may use the bearer minted for
 * it at Instance creation; a restart or a changed assignment must receive the Server's bearer for
 * the holder before any workspace HTTP claim. The check also covers the case where the credential
 * arrived before the serialized restore operation ran.
 */
async function ensureAssignmentCredential(
  state: WorkState,
  scope: { sandboxId: string; environmentGeneration: number },
  timeoutMs: number,
  options: { required: boolean },
): Promise<void> {
  if (state.tokenScope === assignmentKey(scope)) return;
  // A negotiated physical-control attach always requires the credential for the welcome it just
  // received, even on a first bind with no local marker: the immutable env bearer may belong to
  // a different birth Session after a transfer. A legacy first bind keeps the old behavior.
  if (!options.required && !state.assignmentRequired) return;
  const baseline = state.credentialEpoch;
  await waitForCredentialAfter(state, baseline, timeoutMs);
  if (state.tokenScope !== assignmentKey(scope)) {
    throw new Error("the received credential does not belong to the current assignment");
  }
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
  webExtensionPath: string | undefined;
  webGateway: NativeSandboxWebGateway | undefined;
  workspacePersistence: boolean;
}): CloudTurnRunner {
  const server = new URL(input.serverUrl);
  server.protocol = server.protocol === "wss:" ? "https:" : "http:";
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
    ...(input.webGateway ? { webGateway: input.webGateway } : {}),
    ...(input.webExtensionPath ? { webExtensionPath: input.webExtensionPath } : {}),
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
    serverUrl: server.origin,
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
  /** True only when the Server echoed the E8 Session-collaboration capability at the same welcome. */
  sessionCollaborationEnabled = false;
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

async function resetDirectory(directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory, { recursive: true, mode: 0o700 });
}

function attachWorkspace(
  config: RunnerServeConfig,
  options: RunnerServeOptions,
  current: WorkState,
  sandbox: NativeSandbox,
  bridge: RunnerChannelBridge,
  web: { gateway: NativeSandboxWebGateway | undefined; extensionPath: string | undefined },
): void {
  current.turns = createCloudTurnRunner({
    bridge,
    journal: current.journal,
    options,
    privateTurnRoot: current.privateTurnRoot,
    publicRoot: current.publicRoot,
    sandbox,
    serverUrl: config.backendUrl,
    state: () => current,
    webExtensionPath: web.extensionPath,
    webGateway: web.gateway,
    workspacePersistence: config.workspacePersistence === true,
  });
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
    turns: current.turns,
  });
}

/**
 * Gate for replacing the current assignment: a previous marker may be discarded only when it
 * recorded a successful seal; without a marker nothing may look like it could hold unsaved work.
 */
async function assignmentReplacementAllowed(input: {
  config: RunnerServeConfig;
  options: RunnerServeOptions;
  current: WorkState;
  assignment: RunnerAssignment | undefined;
}): Promise<boolean> {
  if (input.assignment) {
    if (input.assignment.sealed) return true;
    logLine(input.options.stderr, "refusing a new assignment: the previous workspace was not sealed");
    return false;
  }
  const leftover = await hasUnmarkedAssignmentState({
    workspace: input.config.workspace,
    journalDir: input.current.journalDir,
    privateTurnRoot: input.current.privateTurnRoot,
    publicRoot: input.current.publicRoot,
  });
  if (!leftover) return true;
  logLine(input.options.stderr, "refusing a new assignment: unmarked local workspace state exists");
  return false;
}

/**
 * E7 sealed-assignment discard: the previous assignment's durable work is settled, so its local
 * workspace, private credential material, public execution material and completed journal entries are
 * removed before a fresh controller/workspace is built. Every step is required; a failure fails
 * closed for the new assignment rather than executing over unproven local state.
 */
async function discardSealedAssignment(input: {
  config: RunnerServeConfig;
  options: RunnerServeOptions;
  current: WorkState;
  sandbox: NativeSandbox;
  bridge: RunnerChannelBridge;
  web: WebGatewayRuntime;
  assignment: RunnerAssignment;
}): Promise<void> {
  const { config, options, current, sandbox, bridge, web, assignment } = input;
  await current.turns.close();
  await current.webExecution?.close();
  current.webExecution = undefined;
  if (current.present) {
    try {
      await sandbox.destroy();
    } catch (error) {
      // Mirror ServeWorkspace.#quiesce: a native namespace whose deletion cannot be verified is
      // fatal, and the reconnect loop must not restart another rebind over it.
      current.fatal = true;
      throw error;
    }
    current.present = false;
  }
  await current.journal.resetScope({
    sandboxId: assignment.sandboxId,
    sessionId: assignment.sessionId,
    environmentGeneration: assignment.environmentGeneration,
    resourceName: assignment.resourceName,
    resourceUid: assignment.resourceUid,
  });
  await resetDirectory(config.workspace);
  await resetDirectory(current.privateTurnRoot);
  await resetDirectory(current.publicRoot);
  current.workspace = undefined;
  current.journal = await CloudJournal.open(current.journalDir);
  attachWorkspace(config, options, current, sandbox, bridge, web);
  await prepareServeWebExecution(current, web.gateway, sandbox, options);
}

/**
 * The Runner's native web boundary. The gateway is always constructed — it opens no listener and
 * no socket until a Server-granted Cloud execution asks for one — and the extension path is the
 * packaged artifact resolved at startup. A missing artifact leaves web tools off for every turn;
 * it never fails startup, because the feature is optional to a turn that does not use it.
 */
interface WebGatewayRuntime {
  readonly gateway: NativeSandboxWebGateway | undefined;
  readonly extensionPath: string | undefined;
}

export async function runRunnerServe(config: RunnerServeConfig, options: RunnerServeOptions): Promise<number> {
  const gatewayStartup = await startServeWebGateway(config.sandboxName, options);
  if (gatewayStartup.exitCode !== undefined) return gatewayStartup.exitCode;
  const web: WebGatewayRuntime = {
    gateway: gatewayStartup.gateway,
    extensionPath: await resolveServeWebExtensionPath(options),
  };
  const webGateway = web.gateway;
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
  let health: RunnerHealthListener | undefined;
  let stopping = false,
    exitCode = 143,
    launchAttempted = false;
  const stopListeners = new Set<() => void>();

  /**
   * E7 assignment bind. A welcome for the SAME assignment keeps all local unsaved bytes. A welcome
   * for a DIFFERENT assignment is accepted only when the previous assignment proved its workspace
   * sealed; then old native/controller/workspace/journal/private/public state is destroyed and a
   * fresh controller + workspace is built for the new Session before any restore or readiness.
   */
  const rebindAssignment = async (): Promise<boolean> => {
    const current = state;
    const scope = bridge.scope;
    if (!current || !scope) return false;
    const assignment = current.assignment;
    if (assignment && assignmentsMatch(assignment, scope)) return true;
    if (!(await assignmentReplacementAllowed({ config, options, current, assignment }))) return false;
    if (assignment) {
      // Sealed previous assignment: its durable work is settled, so discard the completed local
      // state rather than accumulating it. Any failure here fails closed for the new assignment.
      await discardSealedAssignment({ config, options, current, sandbox, bridge, web, assignment });
      // The old Session bearer is invalid for the new assignment: the restore path below must
      // receive the Server's credential for the holder before any workspace HTTP claim.
      current.assignmentRequired = true;
    }
    // Persist BEFORE the in-memory assignment: a failed disk write must not let a reconnect
    // short-circuit the durable marker and prepare the new Session while the old sealed marker
    // still owns the local workspace.
    const proposed: RunnerAssignment = {
      sandboxId: scope.sandboxId,
      sessionId: scope.sessionId,
      environmentGeneration: scope.environmentGeneration,
      resourceName: scope.resourceName,
      resourceUid: scope.resourceUid ?? "",
      sealed: false,
    };
    await writeRunnerAssignment(config.stateDir, proposed);
    current.assignment = proposed;
    return true;
  };

  const requestStop = (code: number) => {
    stopping = true;
    exitCode = code;
    if (state) {
      state.stopping = true;
      state.active?.abort.abort();
    }
    state?.turns.onChannelClosed();
    for (const listener of stopListeners) listener();
  };
  const removeSignals = installRunnerSignals(requestStop, options);
  let result = 1;
  try {
    await mkdir(config.workspace, { recursive: true, mode: 0o700 });
    if (stopping) return exitCode;
    launchAttempted = true;
    await sandbox.launch();
    state = {
      probe: await sandbox.probe(),
      stopping,
      fatal: false,
      present: true,
      token: config.bootstrapToken,
      ...(config.controlToken ? { controlToken: config.controlToken } : {}),
      journal,
      journalDir,
      privateTurnRoot,
      publicRoot,
      credentialEpoch: 0,
      assignmentRequired: false,
      credentialWaiters: [],
      assignment: await readRunnerAssignment(config.stateDir),
      turns: undefined as unknown as CloudTurnRunner,
    };
    attachWorkspace(config, options, state, sandbox, bridge, web);
    await prepareServeWebExecution(state, webGateway, sandbox, options);
    // The platform's default TCP startup probe needs a listening socket on the declared port,
    // which `loadRunnerServeConfig` always supplies (declared 8080 unless PORT overrides). Start
    // it only after native readiness is proven.
    health = await startServeHealthListener(config, options, stopping);
    await maintainConnections(config, state, sandbox, options, stopListeners, bridge, rebindAssignment);
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
    await settleCloudController(state);
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

/** Acceptance-harness path: opens the acceptance run's own channel when an authority was injected. */
async function prepareServeWebExecution(
  state: WorkState,
  webGateway: NativeSandboxWebGateway | undefined,
  sandbox: NativeSandbox,
  options: RunnerServeOptions,
): Promise<void> {
  const open = () => openServeWebExecution(state, webGateway, sandbox, options);
  if (state.workspace) state.afterWorkspaceRestore = open;
  else await open();
}

async function openServeWebExecution(
  state: WorkState,
  webGateway: NativeSandboxWebGateway | undefined,
  sandbox: NativeSandbox,
  options: RunnerServeOptions,
): Promise<void> {
  if (state.stopping || !webGateway || !options.webAuthority) return;
  await state.webExecution?.close();
  state.webExecution = undefined;
  const channel = await webGateway.openExecution({ sandbox, authority: options.webAuthority });
  state.webExecution = channel;
  options.onWebExecution?.(channel);
}

/** Platform TCP startup probe: started after native readiness when a health port is configured. */
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

/** No listener exists until a Server-granted execution opens its own channel. */
async function startServeWebGateway(sandboxName: string, options: RunnerServeOptions): Promise<WebGatewayStartup> {
  try {
    const gateway = await NativeSandboxWebGateway.start({ sandboxName });
    options.onWebGateway?.(gateway);
    return { gateway };
  } catch (error) {
    reportStartupError(error, options);
    return { exitCode: 4 };
  }
}

/**
 * Fixed packaged location of the Pi web-tools extension in the Runner image. `scripts/runner`
 * assembles `packages/client/dist` to `/opt/opentag/client/dist`, and the Client build emits the
 * extension to `dist/pi-extensions/web-tools.mjs`. It is named here as well as resolved
 * automatically because the running module may be a shared build chunk.
 */
const PACKAGED_WEB_EXTENSION_PATH = "/opt/opentag/client/dist/pi-extensions/web-tools.mjs";

/**
 * Resolve the fixed packaged Pi web-tools extension for Cloud turns. The packaged path is tried
 * first, then the artifact's own resolution (which covers development and a relocated build);
 * `resolveWebToolsExtensionPath` verifies the result is a real file and never follows environment
 * variables or cwd, so an Agent cannot substitute its own extension. A missing artifact is a logged
 * fail-closed (web tools stay off), never a guessed path.
 */
async function resolveServeWebExtensionPath(options: RunnerServeOptions): Promise<string | undefined> {
  const path =
    (await resolveWebToolsExtensionPath({ explicitPath: PACKAGED_WEB_EXTENSION_PATH })) ??
    (await resolveWebToolsExtensionPath());
  if (path) return path;
  options.stderr.write("[opentag-runner serve] the trusted web tools extension artifact is missing\n");
  return undefined;
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
  bridge: RunnerChannelBridge,
  rebind: () => Promise<boolean>,
): Promise<ConnectionOutcome> {
  // The previous connection drained before this one starts; its interrupt no longer applies.
  state.credentialInterrupt = undefined;
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
      bridge.sessionCollaborationEnabled = false;
      bridge.emitState("closed");
      state.turns.onChannelClosed();
      state.active?.abort.abort();
      // A credential wait owned by this closing connection can never succeed: interrupt it so the
      // serialized cloud-control tail (which may hold an in-flight rebind cleanup) drains promptly.
      const interrupted = new Error("the control channel closed before the assignment credential arrived");
      state.credentialInterrupt = interrupted;
      for (const waiter of state.credentialWaiters.splice(0)) waiter(interrupted);
      // Drain the serialized cloud-control tail before this connection reports closed: the next
      // connection must never start another rebind/restore over a workspace the old one is still
      // cleaning. `controlTail` only ever grows while `closed` is false, so this is the full tail.
      const drain = controlTail;
      socket.terminate();
      // Work and the queued control tail own their own cleanup promises. Reconnect after BOTH.
      void Promise.all([Promise.resolve(state.active?.done), drain]).then(() => resolve({ kind, healthy }));
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
        sessionCollaborationVersion: RUNNER_SESSION_COLLABORATION_VERSION,
        ...(config.workspacePersistence ? { workspaceVersion: RUNNER_WORKSPACE_VERSION, renewExpired: true } : {}),
        ...(state.controlToken && config.workspacePersistence
          ? { controlToken: state.controlToken, reuseVersion: RUNNER_REUSE_VERSION }
          : {}),
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
      bridge.sessionCollaborationEnabled = data.sessionCollaborationVersion === RUNNER_SESSION_COLLABORATION_VERSION;
      bridge.sendFn = send;
      bridge.emitState("registered");
      armSilence();
      heartbeatTimer = setInterval(
        () => send({ type: "heartbeat", requestId: randomUUID() }),
        data.heartbeatIntervalMs,
      );
      // Journal-driven retransmission of durable Cloud delivery state on every (re)attach, for
      // NEGOTIATED Cloud connections only. A legacy E3 channel never touches Cloud state.
      prepareRunnerConnection(state, cloudCapable, {
        ready,
        isClosed: () => closed,
        enqueue: enqueueCloudControl,
        rebind,
        ensureCredential: () =>
          ensureAssignmentCredential(state, data, options.authTimeoutMs ?? PERSISTENT_AUTH_TIMEOUT_MS, {
            required: data.reuseVersion === RUNNER_REUSE_VERSION,
          }),
      });
      logLine(options.stderr, "authenticated control channel ready");
      return;
    };
    const onAcceptance = (data: RunnerAcceptanceRunFrame) => {
      if (state.active || state.turns.hasPendingWork || (state.workspace && !state.workspace.ready)) {
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
        turnSlotAvailable: () => state.turns.notifyAvailable(),
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
            async () => {
              // The trusted-parent marker must survive the seal: a later rebind may only discard
              // this assignment's state when the seal was durably recorded.
              try {
                await markAssignmentSealed(state, config);
              } catch {
                send({
                  type: "workspace:seal:result",
                  requestId: frame.requestId,
                  ok: false,
                  code: "workspace_save_failed",
                });
                return;
              }
              send({ type: "workspace:seal:result", requestId: frame.requestId, ok: true });
            },
            () =>
              send({
                type: "workspace:seal:result",
                requestId: frame.requestId,
                ok: false,
                code: "workspace_save_failed",
              }),
          );
        },
        turns: state.turns,
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
        credential: (credentials) => applyCredential(state, bridge, credentials),
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
  cloudCapable: boolean,
  callbacks: {
    ready: () => void;
    isClosed: () => boolean;
    enqueue: (label: string, operation: () => Promise<void>) => void;
    rebind: () => Promise<boolean>;
    ensureCredential: () => Promise<void>;
  },
): void {
  const workspace = state.workspace;
  if (!workspace) {
    callbacks.ready();
    if (cloudCapable) callbacks.enqueue("reconcile", () => state.turns.reconcile());
    return;
  }
  callbacks.enqueue("restore", async () => {
    // E7 first: a welcome that names a DIFFERENT assignment must clean the sealed old workspace
    // and rebuild the controller before any journal reconciliation runs against the new scope.
    if (!(await callbacks.rebind()) || callbacks.isClosed()) return;
    // A failed save must never hide an already-journaled result behind another restore attempt.
    // Admission remains blocked by workspace.ready while custody/report acknowledgments flow.
    if (cloudCapable) await state.turns.reconcile();
    // The workspace claim uses the Session bearer: it must belong to the current assignment first
    // (a fresh first bind may use the bearer minted for it at creation).
    await callbacks.ensureCredential();
    const currentWorkspace = state.workspace;
    if (!currentWorkspace || !(await currentWorkspace.prepare()) || callbacks.isClosed()) return;
    await state.afterWorkspaceRestore?.();
    state.afterWorkspaceRestore = undefined;
    callbacks.ready();
    if (cloudCapable) await state.turns.reconcile();
    state.turns.notifyAvailable();
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
  bridge: RunnerChannelBridge,
  rebind: () => Promise<boolean>,
): Promise<void> {
  let failures = 0;
  while (!state.stopping && !state.fatal) {
    const outcome = await serveOnce(config, state, sandbox, options, stopListeners, bridge, rebind);
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
async function settleCloudController(state: WorkState | undefined): Promise<void> {
  if (state) state.stopping = true;
  await state?.turns.close().catch(() => undefined);
}

/** Persist the seal-complete assignment marker; a failure must keep the Server's seal retryable. */
async function markAssignmentSealed(state: WorkState, config: RunnerServeConfig): Promise<void> {
  const assignment = state.assignment;
  if (!assignment) return;
  const sealed = { ...assignment, sealed: true };
  await writeRunnerAssignment(config.stateDir, sealed);
  state.assignment = sealed;
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
  credential: (credentials: { token?: string; controlToken?: string }) => void;
  cancel: (id: string) => void;
  error: () => void;
}
/**
 * Renewal-only reply: a fresh Session bearer, a fresh physical control credential, or both. An
 * authenticated connection never accepts it (the Server only sends it for an expired credential).
 */
function dispatchRenewedFrame(data: Extract<RunnerServerFrame, { type: "auth:renewed" }>, c: FrameDispatch): void {
  if (!c.authenticated && c.renewExpired && (data.token !== undefined || data.controlToken !== undefined)) {
    c.credential({
      ...(data.token !== undefined ? { token: data.token } : {}),
      ...(data.controlToken !== undefined ? { controlToken: data.controlToken } : {}),
    });
    c.finish("renewed");
    return;
  }
  c.finish();
}

/** Post-welcome frames that are neither Cloud delivery nor renewal. */
function dispatchEstablishedFrame(data: RunnerServerFrame, c: FrameDispatch): void {
  switch (data.type) {
    case "workspace:seal":
      c.onWorkspaceSeal(data);
      break;
    case "server:heartbeat":
      c.heartbeat();
      break;
    case "server:credential":
      c.credential({ token: data.token, ...(data.controlToken ? { controlToken: data.controlToken } : {}) });
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

function dispatchFrame(data: RunnerServerFrame, c: FrameDispatch): void {
  if (c.closed) return;
  if (data.type === "auth:renewed") {
    dispatchRenewedFrame(data, c);
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
  dispatchEstablishedFrame(data, c);
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
      | "session:message:run"
      | "session:message:verified"
      | "session:message:cancel"
      | "session:message:settled:ack"
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
    frame.type === "session:message:run" ||
    frame.type === "session:message:verified" ||
    frame.type === "session:message:cancel" ||
    frame.type === "session:message:settled:ack" ||
    frame.type === "credential:frame"
  );
}

/**
 * Cloud delivery frames exist only on a negotiated `cloudDeliveryVersion: 1` channel. Session
 * collaboration frames additionally require the E8 echo, so a Server that never negotiated the
 * capability can never cause a session Turn to run. On a legacy channel the frame is a protocol
 * violation: the connection cycles instead of touching Cloud state. Cancellation stays synchronous
 * so it never waits behind queued durable work.
 */
function dispatchCloudFrame(data: CloudServerFrame, c: FrameDispatch): void {
  if (!c.bridge.cloudEnabled) {
    c.finish();
    return;
  }
  if (data.type.startsWith("session:message:") && !c.bridge.sessionCollaborationEnabled) {
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
    case "session:message:run":
      c.enqueueCloudControl("session:message:run", () => c.turns.handleSessionMessageRun(data));
      break;
    case "session:message:verified":
      c.enqueueCloudControl("session:message:verified", () => c.turns.handleSessionMessageVerified(data));
      break;
    case "session:message:cancel":
      c.turns.handleSessionMessageCancel(data.messageId);
      break;
    case "session:message:settled:ack":
      c.enqueueCloudControl("session:message:settled:ack", () => c.turns.handleSessionMessageSettledAck(data));
      break;
    case "credential:frame":
      c.bridge.emitCredential(data.frame);
      break;
  }
}
