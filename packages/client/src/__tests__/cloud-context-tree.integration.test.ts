import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { prepareCloudContextTree } from "../runner/cloud-context-tree.js";
import { createWorkspaceArchive, restoreWorkspaceArchive } from "../runner/workspace-archive.js";
import { resolveContextTreePackage } from "../runtime/context-tree.js";

/**
 * End-to-end Context Tree continuity for one Cloud Session with the REAL packaged CLI, real Git
 * and the real workspace archive: no public network (the disposable tree is reached through a
 * `git` shim that only rewrites transport), and the exact in-workspace HOME/TMPDIR layout the
 * Cloud worker uses.
 */

const execFileAsync = promisify(execFile);
const contextTreePackage = resolveContextTreePackage();
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
  const { stdout } = await execFileAsync(join(binDirectory, "context-tree"), [...args], {
    encoding: "utf8",
    env: { ...environment, PATH: `${binDirectory}${delimiter}${environment.PATH ?? ""}` },
  }).catch((error: unknown) => {
    const detail = error as { stderr?: string; stdout?: string; message?: string };
    throw new Error(`managed context-tree failed: ${detail.stderr || detail.stdout || detail.message || "no output"}`);
  });
  return JSON.parse(stdout.trim()) as Record<string, unknown>;
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
async function fixture(prefix: string): Promise<Fixture> {
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
  const created = await runCli(["create", "--project-path", seed, "--json"], {
    HOME: accountHome,
    PATH: process.env.PATH ?? "",
  });
  const treePath = created.treePath as string;
  await execFileAsync("/usr/bin/git", ["-C", treePath, "config", "receive.denyCurrentBranch", "updateInstead"]);

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
    /usr/bin/git -C "$root" clone --quiet --origin origin -- "file://${treePath}" "$destination" || exit $?
    /usr/bin/git -C "$destination" remote set-url origin "https://github.com/acme/memory.git"
    exit $?
    ;;
  *" fetch "*|*" push "*|*" pull "*)
    exec /usr/bin/git -c protocol.file.allow=always -c "url.file://${treePath}.insteadOf=https://github.com/acme/memory.git" "$@"
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
    OPENTAG_GITHUB_REPOSITORIES: JSON.stringify([{ fullName: "acme/memory", role: "context_tree" }]),
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
      repository: "acme/memory",
      scratch: overrides.scratch ?? defaultScratch,
      workspace,
    }),
    root,
    treePath,
    workspace,
  };
}

describe("Cloud Context Tree continuity (real CLI)", () => {
  it("publishes a prepared write after a real archive save and restore through the managed CLI", async () => {
    const fixtureValue = await fixture("cloud-ct-roundtrip-");
    const first = await prepareCloudContextTree(fixtureValue.input());
    expect(first.status.status).toBe("ready");
    if (first.status.status !== "ready" || !first.binDirectory) throw new Error("expected a ready tree");
    const treePath = first.status.treePath;
    expect(treePath.startsWith(`${fixtureValue.workspace}/`)).toBe(true);

    // The Agent prepares a write through the managed CLI; the worktree lands INSIDE the saved
    // workspace because the shim pins TMPDIR there.
    const prepared = await runManaged(
      first.binDirectory,
      ["prepare-write", "--project-path", fixtureValue.workspace],
      fixtureValue.environment,
    );
    const worktreePath = prepared.worktreePath as string;
    expect(worktreePath.startsWith(join(fixtureValue.workspace, ".opentag/context-tree/tmp"))).toBe(true);
    await recordMemberMemory(worktreePath, "tree-agent", "Prefer short-lived branches.");

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
    const second = await prepareCloudContextTree(fixtureValue.input({ scratch }));
    expect(second.status.status).toBe("ready");
    if (second.status.status !== "ready" || !second.binDirectory) throw new Error("expected a ready tree");
    const finished = await runManaged(
      second.binDirectory,
      [
        "finish-write",
        "--worktree-path",
        worktreePath,
        "--message",
        "docs(memory): restore prepared write",
        "--project-path",
        fixtureValue.workspace,
      ],
      fixtureValue.environment,
    );
    expect(finished.sha).toMatch(/^[0-9a-f]{40}$/);
    // The draft was published to the disposable remote and the prepared worktree was reclaimed.
    expect(await readFile(join(fixtureValue.treePath, "members", "tree-agent", "memory.md"), "utf8")).toContain(
      "Prefer short-lived branches.",
    );
    await expect(stat(worktreePath)).rejects.toMatchObject({ code: "ENOENT" });
  }, 60_000);

  it("keeps a dirty restored checkout inspectable without resetting it", async () => {
    const fixtureValue = await fixture("cloud-ct-dirty-");
    const first = await prepareCloudContextTree(fixtureValue.input());
    expect(first.status.status).toBe("ready");
    if (first.status.status !== "ready") throw new Error("expected a ready tree");
    const treePath = first.status.treePath;

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
    // Dirty is reported truthfully, but the checkpoint stays addressable for inspection.
    expect(second.status).toEqual({ status: "stale", treePath, reason: "DIRTY_TREE" });
    if (!second.binDirectory) throw new Error("expected an addressable tree");
    const verified = await runManaged(
      second.binDirectory,
      ["verify", "--tree-path", treePath, "--json"],
      fixtureValue.environment,
    );
    expect(verified.ok).toBe(true);
    const read = await runManaged(
      second.binDirectory,
      ["read", ".", "--tree-path", treePath, "--json"],
      fixtureValue.environment,
    );
    expect(JSON.stringify(read)).toContain("Unpublished draft edit.");
    const status = await execFileAsync("/usr/bin/git", ["-C", treePath, "status", "--porcelain"], { encoding: "utf8" });
    expect(status.stdout).toContain(" M NODE.md");
    expect(await readFile(join(treePath, "NODE.md"), "utf8")).toContain("Unpublished draft edit.");
  }, 60_000);
});
