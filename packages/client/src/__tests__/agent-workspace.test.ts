import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
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

  it("C-02/C-03 creates an empty Agent workspace once and shares it across Sessions", async () => {
    const fixture = await workspaceFixture();
    const first = reconcileRequest(fixture.computerId, "session-1", snapshot("agent-1", "workspace-1", "session A"));
    const second = reconcileRequest(fixture.computerId, "session-2", snapshot("agent-1", "workspace-1", "session B"));

    await expect(fixture.reconciler.reconcile(first)).resolves.toMatchObject({ status: "ready" });
    const cwd = await fixture.workspace.cwd("agent-1");
    expect(await readFile(resolve(cwd, ".missing"), "utf8").catch(() => undefined)).toBeUndefined();
    await expect(readdir(cwd)).resolves.toEqual(["AGENTS.md"]);
    await writeFile(resolve(cwd, "shared.txt"), "from session A", "utf8");

    await expect(fixture.reconciler.reconcile(second)).resolves.toMatchObject({ status: "ready" });
    expect(await fixture.workspace.cwd("agent-1")).toBe(cwd);
    expect(await readFile(resolve(await fixture.workspace.cwd("agent-1"), "shared.txt"), "utf8")).toBe(
      "from session A",
    );
    expect(fixture.reconciler.getSession("session-1")?.workspaceId).toBe("workspace-1");
    expect(fixture.reconciler.getSession("session-2")?.workspaceId).toBe("workspace-1");
  });

  it("C-04/C-08 isolates Agents and keeps Session instructions out of managed AGENTS.md", async () => {
    const fixture = await workspaceFixture();
    const a = reconcileRequest(fixture.computerId, "session-a", snapshot("agent-a", "workspace-a", "secret A"));
    const b = reconcileRequest(fixture.computerId, "session-b", snapshot("agent-b", "workspace-b", "secret B"));
    await Promise.all([fixture.reconciler.reconcile(a), fixture.reconciler.reconcile(b)]);

    const cwdA = await fixture.workspace.cwd("agent-a");
    const cwdB = await fixture.workspace.cwd("agent-b");
    expect(cwdA).not.toBe(cwdB);
    await writeFile(resolve(cwdA, "only-a.txt"), "A", "utf8");
    expect(await readFile(resolve(cwdB, "only-a.txt"), "utf8").catch(() => undefined)).toBeUndefined();

    const agentsA = fixture.workspace.paths("agent-a").agentsFile;
    expect(resolve(agentsA, "..")).toBe(cwdA);
    const managed = await readFile(agentsA, "utf8");
    expect(managed).toContain("platform instructions");
    expect(managed).toContain("agent instructions");
    expect(managed).not.toContain("secret A");
    expect(managed).not.toContain("secret B");
    if (process.platform !== "win32") {
      expect((await stat(agentsA)).mode & 0o777).toBe(0o444);
      expect((await stat(cwdA)).mode & 0o777).toBe(0o700);
      expect((await stat(fixture.workspace.paths("agent-a").workspaceState)).mode & 0o777).toBe(0o600);
    }
  });

  it("C-05 coalesces concurrent bootstrap for ten Sessions of one Agent", async () => {
    const fixture = await workspaceFixture();
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        fixture.reconciler.reconcile(
          reconcileRequest(
            fixture.computerId,
            `session-${index}`,
            snapshot("agent-1", "workspace-1", `session instructions ${index}`),
          ),
        ),
      ),
    );
    expect(results.every((result) => result.status === "ready")).toBe(true);
    expect(new Set(results.map(() => fixture.workspace.paths("agent-1").files)).size).toBe(1);
    await expect(readdir(fixture.workspace.paths("agent-1").sessions)).resolves.toHaveLength(10);
  });

  it("keeps workspace-state ownership separate from Session binding and snapshot directories", async () => {
    const fixture = await workspaceFixture();
    const runtime = snapshot("agent-1", "workspace-1", "session");
    const paths = fixture.workspace.paths("agent-1");

    await fixture.workspace.prepareAgent(runtime, computeRuntimeSnapshotHashes(runtime));

    await expect(stat(paths.workspaceState)).resolves.toBeDefined();
    await expect(stat(paths.sessions)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(paths.snapshots)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("C-11 atomically upgrades Agent instructions without deleting live files", async () => {
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
    expect(await readFile(resolve(cwd, "kept.txt"), "utf8")).toBe("keep");
    expect(await readFile(fixture.workspace.paths("agent-1").agentsFile, "utf8")).toContain(
      "upgraded agent instructions",
    );
  });

  it("migrates a v1 workspace to one managed AGENTS.md in the Codex cwd", async () => {
    const fixture = await workspaceFixture();
    const runtime = snapshot("agent-1", "workspace-1", "session");
    const paths = await downgradeWorkspaceToV1(fixture.workspace, runtime);
    await writeFile(resolve(paths.files, "user.txt"), "keep", "utf8");

    await expect(
      fixture.workspace.prepareAgent(runtime, computeRuntimeSnapshotHashes(runtime)),
    ).resolves.toBeUndefined();

    expect(paths.agentsFile).toBe(resolve(await fixture.workspace.cwd("agent-1"), "AGENTS.md"));
    await expect(readFile(paths.agentsFile, "utf8")).resolves.toContain("agent instructions");
    await expect(stat(paths.legacyAgentsFile)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(resolve(paths.files, "user.txt"), "utf8")).resolves.toBe("keep");
    expect(JSON.parse(await readFile(paths.workspaceState, "utf8"))).toMatchObject({ schemaVersion: 2 });
  });

  it.each(["new-written", "legacy-removed"] as const)(
    "re-enters a v1 migration after the %s crash point",
    async (crashPoint) => {
      const fixture = await workspaceFixture();
      const runtime = snapshot("agent-1", "workspace-1", "session");
      const paths = await downgradeWorkspaceToV1(fixture.workspace, runtime);
      const content = await readFile(paths.legacyAgentsFile, "utf8");
      await writeFile(paths.agentsFile, content, { mode: 0o444 });
      if (crashPoint === "legacy-removed") await rm(paths.legacyAgentsFile);

      await expect(
        fixture.workspace.prepareAgent(runtime, computeRuntimeSnapshotHashes(runtime)),
      ).resolves.toBeUndefined();
      await expect(readFile(paths.agentsFile, "utf8")).resolves.toBe(content);
      await expect(stat(paths.legacyAgentsFile)).rejects.toMatchObject({ code: "ENOENT" });
      expect(JSON.parse(await readFile(paths.workspaceState, "utf8"))).toMatchObject({ schemaVersion: 2 });
    },
  );

  it.each(["legacy", "current"] as const)("fails closed when the %s migration file was modified", async (kind) => {
    const fixture = await workspaceFixture();
    const runtime = snapshot("agent-1", "workspace-1", "session");
    const paths = await downgradeWorkspaceToV1(fixture.workspace, runtime);
    const target = kind === "legacy" ? paths.legacyAgentsFile : paths.agentsFile;
    if (kind === "current") await writeFile(target, "external current instructions\n", { mode: 0o444 });
    else {
      await chmod(target, 0o600);
      await writeFile(target, "external legacy instructions\n", "utf8");
    }

    await expect(fixture.workspace.prepareAgent(runtime, computeRuntimeSnapshotHashes(runtime))).rejects.toThrow(
      /modified outside|conflicting AGENTS/i,
    );
    await expect(readFile(target, "utf8")).resolves.toContain("external");
    expect(JSON.parse(await readFile(paths.workspaceState, "utf8"))).toMatchObject({ schemaVersion: 1 });
  });

  it.each(["modified", "legacy-reappeared"] as const)(
    "fails closed when a v2 managed file is %s outside OpenTag",
    async (change) => {
      const fixture = await workspaceFixture();
      const runtime = snapshot("agent-1", "workspace-1", "session");
      await fixture.workspace.prepareAgent(runtime, computeRuntimeSnapshotHashes(runtime));
      const paths = fixture.workspace.paths("agent-1");
      if (change === "modified") {
        await chmod(paths.agentsFile, 0o600);
        await writeFile(paths.agentsFile, "external\n", "utf8");
      } else {
        await writeFile(paths.legacyAgentsFile, "external\n", "utf8");
      }

      await expect(fixture.workspace.prepareAgent(runtime, computeRuntimeSnapshotHashes(runtime))).rejects.toThrow(
        /modified outside|legacy AGENTS/i,
      );
    },
  );

  it("recovers a v2 bootstrap whose state was persisted before the managed file", async () => {
    const fixture = await workspaceFixture();
    const runtime = snapshot("agent-1", "workspace-1", "session");
    const hashes = computeRuntimeSnapshotHashes(runtime);
    await fixture.workspace.prepareAgent(runtime, hashes);
    const paths = fixture.workspace.paths("agent-1");
    await rm(paths.agentsFile);

    await expect(fixture.workspace.prepareAgent(runtime, hashes)).resolves.toBeUndefined();
    await expect(readFile(paths.agentsFile, "utf8")).resolves.toContain("agent instructions");
  });

  it("C-13 fails closed on symlinked or unmanaged workspace state", async () => {
    const home = await temporaryHome();
    const external = await temporaryHome();
    const paths = agentRuntimePaths(home, "agent-1");
    await mkdir(resolve(home, "data", "workspaces"), { recursive: true, mode: 0o700 });
    await symlink(external, paths.workspaceRoot);
    const bindingStore = new SessionBindingStore({ home, providerArtifactIdentity: () => "a".repeat(64) });
    const workspace = new AgentWorkspaceManager({ home, bindingStore });
    const computerId = randomUUID();
    const reconciler = new SessionReconciler({ computerId, preparation: workspace });
    const request = reconcileRequest(computerId, "session-1", snapshot("agent-1", "workspace-1", "s"));

    await expect(reconciler.reconcile(request)).rejects.toThrow(/real director|workspace/i);
  });

  it.each(["symlink", "file"] as const)("fails closed on a %s workspace-states root", async (kind) => {
    const home = await temporaryHome();
    const external = await temporaryHome();
    const runtimeRoot = resolve(home, "data", "runtime");
    const workspaceStatesRoot = resolve(runtimeRoot, "workspace-states");
    await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
    if (kind === "symlink") await symlink(external, workspaceStatesRoot, "dir");
    else await writeFile(workspaceStatesRoot, "not-a-directory", "utf8");
    const bindingStore = new SessionBindingStore({ home, providerArtifactIdentity: () => "a".repeat(64) });
    const workspace = new AgentWorkspaceManager({ home, bindingStore });
    const runtime = snapshot("agent-1", "workspace-1", "session");

    await expect(workspace.prepareAgent(runtime, computeRuntimeSnapshotHashes(runtime))).rejects.toThrow(
      /real director|directories/i,
    );
    expect(await readdir(external)).toEqual([]);
  });

  it("ignores the legacy runtime/agents workspace state without migrating or deleting it", async () => {
    const home = await temporaryHome();
    const legacyPath = resolve(
      home,
      "data",
      "runtime",
      "agents",
      deriveRuntimeKey("agent", "agent-1"),
      "workspace.json",
    );
    await mkdir(resolve(legacyPath, ".."), { recursive: true, mode: 0o700 });
    await writeFile(legacyPath, '{"legacy":true}\n', { mode: 0o600 });
    const bindingStore = new SessionBindingStore({ home, providerArtifactIdentity: () => "a".repeat(64) });
    const workspace = new AgentWorkspaceManager({ home, bindingStore });
    const runtime = snapshot("agent-1", "workspace-1", "session");

    await expect(workspace.prepareAgent(runtime, computeRuntimeSnapshotHashes(runtime))).resolves.toBeUndefined();
    expect(await readFile(legacyPath, "utf8")).toBe('{"legacy":true}\n');
    expect(JSON.parse(await readFile(workspace.paths("agent-1").workspaceState, "utf8"))).toMatchObject({
      agentId: "agent-1",
      workspaceId: "workspace-1",
    });
  });

  it("fails closed when workspace state is lost while the managed Workspace remains non-empty", async () => {
    const fixture = await workspaceFixture();
    const runtime = snapshot("agent-1", "workspace-1", "session");
    const hashes = computeRuntimeSnapshotHashes(runtime);
    await fixture.workspace.prepareAgent(runtime, hashes);
    const paths = fixture.workspace.paths("agent-1");
    await rm(paths.workspaceState);

    await expect(fixture.workspace.prepareAgent(runtime, hashes)).rejects.toThrow(/non-empty.*no valid runtime state/i);
  });

  it("rejects an invalid persisted Provider ID at the workspace-state read boundary", async () => {
    const fixture = await workspaceFixture();
    const runtime = snapshot("agent-1", "workspace-1", "session");
    const hashes = computeRuntimeSnapshotHashes(runtime);
    await fixture.workspace.prepareAgent(runtime, hashes);
    const statePath = fixture.workspace.paths("agent-1").workspaceState;
    const state = JSON.parse(await readFile(statePath, "utf8")) as Record<string, unknown>;
    state.provider = "Claude_Code";
    await writeFile(statePath, `${JSON.stringify(state)}\n`, "utf8");

    await expect(fixture.workspace.verifyAgent(runtime, hashes)).rejects.toThrow("workspace state values are invalid");
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

async function downgradeWorkspaceToV1(workspace: AgentWorkspaceManager, runtime: EffectiveRuntimeSnapshot) {
  await workspace.prepareAgent(runtime, computeRuntimeSnapshotHashes(runtime));
  const paths = workspace.paths(runtime.agentId);
  await rename(paths.agentsFile, paths.legacyAgentsFile);
  const state = JSON.parse(await readFile(paths.workspaceState, "utf8"));
  await writeFile(paths.workspaceState, `${JSON.stringify({ ...state, schemaVersion: 1 }, undefined, 2)}\n`, {
    mode: 0o600,
  });
  return paths;
}

async function temporaryHome(): Promise<string> {
  const home = await mkdtemp(resolve(tmpdir(), "opentag-client-test-"));
  homes.push(home);
  return home;
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
    allowedTools: [],
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
