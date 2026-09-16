import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { GitPublicationError } from "./git-packets.js";
import { type GitProcessOptions, runTrustedGit, runTrustedProcess } from "./git-process.js";

/** Verifies the actual committed SHA using the pinned Server dependency, outside the Agent boundary. */
export async function verifyPublishedContextTree(
  repository: string,
  sha: string,
  options: GitProcessOptions,
): Promise<void> {
  const entries = (await runTrustedGit(["-C", repository, "ls-tree", "-rz", sha], options))
    .toString("utf8")
    .split("\0")
    .filter(Boolean);
  for (const entry of entries) {
    if (entry.startsWith("160000 ")) throw new GitPublicationError("tree_invalid");
    if (!entry.startsWith("120000 ")) continue;
    // The pinned CLI creates exactly this safe root link. All other links are rejected before checkout.
    if (
      !entry.endsWith("\tCLAUDE.md") ||
      !entries.some((item) => /^100(?:644|755) /.test(item) && item.endsWith("\tAGENTS.md"))
    )
      throw new GitPublicationError("tree_invalid");
    const target = await runTrustedGit(["-C", repository, "show", `${sha}:CLAUDE.md`], options);
    if (target.toString("utf8") !== "AGENTS.md") throw new GitPublicationError("tree_invalid");
  }
  const checkout = join(options.cwd, `tree-${sha}`);
  await runTrustedGit(["-C", repository, "worktree", "add", "--detach", checkout, sha], options);
  const packageRoot = dirname(createRequire(import.meta.url).resolve("@first-tree-ai/context-tree/package.json"));
  const result = await runTrustedProcess(
    process.execPath,
    [join(packageRoot, "dist/cli/index.mjs"), "verify", "--tree-path", checkout, "--json"],
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
