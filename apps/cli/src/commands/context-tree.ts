import type { Command } from "commander";
import { type ContextTreeCommandDeps, writeStderr } from "../core/context-tree/shared.js";

/** Keep a tombstone so older instructions lead users to the new settings without writing legacy data. */
export function registerContextTreeCommand(program: Command, deps: ContextTreeCommandDeps = {}): void {
  program
    .command("context-tree")
    .description("Context Tree is configured in Agent settings")
    .command("connect")
    .argument("[name-or-repository]")
    .option("--tree-path <path>")
    .action(() => {
      writeStderr(
        deps,
        "Configure Context Tree in Agent settings → Context Tree. Computer-wide selections are no longer used. Existing trees and memory are preserved.\n",
      );
      process.exitCode = 1;
    });
}
