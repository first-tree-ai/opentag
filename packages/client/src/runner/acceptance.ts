import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomInt } from "node:crypto";
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentRunResult, AgentRuntime, AgentRuntimeEvent, AgentRuntimeFactory } from "../agent-runtime/types.js";
import { PiAgentRuntimeFactory } from "../providers/pi/agent-runtime.js";
import { PiRpcProcess, type PiRpcProcessSpawnOptions } from "../providers/pi/rpc-wire.js";
import { expectedFromIdentity, probeRunnerTools, type RunnerToolProbe, runnerToolsReady } from "./probe.js";
import { collectDescendantPids, processExists, waitForProcessTreeGone } from "./processes.js";
import { redactAcceptanceRecord } from "./redact.js";
import { type AssembledContextTreeSkills, assembleContextTreeSkills, assembleRunnerToolSkills } from "./skills.js";
import { prepareDisposableContextTree } from "./tree.js";
import type { RunnerAcceptanceEvent, RunnerAcceptanceReport, RunnerIdentity, RunnerMode } from "./types.js";

const POLICY = {
  approvals: "never" as const,
  fileSystem: "unrestricted" as const,
  network: "enabled" as const,
  tools: { mode: "provider-default" as const },
};

export const RUNNER_DEEPSEEK_MODEL = "deepseek-v4.1-flash-expires-on-0910";
export const RUNNER_DEEPSEEK_PROVIDER = "deepseek";
export const RUNNER_MODEL_ID = `${RUNNER_DEEPSEEK_PROVIDER}/${RUNNER_DEEPSEEK_MODEL}`;
/** Native Pi `--version` startup measured ~6s on Cloud Run; the provider's 5s local default is too tight. */
export const RUNNER_PI_PROBE_TIMEOUT_MS = 30_000;

export interface RunnerAcceptanceOptions {
  readonly assembleSkills?: () => Promise<AssembledContextTreeSkills>;
  readonly factory?: AgentRuntimeFactory;
  readonly identity?: RunnerIdentity;
  readonly mode: RunnerMode;
  readonly path?: string;
  readonly piHome: string;
  readonly probeTools?: () => Promise<readonly RunnerToolProbe[]>;
  readonly runtimeHome: string;
  readonly sessionDirectory: string;
  readonly workspace: string;
}

function event(name: string, status: RunnerAcceptanceEvent["status"], detail?: string): RunnerAcceptanceEvent {
  return { name, status, ...(detail ? { detail } : {}) };
}

function textOf(result: { output: ReadonlyArray<{ type: string; text?: string }> }): string {
  return result.output
    .filter((item) => item.type === "text")
    .map((item) => item.text?.trim() ?? "")
    .join("\n");
}

async function waitForPath(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      await access(path);
      return;
    } catch {
      if (Date.now() >= deadline) throw new Error(`timed out waiting for ${path}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

async function waitForCondition(check: () => boolean, description: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (check()) return;
    if (Date.now() >= deadline) throw new Error(`timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toolEvents(events: readonly AgentRuntimeEvent[], runId: string) {
  const started = events.filter((item) => item.type === "tool_started" && item.runId === runId);
  const completed = events.filter((item) => item.type === "tool_completed" && item.runId === runId);
  return {
    started,
    successful: completed.filter((item) => item.type === "tool_completed" && item.status === "completed"),
    failed: completed.filter((item) => item.type === "tool_completed" && item.status !== "completed"),
  };
}

/** Exact Pi arguments for an explicit managed skill set (never the ambient Local set). */
export function skillArgsOf(skillPaths: readonly string[]): readonly string[] {
  return ["--no-skills", ...skillPaths.flatMap((path) => ["--skill", path])];
}

function trackedSpawn(pids: Set<number>) {
  return (command: string, args: readonly string[], spawnOptions: PiRpcProcessSpawnOptions) => {
    const child = spawn(command, [...args], { ...spawnOptions, stdio: "pipe" }) as ChildProcessWithoutNullStreams;
    if (typeof child.pid === "number") pids.add(child.pid);
    return child;
  };
}

function runtimeEnvironment(options: RunnerAcceptanceOptions): NodeJS.ProcessEnv {
  return {
    HOME: options.runtimeHome,
    PATH: options.path ?? process.env.PATH,
    PI_CODING_AGENT_DIR: options.piHome,
    PI_CODING_AGENT_SESSION_DIR: options.sessionDirectory,
  };
}

export function createTrackedFactory(
  options: RunnerAcceptanceOptions,
  skillPaths: readonly string[],
  pids: Set<number>,
): PiAgentRuntimeFactory {
  return new PiAgentRuntimeFactory({
    process: {
      args: skillArgsOf(skillPaths),
      command: "pi",
      env: runtimeEnvironment(options),
      probeTimeoutMs: RUNNER_PI_PROBE_TIMEOUT_MS,
      sessionDirectory: options.sessionDirectory,
      spawnProcess: trackedSpawn(pids),
    },
  });
}

/**
 * Ask a short-lived, dedicated Pi RPC process which skills it actually loaded with the exact
 * Runner skill arguments. The process and its request id never touch the acceptance runtime;
 * only command names are read, never resource contents.
 */
async function loadPiSkillNames(
  options: RunnerAcceptanceOptions,
  skillPaths: readonly string[],
  pids: Set<number>,
): Promise<readonly string[]> {
  const rpc = new PiRpcProcess({
    command: "pi",
    args: [...skillArgsOf(skillPaths), "--mode", "rpc"],
    cwd: options.workspace,
    env: runtimeEnvironment(options),
    requestTimeoutMs: 30_000,
    spawnProcess: trackedSpawn(pids),
  });
  try {
    const data: unknown = await rpc.request({ type: "get_commands" }, AbortSignal.timeout(30_000));
    const commands = (data as { commands?: ReadonlyArray<{ name?: unknown; source?: unknown }> } | undefined)?.commands;
    if (!Array.isArray(commands)) throw new Error("Pi get_commands returned no command list");
    const skills = commands
      .filter((command) => command.source === "skill" && typeof command.name === "string")
      .map((command) => command.name as string);
    return [...new Set(skills)].sort();
  } finally {
    await rpc.close(1_000);
  }
}

async function runFixtureTurn(
  runtime: AgentRuntime,
  workspace: string,
  events: AgentRuntimeEvent[],
): Promise<{ binding: unknown; firstTaskMs: number; sum: string }> {
  const left = randomInt(10, 99);
  const right = randomInt(10, 99);
  const sum = String(left + right);
  const fixture = join(workspace, "fixture.txt");
  const sumFile = join(workspace, "sum.txt");
  await writeFile(fixture, `${left} ${right}\n`, "utf8");
  const started = Date.now();
  const result = await runtime.prompt({
    runId: "runner-fixture",
    configuration: { model: RUNNER_MODEL_ID, reasoningEffort: "max" },
    input: {
      items: [
        {
          type: "text",
          text: `Read ${fixture} with file tools. Sum the two integers. Write the sum to ${sumFile} using file tools. Reply with only the integer sum.`,
        },
      ],
    },
    signal: AbortSignal.timeout(180_000),
  });
  const firstTaskMs = Date.now() - started;
  if (result.status !== "completed")
    throw new Error(`fixture run failed: ${JSON.stringify(redactAcceptanceRecord(result.error))}`);
  if (textOf(result) !== sum) throw new Error(`expected ${sum}, got ${JSON.stringify(textOf(result))}`);
  if ((await readFile(sumFile, "utf8")).trim() !== sum) throw new Error("sum.txt mismatch");
  const tools = toolEvents(events, "runner-fixture");
  if (tools.started.length === 0 || tools.successful.length === 0) {
    throw new Error(
      `fixture run did not emit successful tool events (started=${tools.started.length}, successful=${tools.successful.length}, failed=${JSON.stringify(redactAcceptanceRecord(tools.failed))})`,
    );
  }
  if (tools.failed.length > 0) {
    throw new Error(`fixture run had failed tool events: ${JSON.stringify(redactAcceptanceRecord(tools.failed))}`);
  }
  if (!runtime.binding) throw new Error("Pi create did not produce a binding");
  return { binding: runtime.binding, firstTaskMs, sum };
}

type SettledPrompt =
  | { readonly settled: "result"; readonly result: AgentRunResult }
  | { readonly settled: "error"; readonly error: unknown };

const CANCELLATION_CAUSES: ReadonlyMap<string, string> = new Map([
  ["aborted", "run_aborted"],
  ["cancelled", "run_cancelled"],
]);

function assertCancelledOutcome(outcome: SettledPrompt): void {
  if (outcome.settled === "error") {
    throw new Error(
      `cancelled run rejected instead of reporting a cancellation status: ${JSON.stringify(redactAcceptanceRecord(outcome.error instanceof Error ? outcome.error.message : outcome.error))}`,
    );
  }
  const { result } = outcome;
  const expectedCause = CANCELLATION_CAUSES.get(result.status);
  if (!expectedCause || result.error?.code !== expectedCause) {
    throw new Error(
      `expected a confirmed cancellation status/cause, got status=${result.status} code=${result.error?.code ?? "none"}`,
    );
  }
}

async function readFixturePid(path: string): Promise<number> {
  const raw = (await readFile(path, "utf8")).trim();
  const pid = Number(raw);
  if (!Number.isInteger(pid) || pid <= 1) throw new Error(`fixture child wrote an invalid PID: ${JSON.stringify(raw)}`);
  return pid;
}

/** Wait for the synchronous Bash fixture to be live: marker, PID file, tool event, live child. */
async function waitForLiveFixture(workspace: string, events: readonly AgentRuntimeEvent[]): Promise<number> {
  await waitForPath(join(workspace, "child-ready.txt"), 90_000);
  const pidFile = join(workspace, "child.pid");
  await waitForPath(pidFile, 5_000);
  await waitForCondition(
    () =>
      events.some((item) => item.type === "tool_started" && item.runId === "runner-child" && /bash/i.test(item.name)),
    "Bash tool_started event for the fixture",
    5_000,
  );
  const childPid = await readFixturePid(pidFile);
  if (!(await processExists(childPid))) throw new Error(`fixture child ${childPid} is not alive before cancel`);
  return childPid;
}

/**
 * The shared tracked set covers probe/create/resume; PIDs of runtimes we already closed ourselves
 * are pruned, then every process serving the active run must be verifiably live.
 */
async function collectLivePids(childPid: number, pids: Set<number>, requireTrackedPi: boolean): Promise<Set<number>> {
  const live = new Set<number>([childPid, ...(await collectDescendantPids(childPid))]);
  for (const pid of [...pids]) {
    if (!(await processExists(pid))) pids.delete(pid);
  }
  if (requireTrackedPi && pids.size === 0) throw new Error("no tracked live Pi process before cancel");
  for (const pid of pids) {
    for (const descendant of await collectDescendantPids(pid)) live.add(descendant);
  }
  if (live.size < 2) throw new Error("expected live Pi/watchdog/fixture PIDs before cancel");
  for (const pid of live) {
    if (!(await processExists(pid))) throw new Error(`expected live PID ${pid} before cancel`);
  }
  return live;
}

/** Grace window after the tree is gone: a delayed write from an orphan must never appear. */
async function assertNoDelayedWrite(marker: string): Promise<void> {
  await delay(2_000);
  try {
    await readFile(marker, "utf8");
    throw new Error("delayed child write was observed after cancel/close");
  } catch (error) {
    if ((error as { code?: string }).code !== "ENOENT") throw error;
  }
}

export interface CancelEvidence {
  readonly livePidsBeforeCancel: number;
  readonly trackedPiPids: number;
}

/**
 * Cancel an actively running Bash fixture through the real Pi adapter.
 *
 * The fixture command runs synchronously inside the Bash tool: it writes a ready
 * marker and its own PID, then sleeps, so the run stays active until we abort.
 * Cancellation only counts when the run settles with a confirmed cancellation
 * status/cause; every observed Pi/watchdog/fixture PID must be gone afterwards
 * and the delayed write must never land.
 */
async function cancelLongLivedChild(
  runtime: AgentRuntime,
  workspace: string,
  pids: Set<number>,
  events: readonly AgentRuntimeEvent[],
  requireTrackedPi: boolean,
): Promise<CancelEvidence> {
  const ready = join(workspace, "child-ready.txt");
  const pidFile = join(workspace, "child.pid");
  const marker = join(workspace, "delayed.txt");
  const abort = new AbortController();
  const quote = (path: string) => `'${path.replaceAll("'", "'\"'\"'")}'`;
  const fixtureCommand = `printf READY > ${quote(ready)}; echo $$ > ${quote(pidFile)}; sleep 300; echo leaked > ${quote(marker)}`;
  // Attach the settlement handler immediately so a rejection can never be unhandled
  // or raced past the abort/close below.
  const pending: Promise<SettledPrompt> = runtime
    .prompt({
      runId: "runner-child",
      configuration: { model: RUNNER_MODEL_ID, reasoningEffort: "max" },
      input: {
        items: [
          {
            type: "text",
            text: `Run this exact command with the Bash tool, synchronously in the foreground; do not background it and do not return before it exits:\n${fixtureCommand}\nAfter it exits, reply DONE.`,
          },
        ],
      },
      signal: abort.signal,
    })
    .then(
      (result) => ({ settled: "result" as const, result }),
      (error: unknown) => ({ settled: "error" as const, error }),
    );
  try {
    const childPid = await waitForLiveFixture(workspace, events);
    const live = await collectLivePids(childPid, pids, requireTrackedPi);
    const evidence: CancelEvidence = { livePidsBeforeCancel: live.size, trackedPiPids: pids.size };
    // Abort and close WHILE the fixture is active; close errors must surface, never be swallowed.
    abort.abort();
    await runtime.close();
    assertCancelledOutcome(await pending);
    await waitForProcessTreeGone([...live], { timeoutMs: 15_000 });
    await assertNoDelayedWrite(marker);
    return evidence;
  } finally {
    if (!abort.signal.aborted) abort.abort();
    await pending.catch(() => undefined);
  }
}

async function runResumeTurn(
  factory: AgentRuntimeFactory,
  request: Parameters<AgentRuntimeFactory["create"]>[0],
  first: { binding: unknown; sum: string },
): Promise<AgentRuntime> {
  const runtime = await factory.resume({ ...request, binding: first.binding as never });
  try {
    if (JSON.stringify(runtime.binding) !== JSON.stringify(first.binding))
      throw new Error("Pi resume changed the binding");
    const second = await runtime.prompt({
      runId: "runner-resume",
      configuration: request.configuration,
      input: {
        items: [
          { type: "text", text: "What sum did you compute from the fixture file? Reply with only that integer." },
        ],
      },
      signal: AbortSignal.timeout(180_000),
    });
    if (second.status !== "completed" || textOf(second) !== first.sum) {
      throw new Error(`resume expected ${first.sum}, got ${JSON.stringify(textOf(second))}`);
    }
    return runtime;
  } catch (error) {
    // The newly resumed runtime is the one that must be closed, never the old reference.
    return await closeAfterFailure(runtime, error);
  }
}

/** Close after a failure without ever swallowing either the primary or the cleanup error. */
async function closeAfterFailure(runtime: AgentRuntime, error: unknown): Promise<never> {
  const primary = error instanceof Error ? error.message : String(error);
  try {
    await runtime.close();
  } catch (closeError) {
    throw new Error(
      `${primary}; runtime cleanup close also failed: ${closeError instanceof Error ? closeError.message : String(closeError)}`,
    );
  }
  throw error;
}

interface ModelAcceptanceResult {
  readonly firstTaskMs: number;
  readonly evidence: NonNullable<RunnerAcceptanceReport["evidence"]>;
}

async function runModelAcceptance(
  options: RunnerAcceptanceOptions,
  factory: AgentRuntimeFactory,
  skillPaths: readonly string[],
  pids: Set<number>,
  expectedSkills: readonly string[],
  events: RunnerAcceptanceEvent[],
): Promise<ModelAcceptanceResult> {
  const sink: AgentRuntimeEvent[] = [];
  const request = {
    eventSink: (item: AgentRuntimeEvent) => {
      sink.push(item);
    },
    policy: POLICY,
    systemPrompt: "Follow the user's exact response-format request. Do not mention secrets.",
    workspace: {
      cwd: options.workspace,
      environment: { PATH: options.path ?? process.env.PATH ?? "/usr/bin:/bin", HOME: options.runtimeHome },
    },
    configuration: { model: RUNNER_MODEL_ID, reasoningEffort: "max" as const },
  };
  // Actual loaded-skill evidence comes from the real Pi process; a supplied factory is trusted.
  // Events are pushed into the shared report array so failure paths keep their diagnostics.
  let skillsLoaded: readonly string[] | undefined;
  if (!options.factory) {
    const loaded = await loadPiSkillNames(options, skillPaths, pids);
    const actual = loaded.map((name) => name.replace(/^skill:/, "")).sort();
    if (JSON.stringify(actual) !== JSON.stringify([...expectedSkills].sort())) {
      throw new Error(`Pi skill list mismatch; expected: ${expectedSkills.join(", ")}; loaded: ${loaded.join(", ")}`);
    }
    skillsLoaded = loaded;
    events.push(event("model-skills", "passed", loaded.join(",")));
  }
  let runtime: AgentRuntime | undefined = await factory.create(request);
  try {
    const first = await runFixtureTurn(runtime, options.workspace, sink);
    await runtime.close();
    runtime = await runResumeTurn(factory, request, first);
    const cancel = await cancelLongLivedChild(runtime, options.workspace, pids, sink, !options.factory);
    runtime = undefined;
    const tools = [...toolEvents(sink, "runner-fixture").successful, ...toolEvents(sink, "runner-child").successful];
    const toolNames = [...new Set(tools.map((item) => (item.type === "tool_completed" ? item.name : "")))].filter(
      (name) => name.length > 0,
    );
    events.push(event("model-fixture", "passed", first.sum), event("model-resume", "passed"));
    events.push(
      event("model-cancel", "passed", `livePids=${cancel.livePidsBeforeCancel} trackedPi=${cancel.trackedPiPids}`),
    );
    return {
      firstTaskMs: first.firstTaskMs,
      evidence: {
        cancel,
        tools: { names: toolNames.sort(), successfulCount: tools.length },
        ...(skillsLoaded ? { skillsLoaded } : {}),
      },
    };
  } catch (error) {
    if (runtime !== undefined) {
      const closing = runtime;
      runtime = undefined;
      await closeAfterFailure(closing, error);
    }
    throw error;
  }
}

async function collectOfflineEvents(options: RunnerAcceptanceOptions): Promise<{
  events: RunnerAcceptanceEvent[];
  probesOk: boolean;
  skillArguments?: readonly string[];
}> {
  // Probe under the same conditions the runtime gets: the runtime HOME and PATH, with exact
  // version expectations whenever the image identity is known, and the same bounded native
  // startup allowance as `createTrackedFactory` (Pi `--version` is a native process start).
  const defaultProbeTools = () =>
    probeRunnerTools({
      env: { PATH: options.path ?? process.env.PATH ?? "/usr/bin:/bin", HOME: options.runtimeHome },
      ...(options.identity ? { expected: expectedFromIdentity(options.identity) } : {}),
      timeoutMs: RUNNER_PI_PROBE_TIMEOUT_MS,
    });
  const probes = await (options.probeTools ?? defaultProbeTools)();
  const events = probes.map((probe) => event(`probe:${probe.name}`, probe.ok ? "passed" : "failed", probe.detail));
  try {
    const toolSkills = await assembleRunnerToolSkills();
    const toolSkillPaths = toolSkills.skills.map((skill) => skill.directory);
    events.push(
      event(
        "tool-skills",
        toolSkills.skills.length > 0 ? "passed" : "skipped",
        toolSkills.skills.length > 0
          ? toolSkills.skills.map((skill) => skill.name).join(",")
          : "no runner tool skills directory (host development)",
      ),
    );
    if (options.assembleSkills) {
      const assembled = await options.assembleSkills();
      events.push(event("skills", "passed", assembled.skills.map((skill) => skill.name).join(",")));
      return {
        events,
        probesOk: runnerToolsReady(probes),
        skillArguments: skillArgsOf([...assembled.skillPaths, ...toolSkillPaths]),
      };
    }
    const prepared = await prepareDisposableContextTree({ home: options.runtimeHome, workspace: options.workspace });
    try {
      const allSkillArguments = skillArgsOf([...prepared.assembled.skillPaths, ...toolSkillPaths]);
      events.push(event("skills", "passed", prepared.assembled.skills.map((skill) => skill.name).join(",")));
      events.push(event("skills-args", "passed", allSkillArguments.join(" ")));
      events.push(event("context-tree", "passed", prepared.treePath));
      return {
        events,
        probesOk: runnerToolsReady(probes),
        skillArguments: allSkillArguments,
      };
    } finally {
      await prepared.cleanup();
    }
  } catch (error) {
    events.push(event("skills", "failed", error instanceof Error ? error.message : String(error)));
    return { events, probesOk: runnerToolsReady(probes) };
  }
}

/** The assembled skill paths (Context Tree + Runner tool skills) Pi receives through --skill. */
async function assembledSkillPaths(
  options: RunnerAcceptanceOptions,
): Promise<{ expectedSkills: readonly string[]; skillArguments: readonly string[]; skillPaths: readonly string[] }> {
  const assembled = await (options.assembleSkills ?? assembleContextTreeSkills)();
  const toolSkills = await assembleRunnerToolSkills();
  const skillPaths = [...assembled.skillPaths, ...toolSkills.skills.map((skill) => skill.directory)];
  return {
    skillPaths,
    skillArguments: skillArgsOf(skillPaths),
    expectedSkills: [...assembled.skills.map((skill) => skill.name), ...toolSkills.skills.map((skill) => skill.name)],
  };
}

export async function runRunnerAcceptance(options: RunnerAcceptanceOptions): Promise<RunnerAcceptanceReport> {
  await mkdir(options.workspace, { recursive: true });
  const offline = await collectOfflineEvents(options);
  const events = offline.events;
  const offlineFailed = events.some((item) => item.status === "failed") || !offline.probesOk;
  const report = (
    model: RunnerAcceptanceReport["model"],
    failed: boolean,
    extra: { firstTaskMs?: number; evidence?: RunnerAcceptanceReport["evidence"] } = {},
  ): RunnerAcceptanceReport =>
    redactAcceptanceRecord({
      events,
      failed,
      offline: offlineFailed ? "failed" : "passed",
      model,
      ...(options.identity ? { identity: options.identity } : {}),
      ...(offline.skillArguments ? { skillArguments: offline.skillArguments } : {}),
      ...extra,
    });
  if (options.mode !== "real") return report("skipped", offlineFailed);
  if (offlineFailed) {
    events.push(event("model", "failed", "offline checks must pass before real mode"));
    return report("failed", true);
  }
  try {
    // One tracked factory and one shared PID set across probe, create, resume, and cancel.
    const pids = new Set<number>();
    const skills = await assembledSkillPaths(options);
    const factory = options.factory ?? createTrackedFactory(options, skills.skillPaths, pids);
    const probe = await factory.probe({});
    if (probe.issues.some((issue) => issue.code === "credential_missing")) {
      throw new Error("Pi has no configured model credential");
    }
    if (!probe.ready) throw new Error(`Pi probe failed: ${JSON.stringify(redactAcceptanceRecord(probe.issues))}`);
    const model = await runModelAcceptance(options, factory, skills.skillPaths, pids, skills.expectedSkills, events);
    const failed = events.some((item) => item.status === "failed");
    return report(failed ? "failed" : "passed", failed, { firstTaskMs: model.firstTaskMs, evidence: model.evidence });
  } catch (error) {
    events.push(event("model", "failed", error instanceof Error ? error.message : String(error)));
    return report("failed", true);
  }
}
