import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { GitProcessOptions } from "../services/github-proxy/git-process.js";
import { constrainTreeGraphql } from "../services/github-proxy/tree-graphql-policy.js";
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
  await git(project, ["init"]);
  const cli = join(
    dirname(createRequire(import.meta.url).resolve("@first-tree-ai/context-tree/package.json")),
    "dist/cli/index.mjs",
  );
  tree = JSON.parse(
    (await exec(process.execPath, [cli, "create", "--project-path", project, "--json"], { env: environment })).stdout,
  ).treePath;
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
  it("rejects an unindexed leaf even if the caller claims it is a valid Tree", async () => {
    await writeFile(join(tree, "unindexed.md"), "# Unindexed\n");
    await git(tree, ["add", "."]);
    await git(tree, ["commit", "-m", "invalid"]);
    const sha = await git(tree, ["rev-parse", "HEAD"]);
    await git(bare, ["fetch", tree, "master"]);
    await expect(verifyPublishedContextTree(bare, sha, options)).rejects.toThrow(/tree_invalid/);
  });
  it("rejects symlinks before running the verifier or reading their targets", async () => {
    await symlink("/etc/passwd", join(tree, "escape.md"));
    await git(tree, ["add", "."]);
    await git(tree, ["commit", "-m", "symlink"]);
    const sha = await git(tree, ["rev-parse", "HEAD"]);
    await git(bare, ["fetch", tree, "master"]);
    await expect(verifyPublishedContextTree(bare, sha, options)).rejects.toThrow(/tree_invalid/);
  });
});

describe("Tree GraphQL constraints", () => {
  const constrain = (query: string, variables?: Record<string, unknown>) =>
    constrainTreeGraphql({
      request: { query, variables },
      branch: "refs/heads/knowledge",
      taskPrefix: "refs/heads/opentag/session/context_tree/",
    });
  it("keeps native gh aliases and pagination while pinning the Tree default and PR base", () => {
    const result = constrain(
      'query {repository(owner:"o",name:"r"){defaultBranchRef{name} pulls:pullRequests(first:20){nodes{title}}}}',
    );
    expect(result.request.query).toContain('defaultBranchRef: ref(qualifiedName: "refs/heads/knowledge")');
    expect(result.request.query).toContain('baseRefName: "knowledge"');
    expect(result.request.query).toContain("first: 20");
  });
  it("rejects arbitrary ref lookup hidden inside fragments or variables", () => {
    expect(() =>
      constrain(
        'query($ref:String!){repository(owner:"o",name:"r"){...F}} fragment F on Repository{ref(qualifiedName:$ref){target{oid}}}',
        { ref: "refs/heads/private" },
      ),
    ).toThrow(/scope_denied/);
  });
  it("accepts the native gh RepositoryInfo preread and still pins the Tree default branch", () => {
    // cli/cli v2.100.0 api/queries_repo.go GitHubRepo(); parent metadata is windowed by the
    // GraphQL plan before this constraint runs, so only the Tree pinning applies here.
    const native = `
fragment repo on Repository {
  id
  databaseId
  name
  owner { login }
  hasIssuesEnabled
  description
  hasWikiEnabled
  viewerPermission
  defaultBranchRef { name }
}
query RepositoryInfo($owner: String!, $name: String!) {
  repository(owner: $owner, name: $name) {
    ...repo
    parent { ...repo }
    mergeCommitAllowed
    rebaseMergeAllowed
    squashMergeAllowed
  }
}`;
    const result = constrain(native, { owner: "o", name: "r" });
    expect(result.request.query).toContain('ref(qualifiedName: "refs/heads/knowledge")');
    expect(result.request.query).toContain("parent");
    expect(result.request.query).toContain("mergeCommitAllowed");
    expect(result.pullRequestNumbers).toEqual([]);
    expect(result.nodeIds).toEqual([]);
  });

  it("requests fresh checks for PR number and node queries", () => {
    expect(
      constrain('query {repository(owner:"o",name:"r"){pullRequest(number:9){title}}}').pullRequestNumbers,
    ).toEqual([9]);
    expect(constrain('query {node(id:"PR_known"){id}}').nodeIds).toEqual(["PR_known"]);
  });
});
