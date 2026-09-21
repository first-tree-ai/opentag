import { lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitPublicationError } from "./git-packets.js";

/**
 * Ephemeral Git staging root: one exclusive `mkdtemp` directory under the OS temporary
 * directory, created lazily on first use. This is deliberately NOT the removed persistent
 * control store — no control record, receipt, or credential is ever written here, and the
 * directory is never mounted into a Sandbox. Temporary workspaces are disposable verification
 * aids and are never restored as authority after a restart. Cleanup is guaranteed on a normal
 * close and on handled failure paths; a process crash may leave residue behind, and leftover
 * directories are never trusted. Only the Git smart-HTTP gateway stages trusted pack/ref
 * verification workspaces in it, and only when the GitHub transport is enabled at all.
 */
export class GitWorkspace {
  #root?: string;
  #pending?: Promise<string>;
  #closed = false;
  #closing?: Promise<void>;
  #staging = 0;
  #stagingIdle: Array<() => void> = [];

  /** The current ephemeral root once created; undefined before first use and after close. */
  get root(): string | undefined {
    return this.#root;
  }

  /** Root safety validator; replaceable in tests to exercise handled creation failures. */
  readonly #validateRoot: (root: string) => Promise<void>;

  constructor(options: { validateRoot?: (root: string) => Promise<void> } = {}) {
    this.#validateRoot = options.validateRoot ?? assertEphemeralWorkspaceRoot;
  }

  /**
   * Creates one bounded per-operation working directory under the shared ephemeral root. The
   * root itself is created on first use; construction of this class performs no filesystem
   * writes, so a deployment with GitHub integration disabled never touches the filesystem.
   */
  async stagingDirectory(prefix: "read-" | "git-" | "tree-head-"): Promise<string> {
    if (this.#closed) throw new GitPublicationError("unavailable");
    this.#staging++;
    try {
      const root = await this.#ensureRoot();
      // Close wins over both root creation and operation-directory creation. Its drain waits
      // for these filesystem calls before removing the root, and callers receive no stale path.
      if (this.#closed) throw new GitPublicationError("unavailable");
      const staging = await mkdtemp(join(root, prefix));
      if (this.#closed) throw new GitPublicationError("unavailable");
      return staging;
    } finally {
      this.#staging--;
      if (this.#staging === 0) {
        const waiters = this.#stagingIdle.splice(0);
        for (const resolve of waiters) resolve();
      }
    }
  }

  async #ensureRoot(): Promise<string> {
    if (this.#closed) throw new GitPublicationError("unavailable");
    if (this.#root) return this.#root;
    this.#pending ??= createEphemeralRoot(this.#validateRoot).then(
      (root) => {
        this.#root = root;
        return root;
      },
      (error) => {
        this.#pending = undefined;
        throw error;
      },
    );
    return this.#pending;
  }

  /**
   * Removes the ephemeral root on a normal close. Once close begins, no new staging requests
   * are admitted; close waits for in-flight creations to settle (each fails with
   * `unavailable`) before removing the root, so no call returns a valid new directory after
   * close has returned. In-flight operations keep their own per-operation cleanup; shutdown
   * does not wait for them.
   */
  close(): Promise<void> {
    this.#closed = true;
    this.#closing ??= this.#removeRoot();
    return this.#closing;
  }

  async #removeRoot(): Promise<void> {
    const root = await (this.#pending ?? Promise.resolve(this.#root)).catch(() => this.#root);
    if (this.#staging > 0) await new Promise<void>((resolve) => this.#stagingIdle.push(resolve));
    if (root) await rm(root, { recursive: true, force: true });
    this.#pending = undefined;
    this.#root = undefined;
  }
}

/** mkdtemp plus the temporary-workspace safety check, cleaning up if the check cannot pass. */
async function createEphemeralRoot(validateRoot: (root: string) => Promise<void>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "opentag-git-"));
  try {
    await validateRoot(root);
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
  return root;
}

/**
 * Temporary-workspace safety: the staging root must be a real directory owned by this process
 * and inaccessible to anyone else. `mkdtemp` already creates mode 0700; this fails closed if
 * the environment disagrees rather than trusting creation flags.
 */
export async function assertEphemeralWorkspaceRoot(root: string): Promise<void> {
  const info = await lstat(root);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (info.mode & 0o077) !== 0 ||
    (process.getuid && info.uid !== process.getuid())
  )
    throw new GitPublicationError("unavailable");
}
