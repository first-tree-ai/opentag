import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, realpath, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { ContextTreeManager, resolveContextTreePackage, runContextTreeCli } from "../runtime/context-tree.js";

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
/** A local bare remote holding one `docs` tree, reached through the managed GitHub URL. */
async function remoteTree() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "ct-local-v1-")));
  roots.push(root);
  const pack = resolveContextTreePackage();
  if (!pack) throw new Error("Package missing");
  const environment = {
    HOME: root,
    PATH: process.env.PATH,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.test",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.test",
  };
  const git = async (...args: string[]) => (await exec("git", args, { env: environment })).stdout.trim();
  const seed = join(root, "seed");
  await mkdir(seed);
  await git("init", "--initial-branch=main", seed);
  await runContextTreeCli(pack, ["init", join(seed, "docs"), "--project-path", seed, "--json"], { env: environment });
  await writeFile(join(seed, "code.txt"), "unchanged");
  await git("-C", seed, "add", ".");
  await git("-C", seed, "commit", "-m", "init");
  const remote = join(root, "remote.git");
  await git("clone", "--bare", seed, remote);
  const bin = join(root, "bin");
  await mkdir(bin);
  await writeFile(
    join(bin, "git"),
    `#!/bin/sh\nexec /usr/bin/git -c protocol.file.allow=always -c 'url.file://${remote}.insteadOf=https://github.com/acme/project.git' "$@"\n`,
    { mode: 0o700 },
  );
  environment.PATH = `${bin}:${environment.PATH}`;
  const source = { kind: "git", repository: "acme/project", path: "docs", ref: "main" } as const;
  return { root, pack, environment, git, remote, source };
}

it("prepares without syncing; Agent-run syncs share remote snapshots and writes use isolated worktrees", async () => {
  const { root, pack, environment, git, remote, source } = await remoteTree();
  const manager = new ContextTreeManager({ home: join(root, "host"), environment });
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const repositoryConfig = '{"schemaVersion":3,"trees":[{"kind":"directory","path":"docs"}]}';
  await writeFile(join(workspace, ".context-tree.json"), repositoryConfig);
  const first = await manager.ensureAgent(workspace, "pi", [source]);
  if (first.status !== "configured" || first.connections[0]?.status !== "available")
    throw new Error(JSON.stringify(first));
  const ready = first.connections[0];
  // Preparation is local: no repository cache or snapshot exists until the Agent syncs.
  await expect(access(join(root, ".context-tree", "repositories"))).rejects.toMatchObject({ code: "ENOENT" });
  const sync = async (projectPath: string) => {
    const result = await runContextTreeCli(pack, ["sync", "--project-path", projectPath], {
      env: environment,
      network: true,
    });
    const entry = (result.payload as { connections: { ok: boolean; treeRoot: string }[] }).connections[0];
    if (!entry?.ok) throw new Error(JSON.stringify(result.payload));
    return entry.treeRoot;
  };
  const firstTree = await sync(ready.projectPath);
  const prepared = await runContextTreeCli(pack, ["write", "prepare", "--project-path", ready.projectPath], {
    env: environment,
  });
  const session = prepared.payload as { id: string; treeRoot: string };
  expect(prepared.failureCode).toBeUndefined();
  await writeFile(join(session.treeRoot, "decision.md"), "---\ntitle: Decision\n---\nUse small changes.\n");
  expect(
    (
      await runContextTreeCli(pack, ["write", "finish", session.id, "--message", "docs: decision", "--publish"], {
        env: environment,
      })
    ).failureCode,
  ).toBeUndefined();
  const reader = await manager.ensureAgent(join(root, "reader"), "pi", [source]);
  if (reader.status !== "configured" || reader.connections[0]?.status !== "available")
    throw new Error(JSON.stringify(reader));
  const readerTree = await sync(reader.connections[0].projectPath);
  expect(readerTree).not.toBe(firstTree);
  expect(await readFile(join(readerTree, "decision.md"), "utf8")).toContain("Use small changes.");
  expect(await readFile(join(workspace, ".context-tree.json"), "utf8")).toBe(repositoryConfig);
  expect(await git("--git-dir", remote, "show", "main:code.txt")).toBe("unchanged");
}, 60_000);

it("gives a workspace a readable tree after another workspace evicts its idle snapshot", async () => {
  const { root, pack, environment, source } = await remoteTree();
  const manager = new ContextTreeManager({ home: join(root, "host"), environment });
  const prepare = async (name: string) => {
    const status = await manager.ensureAgent(join(root, name), "pi", [source]);
    if (status.status !== "configured" || status.connections[0]?.status !== "available")
      throw new Error(JSON.stringify(status));
    return status.connections[0].projectPath;
  };
  const sync = async (projectPath: string) => {
    const result = await runContextTreeCli(pack, ["sync", "--project-path", projectPath], {
      env: environment,
      network: true,
    });
    const entry = (result.payload as { connections: { ok: boolean; treeRoot: string }[] }).connections[0];
    if (!entry?.ok) throw new Error(JSON.stringify(result.payload));
    return entry.treeRoot;
  };
  const first = await prepare("first");
  const firstTree = await sync(first);
  await expect(access(join(firstTree, "NODE.md"))).resolves.toBeUndefined();

  // Publish a new revision, then age the first snapshot past the eviction window.
  const prepared = await runContextTreeCli(pack, ["write", "prepare", "--project-path", first], { env: environment });
  const session = prepared.payload as { id: string; treeRoot: string };
  await writeFile(join(session.treeRoot, "decision.md"), "---\ntitle: Decision\n---\nUse small changes.\n");
  const finished = await runContextTreeCli(
    pack,
    ["write", "finish", session.id, "--message", "docs: decision", "--publish"],
    {
      env: environment,
    },
  );
  expect(finished.failureCode).toBeUndefined();
  const aged = new Date(Date.now() - 25 * 60 * 60 * 1000);
  await utimes(dirname(firstTree), aged, aged);

  // Another workspace sharing this home syncs the new revision and evicts the idle snapshot.
  const secondTree = await sync(await prepare("second"));
  expect(secondTree).not.toBe(firstTree);
  await expect(access(firstTree)).rejects.toMatchObject({ code: "ENOENT" });

  // Preparation keeps no snapshot path, so the first workspace's next task-boundary sync still reads.
  const reused = await sync(await prepare("first"));
  expect(reused).toBe(secondTree);
  expect(await readFile(join(reused, "decision.md"), "utf8")).toContain("Use small changes.");
}, 60_000);
