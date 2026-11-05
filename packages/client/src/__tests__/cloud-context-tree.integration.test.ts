import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { type CloudContextTreePreparation, prepareCloudContextTree } from "../runner/cloud-context-tree.js";
import { createWorkspaceArchive, restoreWorkspaceArchive } from "../runner/workspace-archive.js";
import { resolveContextTreePackage } from "../runtime/context-tree.js";

/**
 * End-to-end Context Tree continuity for one Cloud Session with the REAL packaged CLI, real Git
 * and the real workspace archive: no public network (the disposable tree is reached through a
 * `git` shim that only rewrites transport), and the exact in-workspace HOME layout the
 * Cloud worker uses.
 */

const execFileAsync = promisify(execFile);
const contextTreePackage = resolveContextTreePackage();
function treeResult(result: CloudContextTreePreparation) {
  if (result.status.status !== "configured" || result.status.connections.length !== 1)
    throw new Error("Expected one configured tree");
  const entry = result.status.connections[0];
  if (!entry) throw new Error("Missing tree result");
  return entry;
}

const roots: string[] = [];
afterEach(() => Promise.all(roots.splice(0).map((path) => rm(path, { force: true, recursive: true }))));

async function runCli(args: readonly string[], environment: NodeJS.ProcessEnv): Promise<Record<string, unknown>> {
  if (!contextTreePackage) throw new Error("the Context Tree package must resolve");
  const { stdout } = await execFileAsync(process.execPath, [contextTreePackage.cliPath, ...args], {
    encoding: "utf8",
    env: environment,
  });
  return JSON.parse(stdout.trim()) as Record<string, unknown>;
}

/** Run one command through the managed CLI shim exactly as the Agent would. */
async function runManaged(
  binDirectory: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
): Promise<Record<string, unknown>> {
  return runManagedRaw(binDirectory, args, environment).catch((error: unknown) => {
    const detail = error as { stderr?: string; stdout?: string; message?: string };
    throw new Error(`managed context-tree failed: ${detail.stderr || detail.stdout || detail.message || "no output"}`);
  });
}

/** Run one command through the managed shim and return its JSON output even when it exits nonzero. */
async function runManagedResult(
  binDirectory: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
): Promise<{ readonly code: number; readonly payload: Record<string, unknown> }> {
  try {
    return { code: 0, payload: await runManagedRaw(binDirectory, args, environment) };
  } catch (error) {
    const detail = error as { code?: number; stdout?: string };
    if (typeof detail.code !== "number" || !detail.stdout) throw error;
    return { code: detail.code, payload: JSON.parse(detail.stdout.trim()) as Record<string, unknown> };
  }
}
async function runManagedRaw(
  binDirectory: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
): Promise<Record<string, unknown>> {
  const { stdout } = await execFileAsync(join(binDirectory, "context-tree"), [...args], {
    encoding: "utf8",
    env: { ...environment, PATH: `${binDirectory}${delimiter}${environment.PATH ?? ""}` },
  });
  return JSON.parse(stdout.trim()) as Record<string, unknown>;
}

/**
 * Preparation only configures the selection; the Agent syncs through the managed shim at a task
 * boundary, as the context-tree-read skill instructs, and keeps the returned treeRoot.
 */
async function prepareAndSync(input: Parameters<typeof prepareCloudContextTree>[0], environment: NodeJS.ProcessEnv) {
  const prepared = await prepareCloudContextTree(input);
  const tree = treeResult(prepared);
  if (tree.status !== "available" || !prepared.binDirectory) throw new Error("expected an available tree");
  const synced = await runManaged(prepared.binDirectory, ["sync", "--project-path", tree.projectPath], environment);
  const [entry] = synced.connections as { ok: boolean; treeRoot: string }[];
  if (!entry?.ok) throw new Error(JSON.stringify(synced));
  return { binDirectory: prepared.binDirectory, projectPath: tree.projectPath, treePath: entry.treeRoot };
}

async function recordMemberMemory(worktreePath: string, slug: string, memory: string): Promise<void> {
  const directory = join(worktreePath, "members", slug);
  await mkdir(directory, { recursive: true });
  const node = (title: string, body: string) => `---\ntitle: "${title}"\n---\n\n# ${title}\n\n${body}\n`;
  await writeFile(join(directory, "NODE.md"), node(slug, "- **[memory.md](memory.md)** — private working memory."));
  await writeFile(join(directory, "memory.md"), node(`${slug} Memory`, memory));
  await writeFile(
    join(worktreePath, "members", "NODE.md"),
    node("Members", `- **[${slug}/](${slug}/NODE.md)** — ${slug} memory.`),
  );
}

interface Fixture {
  readonly environment: Record<string, string>;
  readonly input: (overrides?: { scratch?: string }) => Parameters<typeof prepareCloudContextTree>[0];
  readonly root: string;
  readonly repositoryPath: string;
  readonly treePath: string;
  readonly workspace: string;
}

/** Every regular file in a directory tree, for persisted-secret scans. */
async function workspaceFiles(directory: string): Promise<Buffer[]> {
  const files: Buffer[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await workspaceFiles(path)));
    else if (entry.isFile()) files.push(await readFile(path));
  }
  return files;
}

/** A disposable published tree plus one Session workspace, all local. */
async function fixture(prefix: string, directory = "."): Promise<Fixture> {
  if (!contextTreePackage) throw new Error("the Context Tree package must resolve");
  const root = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  roots.push(root);
  const accountHome = join(root, "account");
  await mkdir(accountHome, { recursive: true });
  await writeFile(
    join(accountHome, ".gitconfig"),
    "[user]\n\tname = OpenTag Test\n\temail = opentag-test@localhost\n[init]\n\tdefaultBranch = master\n",
    "utf8",
  );
  const seed = join(root, "tree-seed");
  await mkdir(seed, { recursive: true });
  const repositoryPath = join(root, "remote-tree");
  const created = await runCli(["init", join(repositoryPath, directory), "--project-path", seed, "--json"], {
    HOME: accountHome,
    PATH: process.env.PATH ?? "",
  });
  const treePath = created.treeRoot as string;
  const gitEnv = { HOME: accountHome, PATH: process.env.PATH };
  if (directory !== ".") {
    await mkdir(join(repositoryPath, "src"));
    await writeFile(join(repositoryPath, "src", "code.ts"), "export const value = 1;\n");
    await writeFile(join(repositoryPath, "README.md"), "Unchanged repository instructions.\n");
  }
  await execFileAsync("/usr/bin/git", ["init", "--initial-branch=main", repositoryPath], { env: gitEnv });
  await execFileAsync("/usr/bin/git", ["-C", repositoryPath, "add", "."], { env: gitEnv });
  await execFileAsync("/usr/bin/git", ["-C", repositoryPath, "commit", "-m", "init"], { env: gitEnv });
  await execFileAsync("/usr/bin/git", ["-C", repositoryPath, "config", "receive.denyCurrentBranch", "updateInstead"]);

  // Rewrite only transport: clone from the disposable tree, keep the GitHub origin identity, and
  // route fetch/push/pull back to the disposable tree. `remote get-url` must stay untouched.
  const gitBin = join(root, "git-bin");
  await mkdir(gitBin, { recursive: true });
  const gitShim = join(gitBin, "git");
  await writeFile(
    gitShim,
    `#!/bin/sh
root=""
previous=""
for argument in "$@"; do
  if [ "$previous" = "-C" ]; then root="$argument"; fi
  previous="$argument"
done
case " $* " in
  *" clone "*)
    for argument in "$@"; do destination="$argument"; done
    /usr/bin/git -C "$root" clone --bare --quiet --origin origin -- "file://${repositoryPath}" "$destination" || exit $?
    /usr/bin/git -C "$destination" remote set-url origin "https://github.com/acme/memory.git"
    exit $?
    ;;
  *" fetch "*|*" push "*|*" pull "*)
    exec /usr/bin/git -c protocol.file.allow=always -c "url.file://${repositoryPath}.insteadOf=https://github.com/acme/memory.git" "$@"
    ;;
esac
if [ -n "$root" ]; then exec /usr/bin/git -C "$root" "$@"; fi
exec /usr/bin/git "$@"
`,
    "utf8",
  );
  await chmod(gitShim, 0o700);

  const workspace = await realpath(await mkdtemp(join(root, "workspace-")));
  const defaultScratch = join(root, "scratch");
  await mkdir(defaultScratch, { recursive: true });
  const path = `${gitBin}${delimiter}${process.env.PATH ?? ""}`;
  const environment = {
    GIT_AUTHOR_EMAIL: "opentag-test@localhost",
    GIT_AUTHOR_NAME: "OpenTag Test",
    GIT_COMMITTER_EMAIL: "opentag-test@localhost",
    GIT_COMMITTER_NAME: "OpenTag Test",
    GH_TOKEN: "execution-local-handle",
    OPENTAG_PROVIDER_PROXY_URL: "http://127.0.0.1:1234",
    // Execution-scoped material must reach CLI children but never the saved workspace.
    OPENTAG_TEST_EXECUTION_SECRET: "execution-secret-0123456789abcdef",
    PATH: path,
  };
  return {
    environment,
    input: (overrides = {}) => ({
      agentSlug: "tree-agent",
      environment,
      path,
      contextTrees: [{ kind: "git" as const, path: directory, ref: "main", repository: "acme/memory" }],
      scratch: overrides.scratch ?? defaultScratch,
      workspace,
    }),
    root,
    repositoryPath,
    treePath,
    workspace,
  };
}

describe("Cloud Context Tree continuity (real CLI)", () => {
  it.each([".", "docs"])(
    "publishes a prepared %s write after archive save and restore through the managed CLI",
    async (directory) => {
      const fixtureValue = await fixture("cloud-ct-roundtrip-", directory);
      const first = await prepareAndSync(fixtureValue.input(), fixtureValue.environment);
      const treePath = first.treePath;
      expect(treePath.startsWith(`${fixtureValue.workspace}/`)).toBe(true);

      // The Agent prepares a write through the managed CLI; the worktree lands INSIDE the saved
      // workspace because the shim pins HOME there.
      const prepared = await runManaged(
        first.binDirectory,
        ["write", "prepare", "--project-path", first.projectPath],
        fixtureValue.environment,
      );
      const worktreePath = prepared.treeRoot as string;
      expect(
        worktreePath.startsWith(join(fixtureValue.workspace, ".opentag/context-tree/home/.context-tree/worktrees")),
      ).toBe(true);
      await recordMemberMemory(worktreePath, "tree-agent", "Prefer short-lived branches.");
      if (directory !== ".") {
        await expect(stat(join(treePath, "../src"))).rejects.toMatchObject({ code: "ENOENT" });
        await expect(stat(join(worktreePath, "../src"))).rejects.toMatchObject({ code: "ENOENT" });
      }

      // Real E5 save/restore: archive the whole workspace, replace it, restore at the same path.
      const archive = join(fixtureValue.root, "state.tar.gz");
      const info = await createWorkspaceArchive(fixtureValue.workspace, archive);
      await rm(fixtureValue.workspace, { recursive: true, force: true });
      await restoreWorkspaceArchive(archive, fixtureValue.workspace, info);
      expect(await readFile(join(worktreePath, "members", "tree-agent", "memory.md"), "utf8")).toContain(
        "Prefer short-lived branches.",
      );
      // The per-execution environment reached the CLI but was never persisted in the workspace.
      const secret = Buffer.from("execution-secret-0123456789abcdef");
      for (const bytes of await workspaceFiles(fixtureValue.workspace)) {
        expect(bytes.includes(secret)).toBe(false);
      }

      // A fresh Turn: fresh scratch, same workspace, same reserved write worktree.
      const scratch = join(fixtureValue.root, "scratch-next");
      await mkdir(scratch, { recursive: true });
      const second = await prepareAndSync(fixtureValue.input({ scratch }), fixtureValue.environment);
      // Repository caches and snapshots were restored, so the next sync reuses the same snapshot.
      expect(second.treePath).toBe(treePath);
      const finished = await runManaged(
        second.binDirectory,
        ["write", "finish", prepared.id as string, "--message", "docs: restore prepared write", "--publish"],
        fixtureValue.environment,
      );
      expect(finished.sha).toMatch(/^[0-9a-f]{40}$/);
      // The draft was published to the disposable remote and the prepared worktree was reclaimed.
      expect(await readFile(join(fixtureValue.treePath, "members", "tree-agent", "memory.md"), "utf8")).toContain(
        "Prefer short-lived branches.",
      );
      await expect(stat(worktreePath)).rejects.toMatchObject({ code: "ENOENT" });
      if (directory !== ".")
        expect(await readFile(join(fixtureValue.repositoryPath, "src/code.ts"), "utf8")).toBe(
          "export const value = 1;\n",
        );
    },
    60_000,
  );

  it.each([".", "docs"])(
    "keeps a dirty restored %s checkout inspectable without resetting it",
    async (directory) => {
      const fixtureValue = await fixture("cloud-ct-dirty-", directory);
      const { treePath } = await prepareAndSync(fixtureValue.input(), fixtureValue.environment);

      // An unpublished direct edit in the Session checkout: the CLI reports DIRTY_TREE on the next
      // Turn and nothing here may reset it.
      const rootNode = await readFile(join(treePath, "NODE.md"), "utf8");
      await writeFile(join(treePath, "NODE.md"), `${rootNode}\nUnpublished draft edit.\n`);

      const archive = join(fixtureValue.root, "state.tar.gz");
      const info = await createWorkspaceArchive(fixtureValue.workspace, archive);
      await rm(fixtureValue.workspace, { recursive: true, force: true });
      await restoreWorkspaceArchive(archive, fixtureValue.workspace, info);

      const scratch = join(fixtureValue.root, "scratch-next");
      await mkdir(scratch, { recursive: true });
      const second = await prepareCloudContextTree(fixtureValue.input({ scratch }));
      // Preparation does not inspect the snapshot; the Agent's own sync reports dirty truthfully,
      // and the checkout stays addressable for inspection.
      const tree = treeResult(second);
      if (tree.status !== "available" || !second.binDirectory) throw new Error("expected an available tree");
      const synced = await runManagedResult(
        second.binDirectory,
        ["sync", "--project-path", tree.projectPath],
        fixtureValue.environment,
      );
      expect(synced.code).not.toBe(0);
      expect(synced.payload.connections).toMatchObject([{ ok: false, error: { code: "DIRTY_TREE" } }]);
      expect(await readFile(join(treePath, "NODE.md"), "utf8")).toContain("Unpublished draft edit.");
    },
    60_000,
  );

  it("always keeps sparse read caches and snapshots, restores offline, and does not persist cleanup logs", async () => {
    const value = await fixture("cloud-ct-sparse-cache-", "docs");
    const prepared = await prepareAndSync(value.input(), value.environment);
    const tree = prepared;
    const state = join(value.workspace, ".opentag/context-tree/home/.context-tree");
    const configurationPath = join(value.workspace, ".opentag/context-tree/project/.context-tree.json");
    const configuration = await readFile(configurationPath, "utf8");
    await mkdir(join(state, "cleanup/logs"), { recursive: true });
    await writeFile(join(state, "cleanup/logs/events.jsonl"), "Disposable cleanup log.\n");
    const archive = join(value.root, "state.tar.gz");
    const info = await createWorkspaceArchive(value.workspace, archive);
    await rm(value.workspace, { recursive: true, force: true });
    await restoreWorkspaceArchive(archive, value.workspace, info);
    expect(await readFile(configurationPath, "utf8")).toBe(configuration);
    expect((await stat(join(state, "repositories"))).isDirectory()).toBe(true);
    expect((await stat(tree.treePath)).isDirectory()).toBe(true);
    await expect(stat(join(state, "cleanup"))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(join(tree.treePath, "../src"))).rejects.toMatchObject({ code: "ENOENT" });
    const offline = await runManaged(
      prepared.binDirectory,
      ["sync", "--offline", "--project-path", tree.projectPath],
      value.environment,
    );
    expect(offline.connections).toMatchObject([{ ok: true, treeRoot: tree.treePath }]);
  }, 60_000);

  it("retains committed sparse sessions and empty sessions across restore for later publish and abort", async () => {
    const value = await fixture("cloud-ct-sparse-committed-", "docs");
    const first = await prepareAndSync(value.input(), value.environment);
    const tree = first;
    const session = await runManaged(
      first.binDirectory,
      ["write", "prepare", "--project-path", tree.projectPath],
      value.environment,
    );
    await recordMemberMemory(session.treeRoot as string, "tree-agent", "Retain this unpublished commit.");
    const committed = await runManaged(
      first.binDirectory,
      ["write", "finish", session.id as string, "--message", "docs: unpublished"],
      value.environment,
    );
    expect(committed.outcome).toBe("committed");
    const empty = await runManaged(
      first.binDirectory,
      ["write", "prepare", "--project-path", tree.projectPath],
      value.environment,
    );
    const archive = join(value.root, "state.tar.gz");
    const info = await createWorkspaceArchive(value.workspace, archive);
    await rm(value.workspace, { recursive: true, force: true });
    await restoreWorkspaceArchive(archive, value.workspace, info);
    expect(await readFile(join(session.treeRoot as string, "members/tree-agent/memory.md"), "utf8")).toContain(
      "Retain this unpublished commit.",
    );
    const reviewed = await runManaged(
      first.binDirectory,
      ["write", "finish", session.id as string, "--message", "Review"],
      value.environment,
    );
    expect(reviewed).toMatchObject({ outcome: "committed", sha: committed.sha, sessionId: session.id });
    await runManaged(first.binDirectory, ["write", "abort", empty.id as string], value.environment);
    await expect(stat(empty.treeRoot as string)).rejects.toMatchObject({ code: "ENOENT" });
    const published = await runManaged(
      first.binDirectory,
      ["write", "finish", session.id as string, "--message", "Publish", "--publish"],
      value.environment,
    );
    expect(published).toMatchObject({ outcome: "published", sha: committed.sha });
    expect(await readFile(join(value.treePath, "members/tree-agent/memory.md"), "utf8")).toContain(
      "Retain this unpublished commit.",
    );
    expect(await readFile(join(value.repositoryPath, "src/code.ts"), "utf8")).toBe("export const value = 1;\n");
  }, 60_000);
});
