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
  const entries = (await runTrustedGit(["-C", repository, "ls-tree", "-rz", sha], options))
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  for (const entry of entries) {
    const name = entry.slice(entry.indexOf("\t") + 1);
    const selected = path === "." || name === path || name.startsWith(`${path}/`) || path.startsWith(`${name}/`);
    if (selected && /^(160000|120000) /.test(entry)) throw new GitPublicationError("tree_invalid");
  }
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
