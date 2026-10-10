import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { connect as connectTcp } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect as connectTls } from "node:tls";
import type { RunnerCloudWorkerRequest } from "@opentag/shared";
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
  CLOUD_SANDBOX_CA_FILE,
  CLOUD_SLACK_API_PORT,
} from "../cloud-runtime/sandbox-entry.js";
import { PiAgentRuntimeFactory } from "../providers/pi/agent-runtime.js";
import type { PiRpcProcessSpawnOptions } from "../providers/pi/rpc-wire.js";
import { completionForError, completionForResult, type TurnCompletion } from "../runtime/agent-turn-runner.js";
import { serializeEnvironment } from "../runtime/im-credential-environment-manager.js";
import {
  type ManagedSessionContext,
  managedAgentSlug,
  renderManagedSystemPrompt,
} from "../runtime/managed-instructions.js";
import { providerRoutingEnvironment, RUNTIME_PROXY_PROVIDER_URL_KEY } from "../runtime/runtime-proxy-material.js";
import { skillArgsOf } from "./acceptance.js";
import {
  CLOUD_CONTEXT_TREE_PREPARATION_BUDGET_MS,
  type CloudContextTreePreparation,
  type CloudContextTreePreparationInput,
  type CloudContextTreeStatus,
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
 * provider shell that sources them. NATIVE TRANSPORT BOUNDARY: before Pi starts, production
 * proves the per-execution HTTP/2 provider bridge with a bounded readiness check of both fixed
 * loopback entries — the execution adapter's fixed CONNECT refusal and a TLS exchange pinned to
 * THIS execution's published CA — so a missing or stale transport fails the Turn honestly. The
 * explicit `localProxyLoopbackSeam` test seam skips that probe for local fixtures only; it is
 * never set by production composition and is never evidence that the native bridge works.
 * Cancellation kills every Pi child this worker owns.
 */

/** Pi custom provider name for the Server-mediated model path. */
export const CLOUD_MODEL_PI_PROVIDER = "opentag";
/**
 * Verified image inputs for exact Cloud model IDs; see docs/cloud-pi-image-input.md.
 * This describes an already-issued model, never admits a model or guesses from its name.
 * Unknown IDs keep Pi's text-only behavior until their capabilities are verified.
 */
const CLOUD_PI_IMAGE_INPUT_MODELS = new Set([
  "gemini-3.8-flash",
  "gemini-3.1-flash-lite",
  "glm-5.3-flash",
  "gpt-6-astra",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "claude-fable-5.1",
  "claude-opus-5",
  "claude-sonnet-5",
  "kimi-k3",
  "deepseek-v4.1-flash",
  "gpt-6-sol",
  "gpt-6-luna",
  "claude-opus-5.5",
]);
/** The locked adapter lives with the Cloud image's Pi installation. */
const CLOUD_PI_MCP_ADAPTER_ENTRY = "/opt/opentag/pi/node_modules/pi-mcp-adapter/index.ts";

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
          // The Server-selected window and output budget travel with the grant verbatim: Pi's
          // native compaction works against this real contextWindow instead of Pi's 128K
          // custom-model default, and the output budget is the issued capability (never a
          // model-name guess).
          models: [
            {
              id: model.model,
              name: model.model,
              input: CLOUD_PI_IMAGE_INPUT_MODELS.has(model.model) ? ["text", "image"] : ["text"],
              contextWindow: model.contextWindow,
              maxTokens: model.maxTokens,
              compat: { supportsStore: false },
            },
          ],
        },
      },
    },
    null,
    2,
  )}\n`;
  const settingsJson = `${JSON.stringify(
    {
      // Pi native auto-compaction is explicitly enabled with its pinned defaults
      // (reserveTokens 16,384 / keepRecentTokens 20,000 stay untouched).
      compaction: { enabled: true },
      defaultModel: `${CLOUD_MODEL_PI_PROVIDER}/${model.model}`,
      defaultProvider: CLOUD_MODEL_PI_PROVIDER,
    },
    null,
    2,
  )}\n`;
  return { authJson, modelsJson, settingsJson };
}

/**
 * Pi's provider block for one Cloud execution. Only the services the trusted parent actually opened
 * appear here: a missing `webTools`/`mcpGateway` field means the corresponding extension is not
 * registered at all, and Pi's own `--no-extensions` default keeps implicit discovery off.
 */
function cloudPiConfiguration(request: RunnerCloudWorkerRequest) {
  return {
    model: `${CLOUD_MODEL_PI_PROVIDER}/${request.model.model}`,
    ...(request.mcpGateway || request.webTools
      ? {
          provider: {
            ...(request.mcpGateway ? { mcpGateway: request.mcpGateway } : {}),
            ...(request.webTools ? { webTools: request.webTools } : {}),
          },
        }
      : {}),
    ...(cloudWorkerRuntime(request).reasoningEffort
      ? { reasoningEffort: cloudWorkerRuntime(request).reasoningEffort }
      : {}),
  };
}

/**
 * The Cloud side of the one shared managed prompt context. A Cloud Turn is a visible Session; a
 * Session message keeps the journaled target kind. The Session identity is the actual request
 * identity (no creator is invented when the request carries none), and collaboration commands are
 * advertised only when the execution holds real proof material.
 */
function cloudManagedSessionContext(
  request: RunnerCloudWorkerRequest,
  contextTree: CloudContextTreeStatus,
): ManagedSessionContext {
  return {
    environment: "cloud",
    sessionId: request.kind === "turn" ? request.delivery.sessionId : request.message.targetSessionId,
    sessionKind: request.kind === "turn" ? "visible" : request.sessionKind,
    cliCommand: "opentag",
    sessionCliAvailable: request.sessionCollaboration !== undefined,
    selfConfigurationEnabled: cloudWorkerRuntime(request).selfConfigurationEnabled === true,
    contextTree,
  };
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
   * Test-only local seam: skip the bounded proxy-transport readiness probe for local fixtures
   * that run the worker outside any native Sandbox. Production never sets this; the real probe
   * against both loopback entries always runs there. This seam is not evidence of the native
   * provider bridge — the bridge is proven by its own real-helper tests.
   */
  readonly localProxyLoopbackSeam?: boolean;
  /**
   * Test seam: relocate the readiness probe targets to free loopback ports. Production always
   * probes the fixed execution entries (`CLOUD_CONNECT_PROXY_PORT`/`CLOUD_SLACK_API_PORT`).
   */
  readonly proxyReadinessPorts?: { readonly connect: number; readonly slack: number };
  /** Test seam: bound the readiness probe deadline (production uses the default). */
  readonly proxyReadinessTimeoutMs?: number;
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
    agentSlug: managedAgentSlug(cloudWorkerRuntime(request).instructions.platform),
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
  let runtime: CloudTurnPiRuntime | undefined;
  // A SIGTERM must terminate the real Pi tree and release the scratch directory. Failures are
  // written to stderr by the signal handler instead of being silently ignored.
  registerRunnerSignalCleanup(async () => {
    terminateTrackedProcesses(pids, { immediate: true });
    const failures: unknown[] = [];
    await runtime?.close().catch((error: unknown) => failures.push(error));
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
    await verifyProxyTransport(request.executionDir, manifest.environment, options);
    await prepareCliDirectories(manifest.environment, scratch);

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
        mcpAdapterEntry: CLOUD_PI_MCP_ADAPTER_ENTRY,
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

    const configuration = cloudPiConfiguration(request);
    const common = {
      configuration,
      eventSink: async (event: AgentRuntimeEvent) => {
        if (event.type === "binding_changed") await persistBinding(bindingFile, event.binding);
      },
      policy: TURN_POLICY,
      systemPrompt: renderManagedSystemPrompt(
        cloudWorkerRuntime(request),
        cloudManagedSessionContext(request, contextTree.status),
      ),
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
        input: cloudWorkerInput(request, new Date(options.now?.() ?? Date.now())),
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
    await rm(scratch, { recursive: true, force: true });
  }
}

/** Bounded total deadline for both readiness probes; the bridge is ready before the worker starts. */
const CLOUD_PROXY_READINESS_TIMEOUT_MS = 10_000;
/** Each probe needs only the adapter's fixed status line; anything larger is a violation. */
const READINESS_RESPONSE_MAX_BYTES = 4 * 1024;
/** Fixed probe target the allowlisted-hosts check always refuses without any upstream work. */
const READINESS_CONNECT_TARGET = "opentag-transport-check.invalid:443";

/**
 * Meaningful per-execution transport proof, replacing the old isSocket-only mount check. The
 * manifest must name the fixed loopback endpoint; then both entries must answer through the
 * HTTP/2 bridge within one bounded deadline:
 *
 * - CONNECT entry: `CONNECT <invalid-host>:443` must return the execution adapter's fixed 403
 *   refusal — a response that exists only because the byte path reaches the trusted adapter of
 *   this execution (no relay, provider, or credential work happens for a refused host).
 * - Slack entry: a TLS handshake pinned to THIS execution's published CA plus a request must
 *   return the adapter's 401 credential challenge. The per-execution CA ties the proof to the
 *   current execution: a stale or foreign listener cannot complete the handshake.
 *
 * Any failure throws BEFORE Pi starts, so a broken transport can never degrade into a Turn that
 * silently has no provider access. The explicit local seam skips both probes for local fixtures.
 */
async function verifyProxyTransport(
  executionDir: string,
  environment: Record<string, string>,
  options: CloudTurnWorkerRunOptions,
): Promise<void> {
  const expected = `http://127.0.0.1:${CLOUD_CONNECT_PROXY_PORT}`;
  for (const key of [RUNTIME_PROXY_PROVIDER_URL_KEY, "LARKSUITE_CLI_PROXY_ADDRESS"]) {
    if (environment[key] !== undefined && environment[key] !== expected) {
      throw new Error("The proxy manifest does not name the fixed execution loopback endpoint");
    }
  }
  if (options.localProxyLoopbackSeam === true) return;
  const ports = options.proxyReadinessPorts ?? { connect: CLOUD_CONNECT_PROXY_PORT, slack: CLOUD_SLACK_API_PORT };
  const deadline = Date.now() + Math.max(1, options.proxyReadinessTimeoutMs ?? CLOUD_PROXY_READINESS_TIMEOUT_MS);
  try {
    const connectLine = await probeStatusLine({
      deadline,
      port: ports.connect,
      request: `CONNECT ${READINESS_CONNECT_TARGET} HTTP/1.1\r\nHost: ${READINESS_CONNECT_TARGET}\r\nConnection: close\r\n\r\n`,
    });
    if (!connectLine.startsWith("HTTP/1.1 403")) {
      throw new Error("the CONNECT entry did not answer with the execution adapter refusal");
    }
    const ca = await readFile(join(executionDir, CLOUD_SANDBOX_CA_FILE));
    const slackLine = await probeStatusLine({
      ca,
      deadline,
      port: ports.slack,
      request: "GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
      servername: "localhost",
    });
    if (!slackLine.startsWith("HTTP/1.1 401")) {
      throw new Error("the Slack entry did not answer with the execution adapter challenge");
    }
  } catch (error) {
    throw new Error(
      `The per-execution proxy transport readiness check failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** One bounded request/response exchange against a loopback entry; resolves with the status line. */
async function probeStatusLine(input: {
  readonly ca?: Buffer;
  readonly deadline: number;
  readonly port: number;
  readonly request: string;
  readonly servername?: string;
}): Promise<string> {
  const remaining = input.deadline - Date.now();
  if (remaining <= 0) throw new Error("the readiness deadline was exceeded");
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    let received = 0;
    let buffered = "";
    const finish = (error?: Error, line?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(line as string);
    };
    const timer = setTimeout(() => finish(new Error("the readiness probe timed out")), remaining);
    timer.unref?.();
    const socket = input.ca
      ? connectTls({
          ca: input.ca,
          host: "127.0.0.1",
          port: input.port,
          rejectUnauthorized: true,
          ...(input.servername ? { servername: input.servername } : {}),
        })
      : connectTcp({ host: "127.0.0.1", port: input.port });
    socket.once("error", (error) => finish(new Error(`the readiness connection failed: ${error.message}`)));
    socket.once("close", () => finish(new Error("the readiness connection closed without a response")));
    socket.on("data", (chunk: Buffer) => {
      received += chunk.byteLength;
      if (received > READINESS_RESPONSE_MAX_BYTES) {
        finish(new Error("the readiness response exceeded the bound"));
        return;
      }
      buffered += chunk.toString("latin1");
      const newline = buffered.indexOf("\r\n");
      if (newline < 0) return;
      const line = buffered.slice(0, newline);
      if (!/^HTTP\/1\.[01] \d{3}( |$)/.test(line)) {
        finish(new Error("the readiness response is not an HTTP status line"));
        return;
      }
      finish(undefined, line);
    });
    socket.once(input.ca ? "secureConnect" : "connect", () => socket.write(input.request));
  });
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

/** Keep CLI writes in the existing per-execution scratch lifetime. */
async function prepareCliDirectories(environment: Record<string, string>, scratch: string): Promise<void> {
  // Native exec does not run the Docker entry script. CLI config belongs to this execution's
  // existing scratch lifetime, never the saved workspace or the read-only public mount.
  if (environment.OPENTAG_SLACK_CONFIG_DIR || environment.SLACK_CONFIG_DIR) {
    const directory = join(scratch, "slack");
    await mkdir(directory, { mode: 0o700 });
    environment.OPENTAG_SLACK_CONFIG_DIR = directory;
    environment.SLACK_CONFIG_DIR = directory;
  }
  if (environment.LARKSUITE_CLI_CONFIG_DIR) {
    const directory = join(scratch, "lark");
    await mkdir(directory, { mode: 0o700 });
    environment.LARKSUITE_CLI_CONFIG_DIR = directory;
  }
}
