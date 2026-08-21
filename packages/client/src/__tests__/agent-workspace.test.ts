import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  computeRuntimeSnapshotHashes,
  type EffectiveRuntimeSnapshot,
  type SessionReconcileRequest,
} from "@opentag/shared";
import { afterEach, describe, expect, it } from "vitest";
import { AgentWorkspaceManager } from "../runtime/agent-workspace.js";
import { agentRuntimePaths, deriveRuntimeKey } from "../runtime/runtime-paths.js";
import { SessionBindingStore } from "../runtime/session-binding-store.js";
import { SessionReconciler } from "../runtime/session-reconciler.js";

const homes: string[] = [];
afterEach(async () => Promise.all(homes.splice(0).map((home) => rm(home, { recursive: true, force: true }))));

describe("AgentWorkspaceManager", () => {
  it("C-01 derives stable non-reversible path keys for hostile IDs", () => {
    const values = ["agent-1", "../agent", "a/b", "a\\b", "Ａgent", "agent-2"];
    const keys = values.map((value) => deriveRuntimeKey("agent", value));
    expect(new Set(keys).size).toBe(values.length);
    expect(deriveRuntimeKey("agent", "agent-1")).toBe(keys[0]);
    for (const [index, key] of keys.entries()) {
      expect(key).toMatch(/^a-[a-f0-9]{40}$/);
      expect(key).not.toContain(values[index]);
      expect(key).not.toContain("/");
    }
  });

  it("creates one empty workspace root and shares it across Sessions", async () => {
    const fixture = await workspaceFixture();
    const first = reconcileRequest(fixture.computerId, "session-1", snapshot("agent-1", "workspace-1", "session A"));
    const second = reconcileRequest(fixture.computerId, "session-2", snapshot("agent-1", "workspace-1", "session B"));

    await expect(fixture.reconciler.reconcile(first)).resolves.toMatchObject({ status: "ready" });
    const cwd = await fixture.workspace.cwd("agent-1");
    expect(cwd).toBe(await fixture.workspace.cwd("agent-1"));
    expect(cwd).toBe(await realpathForTest(fixture.workspace.paths("agent-1").workspaceRoot));
    await expect(readdir(cwd)).resolves.toEqual([]);
    await writeFile(resolve(cwd, "shared.txt"), "from session A", "utf8");

    await expect(fixture.reconciler.reconcile(second)).resolves.toMatchObject({ status: "ready" });
    await expect(readFile(resolve(await fixture.workspace.cwd("agent-1"), "shared.txt"), "utf8")).resolves.toBe(
      "from session A",
    );
  });

  it("isolates Agents without creating an OpenTag instruction file", async () => {
    const fixture = await workspaceFixture();
    await Promise.all([
      fixture.reconciler.reconcile(
        reconcileRequest(fixture.computerId, "session-a", snapshot("agent-a", "workspace-a", "secret A")),
      ),
      fixture.reconciler.reconcile(
        reconcileRequest(fixture.computerId, "session-b", snapshot("agent-b", "workspace-b", "secret B")),
      ),
    ]);

    const cwdA = await fixture.workspace.cwd("agent-a");
    const cwdB = await fixture.workspace.cwd("agent-b");
    expect(cwdA).not.toBe(cwdB);
    await writeFile(resolve(cwdA, "only-a.txt"), "A", "utf8");
    await expect(readFile(resolve(cwdB, "only-a.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(resolve(cwdA, "AGENTS.md"))).rejects.toMatchObject({ code: "ENOENT" });
    if (process.platform !== "win32") expect((await stat(cwdA)).mode & 0o777).toBe(0o700);
  });

  it("preserves workspace files across Agent instruction revisions", async () => {
    const fixture = await workspaceFixture();
    const initialRuntime = snapshot("agent-1", "workspace-1", "session");
    const initial = reconcileRequest(fixture.computerId, "session-1", initialRuntime);
    await fixture.reconciler.reconcile(initial);
    const cwd = await fixture.workspace.cwd("agent-1");
    await writeFile(resolve(cwd, "kept.txt"), "keep", "utf8");
    const upgradedRuntime: EffectiveRuntimeSnapshot = {
      ...initialRuntime,
      revision: { ...initialRuntime.revision, agent: { sequence: 2, id: "agent-revision-2" } },
      instructions: { ...initialRuntime.instructions, agent: "upgraded agent instructions" },
    };

    await expect(
      fixture.reconciler.reconcile({ ...initial, requestId: randomUUID(), runtime: upgradedRuntime }),
    ).resolves.toMatchObject({ status: "ready" });
    await expect(readFile(resolve(cwd, "kept.txt"), "utf8")).resolves.toBe("keep");
    await expect(stat(resolve(cwd, "AGENTS.md"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not inspect or mutate existing workspace contents", async () => {
    const fixture = await workspaceFixture();
    const runtime = snapshot("agent-1", "workspace-1", "session");
    const paths = fixture.workspace.paths(runtime.agentId);
    const nestedFiles = resolve(paths.workspaceRoot, "files", "assets");
    await mkdir(nestedFiles, { recursive: true, mode: 0o700 });
    await writeFile(resolve(paths.workspaceRoot, "AGENTS.md"), "# User instructions\n", "utf8");
    await writeFile(resolve(nestedFiles, "user.txt"), "keep", "utf8");

    await expect(
      fixture.workspace.prepareAgent(runtime, computeRuntimeSnapshotHashes(runtime)),
    ).resolves.toBeUndefined();

    const cwd = await fixture.workspace.cwd(runtime.agentId);
    expect(cwd).toBe(await realpathForTest(paths.workspaceRoot));
    await expect(readFile(resolve(cwd, "AGENTS.md"), "utf8")).resolves.toBe("# User instructions\n");
    await expect(readFile(resolve(cwd, "files", "assets", "user.txt"), "utf8")).resolves.toBe("keep");
  });

  it("fails closed on a symlinked workspace root", async () => {
    const home = await temporaryHome();
    const external = await temporaryHome();
    const paths = agentRuntimePaths(home, "agent-1");
    await mkdir(resolve(paths.workspaceRoot, ".."), { recursive: true, mode: 0o700 });
    await symlink(external, paths.workspaceRoot);
    const workspace = new AgentWorkspaceManager({
      home,
      bindingStore: new SessionBindingStore({ home, providerArtifactIdentity: () => "a".repeat(64) }),
    });
    const runtime = snapshot("agent-1", "workspace-1", "session");

    await expect(workspace.prepareAgent(runtime, computeRuntimeSnapshotHashes(runtime))).rejects.toThrow(
      /real director|workspace/i,
    );
  });
});

async function workspaceFixture() {
  const home = await temporaryHome();
  const computerId = randomUUID();
  const bindingStore = new SessionBindingStore({ home, providerArtifactIdentity: () => "a".repeat(64) });
  const workspace = new AgentWorkspaceManager({ home, bindingStore });
  const reconciler = new SessionReconciler({ computerId, preparation: workspace });
  return { bindingStore, computerId, home, reconciler, workspace };
}

async function temporaryHome(): Promise<string> {
  const home = await mkdtemp(resolve(tmpdir(), "opentag-client-test-"));
  homes.push(home);
  return home;
}

async function realpathForTest(path: string): Promise<string> {
  return (await import("node:fs/promises")).realpath(path);
}

function snapshot(agentId: string, workspaceId: string, sessionInstructions: string): EffectiveRuntimeSnapshot {
  return {
    revision: {
      agent: { sequence: 1, id: "agent-revision-1" },
      session: { sequence: 1, id: "session-revision-1" },
    },
    agentId,
    provider: "codex",
    instructions: {
      platform: "platform instructions",
      agent: "agent instructions",
      session: sessionInstructions,
    },
    execution: { approvalPolicy: "never", networkAccess: false },
    workspace: { workspaceId, mode: "empty_on_create", sharing: "agent" },
  };
}

function reconcileRequest(
  computerId: string,
  sessionId: string,
  runtime: EffectiveRuntimeSnapshot,
): SessionReconcileRequest {
  return {
    type: "session:reconcile",
    requestId: randomUUID(),
    computerId,
    sessionId,
    agentId: runtime.agentId,
    placementGeneration: 1,
    desired: "ready",
    runtime,
  };
}
