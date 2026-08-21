import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
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

  it("creates a root-layout Workspace once and shares it across Sessions", async () => {
    const fixture = await workspaceFixture();
    const first = reconcileRequest(fixture.computerId, "session-1", snapshot("agent-1", "workspace-1", "session A"));
    const second = reconcileRequest(fixture.computerId, "session-2", snapshot("agent-1", "workspace-1", "session B"));

    await expect(fixture.reconciler.reconcile(first)).resolves.toMatchObject({ status: "ready" });
    const cwd = await fixture.workspace.cwd("agent-1");
    expect(cwd).toBe(await realpathForTest(fixture.workspace.paths("agent-1").workspaceRoot));
    await expect(readdir(cwd)).resolves.toEqual([]);
    await writeFile(resolve(cwd, "shared.txt"), "from session A", "utf8");

    await expect(fixture.reconciler.reconcile(second)).resolves.toMatchObject({ status: "ready" });
    await expect(readFile(resolve(await fixture.workspace.cwd("agent-1"), "shared.txt"), "utf8")).resolves.toBe(
      "from session A",
    );
    await expect(readWorkspaceState(fixture.workspace, "agent-1")).resolves.toMatchObject({
      schemaVersion: 3,
      layout: "root",
      transition: "complete",
    });
    if (process.platform !== "win32") {
      expect((await stat(cwd)).mode & 0o777).toBe(0o700);
      expect((await stat(fixture.workspace.paths("agent-1").workspaceState)).mode & 0o777).toBe(0o600);
    }
  });

  it("preserves the exact Issue #101 legacy view while removing only proven managed instructions", async () => {
    const fixture = await workspaceFixture();
    const runtime = snapshot("agent-1", "workspace-1", "session");
    const legacy = managedInstructions("old platform", "old agent");
    const stalePartial = managedInstructions(runtime.instructions.platform, runtime.instructions.agent);
    const paths = await writeLegacyWorkspace(fixture, runtime, {
      schemaVersion: 1,
      rootInstructions: legacy,
      filesInstructions: stalePartial,
    });
    await writeFile(resolve(paths.files, "user.txt"), "keep", "utf8");
    await writeFile(resolve(paths.workspaceRoot, "root-user.txt"), "also keep", "utf8");

    await expect(
      fixture.workspace.prepareAgent(runtime, computeRuntimeSnapshotHashes(runtime)),
    ).resolves.toBeUndefined();

    expect(await fixture.workspace.cwd(runtime.agentId)).toBe(await realpathForTest(paths.files));
    await expect(readFile(resolve(paths.files, "user.txt"), "utf8")).resolves.toBe("keep");
    await expect(readFile(resolve(paths.workspaceRoot, "root-user.txt"), "utf8")).resolves.toBe("also keep");
    await expect(stat(paths.legacyAgentsFile)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(paths.agentsFile)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readWorkspaceState(fixture.workspace, runtime.agentId)).resolves.toEqual({
      schemaVersion: 3,
      agentId: runtime.agentId,
      workspaceId: runtime.workspace.workspaceId,
      provider: runtime.provider,
      layout: "legacy-files",
      transition: "complete",
    });
  });

  it("upgrades a completed schema-v2 managed Workspace without changing its cwd", async () => {
    const fixture = await workspaceFixture();
    const runtime = snapshot("agent-1", "workspace-1", "session");
    const managed = managedInstructions("old platform", "old agent");
    const paths = await writeLegacyWorkspace(fixture, runtime, {
      schemaVersion: 2,
      filesInstructions: managed,
    });
    await writeFile(resolve(paths.files, "kept.txt"), "keep", "utf8");

    await fixture.workspace.prepareAgent(runtime, computeRuntimeSnapshotHashes(runtime));

    expect(await fixture.workspace.cwd(runtime.agentId)).toBe(await realpathForTest(paths.files));
    await expect(readFile(resolve(paths.files, "kept.txt"), "utf8")).resolves.toBe("keep");
    await expect(stat(paths.agentsFile)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("finishes an interrupted schema-v1 migration after the legacy root file was removed", async () => {
    const fixture = await workspaceFixture();
    const runtime = snapshot("agent-1", "workspace-1", "session");
    const oldManaged = managedInstructions("old platform", "old agent");
    const migratedManaged = managedInstructions(runtime.instructions.platform, runtime.instructions.agent);
    const paths = await writeLegacyWorkspace(fixture, runtime, {
      schemaVersion: 1,
      filesInstructions: migratedManaged,
      provenanceInstructions: oldManaged,
    });
    await writeFile(resolve(paths.files, "kept.txt"), "keep", "utf8");

    await expect(
      fixture.workspace.prepareAgent(runtime, computeRuntimeSnapshotHashes(runtime)),
    ).resolves.toBeUndefined();

    expect(await fixture.workspace.cwd(runtime.agentId)).toBe(await realpathForTest(paths.files));
    await expect(readFile(resolve(paths.files, "kept.txt"), "utf8")).resolves.toBe("keep");
    await expect(stat(paths.agentsFile)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readWorkspaceState(fixture.workspace, runtime.agentId)).resolves.toMatchObject({
      schemaVersion: 3,
      transition: "complete",
      layout: "legacy-files",
    });
  });

  it.each(["before-removal", "after-root-removal", "after-all-removal"] as const)(
    "retries an interrupted compatibility transition from %s",
    async (crashPoint) => {
      const fixture = await workspaceFixture();
      const runtime = snapshot("agent-1", "workspace-1", "session");
      const root = managedInstructions("root platform", "root agent");
      const files = managedInstructions("files platform", "files agent");
      const paths = fixture.workspace.paths(runtime.agentId);
      await mkdir(paths.files, { recursive: true, mode: 0o700 });
      await mkdir(paths.workspaceStatesRoot, { recursive: true, mode: 0o700 });
      await writeFile(paths.legacyAgentsFile, root, { mode: 0o444 });
      await writeFile(paths.agentsFile, files, { mode: 0o444 });
      await writeFile(
        paths.workspaceState,
        `${JSON.stringify({
          schemaVersion: 3,
          agentId: runtime.agentId,
          workspaceId: runtime.workspace.workspaceId,
          provider: runtime.provider,
          layout: "legacy-files",
          transition: "pending",
          managedFiles: { root: sha256(root), files: sha256(files) },
        })}\n`,
        { mode: 0o600 },
      );
      if (crashPoint !== "before-removal") await rm(paths.legacyAgentsFile);
      if (crashPoint === "after-all-removal") await rm(paths.agentsFile);

      await expect(
        fixture.workspace.prepareAgent(runtime, computeRuntimeSnapshotHashes(runtime)),
      ).resolves.toBeUndefined();
      await expect(readWorkspaceState(fixture.workspace, runtime.agentId)).resolves.toMatchObject({
        transition: "complete",
        layout: "legacy-files",
      });
      await expect(stat(paths.legacyAgentsFile)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(paths.agentsFile)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it.each(["root", "files"] as const)("fails closed and preserves a user-authored %s AGENTS.md", async (kind) => {
    const fixture = await workspaceFixture();
    const runtime = snapshot("agent-1", "workspace-1", "session");
    const managed = managedInstructions("old platform", "old agent");
    const paths = await writeLegacyWorkspace(fixture, runtime, {
      schemaVersion: 1,
      rootInstructions: kind === "root" ? "# User root instructions\n" : managed,
      filesInstructions: kind === "files" ? "# User files instructions\n" : undefined,
      provenanceInstructions: managed,
    });
    const target = kind === "root" ? paths.legacyAgentsFile : paths.agentsFile;

    await expect(fixture.workspace.prepareAgent(runtime, computeRuntimeSnapshotHashes(runtime))).rejects.toThrow(
      /not proven OpenTag-managed/i,
    );
    await expect(readFile(target, "utf8")).resolves.toContain("User");
    await expect(readWorkspaceState(fixture.workspace, runtime.agentId)).resolves.toMatchObject({ schemaVersion: 1 });
  });

  it("does not apply schema-v2 provenance to a root AGENTS.md with identical bytes", async () => {
    const fixture = await workspaceFixture();
    const runtime = snapshot("agent-1", "workspace-1", "session");
    const managed = managedInstructions("old platform", "old agent");
    const paths = await writeLegacyWorkspace(fixture, runtime, {
      schemaVersion: 2,
      rootInstructions: managed,
      filesInstructions: managed,
    });

    await expect(fixture.workspace.prepareAgent(runtime, computeRuntimeSnapshotHashes(runtime))).rejects.toThrow(
      /root AGENTS\.md is not proven/i,
    );
    await expect(readFile(paths.legacyAgentsFile, "utf8")).resolves.toBe(managed);
    await expect(readFile(paths.agentsFile, "utf8")).resolves.toBe(managed);
  });

  it("does not apply schema-v1 provenance to a copied files/AGENTS.md with identical bytes", async () => {
    if (process.platform === "win32") return;
    const fixture = await workspaceFixture();
    const runtime = snapshot("agent-1", "workspace-1", "session");
    const managed = managedInstructions("old platform", "old agent");
    const paths = await writeLegacyWorkspace(fixture, runtime, {
      schemaVersion: 1,
      rootInstructions: managed,
      filesInstructions: managed,
    });
    await chmod(paths.agentsFile, 0o600);

    await expect(fixture.workspace.prepareAgent(runtime, computeRuntimeSnapshotHashes(runtime))).rejects.toThrow(
      /files\/AGENTS\.md is not proven/i,
    );
    await expect(readFile(paths.agentsFile, "utf8")).resolves.toBe(managed);
  });

  it("fails closed if a stale-looking partial migration file is writable", async () => {
    if (process.platform === "win32") return;
    const fixture = await workspaceFixture();
    const runtime = snapshot("agent-1", "workspace-1", "session");
    const managed = managedInstructions("old platform", "old agent");
    const paths = await writeLegacyWorkspace(fixture, runtime, {
      schemaVersion: 1,
      rootInstructions: managed,
      filesInstructions: managedInstructions("other platform", "other agent"),
    });
    await chmod(paths.agentsFile, 0o600);

    await expect(fixture.workspace.prepareAgent(runtime, computeRuntimeSnapshotHashes(runtime))).rejects.toThrow(
      /not proven OpenTag-managed/i,
    );
    await expect(stat(paths.agentsFile)).resolves.toBeDefined();
  });

  it("fails closed if a proven file changes after pending provenance was recorded", async () => {
    const fixture = await workspaceFixture();
    const runtime = snapshot("agent-1", "workspace-1", "session");
    const paths = fixture.workspace.paths(runtime.agentId);
    const managed = managedInstructions("old", "old");
    await mkdir(paths.files, { recursive: true, mode: 0o700 });
    await mkdir(paths.workspaceStatesRoot, { recursive: true, mode: 0o700 });
    await writeFile(paths.agentsFile, "# User replacement\n", "utf8");
    await writeFile(
      paths.workspaceState,
      `${JSON.stringify({
        schemaVersion: 3,
        agentId: runtime.agentId,
        workspaceId: runtime.workspace.workspaceId,
        provider: runtime.provider,
        layout: "legacy-files",
        transition: "pending",
        managedFiles: { files: sha256(managed) },
      })}\n`,
      "utf8",
    );

    await expect(fixture.workspace.prepareAgent(runtime, computeRuntimeSnapshotHashes(runtime))).rejects.toThrow(
      /changed during transition/i,
    );
    await expect(readFile(paths.agentsFile, "utf8")).resolves.toBe("# User replacement\n");
  });

  it("restores a replacement that was atomically isolated during cleanup", async () => {
    const fixture = await workspaceFixture();
    const runtime = snapshot("agent-1", "workspace-1", "session");
    const paths = fixture.workspace.paths(runtime.agentId);
    const managed = managedInstructions("old", "old");
    const managedHash = sha256(managed);
    const replacement = "# User replacement moved during cleanup\n";
    await mkdir(paths.files, { recursive: true, mode: 0o700 });
    await mkdir(paths.workspaceStatesRoot, { recursive: true, mode: 0o700 });
    await mkdir(paths.workspaceTransitionRoot, { recursive: true, mode: 0o700 });
    await writeFile(resolve(paths.workspaceTransitionRoot, `files-${managedHash}.managed`), replacement, "utf8");
    await writeFile(
      paths.workspaceState,
      `${JSON.stringify({
        schemaVersion: 3,
        agentId: runtime.agentId,
        workspaceId: runtime.workspace.workspaceId,
        provider: runtime.provider,
        layout: "legacy-files",
        transition: "pending",
        managedFiles: { files: managedHash },
      })}\n`,
      "utf8",
    );

    await expect(fixture.workspace.prepareAgent(runtime, computeRuntimeSnapshotHashes(runtime))).rejects.toThrow(
      /changed while OpenTag isolated/i,
    );
    await expect(readFile(paths.agentsFile, "utf8")).resolves.toBe(replacement);
    await expect(
      readFile(resolve(paths.workspaceTransitionRoot, `files-${managedHash}.managed`), "utf8"),
    ).resolves.toBe(replacement);
    await writeFile(paths.agentsFile, "# Later user edit\n", "utf8");
    await expect(
      readFile(resolve(paths.workspaceTransitionRoot, `files-${managedHash}.managed`), "utf8"),
    ).resolves.toBe(replacement);
    await expect(readWorkspaceState(fixture.workspace, runtime.agentId)).resolves.toMatchObject({
      transition: "pending",
    });
  });

  it("restores a directory replacement isolated during cleanup without deleting its backup", async () => {
    const fixture = await workspaceFixture();
    const runtime = snapshot("agent-1", "workspace-1", "session");
    const paths = fixture.workspace.paths(runtime.agentId);
    const managedHash = sha256(managedInstructions("old", "old"));
    const quarantine = resolve(paths.workspaceTransitionRoot, `files-${managedHash}.managed`);
    await mkdir(paths.files, { recursive: true, mode: 0o700 });
    await mkdir(paths.workspaceStatesRoot, { recursive: true, mode: 0o700 });
    await mkdir(quarantine, { recursive: true, mode: 0o700 });
    await writeFile(resolve(quarantine, "user.txt"), "keep", "utf8");
    await writeFile(
      paths.workspaceState,
      `${JSON.stringify({
        schemaVersion: 3,
        agentId: runtime.agentId,
        workspaceId: runtime.workspace.workspaceId,
        provider: runtime.provider,
        layout: "legacy-files",
        transition: "pending",
        managedFiles: { files: managedHash },
      })}\n`,
      "utf8",
    );

    await expect(fixture.workspace.prepareAgent(runtime, computeRuntimeSnapshotHashes(runtime))).rejects.toThrow(
      /non-file Workspace entry/i,
    );
    await expect(readFile(resolve(paths.agentsFile, "user.txt"), "utf8")).resolves.toBe("keep");
    await expect(readFile(resolve(quarantine, "user.txt"), "utf8")).resolves.toBe("keep");
  });

  it("stops managing Workspace instruction files after the compatibility transition completes", async () => {
    const fixture = await workspaceFixture();
    const runtime = snapshot("agent-1", "workspace-1", "session");
    await fixture.workspace.prepareAgent(runtime, computeRuntimeSnapshotHashes(runtime));
    const paths = fixture.workspace.paths(runtime.agentId);
    await writeFile(paths.legacyAgentsFile, "# User instructions\n", "utf8");
    await mkdir(paths.files);
    await writeFile(paths.agentsFile, "# Nested user instructions\n", "utf8");

    await expect(
      fixture.workspace.verifyAgent(runtime, computeRuntimeSnapshotHashes(runtime)),
    ).resolves.toBeUndefined();
    await expect(readFile(paths.legacyAgentsFile, "utf8")).resolves.toBe("# User instructions\n");
    await expect(readFile(paths.agentsFile, "utf8")).resolves.toBe("# Nested user instructions\n");
    expect(await fixture.workspace.cwd(runtime.agentId)).toBe(await realpathForTest(paths.workspaceRoot));
  });

  it("does not recreate a deleted legacy files/ entry after compatibility completes", async () => {
    const fixture = await workspaceFixture();
    const runtime = snapshot("agent-1", "workspace-1", "session");
    const managed = managedInstructions("old platform", "old agent");
    const paths = await writeLegacyWorkspace(fixture, runtime, {
      schemaVersion: 2,
      filesInstructions: managed,
    });
    await fixture.workspace.prepareAgent(runtime, computeRuntimeSnapshotHashes(runtime));
    await rm(paths.files, { recursive: true });

    await expect(
      fixture.workspace.verifyAgent(runtime, computeRuntimeSnapshotHashes(runtime)),
    ).resolves.toBeUndefined();
    await expect(stat(paths.files)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fixture.workspace.cwd(runtime.agentId)).rejects.toThrow(/ENOENT|real director/i);
  });

  it("fails closed when layout state is missing from a non-empty Workspace", async () => {
    const fixture = await workspaceFixture();
    const runtime = snapshot("agent-1", "workspace-1", "session");
    const paths = fixture.workspace.paths(runtime.agentId);
    await mkdir(paths.workspaceRoot, { recursive: true, mode: 0o700 });
    await writeFile(resolve(paths.workspaceRoot, "user.txt"), "keep", "utf8");

    await expect(fixture.workspace.prepareAgent(runtime, computeRuntimeSnapshotHashes(runtime))).rejects.toThrow(
      /non-empty.*no valid layout state/i,
    );
    await expect(readFile(resolve(paths.workspaceRoot, "user.txt"), "utf8")).resolves.toBe("keep");
  });

  it("rejects identity changes recorded by either legacy or current state", async () => {
    const fixture = await workspaceFixture();
    const runtime = snapshot("agent-1", "workspace-1", "session");
    await fixture.workspace.prepareAgent(runtime, computeRuntimeSnapshotHashes(runtime));

    await expect(
      fixture.workspace.prepareAgent(
        { ...runtime, workspace: { ...runtime.workspace, workspaceId: "workspace-other" } },
        computeRuntimeSnapshotHashes(runtime),
      ),
    ).rejects.toThrow(/identity cannot be changed/i);
  });

  it("requires preparation to complete before resolving cwd", async () => {
    const fixture = await workspaceFixture();
    await expect(fixture.workspace.cwd("missing")).rejects.toThrow(/transition is incomplete/i);
  });

  it.each([
    { schemaVersion: 9 },
    { schemaVersion: 3, transition: "complete", layout: "invalid" },
    { schemaVersion: 3, transition: "invalid", layout: "legacy-files" },
    { schemaVersion: 3, transition: "pending", layout: "legacy-files", managedFiles: null },
    { schemaVersion: 3, transition: "pending", layout: "legacy-files", managedFiles: { other: "x" } },
    { schemaVersion: 3, transition: "pending", layout: "legacy-files", managedFiles: { files: "bad" } },
  ])("rejects malformed compatibility state %#", async (partial) => {
    const fixture = await workspaceFixture();
    const runtime = snapshot("agent-1", "workspace-1", "session");
    const paths = fixture.workspace.paths(runtime.agentId);
    await mkdir(paths.workspaceRoot, { recursive: true, mode: 0o700 });
    await mkdir(paths.workspaceStatesRoot, { recursive: true, mode: 0o700 });
    await writeFile(
      paths.workspaceState,
      `${JSON.stringify({
        agentId: runtime.agentId,
        workspaceId: runtime.workspace.workspaceId,
        provider: runtime.provider,
        ...partial,
      })}\n`,
      "utf8",
    );

    await expect(fixture.workspace.prepareAgent(runtime, computeRuntimeSnapshotHashes(runtime))).rejects.toThrow(
      /workspace.*(state|layout|transition|provenance|hash)/i,
    );
  });

  it("fails closed on a symlinked Workspace root", async () => {
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

async function writeLegacyWorkspace(
  fixture: Awaited<ReturnType<typeof workspaceFixture>>,
  runtime: EffectiveRuntimeSnapshot,
  options: {
    schemaVersion: 1 | 2;
    rootInstructions?: string;
    filesInstructions?: string;
    provenanceInstructions?: string;
  },
) {
  const paths = fixture.workspace.paths(runtime.agentId);
  await mkdir(paths.files, { recursive: true, mode: 0o700 });
  await mkdir(paths.workspaceStatesRoot, { recursive: true, mode: 0o700 });
  if (options.rootInstructions !== undefined) {
    await writeFile(paths.legacyAgentsFile, options.rootInstructions, { mode: 0o444 });
  }
  if (options.filesInstructions !== undefined) {
    await writeFile(paths.agentsFile, options.filesInstructions, { mode: 0o444 });
  }
  const provenance = options.provenanceInstructions ?? options.rootInstructions ?? options.filesInstructions;
  if (provenance === undefined) throw new Error("legacy fixture requires managed instruction provenance");
  const hashes = computeRuntimeSnapshotHashes(runtime);
  await writeFile(
    paths.workspaceState,
    `${JSON.stringify({
      schemaVersion: options.schemaVersion,
      agentId: runtime.agentId,
      workspaceId: runtime.workspace.workspaceId,
      provider: runtime.provider,
      appliedAgentRevisionSequence: runtime.revision.agent.sequence,
      appliedAgentRevisionId: runtime.revision.agent.id,
      agentConfigHash: hashes.agentConfigHash,
      managedInstructionsHash: sha256(provenance),
    })}\n`,
    { mode: 0o600 },
  );
  return paths;
}

function managedInstructions(platform: string, agent: string): string {
  return [
    "# OpenTag managed instructions",
    "",
    "This file is managed by OpenTag. Session-specific instructions are injected per turn.",
    "",
    "## Platform",
    "",
    platform,
    "",
    "## Agent",
    "",
    agent,
    "",
  ].join("\n");
}

async function readWorkspaceState(workspace: AgentWorkspaceManager, agentId: string) {
  return JSON.parse(await readFile(workspace.paths(agentId).workspaceState, "utf8"));
}

async function temporaryHome(): Promise<string> {
  const home = await mkdtemp(resolve(tmpdir(), "opentag-client-test-"));
  homes.push(home);
  return home;
}

async function realpathForTest(path: string): Promise<string> {
  return (await import("node:fs/promises")).realpath(path);
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
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
