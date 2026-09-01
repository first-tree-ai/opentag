import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface OpenTagHomeLayout {
  config: string;
  contextTreeBin: string;
  contextTreeConfigFile: string;
  daemonState: string;
  data: string;
  home: string;
  logs: string;
  runtime: string;
  runtimeEffectiveSnapshots: string;
  runtimeSessionBindings: string;
  runtimeWorkspaceStates: string;
  serviceState: string;
  state: string;
  workspaces: string;
}

export function resolveOpenTagHome(environment: NodeJS.ProcessEnv = process.env): string {
  return environment.OPENTAG_HOME ? resolve(environment.OPENTAG_HOME) : join(homedir(), ".opentag");
}

export function resolveOpenTagHomeLayout(home = resolveOpenTagHome()): OpenTagHomeLayout {
  const resolvedHome = resolve(home);
  const config = join(resolvedHome, "config");
  const data = join(resolvedHome, "data");
  const runtime = join(data, "runtime");
  const state = join(resolvedHome, "state");
  return {
    config,
    // Holds the shim the Context Tree skills invoke by name; OpenTag's own calls bypass it.
    contextTreeBin: join(resolvedHome, "context-tree", "bin"),
    contextTreeConfigFile: join(config, "context-tree.json"),
    daemonState: join(state, "daemon"),
    data,
    home: resolvedHome,
    logs: join(resolvedHome, "logs"),
    runtime,
    runtimeEffectiveSnapshots: join(runtime, "effective-snapshots"),
    runtimeSessionBindings: join(runtime, "session-bindings"),
    runtimeWorkspaceStates: join(runtime, "workspace-states"),
    serviceState: join(state, "service"),
    state,
    workspaces: join(data, "workspaces"),
  };
}
