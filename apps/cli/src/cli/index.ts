#!/usr/bin/env node

import { CommanderError } from "commander";
import { type CommandResult, presentCommand, toCommandError } from "../core/command/policy.js";
import { createProgram } from "./program.js";

try {
  await createProgram().parseAsync(process.argv);
} catch (error) {
  // Commands that override exit behavior (e.g. provider-cli usage errors exit 2)
  // throw CommanderError; everything else already exited through commander.
  if (error instanceof CommanderError) {
    process.exit(error.exitCode === 0 ? 0 : 2);
  }
  const result: CommandResult<never> = {
    ok: false,
    error: toCommandError(error),
    exitCode: 1,
  };
  process.exitCode = presentCommand(result, { json: process.argv.includes("--json") });
}
