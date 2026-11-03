import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
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

async function selectedTree(path: string) {
  await mkdir(join(tree, path), { recursive: true });
  await copyFile(join(tree, "NODE.md"), join(tree, path, "NODE.md"));
}
async function commitIndex() {
  await git(tree, ["commit", "--quiet", "-m", "fixture"]);
  const sha = await git(tree, ["rev-parse", "HEAD"]);
  await git(bare, ["fetch", tree, "main"]);
  return sha;
}

it("validates a selected Tree beside a whole-repository listing above the unchanged output cap", async () => {
  await selectedTree("docs");
  await git(tree, ["add", "."]);
  const blob = await git(tree, ["rev-parse", "HEAD:NODE.md"]);
  const records = Array.from(
    { length: 12000 },
    (_, i) => `100644 ${blob}\tunrelated-${String(i).padStart(5, "0")}-${"x".repeat(110)}.txt`,
  );
  const adding = exec("git", ["-C", tree, "update-index", "-z", "--index-info"], { env: environment });
  adding.child.stdin?.end(Buffer.from(records.join(String.fromCharCode(0)) + String.fromCharCode(0)));
  await adding;
  const sha = await commitIndex();
  await expect(verifyPublishedContextTree(bare, sha, options, "docs")).resolves.toBeUndefined();
  await expect(verifyPublishedContextTree(bare, sha, options)).rejects.toMatchObject({ code: "resource_limit" });
}, 60000);

it("validates normal nested directories without reading unrelated invalid content", async () => {
  await selectedTree("outer/inner");
  await writeFile(join(tree, "unrelated.md"), "unrelated invalid frontmatter");
  await git(tree, ["add", "."]);
  await expect(verifyPublishedContextTree(bare, await commitIndex(), options, "outer/inner")).resolves.toBeUndefined();
});

it("treats wildcard characters and spaces as literal selected paths", async () => {
  const path = "[dir]/space dir";
  await selectedTree(path);
  await mkdir(join(tree, "d", "space dir"), { recursive: true });
  await symlink("/etc/passwd", join(tree, "d", "space dir", "escape"));
  await git(tree, ["add", "."]);
  await expect(verifyPublishedContextTree(bare, await commitIndex(), options, path)).resolves.toBeUndefined();
});

it.each(["ancestor", "selected", "descendant"] as const)("rejects a %s symlink before checkout", async (kind) => {
  let selected: string;
  if (kind === "ancestor") {
    await symlink("/etc", join(tree, "link"));
    selected = "link/docs";
  } else if (kind === "selected") {
    await symlink("/etc", join(tree, "docs"));
    selected = "docs";
  } else {
    await selectedTree("docs");
    await symlink("/etc/passwd", join(tree, "docs", "escape"));
    selected = "docs";
  }
  await git(tree, ["add", "."]);
  const sha = await commitIndex();
  await expect(verifyPublishedContextTree(bare, sha, options, selected)).rejects.toMatchObject({
    code: "tree_invalid",
  });
  await expect(stat(join(root, `tree-${sha}`))).rejects.toMatchObject({ code: "ENOENT" });
});

it.each(["ancestor", "selected", "descendant"] as const)("rejects a %s Gitlink before checkout", async (kind) => {
  if (kind === "descendant") await selectedTree("docs");
  await git(tree, ["add", "."]);
  const module = kind === "descendant" ? "docs/module" : "module";
  const selected = kind === "ancestor" ? "module/docs" : kind === "selected" ? "module" : "docs";
  await git(tree, [
    "update-index",
    "--add",
    "--cacheinfo",
    `160000,${await git(tree, ["rev-parse", "HEAD"])},${module}`,
  ]);
  const sha = await commitIndex();
  await expect(verifyPublishedContextTree(bare, sha, options, selected)).rejects.toMatchObject({
    code: "tree_invalid",
  });
  await expect(stat(join(root, `tree-${sha}`))).rejects.toMatchObject({ code: "ENOENT" });
});

it.each(["missing", "NODE.md"])(
  "rejects %s ancestor after one Git lookup despite a long remaining path",
  async (ancestor) => {
    const trace = join(root, "git-trace.jsonl");
    const path = `${ancestor}/${Array(2000).fill("a").join("/")}`;
    await expect(
      verifyPublishedContextTree(
        bare,
        await git(tree, ["rev-parse", "HEAD"]),
        {
          ...options,
          environment: { ...environment, GIT_TRACE2_EVENT: trace },
        },
        path,
      ),
    ).rejects.toMatchObject({ code: "tree_invalid" });
    const events = (await readFile(trace, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(events.filter((event) => event.event === "start")).toHaveLength(1);
  },
);
