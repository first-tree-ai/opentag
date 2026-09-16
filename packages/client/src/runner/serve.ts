import { randomInt, randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RUNNER_WS_PROTOCOL_VERSION,
  RunnerAcceptanceReportWireSchema,
  type RunnerAcceptanceRunFrame,
  type RunnerServerFrame,
  RunnerServerFrameSchema,
  type RunnerWelcomeFrame,
  serializeRunnerAcceptanceWorkerStdin,
} from "@opentag/shared";
import WebSocket, { type ClientOptions } from "ws";
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
  /** Declared platform container port for the startup probe; absent means no health listener. */
  readonly healthPort?: number;
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
}

const DEFAULT_AUTH_TIMEOUT_MS = 5_000;
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
  return {
    backendUrl: resolveRunnerBackendUrl(backendRaw),
    bootstrapToken: token,
    sandboxName,
    workspace: env.OPENTAG_RUNNER_WORKSPACE ?? join(tmpdir(), "opentag-runner-workspaces", sandboxName),
    ...(healthPort !== undefined ? { healthPort } : {}),
  };
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

interface WorkState {
  active?: { requestId: string; abort: AbortController; done: Promise<void> };
  probe: SandboxProbeResult;
  stopping: boolean;
  fatal: boolean;
  present: boolean;
  token: string;
}
export async function runRunnerServe(config: RunnerServeConfig, options: RunnerServeOptions): Promise<number> {
  let sandbox: NativeSandbox;
  try {
    sandbox = (options.sandboxFactory ?? ((name, workspace) => new NativeSandbox({ name, workspace })))(
      config.sandboxName,
      config.workspace,
    );
  } catch (error) {
    reportStartupError(error, options);
    return startupExitCode(error);
  }
  let state: WorkState | undefined;
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
    // The platform's default TCP startup probe needs a listening socket on the declared port.
    // Start it only after native readiness is proven, and only when the platform provided PORT.
    if (!stopping && config.healthPort !== undefined) {
      health = await startRunnerHealthListener({
        port: config.healthPort,
        onError: (message) => logLine(options.stderr, `startup health listener error: ${message}`),
      });
      logLine(options.stderr, `startup health listener ready on port ${health.port}`);
    }
    await maintainConnections(config, state, sandbox, options, stopListeners);
    result = stopping ? exitCode : state.fatal ? 5 : 1;
  } catch (error) {
    reportStartupError(error, options);
    if (error instanceof NativeSandboxError && error.code === "unavailable") launchAttempted = false;
    result = startupExitCode(error);
  } finally {
    // The probe listener and process handlers are released even when sandbox cleanup throws.
    try {
      if (!(await cleanupRunner(sandbox, state, launchAttempted, options))) result = 5;
    } finally {
      await health?.close();
      removeSignals();
    }
  }
  return result;
}
interface ConnectionOutcome {
  /**
   * "auth_failed" is the ONLY permanent outcome: an explicit in-band `auth:result ok:false`.
   * "auth_timeout" and "closed" are transport failures and take the backoff reconnect path.
   */
  kind: "closed" | "auth_failed" | "auth_timeout";
  healthy: boolean;
}
async function serveOnce(
  config: RunnerServeConfig,
  state: WorkState,
  sandbox: NativeSandbox,
  options: RunnerServeOptions,
  stopListeners: Set<() => void>,
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
    const finish = (kind: ConnectionOutcome["kind"] = "closed") => {
      if (closed) return;
      closed = true;
      clearTimeout(authTimer);
      clearInterval(heartbeatTimer);
      clearTimeout(silenceTimer);
      stopListeners.delete(stop);
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
    const authTimer = setTimeout(() => finish("auth_timeout"), options.authTimeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS);
    const ready = () =>
      send({
        type: "runner:ready",
        requestId: randomUUID(),
        readiness: { sandboxName: config.sandboxName, rootfs: SANDBOX_ROOTFS, ...state.probe },
      });
    socket.on("open", () => send({ type: "auth", requestId: randomUUID(), token: state.token }));
    const onWelcome = (data: RunnerWelcomeFrame) => {
      if (
        welcome ||
        data.protocolVersion !== RUNNER_WS_PROTOCOL_VERSION ||
        !data.resourceName.endsWith(`/instances/${config.sandboxName}`)
      ) {
        finish();
        return;
      }
      welcome = data;
      welcomeAt = Date.now();
      clearTimeout(authTimer);
      ready();
      armSilence();
      heartbeatTimer = setInterval(
        () => send({ type: "heartbeat", requestId: randomUUID() }),
        data.heartbeatIntervalMs,
      );
      logLine(options.stderr, "authenticated control channel ready");
      return;
    };
    const onAcceptance = (data: RunnerAcceptanceRunFrame) => {
      if (state.active) {
        send({
          type: "acceptance:result",
          requestId: data.requestId,
          outcome: "failed",
          failure: { code: "runner_busy", message: "An acceptance run is already active" },
        });
        return;
      }
      if (data.deadlineAtMs <= Date.now()) {
        send({ type: "acceptance:result", requestId: data.requestId, outcome: "cancelled" });
        return;
      }
      startAcceptance(data, state, sandbox, { send, ready, finish, isClosed: () => closed });
      return;
    };
    const handle = (data: RunnerServerFrame) =>
      dispatchFrame(data, {
        closed,
        authenticated,
        welcomed: welcome !== undefined,
        finish,
        armSilence,
        onWelcome,
        onAcceptance,
        authResult: (ok) => {
          // Only an explicit in-band rejection is permanent; a duplicate grant is idempotent.
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
): Promise<void> {
  let failures = 0;
  while (!state.stopping && !state.fatal) {
    const outcome = await serveOnce(config, state, sandbox, options, stopListeners);
    // This barrier covers worker exit AND native deletion/recreation. No successor connection
    // can dispatch work into a sandbox still owned by the prior connection.
    await state.active?.done;
    if (state.stopping || state.fatal) break;
    if (outcome.kind === "auth_failed") {
      // The Server explicitly rejected the credential in-band; retrying the same token is
      // pointless, so the Runner exits for an operator or an Account stop/start to intervene.
      logLine(options.stderr, "Runner authentication rejected");
      break;
    }
    if (outcome.kind === "auth_timeout") {
      logLine(options.stderr, "Runner authentication timed out; reconnecting");
    }
    failures = outcome.healthy ? 0 : failures + 1;
    if (failures >= (options.maxReconnectAttempts ?? DEFAULT_MAX_RECONNECT_ATTEMPTS)) break;
    const delay = Math.min(1_000 * 2 ** failures, 30_000) + (options.randomJitter ?? randomInt)(500);
    await waitReconnect(delay, state, options, stopListeners);
  }
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
      await sandbox.destroy();
      state.present = false;
      if (!state.stopping) {
        state.present = true;
        await sandbox.launch();
        state.probe = await sandbox.probe();
      }
    } catch {
      state.fatal = true;
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
    if (state.fatal) callbacks.finish();
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
  finish: (kind?: ConnectionOutcome["kind"]) => void;
  armSilence: () => void;
  onWelcome: (frame: RunnerWelcomeFrame) => void;
  onAcceptance: (frame: RunnerAcceptanceRunFrame) => void;
  authResult: (ok: boolean) => void;
  heartbeat: () => void;
  credential: (token: string) => void;
  cancel: (id: string) => void;
  error: () => void;
}
function dispatchFrame(data: RunnerServerFrame, c: FrameDispatch): void {
  if (c.closed) return;
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
  switch (data.type) {
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
