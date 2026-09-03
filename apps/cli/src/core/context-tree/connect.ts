import { type ContextTreePackage, runContextTreeCli } from "@opentag/client";
import { type ContextTreeTarget, formatContextTreeTarget, parseContextTreeTarget } from "@opentag/shared";
import {
  type ContextTreeCommandDeps,
  ContextTreeUsageError,
  resolveContextTreeAssets,
  resolveHome,
  writeContextTreeConfig,
  writeStderr,
  writeStdout,
} from "./shared.js";

export interface ContextTreeConnectOptions extends ContextTreeCommandDeps {
  /** Positional `name-or-repository`, or undefined when `--tree-path` is used. */
  readonly target?: string;
  readonly treePath?: string;
}

/** Resolve the single positional argument or `--tree-path` into one target, or fail as usage. */
function parseConnectTarget(options: ContextTreeConnectOptions): ContextTreeTarget {
  if (options.target !== undefined && options.treePath !== undefined) {
    throw new ContextTreeUsageError("Pass either a managed name or OWNER/REPO, or --tree-path, not both");
  }
  const raw = options.treePath ?? options.target;
  if (raw === undefined || raw.trim().length === 0) {
    throw new ContextTreeUsageError("A managed Context Tree name, OWNER/REPO, or --tree-path is required");
  }
  const target = parseContextTreeTarget(raw);
  if (!target || (options.treePath !== undefined && target.kind !== "path")) {
    throw new ContextTreeUsageError(
      `"${raw}" is not a managed Context Tree name, an OWNER/REPO repository, or an absolute path`,
    );
  }
  return target;
}

/**
 * Confirm the target is usable, using only read commands.
 *
 * Connecting a throwaway project directory to test a target would leave a stale record in the
 * CLI's connection store and write instruction files into it, so this never connects. A GitHub
 * target cannot be checked at all without cloning, which is network work this command was not
 * asked for; the first Agent Session clones it.
 */
async function validateTarget(
  target: ContextTreeTarget,
  assets: ContextTreePackage,
): Promise<{ message: string } | undefined> {
  if (target.kind === "github") return undefined;
  if (target.kind === "path") {
    const { failureCode } = await runContextTreeCli(assets, ["verify", "--tree-path", target.path]);
    return failureCode === undefined
      ? undefined
      : { message: `${target.path} is not a usable Context Tree (${failureCode}).` };
  }
  const { payload, failureCode } = await runContextTreeCli(assets, ["list"]);
  if (failureCode !== undefined) return { message: `Could not list managed Context Trees (${failureCode}).` };
  const trees = (payload as { trees?: readonly { name?: unknown }[] }).trees ?? [];
  return trees.some((entry) => entry.name === target.name)
    ? undefined
    : {
        message: `No managed Context Tree named "${target.name}" exists. Create one with "context-tree create", or pass OWNER/REPO or --tree-path.`,
      };
}

/**
 * Name the Context Tree that every Agent Session on this Computer should use.
 *
 * This command does not create trees. A tree is created once with the Context Tree CLI itself
 * (`context-tree create`, or `publish` for a GitHub-backed one) and named here; OpenTag then
 * connects each Agent workspace to it automatically at Session start.
 */
export async function runContextTreeConnect(options: ContextTreeConnectOptions): Promise<{ exitCode: 0 | 1 }> {
  const target = parseConnectTarget(options);
  const assets = resolveContextTreeAssets(options);
  if (!assets) {
    writeStderr(options, "The Context Tree package is missing from this installation.\n");
    return { exitCode: 1 };
  }
  const rejected = await validateTarget(target, assets);
  if (rejected) {
    writeStderr(options, `${rejected.message}\n`);
    return { exitCode: 1 };
  }

  const configPath = await writeContextTreeConfig(resolveHome(options), target);
  writeStdout(options, `Context Tree for this Computer: ${formatContextTreeTarget(target)}\n`);
  writeStdout(options, `Recorded in ${configPath}\n`);
  if (target.kind === "github") {
    writeStdout(options, "The first Agent Session clones it, so GitHub credentials must work on this Computer.\n");
  }
  writeStdout(options, "Every Agent Session on this Computer now connects to it automatically.\n");
  return { exitCode: 0 };
}
