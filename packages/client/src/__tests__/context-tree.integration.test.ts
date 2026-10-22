import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, expect, it } from "vitest";
import { ContextTreeManager, resolveContextTreePackage, runContextTreeCli } from "../runtime/context-tree.js";

const exec = promisify(execFile);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
it("shares remote snapshots, writes through isolated worktrees, and preserves repository-local config", async () => {
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
  const manager = new ContextTreeManager({ home: join(root, "host"), environment, sessionStartBudgetMs: 30_000 });
  const workspace = join(root, "workspace");
  await mkdir(workspace);
  const repositoryConfig = '{"schemaVersion":3,"trees":[{"kind":"directory","path":"docs"}]}';
  await writeFile(join(workspace, ".context-tree.json"), repositoryConfig);
  const first = await manager.ensureAgent(workspace, "pi", [source]);
  expect(first).toMatchObject({ connections: [{ status: "ready" }] });
  if (first.status !== "configured" || first.connections[0]?.status !== "ready") throw new Error(JSON.stringify(first));
  const ready = first.connections[0];
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
  if (reader.status !== "configured" || reader.connections[0]?.status !== "ready")
    throw new Error(JSON.stringify(reader));
  expect(reader.connections[0].treePath).not.toBe(ready.treePath);
  expect(await readFile(join(reader.connections[0].treePath, "decision.md"), "utf8")).toContain("Use small changes.");
  expect(await readFile(join(workspace, ".context-tree.json"), "utf8")).toBe(repositoryConfig);
  expect(await git("--git-dir", remote, "show", "main:code.txt")).toBe("unchanged");
}, 60_000);
