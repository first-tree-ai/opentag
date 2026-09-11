import { configureClientLoggerForService, resolveOpenTagHome, resolveOpenTagHomeLayout } from "@opentag/client";
import { type Command, CommanderError } from "commander";
import { resolveChannelEnvironment } from "../core/channel/environment.js";
import {
  CommandError,
  commandExitCode,
  EXIT_CODES,
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
    // After the failure is presented, so reporting can only ever delay the exit, never the answer.
    await report(error, commandError, { command: state.command, environment: env });
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
