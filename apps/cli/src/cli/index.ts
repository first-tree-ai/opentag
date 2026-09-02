#!/usr/bin/env node

import { configureClientLoggerForService, resolveOpenTagHome, resolveOpenTagHomeLayout } from "@opentag/client";
import { CommanderError } from "commander";
import { resolveChannelEnvironment } from "../core/channel/environment.js";
import { type CommandResult, commandExitCode, presentCommand, toCommandError } from "../core/command/policy.js";
import { createProgram } from "./program.js";

try {
  const environment = resolveChannelEnvironment(process.env);
  const home = resolveOpenTagHome(environment);
  configureClientLoggerForService(resolveOpenTagHomeLayout(home).logs);
  await createProgram().parseAsync(process.argv);
} catch (error) {
  // Commands that override exit behavior (e.g. provider-cli usage errors exit 2)
  // throw CommanderError; everything else already exited through commander.
  if (error instanceof CommanderError) {
    process.exit(error.exitCode === 0 ? 0 : 2);
  }
  const commandError = toCommandError(error);
  const result: CommandResult<never> = {
    ok: false,
    error: commandError,
    exitCode: commandExitCode(commandError),
  };
  process.exitCode = presentCommand(result, { json: process.argv.includes("--json") });
}
