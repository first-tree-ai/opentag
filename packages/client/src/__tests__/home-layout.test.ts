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
      runtimeAgents: join(root, "data", "runtime", "agents"),
      serviceState: join(root, "state", "service"),
      state: join(root, "state"),
      workspaces: join(root, "data", "workspaces"),
    });
  });

  it("keeps runtime recovery state and workspaces in separate data roots", async () => {
    const home = await mkdtemp(join(tmpdir(), "opentag-layout-runtime-"));
    directories.push(home);
    const paths = agentRuntimePaths(home, "agent-1");

    expect(paths.controlRoot).toBe(join(home, "data", "runtime", "agents"));
    expect(paths.agentControl).toMatch(new RegExp(`^${escapeRegExp(paths.controlRoot)}/a-[a-f0-9]{40}$`, "u"));
    expect(paths.workspaceRoot).toMatch(
      new RegExp(`^${escapeRegExp(join(home, "data", "workspaces"))}/a-[a-f0-9]{40}$`, "u"),
    );
    expect(sessionBindingPath(home, "agent-1", "session-1")).toContain("/data/runtime/agents/");
    expect(snapshotPath(home, "agent-1", "snapshot-1")).toContain("/data/runtime/agents/");
  });
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}
