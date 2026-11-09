import { lstat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { ContextTreePathSchema } from "@opentag/shared";
import { GitPublicationError } from "./git-packets.js";
import { type GitProcessOptions, runTrustedGit, runTrustedProcess } from "./git-process.js";

/** Verifies the actual committed SHA using the pinned Server dependency, outside the Agent boundary. */
export async function verifyPublishedContextTree(
  repository: string,
  sha: string,
  options: GitProcessOptions,
  path = ".",
): Promise<void> {
  if (!ContextTreePathSchema.safeParse(path).success) throw new GitPublicationError("tree_invalid");
  await assertSupportedCommittedPath(repository, sha, path, options);
  const checkout = join(options.cwd, `tree-${sha}`);
  await runTrustedGit(["-C", repository, "worktree", "add", "--detach", checkout, sha], options);
  let tree = checkout;
  for (const part of path === "." ? [] : path.split("/")) {
    tree = join(tree, part);
    const info = await lstat(tree);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new GitPublicationError("tree_invalid");
  }
  const packageRoot = dirname(createRequire(import.meta.url).resolve("@first-tree-ai/context-tree/package.json"));
  const result = await runTrustedProcess(
    process.execPath,
    [join(packageRoot, "dist/cli/index.mjs"), "verify", "--tree-path", tree, "--json"],
    {
      ...options,
      cwd: checkout,
      timeoutMs: 20_000,
    },
  );
  let payload: unknown;
  try {
    payload = JSON.parse(result.stdout.toString("utf8"));
  } catch {
    throw new GitPublicationError("tree_invalid");
  }
  if (
    result.code !== 0 ||
    typeof payload !== "object" ||
    payload === null ||
    !("ok" in payload) ||
    payload.ok !== true
  ) {
    throw new GitPublicationError("tree_invalid");
  }
}

async function assertSupportedCommittedPath(
  repository: string,
  sha: string,
  path: string,
  options: GitProcessOptions,
): Promise<void> {
  const args = ["--literal-pathspecs", "-C", repository, "ls-tree", "-rz", sha];
  if (path !== ".") {
    let ancestor = "";
    for (const part of path.split("/")) {
      ancestor = ancestor ? `${ancestor}/${part}` : part;
      const entry = await runTrustedGit(
        ["--literal-pathspecs", "-C", repository, "ls-tree", "-z", sha, "--", ancestor],
        options,
      );
      if (!/^040000 tree [0-9a-f]+\t[^\0]+\0$/.test(entry.toString("utf8"))) {
        throw new GitPublicationError("tree_invalid");
      }
    }
    args.push("--", path);
  }
  assertSupportedEntries(await runTrustedGit(args, options));
}

function assertSupportedEntries(output: Buffer): void {
  if (
    output
      .toString("utf8")
      .split("\0")
      .some((entry) => /^(160000|120000) /.test(entry))
  ) {
    throw new GitPublicationError("tree_invalid");
  }
}
