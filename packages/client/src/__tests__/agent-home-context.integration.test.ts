import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { EffectiveRuntimeSnapshot, SessionReconcileRequest } from "@opentag/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentWorkspaceManager } from "../runtime/agent-workspace.js";
import {
  type ContextTreeExecFile,
  ContextTreeManager,
  type ContextTreePackage,
  resolveContextTreePackage,
  runContextTreeCli,
} from "../runtime/context-tree.js";
import { SessionBindingStore } from "../runtime/session-binding-store.js";
import { SessionReconciler } from "../runtime/session-reconciler.js";
import { resolveOpenTagHomeLayout } from "../storage/home-layout.js";

/**
 * Offline regression of the shared Agent Home / Context Tree filesystem and CLI contract.
 * It uses real Git, the packaged Context Tree CLI, and production workspace/session/tree
 * managers. It does not invoke a model, prove prompt compliance, or enforce a sandbox.
 */
const execFileAsync = promisify(execFile);
const contextTreePackage = resolveContextTreePackage();
const roots: string[] = [];

vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });

afterEach(async () => Promise.all(roots.splice(0).map((path) => rm(path, { force: true, recursive: true }))));

describe("shared Agent Home and Context Tree", () => {
  it("shares one persistent Home, isolates code worktrees, and sequences Tree writes", async () => {
    if (!contextTreePackage) throw new Error("packaged Context Tree CLI is required");
    const processHome = process.env.HOME;
    const fixture = await isolatedFixture(contextTreePackage);
    const { agentId, computerId, environment, execFile: isolatedExecFile, openTagHome, runCli, runRoot } = fixture;
    const first = createManagers(openTagHome, computerId);
    const requests = ["session-a", "session-b"].map((sessionId) =>
      reconcileRequest(computerId, sessionId, runtime(agentId)),
    );
    for (const request of requests) {
      await expect(first.reconciler.reconcile(request)).resolves.toMatchObject({ status: "ready" });
    }

    const agentHome = await first.workspace.cwd(agentId);
    await expect(readdir(agentHome)).resolves.toEqual([]);
    for (const request of requests) {
      await expect(first.store.read(agentId, request.sessionId)).resolves.toMatchObject({ workspaceId: agentId });
    }
    await writeFile(join(agentHome, "shared-note.txt"), "Persistent shared Home marker\n");
    const { taskA, taskB } = await seedAgentOwnedCode(environment, runRoot, agentHome);

    const userInstructions = "# User-owned instructions\n\nPreserve this exact text.\n";
    await writeFile(join(agentHome, "AGENTS.md"), userInstructions);
    const treeSeed = join(runRoot, "tree-seed");
    await mkdir(treeSeed);
    const created = await runCli(["create", "--project-path", treeSeed, "--json"]);
    expect(created.failureCode).toBeUndefined();
    const treePath = readTreePath(created.payload);
    expect(treePath.startsWith(`${fixture.accountHome}/`)).toBe(true);

    const layout = resolveOpenTagHomeLayout(openTagHome);
    await mkdir(layout.contextTreeConfigDir, { recursive: true });
    await writeFile(
      layout.contextTreeConfigFile,
      `${JSON.stringify({ schemaVersion: 1, target: { kind: "path", path: treePath } })}\n`,
    );
    const treeManager = new ContextTreeManager({
      home: openTagHome,
      codexHome: join(fixture.accountHome, ".codex"),
      contextTreePackage,
      sessionStartBudgetMs: 30_000,
      execFile: isolatedExecFile,
    });
    const statuses = await Promise.all([treeManager.ensureAgent(agentHome), treeManager.ensureAgent(agentHome)]);
    for (const status of statuses) expect(status).toEqual({ status: "ready", treePath });
    expect(await readFile(join(agentHome, "AGENTS.md"), "utf8")).toBe(userInstructions);
    await expect(
      readFile(join(agentHome, ".claude", "skills", "context-tree-read", "SKILL.md"), "utf8"),
    ).resolves.toContain("context-tree sync");
    await expect(
      readFile(join(fixture.accountHome, ".codex", "skills", "context-tree-write", "SKILL.md"), "utf8"),
    ).resolves.toContain("context-tree prepare-write");

    const unanchored = await runCli(["resolve", "--project-path", taskA, "--json"], taskA);
    expect(unanchored.failureCode).toBe("NO_CONNECTION");
    expect(unanchored.payload).toMatchObject({ error: { code: "NO_CONNECTION" } });
    for (const cwd of [taskA, taskB]) {
      const synced = await runCli(["sync", "--project-path", agentHome], cwd);
      expect(synced.failureCode).toBeUndefined();
      expect(readTreePath(synced.payload)).toBe(treePath);
    }

    const markerA = "Parallel code tasks use independent worktrees while sharing one persistent Agent Home.";
    const markerB =
      "This keeps code edits separate without duplicating durable Agent files or shared Context Tree decisions.";
    await recordSequentialTreeWrites({
      agentHome,
      environment,
      markerA,
      markerB,
      runCli,
      runRoot,
      taskA,
      taskB,
      treePath,
    });

    const restarted = createManagers(openTagHome, computerId);
    for (const request of requests) {
      await expect(restarted.reconciler.reconcile({ ...request, requestId: randomUUID() })).resolves.toMatchObject({
        status: "ready",
      });
    }
    expect(await restarted.workspace.cwd(agentId)).toBe(agentHome);
    expect(await readFile(join(agentHome, "shared-note.txt"), "utf8")).toBe("Persistent shared Home marker\n");
    expect(await readFile(join(taskA, "code.txt"), "utf8")).toBe("task A independent edit\n");
    expect(await readFile(join(taskB, "code.txt"), "utf8")).toBe("task B independent edit\n");
    expect(await readFile(join(agentHome, "AGENTS.md"), "utf8")).toBe(userInstructions);
    expect(process.env.HOME).toBe(processHome);
  });
});

async function isolatedFixture(cliPackage: ContextTreePackage) {
  const runRoot = await realpath(await mkdtemp(join(tmpdir(), "opentag-221-home-")));
  roots.push(runRoot);
  const accountHome = join(runRoot, "account");
  const openTagHome = join(runRoot, "opentag");
  const tmp = join(runRoot, "tmp");
  await Promise.all([mkdir(join(accountHome, ".codex"), { recursive: true }), mkdir(tmp, { recursive: true })]);
  await writeFile(
    join(accountHome, ".gitconfig"),
    "[user]\n\tname = OpenTag Test\n\temail = opentag-test@localhost\n[init]\n\tdefaultBranch = master\n",
  );
  const environment: NodeJS.ProcessEnv = {
    HOME: accountHome,
    PATH: process.env.PATH,
    TMPDIR: tmp,
    XDG_CONFIG_HOME: join(accountHome, ".config"),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: join(accountHome, ".gitconfig"),
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "OpenTag Test",
    GIT_AUTHOR_EMAIL: "opentag-test@localhost",
    GIT_COMMITTER_NAME: "OpenTag Test",
    GIT_COMMITTER_EMAIL: "opentag-test@localhost",
  };
  // Always replace env. ContextTreeManager's Codex install spreads process.env, which would
  // leak host credentials if this seam forwarded options.env.
  const isolatedExecFile: ContextTreeExecFile = async (file, args, options) => {
    const { stdout } = await execFileAsync(file, [...args], {
      cwd: options.cwd,
      encoding: "utf8",
      env: environment,
      maxBuffer: options.maxBuffer,
      timeout: options.timeout,
      windowsHide: options.windowsHide,
    });
    return { stdout };
  };
  return {
    accountHome,
    agentId: "agent-221-home",
    computerId: randomUUID(),
    environment,
    execFile: isolatedExecFile,
    openTagHome,
    runCli: (args: readonly string[], cwd = runRoot) =>
      runContextTreeCli(cliPackage, args, { cwd, execFile: isolatedExecFile }),
    runRoot,
  };
}

type RunCli = (args: readonly string[], cwd?: string) => ReturnType<typeof runContextTreeCli>;

/** Fixture-as-Agent: create a local repo, bare clone, and two isolated editing worktrees. */
async function seedAgentOwnedCode(environment: NodeJS.ProcessEnv, runRoot: string, agentHome: string) {
  const seed = join(runRoot, "code-origin");
  await mkdir(seed);
  await git(environment, seed, "init", "-b", "main");
  await writeFile(join(seed, "code.txt"), "baseline\n");
  await git(environment, seed, "add", "code.txt");
  await git(environment, seed, "commit", "-m", "test: seed local repository");
  const clone = join(agentHome, "source-repos", "local-example.git");
  await mkdir(join(agentHome, "source-repos"));
  await git(environment, runRoot, "clone", "--bare", seed, clone);
  expect(await git(environment, clone, "rev-parse", "--is-bare-repository")).toBe("true");
  expect(await git(environment, clone, "remote", "get-url", "origin")).toBe(seed);

  const taskA = join(agentHome, "worktrees", "session-a-task");
  const taskB = join(agentHome, "worktrees", "session-b-task");
  await git(environment, clone, "worktree", "add", taskA, "-b", "test/task-a", "main");
  await git(environment, clone, "worktree", "add", taskB, "-b", "test/task-b", "main");
  await Promise.all([
    writeFile(join(taskA, "code.txt"), "task A independent edit\n"),
    writeFile(join(taskB, "code.txt"), "task B independent edit\n"),
  ]);
  expect(await readFile(join(taskA, "code.txt"), "utf8")).toBe("task A independent edit\n");
  expect(await readFile(join(taskB, "code.txt"), "utf8")).toBe("task B independent edit\n");
  expect(await git(environment, clone, "show", "main:code.txt")).toBe("baseline");
  expect(await git(environment, taskA, "branch", "--show-current")).toBe("test/task-a");
  expect(await git(environment, taskB, "branch", "--show-current")).toBe("test/task-b");
  return { taskA, taskB };
}

/** Sequential prepare-write -> edit -> finish-write, then the other task reads. Never concurrent. */
async function recordSequentialTreeWrites(options: {
  agentHome: string;
  environment: NodeJS.ProcessEnv;
  markerA: string;
  markerB: string;
  runCli: RunCli;
  runRoot: string;
  taskA: string;
  taskB: string;
  treePath: string;
}): Promise<void> {
  const { agentHome, environment, markerA, markerB, runCli, runRoot, taskA, taskB, treePath } = options;
  const treeShas = [await git(environment, treePath, "rev-parse", "HEAD")];
  for (const [cwd, marker, message] of [
    [taskA, markerA, "test: record shared Home decision"],
    [taskB, markerB, "test: record shared Home rationale"],
  ] as const) {
    const prepared = await runCli(["prepare-write", "--project-path", agentHome], cwd);
    expect(prepared.failureCode).toBeUndefined();
    const worktreePath = readWorktreePath(prepared.payload);
    expect(worktreePath.startsWith(`${runRoot}/`)).toBe(true);
    const nodePath = join(worktreePath, "NODE.md");
    await writeFile(nodePath, `${await readFile(nodePath, "utf8")}\n${marker}\n`);
    const finished = await runCli(
      ["finish-write", "--project-path", agentHome, "--worktree-path", worktreePath, "--message", message],
      cwd,
    );
    expect(finished.failureCode).toBeUndefined();
    const other = cwd === taskA ? taskB : taskA;
    const synced = await runCli(["sync", "--project-path", agentHome], other);
    expect(synced.failureCode).toBeUndefined();
    expect(readTreePath(synced.payload)).toBe(treePath);
    const read = await runCli(["read", "--tree-path", treePath, "--json"], other);
    expect(read.failureCode).toBeUndefined();
    expect(readNodeBody(read.payload)).toContain(marker);
    treeShas.push(await git(environment, treePath, "rev-parse", "HEAD"));
  }
  expect(new Set(treeShas).size).toBe(3);
  const finalRead = await runCli(["read", "--tree-path", treePath, "--json"], taskA);
  expect(finalRead.failureCode).toBeUndefined();
  const finalBody = readNodeBody(finalRead.payload);
  expect(finalBody).toContain(markerA);
  expect(finalBody).toContain(markerB);
  const verified = await runCli(["verify", "--tree-path", treePath, "--json"]);
  expect(verified.failureCode).toBeUndefined();
  expect(verified.payload).toMatchObject({ ok: true });
  expect(await git(environment, treePath, "status", "--porcelain")).toBe("");
}

function createManagers(home: string, installationId: string) {
  const store = new SessionBindingStore({ home, providerArtifactIdentity: () => "a".repeat(64) });
  const workspace = new AgentWorkspaceManager({ home, bindingStore: store });
  return {
    store,
    workspace,
    reconciler: new SessionReconciler({ installationId, preparation: workspace }),
  };
}

function runtime(agentId: string): EffectiveRuntimeSnapshot {
  return {
    revision: {
      agent: { sequence: 1, id: "agent-revision-1" },
      session: { sequence: 1, id: "session-revision-1" },
    },
    agentId,
    provider: "codex",
    instructions: {
      platform: "Agent slug: agent-221-home",
      agent: "Local Agent Home regression",
      session: "Filesystem and Context Tree acceptance",
    },
    execution: { approvalPolicy: "never", networkAccess: false },
    workspace: { workspaceId: agentId, mode: "empty_on_create", sharing: "agent" },
  };
}

function reconcileRequest(
  installationId: string,
  sessionId: string,
  snapshot: EffectiveRuntimeSnapshot,
): SessionReconcileRequest {
  return {
    type: "session:reconcile",
    requestId: randomUUID(),
    installationId,
    sessionId,
    agentId: snapshot.agentId,
    placementGeneration: 1,
    desired: "ready",
    runtime: snapshot,
  };
}

async function git(environment: NodeJS.ProcessEnv, cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    env: environment,
    timeout: 30_000,
  });
  return stdout.trim();
}

function readTreePath(payload: unknown): string {
  if (typeof payload !== "object" || payload === null) throw new Error("Context Tree CLI payload is not an object");
  const record = payload as { treePath?: unknown; tree?: { path?: unknown } };
  const treePath = typeof record.treePath === "string" ? record.treePath : record.tree?.path;
  if (typeof treePath !== "string" || treePath.length === 0) {
    throw new Error("Context Tree CLI payload is missing a tree path");
  }
  return treePath;
}

function readWorktreePath(payload: unknown): string {
  if (typeof payload !== "object" || payload === null) throw new Error("Context Tree CLI payload is not an object");
  const worktreePath = (payload as { worktreePath?: unknown }).worktreePath;
  if (typeof worktreePath !== "string" || worktreePath.length === 0) {
    throw new Error("prepare-write payload is missing worktreePath");
  }
  return worktreePath;
}

function readNodeBody(payload: unknown): string {
  if (typeof payload !== "object" || payload === null) throw new Error("Context Tree CLI payload is not an object");
  const body = (payload as { node?: { body?: unknown } }).node?.body;
  if (typeof body !== "string") throw new Error("read payload is missing node.body");
  return body;
}
