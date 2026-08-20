import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { resolveOpenTagHomeLayout } from "../storage/home-layout.js";

export function deriveRuntimeKey(kind: "agent" | "session" | "snapshot", id: string): string {
  const digest = createHash("sha256").update(`${kind}\0${id}`, "utf8").digest("hex");
  return `${kind[0]}-${digest.slice(0, 40)}`;
}

export interface AgentRuntimePaths {
  agentsFile: string;
  effectiveSnapshotsRoot: string;
  files: string;
  legacyAgentsFile: string;
  runtimeRoot: string;
  sessionBindingsRoot: string;
  sessions: string;
  snapshots: string;
  workspaceRoot: string;
  workspaceState: string;
  workspaceStatesRoot: string;
}

export function agentRuntimePaths(home: string, agentId: string): AgentRuntimePaths {
  const layout = resolveOpenTagHomeLayout(home);
  const key = deriveRuntimeKey("agent", agentId);
  const workspaceRoot = resolve(layout.workspaces, key);
  return {
    agentsFile: resolve(workspaceRoot, "files", "AGENTS.md"),
    effectiveSnapshotsRoot: layout.runtimeEffectiveSnapshots,
    files: resolve(workspaceRoot, "files"),
    legacyAgentsFile: resolve(workspaceRoot, "AGENTS.md"),
    runtimeRoot: layout.runtime,
    sessionBindingsRoot: layout.runtimeSessionBindings,
    sessions: resolve(layout.runtimeSessionBindings, key),
    snapshots: resolve(layout.runtimeEffectiveSnapshots, key),
    workspaceRoot,
    workspaceState: resolve(layout.runtimeWorkspaceStates, `${key}.json`),
    workspaceStatesRoot: layout.runtimeWorkspaceStates,
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
