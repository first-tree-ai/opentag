#!/usr/bin/env node

import { configureClientLoggerForService, resolveOpenTagHome, resolveOpenTagHomeLayout } from "@opentag/client";
import { CommanderError } from "commander";
import { resolveChannelEnvironment } from "../core/channel/environment.js";
import {
  CommandError,
  type CommandResult,
  commandExitCode,
  EXIT_CODES,
  presentCommand,
  toCommandError,
} from "../core/command/policy.js";
import {
  installCliProcessErrorReporting,
  reportCliError,
  resolveCommandPath,
  shouldReportCommandError,
} from "../core/diagnostics/error-reporting.js";
import { createProgram } from "./program.js";

const json = process.argv.includes("--json");
let command: string | undefined;
try {
  const program = createProgram({ json });
  // The command path only, never its arguments: those are the user's and may carry secrets.
  command = resolveCommandPath(program, process.argv.slice(2));
  const environment = resolveChannelEnvironment(process.env);
  const home = resolveOpenTagHome(environment);
  configureClientLoggerForService(resolveOpenTagHomeLayout(home).logs);
  installCliProcessErrorReporting({ command });
  await program.parseAsync(process.argv);
} catch (error) {
  // Commander usage errors (unknown options, missing required options or arguments) are
  // input-validation failures: they exit 2, and a --json caller receives the same failure
  // envelope as any other command instead of human help text.
  if (error instanceof CommanderError) {
    if (error.exitCode !== 0 && json) {
      const commandError = new CommandError(
        { code: "USAGE_ERROR", category: "validation", retryability: "never", phase: "validation" },
        error.message,
      );
      presentCommand({ ok: false, error: commandError, exitCode: EXIT_CODES.usage }, { json: true });
    }
    process.exit(error.exitCode === 0 ? 0 : EXIT_CODES.usage);
  } else {
    const commandError = toCommandError(error);
    const result: CommandResult<never> = {
      ok: false,
      error: commandError,
      exitCode: commandExitCode(commandError),
    };
    process.exitCode = presentCommand(result, { json });
    // After the failure is presented, so reporting can only ever delay the exit, never the answer.
    if (shouldReportCommandError(commandError)) await reportCliError(error, { command });
  }
}
