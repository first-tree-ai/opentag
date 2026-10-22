import { mkdir, readFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { GitPublicationError } from "../github-proxy/git-packets.js";
import { runTrustedProcess } from "../github-proxy/git-process.js";
import type { GitWorkspace } from "../github-proxy/git-workspace.js";

/** Generate the initial page with the pinned package, without host configuration or credentials. */
export async function contextTreeInitialContent(
  workspace: GitWorkspace,
  signal: AbortSignal,
  name: string,
): Promise<string> {
  const directory = await workspace.stagingDirectory("tree-head-");
  try {
    const home = join(directory, "home");
    const tree = join(directory, "tree", name);
    await mkdir(home, { mode: 0o700 });
    const packageRoot = dirname(createRequire(import.meta.url).resolve("@first-tree-ai/context-tree/package.json"));
    const result = await runTrustedProcess(
      process.execPath,
      [join(packageRoot, "dist/cli/index.mjs"), "init", tree, "--project-path", directory, "--json"],
      {
        cwd: directory,
        environment: { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: home },
        signal,
        timeoutMs: 20_000,
      },
    );
    if (result.code !== 0) throw new GitPublicationError("tree_invalid");
    return await readFile(join(tree, "NODE.md"), "utf8");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
