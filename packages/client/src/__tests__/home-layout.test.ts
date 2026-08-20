import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { agentRuntimePaths, sessionBindingPath, snapshotPath } from "../runtime/runtime-paths.js";
import { resolveOpenTagHome, resolveOpenTagHomeLayout } from "../storage/home-layout.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

describe("OpenTag Home layout", () => {
  it("resolves the lifecycle roots from one canonical Home", async () => {
    const root = await mkdtemp(join(tmpdir(), "opentag-layout-"));
    directories.push(root);
    const home = join(root, "custom", "..");

    expect(resolveOpenTagHome({ OPENTAG_HOME: home })).toBe(root);
    expect(resolveOpenTagHomeLayout(home)).toEqual({
      config: join(root, "config"),
      daemonState: join(root, "state", "daemon"),
      data: join(root, "data"),
      home: root,
      logs: join(root, "logs"),
      runtime: join(root, "data", "runtime"),
      runtimeEffectiveSnapshots: join(root, "data", "runtime", "effective-snapshots"),
      runtimeSessionBindings: join(root, "data", "runtime", "session-bindings"),
      runtimeWorkspaceStates: join(root, "data", "runtime", "workspace-states"),
      serviceState: join(root, "state", "service"),
      state: join(root, "state"),
      workspaces: join(root, "data", "workspaces"),
    });
  });

  it("keeps runtime recovery state and workspaces in separate data roots", async () => {
    const home = await mkdtemp(join(tmpdir(), "opentag-layout-runtime-"));
    directories.push(home);
    const paths = agentRuntimePaths(home, "agent-1");

    expect(paths.runtimeRoot).toBe(join(home, "data", "runtime"));
    expect(paths.workspaceStatesRoot).toBe(join(home, "data", "runtime", "workspace-states"));
    expect(paths.sessionBindingsRoot).toBe(join(home, "data", "runtime", "session-bindings"));
    expect(paths.effectiveSnapshotsRoot).toBe(join(home, "data", "runtime", "effective-snapshots"));
    expect(paths.workspaceState).toMatch(
      new RegExp(`^${escapeRegExp(paths.workspaceStatesRoot)}/a-[a-f0-9]{40}\\.json$`, "u"),
    );
    expect(paths.sessions).toMatch(new RegExp(`^${escapeRegExp(paths.sessionBindingsRoot)}/a-[a-f0-9]{40}$`, "u"));
    expect(paths.snapshots).toMatch(new RegExp(`^${escapeRegExp(paths.effectiveSnapshotsRoot)}/a-[a-f0-9]{40}$`, "u"));
    expect(paths.workspaceRoot).toMatch(
      new RegExp(`^${escapeRegExp(join(home, "data", "workspaces"))}/a-[a-f0-9]{40}$`, "u"),
    );
    expect(sessionBindingPath(home, "agent-1", "session-1")).toMatch(
      /\/data\/runtime\/session-bindings\/a-[a-f0-9]{40}\/s-[a-f0-9]{40}\.json$/u,
    );
    expect(snapshotPath(home, "agent-1", "snapshot-1")).toMatch(
      /\/data\/runtime\/effective-snapshots\/a-[a-f0-9]{40}\/s-[a-f0-9]{40}\.json$/u,
    );
  });
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
