import { configureClientLoggerForService, resolveOpenTagHome, resolveOpenTagHomeLayout } from "@opentag/client";
import { type Command, CommanderError } from "commander";
import { resolveChannelEnvironment } from "../core/channel/environment.js";
import {
  CommandError,
  commandExitCode,
  EXIT_CODES,
  hasBrokenPipeCode,
  isBrokenPipeError,
  markOutputBrokenPipeError,
  observeCommandFailures,
  presentCommand,
  toCommandError,
} from "../core/command/policy.js";
import {
  installCliProcessErrorReporting,
  reportCommandFailure,
  resolveCommandPath,
} from "../core/diagnostics/error-reporting.js";
import { createProgram } from "./program.js";

export interface OutputErrorStream {
  on(event: "error", listener: (error: unknown) => void): unknown;
  write?: ((...args: never[]) => unknown) | undefined;
}

const guardedOutputStreams = new WeakSet<OutputErrorStream>();
const guardedOutputWrites = new WeakMap<OutputErrorStream, unknown>();

function guardOutputStreamWrite(stream: OutputErrorStream): void {
  if (typeof stream.write !== "function") return;
  if (guardedOutputWrites.get(stream) === stream.write) return;
  const currentWrite = stream.write as (...args: unknown[]) => unknown;
  const guardedWrite = function (this: unknown, ...args: unknown[]) {
    try {
      return currentWrite.apply(this ?? stream, args);
    } catch (error) {
      if (hasBrokenPipeCode(error)) {
        markOutputBrokenPipeError(error);
      }
      throw error;
    }
  };
  stream.write = guardedWrite as OutputErrorStream["write"];
  guardedOutputWrites.set(stream, stream.write);
}

/**
 * Ignore `EPIPE` on an output stream when a downstream pipe consumer (`head`, `grep -q`) closes
 * early, and mark synchronous `EPIPE` write throws as originating from this output boundary.
 * The `"error"` listener is installed once per stream and left attached because Node's async
 * `WriteWrap.onWriteComplete` can emit `"error"` on the next tick after `runCli` has already returned.
 */
export function ignoreBrokenPipeOnStream(stream: OutputErrorStream): void {
  guardOutputStreamWrite(stream);
  if (guardedOutputStreams.has(stream)) return;
  guardedOutputStreams.add(stream);
  stream.on("error", (error: unknown) => {
    if (hasBrokenPipeCode(error)) {
      markOutputBrokenPipeError(error);
      return;
    }
    throw error;
  });
}

export interface RunCliOptions {
  argv: readonly string[];
  env?: NodeJS.ProcessEnv;
  /** The program to run; the real one by default. Tests register a throwing command on it. */
  program?: Command;
  /** Relays one failure; `reportCommandFailure` by default. */
  report?: typeof reportCommandFailure;
  /** Ends the process for a Commander usage or help exit; `process.exit` by default. */
  exit?: (code: number) => void;
  /** Whether to install the process-level uncaught-failure handlers; on by default. */
  processHandlers?: boolean;
  /** Output streams to guard against `EPIPE`; `process.stdout` and `process.stderr` by default. */
  stdoutStream?: OutputErrorStream;
  stderrStream?: OutputErrorStream;
}

interface RunState {
  command?: string;
  detachObserver?: () => void;
}

/**
 * The CLI entry point's whole behaviour, so it can run under test with a real program.
 *
 * A failure is reported from exactly one of two places: the shared execution path, which handles
 * most command failures and returns an exit code, or the catch below, which sees what escaped it.
 * `reportCommandFailure` keeps the two from reporting the same thrown value twice.
 */
export async function runCli(options: RunCliOptions): Promise<number> {
  ignoreBrokenPipeOnStream(options.stdoutStream ?? process.stdout);
  ignoreBrokenPipeOnStream(options.stderrStream ?? process.stderr);
  const argv = [...options.argv];
  const env = options.env ?? process.env;
  const json = argv.includes("--json");
  const report = options.report ?? reportCommandFailure;
  const state: RunState = {};
  try {
    await runProgram(options, argv, env, report, state);
    return EXIT_CODES.success;
  } catch (error) {
    if (error instanceof CommanderError) return exitForUsage(error, json, options.exit);
    const commandError = toCommandError(error);
    const exitCode = presentCommand(
      { ok: false, error: commandError, exitCode: commandExitCode(commandError) },
      { json },
    );
    if (!isBrokenPipeError(commandError)) {
      // After the failure is presented, so reporting can only ever delay the exit, never the answer.
      await report(error, commandError, { command: state.command, environment: env });
    }
    return exitCode;
  } finally {
    state.detachObserver?.();
  }
}

async function runProgram(
  options: RunCliOptions,
  argv: string[],
  env: NodeJS.ProcessEnv,
  report: typeof reportCommandFailure,
  state: RunState,
): Promise<void> {
  const program = options.program ?? createProgram({ json: argv.includes("--json") });
  // The command path only, never its arguments: those are the user's and may carry secrets.
  state.command = resolveCommandPath(program, argv.slice(2));
  const environment = resolveChannelEnvironment(env);
  const home = resolveOpenTagHome(environment);
  configureClientLoggerForService(resolveOpenTagHomeLayout(home).logs);
  const context = { command: state.command, environment: env, home };
  if (options.processHandlers !== false) installCliProcessErrorReporting(context);
  state.detachObserver = observeCommandFailures((error, commandError) => {
    void report(error, commandError, context);
  });
  await program.parseAsync(argv);
}

/**
 * Commander usage errors (unknown options, missing required options or arguments) are
 * input-validation failures: they exit 2, and a --json caller receives the same failure envelope
 * as any other command instead of human help text.
 */
function exitForUsage(
  error: CommanderError,
  json: boolean,
  exit: (code: number) => void = (code) => process.exit(code),
): number {
  if (error.exitCode !== 0 && json) {
    const commandError = new CommandError(
      { code: "USAGE_ERROR", category: "validation", retryability: "never", phase: "validation" },
      error.message,
    );
    presentCommand({ ok: false, error: commandError, exitCode: EXIT_CODES.usage }, { json: true });
  }
  const code = error.exitCode === 0 ? 0 : EXIT_CODES.usage;
  exit(code);
  return code;
}
