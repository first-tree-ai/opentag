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
import { createProgram } from "./program.js";

const json = process.argv.includes("--json");
try {
  const environment = resolveChannelEnvironment(process.env);
  const home = resolveOpenTagHome(environment);
  configureClientLoggerForService(resolveOpenTagHomeLayout(home).logs);
  await createProgram({ json }).parseAsync(process.argv);
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
  }
}
