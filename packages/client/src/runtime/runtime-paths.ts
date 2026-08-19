import { createHash } from "node:crypto";
import { resolve } from "node:path";

export function deriveRuntimeKey(kind: "agent" | "session" | "snapshot", id: string): string {
  const digest = createHash("sha256").update(`${kind}\0${id}`, "utf8").digest("hex");
  return `${kind[0]}-${digest.slice(0, 40)}`;
}

export interface AgentRuntimePaths {
  agentControl: string;
  agentsFile: string;
  controlRoot: string;
  files: string;
  sessions: string;
  snapshots: string;
  workspaceRoot: string;
  workspaceState: string;
}

export function agentRuntimePaths(home: string, agentId: string): AgentRuntimePaths {
  const runtimeRoot = resolve(home, "runtime");
  const controlRoot = resolve(runtimeRoot, "control");
  const key = deriveRuntimeKey("agent", agentId);
  const agentControl = resolve(controlRoot, "agents", key);
  const workspaceRoot = resolve(runtimeRoot, "workspaces", key);
  return {
    agentControl,
    agentsFile: resolve(workspaceRoot, "AGENTS.md"),
    controlRoot,
    files: resolve(workspaceRoot, "files"),
    sessions: resolve(agentControl, "sessions"),
    snapshots: resolve(agentControl, "snapshots"),
    workspaceRoot,
    workspaceState: resolve(agentControl, "workspace.json"),
  };
}

export function sessionBindingPath(home: string, agentId: string, sessionId: string): string {
  const paths = agentRuntimePaths(home, agentId);
  return resolve(paths.sessions, `${deriveRuntimeKey("session", sessionId)}.json`);
}

export function snapshotPath(home: string, agentId: string, snapshotHash: string): string {
  const paths = agentRuntimePaths(home, agentId);
  return resolve(paths.snapshots, `${deriveRuntimeKey("snapshot", snapshotHash)}.json`);
}
