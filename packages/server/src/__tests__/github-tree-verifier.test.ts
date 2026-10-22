import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GitProcessOptions } from "../services/github-proxy/git-process.js";
import { verifyPublishedContextTree } from "../services/github-proxy/tree-verifier.js";

const exec = promisify(execFile);
let root: string, tree: string, bare: string;
let environment: NodeJS.ProcessEnv, options: GitProcessOptions;
async function git(cwd: string, args: string[]) {
  return (await exec("git", args, { cwd, env: environment })).stdout.trim();
}
beforeEach(async () => {
  root = await mkdtemp(join(await realpath(tmpdir()), "opentag-trusted-tree-"));
  const home = join(root, "home");
  await mkdir(home);
  environment = {
    PATH: process.env.PATH,
    HOME: home,
    XDG_CONFIG_HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_AUTHOR_NAME: "Fixture",
    GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Fixture",
    GIT_COMMITTER_EMAIL: "fixture@example.invalid",
  };
  const project = join(root, "project");
  await mkdir(project);
  const cli = join(
    dirname(createRequire(import.meta.url).resolve("@first-tree-ai/context-tree/package.json")),
    "dist/cli/index.mjs",
  );
  tree = join(root, "tree");
  await exec(process.execPath, [cli, "init", tree, "--project-path", project, "--json"], { env: environment });
  await git(tree, ["init", "--initial-branch", "main"]);
  await git(tree, ["add", "NODE.md"]);
  await git(tree, ["commit", "-m", "initialize"]);
  bare = join(root, "trusted.git");
  await git(root, ["clone", "--bare", tree, bare]);
  options = { cwd: root, environment, signal: new AbortController().signal };
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("pinned trusted Context Tree verifier", () => {
  it("validates the actual committed Tree with the installed pinned CLI", async () => {
    await expect(
      verifyPublishedContextTree(bare, await git(tree, ["rev-parse", "HEAD"]), options),
    ).resolves.toBeUndefined();
  });
  it("rejects a leaf without required frontmatter", async () => {
    await writeFile(join(tree, "unindexed.md"), "# Unindexed\n");
    await git(tree, ["add", "."]);
    await git(tree, ["commit", "-m", "invalid"]);
    const sha = await git(tree, ["rev-parse", "HEAD"]);
    await git(bare, ["fetch", tree, "main"]);
    await expect(verifyPublishedContextTree(bare, sha, options)).rejects.toThrow(/tree_invalid/);
  });
  it("rejects symlinks before running the verifier or reading their targets", async () => {
    await symlink("/etc/passwd", join(tree, "escape.md"));
    await git(tree, ["add", "."]);
    await git(tree, ["commit", "-m", "symlink"]);
    const sha = await git(tree, ["rev-parse", "HEAD"]);
    await git(bare, ["fetch", tree, "main"]);
    await expect(verifyPublishedContextTree(bare, sha, options)).rejects.toThrow(/tree_invalid/);
  });
});
