import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EffectiveRuntimeSnapshot, RunnerCloudTurnWorkerRequest } from "@opentag/shared";
import type {
  AgentPromptRequest,
  AgentRunResult,
  AgentRuntimeBinding,
  AgentRuntimeEvent,
  CreateAgentRuntimeRequest,
  ResumeAgentRuntimeRequest,
} from "../agent-runtime/types.js";
import { prepareSandboxCa } from "../cloud-runtime/sandbox-ca.js";
import {
  CLOUD_CONNECT_PROXY_PORT,
  CLOUD_EXECUTION_MOUNT,
  CLOUD_SLACK_API_PORT,
} from "../cloud-runtime/sandbox-entry.js";
import { type SandboxLoopbackForwarder, startSandboxLoopbackForwarder } from "../cloud-runtime/sandbox-loopback.js";
import { PiAgentRuntimeFactory } from "../providers/pi/agent-runtime.js";
import type { PiRpcProcessSpawnOptions } from "../providers/pi/rpc-wire.js";
import {
  buildAgentInput,
  completionForError,
  completionForResult,
  type TurnCompletion,
  turnTimeoutMs,
} from "../runtime/agent-turn-runner.js";
import { serializeEnvironment } from "../runtime/im-credential-environment-manager.js";
import { providerRoutingEnvironment, RUNTIME_PROXY_PROVIDER_URL_KEY } from "../runtime/runtime-proxy-material.js";
import { skillArgsOf } from "./acceptance.js";
import { registerRunnerSignalCleanup } from "./signals.js";
import { assembleRunnerToolSkills } from "./skills.js";

/**
 * In-sandbox Cloud Turn worker (E4). Runs INSIDE the native Sandbox (or the local harness seam).
 * The bounded stdin document is the only control input: the delivery payload, the
 * execution-scoped model grant, and the per-execution public material directory written by the
 * trusted Runner. The model token and proxy handles land only in a disposable Pi home inside the
 * disposable sandbox filesystem — never in argv, logs, the Session workspace, or any parent-visible
 * location. stdout carries exactly one JSON result line.
 *
 * Continuity: one Cloud Sandbox serves exactly one Agent Session, so the worker keeps the Pi
 * conversation directory and the persisted provider binding under the Session workspace's private
 * `.opentag/pi-session` subtree across Turns of that allocation (it survives a native rootfs
 * reset). A same-Session second message resumes the exact binding/history instead of starting a
 * blank Pi session; E5 restores that directory before a replacement allocation becomes ready.
 * Model grants and the published proxy environment are per-turn scratch files and are
 * never part of the persisted conversation state.
 *
 * The proxy environment manifest the trusted Runner published is applied to the Pi process so IM
 * and Git CLIs reach providers through the trusted Relay/adapter; the platform master key and raw
 * IM tokens never enter the Sandbox. Only the execution-scoped routing inputs reach the Pi
 * process; the standard proxy/CA variables are derived inside provider launchers and in the
 * scratch provider env file the model sources explicitly, so the Agent's ordinary subprocesses
 * keep public routing and the system trust store.
 *
 * NATIVE UDS BOUNDARY: production always requires BOTH real mounted `connect.sock`/`slack.sock`
 * endpoints. The loopback fallback exists ONLY for the explicit local test seam
 * `localProxyLoopbackSeam: true`; production never sets it, so a missing native mount fails the
 * Turn before Pi starts. Whether a bind-mounted Unix socket is connectable through the native
 * Cloud Run Sandbox supervisor remains live-unverified until a GCP acceptance run.
 *
 * Cancellation: the worker kills every Pi child it owns and closes the runtime; a SIGTERM cleanup
 * failure is surfaced on stderr, never swallowed.
 */

/** Pi custom provider name for the Server-mediated model path. */
export const CLOUD_MODEL_PI_PROVIDER = "opentag";

const TURN_POLICY = {
  approvals: "never" as const,
  fileSystem: "unrestricted" as const,
  network: "enabled" as const,
  tools: { mode: "provider-default" as const },
};

/** Pi conversation/binding subtree inside the Session workspace; survives a native reset. */
export const CLOUD_TURN_CONTINUITY_SUBDIRECTORY = ".opentag/pi-session";
const BINDING_FILE_NAME = "pi-binding.json";

const ProxyEnvironmentManifestSchema = {
  parse(value: unknown): { executionId: string; environment: Record<string, string> } {
    if (typeof value !== "object" || value === null) throw new Error("The proxy environment manifest is invalid");
    const record = value as Record<string, unknown>;
    if (
      typeof record.executionId !== "string" ||
      typeof record.environment !== "object" ||
      record.environment === null
    ) {
      throw new Error("The proxy environment manifest is invalid");
    }
    const environment: Record<string, string> = {};
    for (const [key, entry] of Object.entries(record.environment)) {
      if (typeof entry === "string") environment[key] = entry;
    }
    return { executionId: record.executionId, environment };
  },
};

const PersistedBindingSchema = {
  parse(value: unknown): AgentRuntimeBinding {
    if (typeof value !== "object" || value === null) throw new Error("The persisted Pi binding is invalid");
    const record = value as Record<string, unknown>;
    if (
      typeof record.providerId !== "string" ||
      typeof record.schemaVersion !== "number" ||
      typeof record.payload !== "object" ||
      record.payload === null
    ) {
      throw new Error("The persisted Pi binding is invalid");
    }
    return {
      payload: record.payload as AgentRuntimeBinding["payload"],
      providerId: record.providerId,
      schemaVersion: record.schemaVersion,
    };
  },
};

function trackedSpawn(pids: Set<number>) {
  return (command: string, args: readonly string[], spawnOptions: PiRpcProcessSpawnOptions) => {
    const child = spawn(command, [...args], { ...spawnOptions, stdio: "pipe" }) as ChildProcessWithoutNullStreams;
    if (typeof child.pid === "number") pids.add(child.pid);
    return child;
  };
}

/** Terminate every Pi child this worker owns; SIGKILL escalation is bounded and unref'd. */
function terminateTrackedProcesses(pids: Set<number>, options: { immediate?: boolean } = {}): void {
  const signalled: number[] = [];
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
      signalled.push(pid);
    } catch {
      pids.delete(pid);
    }
  }
  if (signalled.length === 0) return;
  const escalate = () => {
    for (const pid of signalled) {
      /* v8 ignore next -- signal races are expected while terminating. */
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
      pids.delete(pid);
    }
  };
  if (options.immediate) {
    escalate();
    return;
  }
  const escalation = setTimeout(escalate, 2_000);
  escalation.unref?.();
}

/**
 * Cloud-accurate managed system prompt. The Local renderer (`renderManagedSystemPrompt`) asserts a
 * persistent Agent Home shared across an Agent's Sessions and Context Tree/Session-CLI access —
 * none of which hold inside a Session-scoped Cloud Sandbox (E8 is deferred), so the Cloud
 * worker renders the deployment's platform/agent/session instructions with Cloud-true context and
 * never reuses the Local wording.
 */
export function renderCloudSystemPrompt(snapshot: EffectiveRuntimeSnapshot): string {
  return [
    "# OpenTag managed instructions",
    "",
    "These trusted instructions are injected through the Agent Runtime Provider's native system prompt.",
    "",
    "## Cloud execution context",
    "",
    "- You run inside a Session-scoped Cloud Sandbox. The workspace is this Session's own; it is not shared with other Sessions.",
    "- The workspace and Pi conversation for this Session recover from the last successful save when the environment is replaced. Unsaved changes can be lost; running processes and background services do not survive Turn cleanup or replacement.",
    "- Saved workspaces are limited to 256 MiB of file content, 50,000 entries and a 128 MiB compressed archive. Hard links, sockets, FIFOs and links outside the workspace cannot be saved. Keep dependency caches, large installs and disposable build output outside the workspace (for example /tmp); recreate them on later Turns. Exceeding these limits blocks further execution and requires recovery or explicit discard of unsaved changes.",
    "- Credentials are execution-scoped and short-lived; the managed IM/Git CLIs reach providers through the platform proxy. Never ask the user for tokens and never persist credential material.",
    "",
    "## Platform",
    "",
    snapshot.instructions.platform,
    "",
    "## Agent",
    "",
    snapshot.instructions.agent,
    "",
    ...(snapshot.instructions.session ? ["## Session", "", snapshot.instructions.session, ""] : []),
  ].join("\n");
}

/** The model grant becomes exactly one disposable Pi provider document set. */
export function cloudTurnPiDocuments(request: RunnerCloudTurnWorkerRequest): {
  authJson: string;
  modelsJson: string;
  settingsJson: string;
} {
  const model = request.model;
  const authJson = `${JSON.stringify({ [CLOUD_MODEL_PI_PROVIDER]: { type: "api_key", key: model.token } }, null, 2)}\n`;
  const modelsJson = `${JSON.stringify(
    {
      providers: {
        [CLOUD_MODEL_PI_PROVIDER]: {
          api: "openai-completions",
          baseUrl: model.baseUrl,
          models: [{ id: model.model, name: model.model }],
        },
      },
    },
    null,
    2,
  )}\n`;
  const settingsJson = `${JSON.stringify(
    {
      defaultModel: `${CLOUD_MODEL_PI_PROVIDER}/${model.model}`,
      defaultProvider: CLOUD_MODEL_PI_PROVIDER,
    },
    null,
    2,
  )}\n`;
  return { authJson, modelsJson, settingsJson };
}

/** The exact runtime surface the Turn worker drives; the real factory satisfies it. */
export interface CloudTurnPiFactory {
  create(request: CreateAgentRuntimeRequest): Promise<CloudTurnPiRuntime>;
  resume(request: ResumeAgentRuntimeRequest): Promise<CloudTurnPiRuntime>;
}

export interface CloudTurnPiRuntime {
  prompt(request: AgentPromptRequest): Promise<AgentRunResult>;
  close(): Promise<void>;
}

export interface CloudTurnWorkerRunOptions {
  readonly now?: () => number;
  readonly signal?: AbortSignal;
  readonly workspace: string;
  /**
   * Allocation-stable in-sandbox directory for Pi continuity. Defaults to the Session
   * workspace's private `.opentag/pi-session` subtree so a native rootfs reset preserves history.
   */
  readonly continuityDirectory?: string;
  /**
   * In-sandbox mount point the public execution directories live under. Production always uses
   * the fixed `CLOUD_EXECUTION_MOUNT`; the local acceptance harness may relocate it so the same
   * validation code runs off a disposable fixture. NEVER a host path in production.
   */
  readonly executionMount?: string;
  /**
   * Test-only local seam: with no mounted proxy sockets at all, accept the manifest's fixed
   * loopback endpoints instead of failing. Production never sets this; both real Unix sockets are
   * required there, so a missing native mount can never degrade into a loopback execution.
   */
  readonly localProxyLoopbackSeam?: boolean;
  /** Test seam: build the Pi factory for this turn (production builds the real one). */
  readonly createPiFactory?: (input: {
    readonly environment: Record<string, string>;
    readonly sessionDirectory: string;
    readonly pids: Set<number>;
  }) => CloudTurnPiFactory;
}

export async function runCloudTurnWorker(
  request: RunnerCloudTurnWorkerRequest,
  options: CloudTurnWorkerRunOptions,
): Promise<TurnCompletion> {
  assertSafeInSandboxPath(request.executionDir, "execution directory");
  const executionMount = options.executionMount ?? CLOUD_EXECUTION_MOUNT;
  if (!request.executionDir.startsWith(`${executionMount}/`)) {
    throw new Error("The Turn execution directory is outside the Sandbox mount");
  }
  const continuityDirectory = assertSafeInSandboxPath(
    request.piSessionDirectory ??
      options.continuityDirectory ??
      join(assertSafeInSandboxPath(options.workspace, "workspace"), CLOUD_TURN_CONTINUITY_SUBDIRECTORY),
    "continuity directory",
  );
  const scratch = await mkdtemp(join(tmpdir(), "opentag-cloud-turn-"));
  const pids = new Set<number>();
  let forwarder: SandboxLoopbackForwarder | undefined;
  let runtime: CloudTurnPiRuntime | undefined;
  // A SIGTERM must terminate the real Pi tree and release the forwarder/scratch. Failures are
  // written to stderr by the signal handler instead of being silently ignored.
  registerRunnerSignalCleanup(async () => {
    terminateTrackedProcesses(pids, { immediate: true });
    const failures: unknown[] = [];
    await runtime?.close().catch((error: unknown) => failures.push(error));
    await forwarder?.close().catch((error: unknown) => failures.push(error));
    await rm(scratch, { recursive: true, force: true }).catch((error: unknown) => failures.push(error));
    if (failures.length > 0) {
      throw new Error(`Cloud Turn signal cleanup failed: ${failures.map((error) => String(error)).join("; ")}`);
    }
  });
  try {
    const home = join(scratch, "home");
    const piHome = join(scratch, "pi-agent");
    const sessionDirectory = join(continuityDirectory, "sessions");
    await mkdir(home, { recursive: true, mode: 0o700 });
    await mkdir(piHome, { recursive: true, mode: 0o700 });
    await mkdir(sessionDirectory, { recursive: true, mode: 0o700 });
    const bindingFile = join(continuityDirectory, BINDING_FILE_NAME);

    // Per-execution proxy material published by the trusted Runner (read-only mount).
    const manifest = ProxyEnvironmentManifestSchema.parse(
      JSON.parse(await readFile(join(request.executionDir, "environment.json"), "utf8")),
    );
    forwarder = await openProxyBridge(request.executionDir, manifest.environment, options);

    const documents = cloudTurnPiDocuments(request);
    await writeFile(join(piHome, "auth.json"), documents.authJson, { mode: 0o600 });
    await writeFile(join(piHome, "models.json"), documents.modelsJson, { mode: 0o600 });
    await writeFile(join(piHome, "settings.json"), documents.settingsJson, { mode: 0o600 });

    const baseEnvironment: NodeJS.ProcessEnv = {
      HOME: home,
      LANG: "C.UTF-8",
      PATH: `${request.executionDir}/bin:/usr/local/bin:/opt/opentag/tools/bin:/usr/bin:/bin`,
      PI_CODING_AGENT_DIR: piHome,
      PI_CODING_AGENT_SESSION_DIR: sessionDirectory,
      TMPDIR: tmpdir(),
      ...manifest.environment,
    };
    const { environment } = prepareSandboxCa({
      destination: join(home, ".opentag", "ca.pem"),
      environment: baseEnvironment,
      mount: request.executionDir,
    });
    const runtimeEnvironment = environment as Record<string, string>;
    // The managed outbox instructions tell the model to load provider credentials from
    // `$OPENTAG_PROVIDER_ENV_FILE`. Publish that per-turn file inside the disposable scratch so
    // the same instruction works inside the Sandbox; it dies with the scratch and is never part
    // of the persistent Pi conversation directory. The file additionally exposes the scoped
    // routing inputs as standard proxy/CA variables for exactly the shell that sources it, which
    // is what the Slack raw file upload/download flow needs; the Pi process itself never gets
    // them. CA paths follow the Sandbox-owned copy prepared above.
    const providerEnvironmentPath = join(scratch, "provider-environment.sh");
    await writeFile(
      providerEnvironmentPath,
      serializeEnvironment({ ...environment, ...providerRoutingEnvironment(environment) }, process.platform),
      { mode: 0o600 },
    );
    runtimeEnvironment.OPENTAG_PROVIDER_ENV_FILE = providerEnvironmentPath;

    // Reuse the E3 Runner tool skills (`git`/`gh`/`lark-cli`/`slack`) through the same assembly and
    // argument helper; an empty skill set is the honest host-dev case, never a different runtime.
    const toolSkills = await assembleRunnerToolSkills();
    const skillPaths = toolSkills.skills.map((skill) => skill.directory);
    const factory =
      options.createPiFactory?.({ environment: runtimeEnvironment, pids, sessionDirectory }) ??
      new PiAgentRuntimeFactory({
        process: {
          args: skillArgsOf(skillPaths),
          command: "pi",
          env: environment,
          sessionDirectory,
          // E3 measured native Cloud Pi startup above the Local 5s default; keep the verified budget.
          probeTimeoutMs: 30_000,
          spawnProcess: trackedSpawn(pids),
        },
      });

    const configuration = {
      model: `${CLOUD_MODEL_PI_PROVIDER}/${request.model.model}`,
      ...(request.delivery.runtime.reasoningEffort
        ? { reasoningEffort: request.delivery.runtime.reasoningEffort }
        : {}),
    };
    const common = {
      configuration,
      eventSink: async (event: AgentRuntimeEvent) => {
        if (event.type === "binding_changed") await persistBinding(bindingFile, event.binding);
      },
      policy: TURN_POLICY,
      systemPrompt: renderCloudSystemPrompt(request.delivery.runtime),
      workspace: { cwd: options.workspace, environment: runtimeEnvironment },
    };
    const persisted = await readPersistedBinding(bindingFile);
    const activeRuntime = persisted
      ? await factory.resume({ ...common, binding: persisted })
      : await factory.create(common);
    runtime = activeRuntime;

    const timeout = turnTimeoutMs(request.delivery, options.now?.() ?? Date.now());
    const deadline = AbortSignal.timeout(Math.max(1, timeout));
    const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
    const onAbort = () => terminateTrackedProcesses(pids);
    signal.addEventListener("abort", onAbort, { once: true });
    let completion: TurnCompletion;
    // Distinguish a caller stop from the Turn deadline at the moment the run settles.
    const stopReason = () =>
      options.signal?.aborted ? "client_shutdown" : deadline.aborted ? "turn_timeout" : undefined;
    try {
      const result = await activeRuntime.prompt({
        runId: randomTurnRunId(request),
        configuration,
        input: buildAgentInput(request.delivery),
        signal,
      });
      // A completed result is preserved; a stop/timeout that raced a failed result maps true.
      completion =
        result.status === "completed"
          ? completionForResult(result, undefined)
          : completionForResult(result, stopReason());
    } catch (error) {
      completion = completionForError(error, stopReason());
    } finally {
      signal.removeEventListener("abort", onAbort);
      await activeRuntime.close().catch(() => undefined);
      terminateTrackedProcesses(pids);
    }
    return completion;
  } finally {
    registerRunnerSignalCleanup(undefined);
    await forwarder?.close().catch(() => undefined);
    await rm(scratch, { recursive: true, force: true });
  }
}

/**
 * Bridge the manifest's fixed loopback ports to the mounted per-execution Unix sockets. The native
 * path requires BOTH sockets to be real sockets; a partial mount or a missing native socket with a
 * socket-oriented manifest fails closed. Only the explicit local seam (no sockets at all AND the
 * manifest naming the fixed loopback ports) skips the forwarder.
 */
async function openProxyBridge(
  executionDir: string,
  environment: Record<string, string>,
  options: CloudTurnWorkerRunOptions,
): Promise<SandboxLoopbackForwarder | undefined> {
  const connectSocket = join(executionDir, "connect.sock");
  const slackSocket = join(executionDir, "slack.sock");
  const kinds = await Promise.all([socketKind(connectSocket), socketKind(slackSocket)]);
  const sockets = kinds.filter((kind) => kind === "socket").length;
  if (sockets === 2) {
    return startSandboxLoopbackForwarder({
      endpoints: [
        { name: "connect", port: CLOUD_CONNECT_PROXY_PORT },
        { name: "slack", port: CLOUD_SLACK_API_PORT },
      ],
      mount: executionDir,
    });
  }
  if (sockets !== 0) {
    throw new Error("The per-execution proxy Unix sockets are incomplete");
  }
  if (options.localProxyLoopbackSeam !== true) {
    throw new Error(
      "The per-execution proxy Unix sockets are missing; the native connect.sock/slack.sock mounts are required",
    );
  }
  // Explicit local test seam only: the manifest must still name the fixed loopback endpoint.
  const loopback = environment[RUNTIME_PROXY_PROVIDER_URL_KEY];
  if (loopback !== `http://127.0.0.1:${CLOUD_CONNECT_PROXY_PORT}`) {
    throw new Error("The proxy manifest names no mounted Unix socket and no fixed loopback endpoint");
  }
  return undefined;
}

async function socketKind(path: string): Promise<"missing" | "other" | "socket"> {
  try {
    const stats = await lstat(path);
    return stats.isSocket() ? "socket" : "other";
  } catch {
    return "missing";
  }
}

async function readPersistedBinding(path: string): Promise<AgentRuntimeBinding | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  return PersistedBindingSchema.parse(JSON.parse(raw));
}

/** Atomic binding persistence: the next Turn resumes exactly this provider binding. */
async function persistBinding(path: string, binding: AgentRuntimeBinding): Promise<void> {
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(binding)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

/** An in-sandbox path only; the trusted parent never supplies a host path here. */
function assertSafeInSandboxPath(value: string, label: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 512 ||
    !value.startsWith("/") ||
    value.split("/").includes("..") ||
    /[\0\n\r]/.test(value)
  ) {
    throw new Error(`Unsafe ${label} for the Cloud Turn worker`);
  }
  return value;
}

function randomTurnRunId(request: RunnerCloudTurnWorkerRequest): string {
  return `cloud-turn-${request.delivery.deliveryId}`;
}
