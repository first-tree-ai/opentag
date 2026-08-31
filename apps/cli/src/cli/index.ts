#!/usr/bin/env node

import { CommanderError } from "commander";
import "../core/channel/environment.js";
import { createProgram } from "./program.js";

try {
  await createProgram().parseAsync(process.argv);
} catch (error) {
  // Commands that override exit behavior (e.g. provider-cli usage errors exit 2)
  // throw CommanderError; everything else already exited through commander.
  if (error instanceof CommanderError) {
    process.exit(error.exitCode);
  }
  throw error;
}
