import { lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { skillSourceUnreachable } from "../errors.js";

/**
 * One request's private working directory for a fetched source.
 *
 * A remote source has to land somewhere before it can be read, and that somewhere must be invisible to
 * every other request and to every other Account. `mkdtemp` gives an exclusive, `0700` directory; the
 * mode is re-checked after creation and the workspace fails closed if the environment disagrees, so a
 * misconfigured umask cannot leave a fetched repository world-readable.
 *
 * The directory is disposed on every path — success, failure, and abandonment — because a repository
 * snapshot is unbounded in the ways a Skill archive is not: it can hold thousands of files, and a
 * leaked one would outlive the request that caused it. A process crash may still leave residue, and
 * residue is never treated as state: the next request gets a fresh directory.
 */

const WORKSPACE_PREFIX = "opentag-skill-source-";

export class SkillSourceWorkspace {
  readonly #root: string;
  #disposed = false;

  private constructor(root: string) {
    this.#root = root;
  }

  /**
   * Creates a workspace, or fails with the source error the caller already renders. A deployment
   * whose temporary directory is unwritable cannot install from a source, which is an unavailable
   * source from the user's point of view.
   *
   * The directory is removed when the privacy check fails after `mkdtemp` has already created it:
   * the factory never returns on that path, so the caller's disposer can never reach it.
   * `validateRoot` is injectable because the check depends on the ambient `umask`, which a test
   * cannot arrange portably.
   */
  static async create(options: { validateRoot?: (root: string) => Promise<void> } = {}): Promise<SkillSourceWorkspace> {
    let root: string | undefined;
    try {
      root = await mkdtemp(join(tmpdir(), WORKSPACE_PREFIX));
      await (options.validateRoot ?? assertPrivateWorkspaceRoot)(root);
    } catch {
      if (root !== undefined) await rm(root, { recursive: true, force: true }).catch(() => undefined);
      throw skillSourceUnreachable("The source could not be staged on this deployment");
    }
    return new SkillSourceWorkspace(root);
  }

  get root(): string {
    return this.#root;
  }

  /** Removes the workspace. Idempotent, and never throws: cleanup must not mask the real failure. */
  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    await rm(this.#root, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * The workspace must be a real directory owned by this process and reachable by nobody else.
 *
 * Exported so the check can be exercised directly: whether `mkdtemp` produces a private directory
 * depends on the ambient `umask`, which a test cannot portably arrange. A deployment that fails this
 * check fails closed — the staging directory is removed and the install reports an unavailable
 * source — rather than fetching a repository into a world-readable directory.
 */
export async function assertPrivateWorkspaceRoot(root: string): Promise<void> {
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error("The workspace is not a directory");
  if ((info.mode & 0o077) !== 0) throw new Error("The workspace is readable by other users");
  if (process.getuid && info.uid !== process.getuid()) throw new Error("The workspace has another owner");
}
