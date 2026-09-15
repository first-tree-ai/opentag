import { resolveContextTreeHome } from "@opentag/client";
import type { ContextTreeCommandDeps } from "./shared.js";

export interface ContextTreeState {
  configPath: string;
  target?: string;
  tree: "unknown" | "valid" | "invalid" | "not-cloned";
  detail?: string;
}

/** Legacy data is retained on disk but never used as an Agent's selection. */
export async function readContextTreeState(deps: ContextTreeCommandDeps = {}): Promise<ContextTreeState> {
  return {
    configPath: resolveContextTreeHome(deps.env ?? process.env).configFile,
    tree: "unknown",
    detail:
      "Context Tree is configured per Agent in Agent settings → Context Tree. Legacy computer-wide selections are ignored.",
  };
}
