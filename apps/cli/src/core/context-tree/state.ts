import { readContextTreePreparation, runContextTreeCli } from "@opentag/client";
import { formatContextTreeTarget } from "@opentag/shared";
import {
  type ContextTreeCommandDeps,
  contextTreeConfigPath,
  readContextTreeConfig,
  resolveContextTreeAssets,
  resolveHome,
} from "./shared.js";

export interface ContextTreeState {
  configPath: string;
  target?: string;
  /** `not-cloned` is a GitHub target the first Agent Session has yet to clone. */
  tree: "unknown" | "valid" | "invalid" | "not-cloned";
  detail?: string;
}

/** Read-only view of this Computer's Context Tree wiring, for `opentag doctor`. */
export async function readContextTreeState(deps: ContextTreeCommandDeps = {}): Promise<ContextTreeState> {
  const home = resolveHome(deps);
  const configPath = contextTreeConfigPath(home);
  const assets = resolveContextTreeAssets(deps);

  let config: Awaited<ReturnType<typeof readContextTreeConfig>>;
  try {
    config = await readContextTreeConfig(home);
  } catch {
    return { configPath, tree: "unknown", detail: "the configuration file is unreadable or invalid" };
  }
  if (!config) return { configPath, tree: "unknown" };
  const configured = config.target;
  const target = formatContextTreeTarget(configured);
  if (!assets) return { configPath, target, tree: "unknown", detail: "the Context Tree package is missing" };

  if (configured.kind === "path") {
    const { failureCode } = await runContextTreeCli(assets, ["verify", "--tree-path", configured.path]);
    if (failureCode === undefined) return { configPath, target, tree: "valid" };
    return { configPath, target, tree: "invalid", detail: failureCode };
  }
  const { payload, failureCode } = await runContextTreeCli(assets, ["list"]);
  if (failureCode !== undefined) return { configPath, target, tree: "unknown", detail: failureCode };
  const trees = (payload as { trees?: readonly { name?: unknown; tree?: { repository?: unknown } }[] }).trees ?? [];
  if (configured.kind === "managed") {
    return trees.some((entry) => entry.name === configured.name)
      ? { configPath, target, tree: "valid" }
      : { configPath, target, tree: "invalid", detail: "the named managed Context Tree does not exist" };
  }
  const repository = configured.repository.toLowerCase();
  const cloned = trees.some(
    (entry) => typeof entry.tree?.repository === "string" && entry.tree.repository.toLowerCase() === repository,
  );
  if (cloned) return { configPath, target, tree: "valid" };
  try {
    const preparation = await readContextTreePreparation(home);
    if (preparation?.target === target && preparation.status === "unavailable") {
      return { configPath, target, tree: "invalid", detail: preparation.reason };
    }
  } catch {
    // The live CLI state remains authoritative when the optional diagnostic record is unreadable.
  }
  return { configPath, target, tree: "not-cloned" };
}
