import { homedir } from "node:os";
import { join, resolve } from "node:path";

export interface OpenTagHomeLayout {
  config: string;
  daemonState: string;
  data: string;
  home: string;
  logs: string;
  runtimeAgents: string;
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
  const state = join(resolvedHome, "state");
  return {
    config,
    daemonState: join(state, "daemon"),
    data,
    home: resolvedHome,
    logs: join(resolvedHome, "logs"),
    runtimeAgents: join(data, "runtime", "agents"),
    serviceState: join(state, "service"),
    state,
    workspaces: join(data, "workspaces"),
  };
}
