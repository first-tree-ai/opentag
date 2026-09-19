import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { AgentRuntimeProvider } from "@opentag/shared";

/**
 * Workspace-relative roots that sync reads and writes, and the check that keeps them real.
 *
 * A workspace can contain a symlink where a root should be — most dangerously a provider skills
 * root that points into another workspace, where a removal pass would delete that workspace's
 * Skills. Every root is validated before anything is listed, read, or removed. Absence is fine; a
 * symlink or any non-directory on the path, or a root that resolves outside the workspace, is not.
 */

/** The roots, relative to an Agent workspace, that hold Agent-scoped Skills. */
export function skillRootForProvider(cwd: string, provider: AgentRuntimeProvider): string {
  if (provider === "codex") return join(cwd, ".agents", "skills");
  if (provider === "pi") return join(cwd, ".opentag", "skills");
  return join(cwd, ".claude", "skills");
}

/** Staging is outside the provider root so a crash cannot leave a discoverable half-skill. */
export function skillStagingRoot(cwd: string): string {
  return join(cwd, ".opentag", "skill-staging");
}

export function skillConflictsRoot(cwd: string): string {
  return join(cwd, ".opentag", "skill-conflicts");
}

function isEscape(suffix: string): boolean {
  return suffix === ".." || suffix.startsWith(`..${sep}`) || isAbsolute(suffix);
}

/**
 * Walk every segment from `cwd` down to `root` and require each existing one to be a real
 * directory, then require `realpath(root)` to stay inside `realpath(cwd)`.
 */
export async function assertSafeSkillRoot(cwd: string, root: string): Promise<void> {
  const resolvedCwd = resolve(cwd);
  const resolvedRoot = resolve(root);
  const suffix = relative(resolvedCwd, resolvedRoot);
  if (suffix === "" || isEscape(suffix)) {
    throw new Error(`Skill root is not inside its workspace: ${resolvedRoot}`);
  }
  let current = resolvedCwd;
  for (const segment of suffix.split(sep)) {
    current = join(current, segment);
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`Skill root traverses a symlink or non-directory: ${current}`);
    }
  }
  const [realCwd, realRoot] = await Promise.all([realpath(resolvedCwd), realpath(resolvedRoot)]);
  const realSuffix = relative(realCwd, realRoot);
  if (realSuffix !== "" && isEscape(realSuffix)) {
    throw new Error(`Skill root resolves outside its workspace: ${resolvedRoot}`);
  }
}

/** The first unsafe root's reason, or `undefined` when every root is safe. Never throws. */
export async function unsafeSkillRootReason(cwd: string, roots: readonly string[]): Promise<string | undefined> {
  for (const root of roots) {
    try {
      await assertSafeSkillRoot(cwd, root);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }
  return undefined;
}

/**
 * Whether sync has ever started in this workspace.
 *
 * The staging root is the sentinel: sync creates it on every runtime start. Requiring it stops
 * adoption from marking a directory nested inside a checkout that sync never manages.
 */
export async function isSyncedWorkspace(workspace: string): Promise<boolean> {
  try {
    const info = await lstat(skillStagingRoot(workspace));
    return info.isDirectory() && !info.isSymbolicLink();
  } catch {
    return false;
  }
}
