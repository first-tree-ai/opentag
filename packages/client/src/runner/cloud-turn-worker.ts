import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EffectiveRuntimeSnapshot, RunnerCloudWorkerRequest } from "@opentag/shared";
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
import { completionForError, completionForResult, type TurnCompletion } from "../runtime/agent-turn-runner.js";
import { serializeEnvironment } from "../runtime/im-credential-environment-manager.js";
import { providerRoutingEnvironment, RUNTIME_PROXY_PROVIDER_URL_KEY } from "../runtime/runtime-proxy-material.js";
import { skillArgsOf } from "./acceptance.js";
import {
  CLOUD_CONTEXT_TREE_PREPARATION_BUDGET_MS,
  type CloudContextTreePreparation,
  type CloudContextTreePreparationInput,
  type CloudContextTreeStatus,
  cloudAgentSlug,
  prepareCloudContextTree,
} from "./cloud-context-tree.js";
import {
  cloudSessionCliEnvironment,
  cloudWorkerInput,
  cloudWorkerRuntime,
  cloudWorkerTimeout,
} from "./cloud-worker-input.js";
import { registerRunnerSignalCleanup } from "./signals.js";
import { assembleContextTreeSkills, assembleRunnerToolSkills } from "./skills.js";

/**
 * In-sandbox Cloud worker: one IM Turn or Session message inside the disposable Sandbox. The
 * bounded stdin document is the only control input; model grants, proxy handles and Session
 * proofs land only in disposable scratch or the disposable Pi home — never in argv, logs, the
 * workspace, or parent-visible storage. stdout carries exactly one JSON result line.
 *
 * Continuity: the Pi conversation and persisted binding live under the Session workspace's
 * private `.opentag/pi-session` subtree (or the supplied allocation-stable directory), so a
 * same-Session next message resumes the exact history instead of a blank Pi session; E5 restores
 * that directory before a replacement allocation becomes ready. Grants and scratch files are
 * per-message and never persist.
 *
 * The per-execution proxy manifest is the only credential source for Pi and its tools; platform
 * keys and raw IM tokens never enter the Sandbox, and routing/CA variables reach only the
 * provider shell that sources them. NATIVE UDS BOUNDARY: production requires both mounted
 * `connect.sock`/`slack.sock`; the loopback fallback exists only for the explicit
 * `localProxyLoopbackSeam` test seam. Cancellation kills every Pi child this worker owns.
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
 * Optional context for the Cloud system prompt: this Turn's Context Tree status and whether the
 * execution holds real Session-collaboration material (proof and server URL). Absent context
 * keeps the corresponding sections out of the prompt.
 */
export interface CloudSystemPromptContext {
  readonly contextTree?: CloudContextTreeStatus;
  readonly sessionCollaboration?: boolean;
}

/**
 * Cloud-accurate managed system prompt. It never reuses the Local renderer's persistent Agent
 * Home / shared-workspace wording; the Context Tree and Session sections appear only with real
 * per-Turn state.
 */
export function renderCloudSystemPrompt(
  snapshot: EffectiveRuntimeSnapshot,
  context?: CloudSystemPromptContext,
): string {
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
    ...renderCloudContextTree(snapshot, context?.contextTree),
    ...(context?.sessionCollaboration
      ? [
          "## Session collaboration",
          "",
          "Use `opentag session create`, `opentag session send`, and `opentag session list` to coordinate authorized Sessions of this Agent. Use `--help` for command options.",
          "Each Cloud Session has its own workspace and history. Send relevant information explicitly; another Session cannot read this workspace. Only published Context Tree knowledge is shared.",
          "Your source Session identity is supplied by this execution. Do not copy or persist its temporary proof. A child Session reports through `opentag session send`; its final text is not automatically returned to its parent.",
          "",
        ]
      : []),
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

/**
 * The Context Tree section the Cloud Sandbox can truthfully offer. The Agent is told plainly when
 * durable memory is absent or stale, so it cannot mistake a failed connection for an empty tree or
 * a failed synchronization for the newest published state.
 */
function renderCloudContextTree(
  snapshot: EffectiveRuntimeSnapshot,
  status: CloudContextTreeStatus | undefined,
): readonly string[] {
  if (!status) return [];
  if (status.status === "configured") {
    return [
      "## Context Trees",
      "Trees have no implied precedence. Use the upstream skills to select relevant trees, attribute disagreements to aliases, and choose an explicit write destination.",
      ...status.connections.flatMap((entry) => [
        `Alias ${entry.alias} — ${entry.repository}:`,
        ...renderCloudTreeFacts(entry),
      ]),
      ...new Set(status.connections.flatMap((entry) => renderCloudTreeGuidance(snapshot, entry))),
    ];
  }
  return ["## Context Tree", "", ...renderCloudTreeFacts(status), ...renderCloudTreeGuidance(snapshot, status)];
}

function renderCloudTreeFacts(status: Exclude<CloudContextTreeStatus, { status: "configured" }>): readonly string[] {
  if (status.status === "ready")
    return [
      `Context Tree: ${status.treePath} — synchronized at the start of this Turn${
        status.branch && status.sha ? ` (branch ${status.branch}, commit ${status.sha.slice(0, 12)})` : ""
      }.`,
    ];
  if (status.status === "stale")
    return [
      `Context Tree: ${status.treePath} — ${
        status.reason === "DIRTY_TREE"
          ? "the preserved checkout has unpublished changes"
          : `this Turn's synchronization failed (${status.reason})`
      }.`,
    ];
  if (status.status === "unconfigured")
    return [
      "Context Tree: disabled for this Agent (no Context Tree repository is selected on the Agent's Context Tree page).",
    ];
  return [`Context Tree unavailable (${status.reason}).`];
}

function renderCloudTreeGuidance(
  snapshot: EffectiveRuntimeSnapshot,
  status: Exclude<CloudContextTreeStatus, { status: "configured" }>,
): readonly string[] {
  if (status.status === "ready") {
    const slug = cloudAgentSlug(snapshot.instructions.platform);
    const member = slug
      ? `Your Agent slug is \`${slug}\` (also stated in the Platform section): \`members/${slug}/\` is your own private working memory in the tree. Do not write to another Agent's member directory.`
      : "`members/<your Agent slug>/` is your own private working memory in the tree; the Agent slug is stated in the Platform section below. Do not write to another Agent's member directory.";
    return [
      "Ready Context Trees are connected on this Agent's Context Tree page. Each checkout lives inside this Session's own workspace and is saved and restored with it, including unpublished drafts. Only the published tree is shared with other Agents that select the same repository; your files and Pi conversation stay private to this Session.",
      "Read the decisions that bear on a task before planning or changing code, and record durable decisions there. Use the context-tree-read and context-tree-write skills; the `context-tree` command is on PATH.",
      member,
      "",
    ];
  }
  if (status.status === "stale") {
    const dirty = status.reason === "DIRTY_TREE";
    return [
      ...(dirty
        ? [
            "For stale trees with unpublished changes: the changes were left untouched. Inspect them with the `context-tree` command (`context-tree read --tree-path <tree> …`, `context-tree verify --tree-path <tree>`) or with `git`, and continue any prepared write worktree. Synchronizing or publishing will keep failing until the changes are committed or otherwise resolved; do not reset or discard them silently.",
          ]
        : [
            "For other stale trees, the on-disk copy may be outdated: it is not confirmed to be the newest published state. Unpublished drafts were left untouched. You may read the local copy as potentially stale context, and expect synchronizing or publishing to fail until a later Turn succeeds.",
          ]),
      "",
    ];
  }
  if (status.status === "unconfigured") {
    return [
      "Durable memory is not active. Do not assume earlier decisions were recorded, and do not create or connect a tree yourself.",
      "",
    ];
  }
  return [
    "Unavailable trees are not active for this Turn; other ready trees remain usable. Continue the task without those trees. Do not assume earlier decisions were recorded, and do not attempt to repair, create, or connect a tree yourself. Any unpublished drafts from earlier Turns remain preserved in this Session's workspace.",
    ...(status.reason === "GITHUB_PERMISSION"
      ? [
          "The current execution does not grant this Session the selected repository, so the managed connection stays detached until the grant returns.",
        ]
      : []),
    ...(status.reason === "DIRTY_TREE"
      ? [
          "The preserved checkout contains unpublished changes from an earlier Turn. They were left untouched; do not commit, reset, or discard them silently — report their presence.",
        ]
      : []),
    "",
  ];
}

/** The model grant becomes exactly one disposable Pi provider document set. */
export function cloudTurnPiDocuments(request: RunnerCloudWorkerRequest): {
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
          // Router accepts at most 8,192 output tokens and has no OpenAI `store` option.
          models: [{ id: model.model, name: model.model, maxTokens: 8_192, compat: { supportsStore: false } }],
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
  /**
   * Test seam: replace Context Tree preparation (production runs the packaged CLI through
   * `prepareCloudContextTree`). Receives only per-Turn, in-sandbox inputs.
   */
  readonly prepareContextTree?: (input: CloudContextTreePreparationInput) => Promise<CloudContextTreePreparation>;
  /** Test seam: override the bounded pre-run Context Tree preparation budget. */
  readonly contextTreePreparationBudgetMs?: number;
  /** Test seam: build the Pi factory for this turn (production builds the real one). */
  readonly createPiFactory?: (input: {
    readonly environment: Record<string, string>;
    readonly sessionDirectory: string;
    readonly pids: Set<number>;
  }) => CloudTurnPiFactory;
}

/** The effective execution bounds shared by optional preparation and the Pi run. */
interface TurnExecutionContext {
  readonly signal: AbortSignal;
  readonly stopReason: () => string | undefined;
}

function createTurnExecutionContext(
  request: RunnerCloudWorkerRequest,
  options: CloudTurnWorkerRunOptions,
): TurnExecutionContext {
  const deadline = AbortSignal.timeout(Math.max(1, cloudWorkerTimeout(request, options.now?.() ?? Date.now())));
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  return {
    signal,
    // Distinguish a caller stop from the Turn deadline at the moment a stop is observed.
    stopReason: () => (options.signal?.aborted ? "client_shutdown" : deadline.aborted ? "turn_timeout" : undefined),
  };
}

/**
 * Optional pre-run memory with its own small budget on top of the Turn execution bounds. It is
 * fully awaited, so a stop leaves no CLI child or `git` writing after the Turn stopped waiting.
 */
function prepareTurnContextTree(
  request: RunnerCloudWorkerRequest,
  options: CloudTurnWorkerRunOptions,
  execution: TurnExecutionContext,
  scratch: string,
  environment: Record<string, string>,
): Promise<CloudContextTreePreparation> {
  const budget = AbortSignal.timeout(
    Math.max(1, options.contextTreePreparationBudgetMs ?? CLOUD_CONTEXT_TREE_PREPARATION_BUDGET_MS),
  );
  return (options.prepareContextTree ?? prepareCloudContextTree)({
    agentSlug: cloudAgentSlug(cloudWorkerRuntime(request).instructions.platform),
    environment,
    path: `${request.executionDir}/bin:/usr/local/bin:/opt/opentag/tools/bin:/usr/bin:/bin`,
    contextTrees: cloudWorkerRuntime(request).contextTrees,
    scratch,
    signal: AbortSignal.any([execution.signal, budget]),
    workspace: options.workspace,
  });
}

export async function runCloudTurnWorker(
  request: RunnerCloudWorkerRequest,
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

    // The effective execution deadline and caller cancellation bound everything below, including
    // optional Context Tree preparation (which additionally has its own small budget).
    const execution = createTurnExecutionContext(request, options);
    const contextTree = await prepareTurnContextTree(request, options, execution, scratch, manifest.environment);
    if (execution.signal.aborted) {
      // The execution deadline or caller stop fired during preparation. The preparation child
      // (including any nested git) was stopped and awaited, so Pi must not start now.
      return completionForError(new Error("The Turn stopped during Context Tree preparation"), execution.stopReason());
    }

    const documents = cloudTurnPiDocuments(request);
    await writeFile(join(piHome, "auth.json"), documents.authJson, { mode: 0o600 });
    await writeFile(join(piHome, "models.json"), documents.modelsJson, { mode: 0o600 });
    await writeFile(join(piHome, "settings.json"), documents.settingsJson, { mode: 0o600 });

    const baseEnvironment: NodeJS.ProcessEnv = {
      HOME: home,
      LANG: "C.UTF-8",
      PATH: [
        ...(contextTree.binDirectory ? [contextTree.binDirectory] : []),
        `${request.executionDir}/bin`,
        "/usr/local/bin",
        "/opt/opentag/tools/bin",
        "/usr/bin",
        "/bin",
      ].join(":"),
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
    Object.assign(runtimeEnvironment, await cloudSessionCliEnvironment(request, scratch));
    // Internal children receive no IM outbox material. Visible callbacks retain the same scoped CLI path as IM Turns.
    if (request.kind === "turn" || request.sessionKind === "visible") {
      const providerEnvironmentPath = join(scratch, "provider-environment.sh");
      await writeFile(
        providerEnvironmentPath,
        serializeEnvironment({ ...environment, ...providerRoutingEnvironment(environment) }, process.platform),
        { mode: 0o600 },
      );
      runtimeEnvironment.OPENTAG_PROVIDER_ENV_FILE = providerEnvironmentPath;
    }

    // Reuse the packaged Context Tree skills and the E3 Runner tool skills (`git`/`gh`/
    // `lark-cli`/`slack`) through the same assembly and argument helper; a missing skill set is
    // the honest host-dev case, never a different runtime.
    const contextTreeSkills = await assembleContextTreeSkills().catch(() => undefined);
    const toolSkills = await assembleRunnerToolSkills();
    const skillPaths = [...(contextTreeSkills?.skillPaths ?? []), ...toolSkills.skills.map((skill) => skill.directory)];
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
      ...(cloudWorkerRuntime(request).reasoningEffort
        ? { reasoningEffort: cloudWorkerRuntime(request).reasoningEffort }
        : {}),
    };
    const common = {
      configuration,
      eventSink: async (event: AgentRuntimeEvent) => {
        if (event.type === "binding_changed") await persistBinding(bindingFile, event.binding);
      },
      policy: TURN_POLICY,
      systemPrompt: renderCloudSystemPrompt(cloudWorkerRuntime(request), {
        contextTree: contextTree.status,
        sessionCollaboration: request.sessionCollaboration !== undefined,
      }),
      workspace: { cwd: options.workspace, environment: runtimeEnvironment },
    };
    const persisted = await readPersistedBinding(bindingFile);
    const activeRuntime = persisted
      ? await factory.resume({ ...common, binding: persisted })
      : await factory.create(common);
    runtime = activeRuntime;

    const onAbort = () => terminateTrackedProcesses(pids);
    execution.signal.addEventListener("abort", onAbort, { once: true });
    let completion: TurnCompletion;
    try {
      const result = await activeRuntime.prompt({
        runId: randomTurnRunId(request),
        configuration,
        input: cloudWorkerInput(request),
        signal: execution.signal,
      });
      // A completed result is preserved; a stop/timeout that raced a failed result maps true.
      completion =
        result.status === "completed"
          ? completionForResult(result, undefined)
          : completionForResult(result, execution.stopReason());
    } catch (error) {
      completion = completionForError(error, execution.stopReason());
    } finally {
      execution.signal.removeEventListener("abort", onAbort);
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

function randomTurnRunId(request: RunnerCloudWorkerRequest): string {
  return request.kind === "turn"
    ? `cloud-turn-${request.delivery.deliveryId}`
    : `cloud-session-${request.message.messageId}`;
}
