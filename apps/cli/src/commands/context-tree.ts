import { type Command, CommanderError } from "commander";
import { runContextTreeConnect } from "../core/context-tree/connect.js";
import { type ContextTreeCommandDeps, ContextTreeUsageError, writeStderr } from "../core/context-tree/shared.js";

/** Usage errors exit 2; operational failures exit 1. Behavior lives in `core/context-tree`. */
function usageErrorsExit2(error: CommanderError): never {
  if (error.exitCode === 0) throw error;
  throw new CommanderError(2, error.code, error.message);
}

export function registerContextTreeCommand(program: Command, deps: ContextTreeCommandDeps = {}): void {
  const contextTree = program
    .command("context-tree")
    .description("Choose the Context Tree that every Agent Session on this Computer uses")
    .exitOverride(usageErrorsExit2);

  contextTree
    .command("connect")
    .description("Record an existing Context Tree as this Computer's durable memory")
    .argument("[name-or-repository]", "managed Context Tree name, or a GitHub OWNER/REPO")
    .option("--tree-path <path>", "absolute path to an existing Context Tree Git root")
    .action(async (target: string | undefined, options: { treePath?: string }) => {
      try {
        process.exitCode = (
          await runContextTreeConnect({
            ...deps,
            ...(target !== undefined ? { target } : {}),
            ...(options.treePath !== undefined ? { treePath: options.treePath } : {}),
          })
        ).exitCode;
      } catch (error) {
        if (error instanceof ContextTreeUsageError) {
          // Commander prints its own usage errors but not one thrown from an action handler,
          // and an exit code with no explanation is not a usable failure.
          writeStderr(deps, `error: ${error.message}\n`);
          throw new CommanderError(2, "opentag.context-tree.usage", error.message);
        }
        throw error;
      }
    });
}
