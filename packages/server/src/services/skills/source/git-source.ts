import { lstat, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  checkOutboundUrl,
  type RemoteSkillSource,
  SKILL_SOURCE_GIT_TIMEOUT_MS,
  SKILL_SOURCE_SNAPSHOT_MAX_BYTES,
  SKILL_UNPACKED_MAX_BYTES,
} from "@opentag/shared";
import { GitPublicationError } from "../../github-proxy/git-packets.js";
import { runTrustedProcess } from "../../github-proxy/git-process.js";
import { classifyOutboundDestination, resolveAllAddresses } from "../../outbound/destination-policy.js";
import type { SkillServiceError } from "../errors.js";
import { skillSourceBlocked, skillSourceInvalid, skillSourceTooLarge, skillSourceUnreachable } from "../errors.js";
import type { SkillSourceFile, SkillSourceSnapshot } from "./source-snapshot.js";

/**
 * The git transport for repository sources.
 *
 * A source is fetched as a **tree-first shallow partial clone**: `--depth 1` bounds the history,
 * `--no-checkout` means no working tree is written, and `--filter=blob:none` means only the commit
 * and its trees are downloaded at first. A blob arrives when a candidate is actually inspected or
 * packaged (`cat-file blob <sha>`, which the promisor remote serves on demand), so a repository with
 * a hundred non-Skill megabytes costs a tree listing and nothing more. A server that ignores the
 * filter degrades to an ordinary shallow clone and the same code path still works; a server that
 * refuses `--depth` is refused in turn, because an unbounded history is not something this feature
 * will download.
 *
 * Everything the process does is fixed here rather than left to the ambient environment: the
 * sandboxed spawner (`github-proxy/git-process.ts`) kills the process group on a deadline, and the
 * arguments and environment below remove every way a git invocation could reach outside the clone —
 * a credential helper, an SSH key, a hook, a `file://` path, a redirect, or a protocol git does not
 * need for a public HTTPS fetch.
 *
 * The remote is judged by the shared address policy *before* a process is spawned, because git
 * resolves DNS itself and would happily dial a name the policy refuses.
 */

/**
 * A git invocation's outcome as a Skill source failure.
 *
 * The spawner reports a resource limit, an unavailable peer, and a non-zero exit alike, and none of
 * them may reach the caller as a raw error: an unhandled one becomes a 500 for what is really a
 * decision about the source. A limit is the one case worth distinguishing, because the caller's next
 * step is different — the source is too big, not unreachable.
 */
function gitFailure(error: unknown): SkillServiceError {
  if (error instanceof GitPublicationError && error.code === "resource_limit") return skillSourceTooLarge();
  return skillSourceUnreachable();
}

/** One git invocation, as the injected runner receives it. */
export interface GitProcessInvocation {
  cwd: string;
  environment: NodeJS.ProcessEnv;
  signal: AbortSignal;
  maxOutputBytes?: number;
  timeoutMs?: number;
}

export type GitProcessRunner = (
  binary: string,
  args: string[],
  options: GitProcessInvocation,
) => Promise<{ code: number; stdout: Buffer }>;

/** The default runner: the Server's sandboxed, process-group-killing spawner. */
export const defaultGitProcessRunner: GitProcessRunner = (binary, args, options) =>
  runTrustedProcess(binary, args, options);

/**
 * `-c` overrides applied to every command.
 *
 * `protocol.allow=never` with only HTTP(S) re-enabled removes `ext::`, `file://`, and SSH as
 * transports even if a URL ever reached this layer that the source parser would not produce; a
 * `file://` fetch reads the Server's own disk, and an `ext::` fetch executes a command.
 * `http.followRedirects=false` closes the same hole the HTTP fetcher closes for `fetch` — a redirect
 * to a private address — and `core.hooksPath=/dev/null` makes a hook in the fetched repository inert.
 */
export const GIT_SOURCE_CONFIG: readonly string[] = Object.freeze([
  "protocol.allow=never",
  "protocol.http.allow=always",
  "protocol.https.allow=always",
  "protocol.file.allow=never",
  "http.followRedirects=false",
  "core.hooksPath=/dev/null",
  "gc.auto=0",
  "advice.detachedHead=false",
]);

function configArguments(proxyUrl?: string): string[] {
  const settings = proxyUrl === undefined ? GIT_SOURCE_CONFIG : [...GIT_SOURCE_CONFIG, `http.proxy=${proxyUrl}`];
  return settings.flatMap((setting) => ["-c", setting]);
}

/**
 * The environment for every git invocation.
 *
 * A sibling of the GitHub transport's trusted environment rather than a shared helper: this one is
 * strictly stricter. It has no place to put a credential — `GIT_ASKPASS` is empty, so git fails
 * instead of prompting, and `GIT_SSH_COMMAND` makes an SSH attempt fail immediately — and its HOME
 * is the request's own workspace, so a global or system git configuration cannot influence it.
 */
export function gitSourceEnvironment(home: string, options: { proxyUrl?: string } = {}): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home,
    // The pinning proxy is the only route out; an inherited `no_proxy` could bypass it for a name a
    // deployment happens to list, so both spellings are cleared.
    ...(options.proxyUrl === undefined ? {} : { NO_PROXY: "", no_proxy: "" }),
    XDG_CONFIG_HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_ATTR_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_ASKPASS: "",
    GIT_SSH_COMMAND: "/bin/false",
    GIT_LFS_SKIP_SMUDGE: "1",
    GIT_OPTIONAL_LOCKS: "0",
    LC_ALL: "C",
  };
}

/**
 * The clone command: bounded history, no worktree, no blobs, one branch, explicit ref when given.
 *
 * `proxyUrl` is the address-pinning tunnel. Git resolves the hostname itself, so the only way to bind
 * the policy's judgement to the connection is to make git dial through something that has already
 * resolved and approved it.
 */
export function gitCloneArguments(
  source: RemoteSkillSource,
  directory: string,
  options: { proxyUrl?: string } = {},
): string[] {
  return [
    ...configArguments(options.proxyUrl),
    "clone",
    "--quiet",
    "--no-checkout",
    "--depth",
    "1",
    "--single-branch",
    "--no-tags",
    "--filter=blob:none",
    ...(source.ref === undefined ? [] : ["--branch", source.ref]),
    "--",
    source.url,
    directory,
  ];
}

/** The environment check for one repository source, run before any process exists. */
export async function assertGitRemoteAllowed(
  source: RemoteSkillSource,
  options: {
    allowLoopback: boolean;
    resolveAddresses?: (hostname: string) => Promise<string[]>;
  },
): Promise<void> {
  const target = checkOutboundUrl(source.url, { allowLoopback: options.allowLoopback });
  if ("failure" in target) throw skillSourceBlocked();
  const destination = await classifyOutboundDestination(target.url, options.resolveAddresses ?? resolveAllAddresses);
  if (!destination.ok) {
    throw destination.failure.kind === "blocked" ? skillSourceBlocked() : skillSourceUnreachable();
  }
}

/* ------------------------------ tree and blobs ------------------------------ */

const TREE_RECORD = /^(\d+) \w+ ([0-9a-f]+)\t([\s\S]*)$/;

/**
 * The regular files of a tree listing.
 *
 * `ls-tree` reports every object in the tree, including the two kinds a Skill may never contain:
 * `120000` symlinks (which the archive validator also refuses, so a source could otherwise smuggle
 * one through) and `160000` submodule links (which are not files at all). Both are dropped here.
 */
export function parseGitTree(stdout: Buffer): SkillSourceFile[] {
  const files: SkillSourceFile[] = [];
  for (const record of stdout.toString("utf8").split("\0")) {
    if (record === "") continue;
    const match = TREE_RECORD.exec(record);
    if (match === null) continue;
    const [, mode, object, path] = match;
    if (mode === undefined || object === undefined || path === undefined) continue;
    if (mode === "120000" || mode === "160000") continue;
    files.push({ path, executable: mode === "100755", id: object });
  }
  return files;
}

/** The blob id of each file, kept beside the listing so a read needs no path parsing. */
function blobIds(stdout: Buffer): Map<string, string> {
  const ids = new Map<string, string>();
  for (const record of stdout.toString("utf8").split("\0")) {
    const match = TREE_RECORD.exec(record);
    if (match?.[2] !== undefined && match[3] !== undefined) ids.set(match[3], match[2]);
  }
  return ids;
}

export interface GitSnapshotOptions {
  source: RemoteSkillSource;
  /** The request's private workspace; the clone is created inside it. */
  workspace: string;
  signal: AbortSignal;
  /**
   * The address-pinning tunnel to route every git connection through. Production always supplies it;
   * a test that drives the runner directly may omit it.
   */
  proxyUrl?: string;
  maxBytes?: number;
  timeoutMs?: number;
  run?: GitProcessRunner;
  /** Test seam for the periodic size check; defaults to walking the clone directory. */
  measureWorkspace?: (path: string) => Promise<number>;
}

async function directoryBytes(path: string): Promise<number> {
  let total = 0;
  const pending = [path];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (directory === undefined) break;
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const child = join(directory, entry.name);
      if (entry.isDirectory()) pending.push(child);
      else total += (await lstat(child)).size;
    }
  }
  return total;
}

/**
 * Clones a repository source and returns a lazy snapshot of it.
 *
 * The clone is bounded twice: the spawner's own deadline kills the process group, and a periodic
 * directory measurement aborts and removes a clone that grows past the byte budget. The measurement
 * keeps running while the snapshot is alive, because lazily fetched blobs grow the same directory —
 * a `--filter` the peer did not honour is exactly the case an unbounded clone would otherwise win.
 */
export async function fetchGitSnapshot(options: GitSnapshotOptions): Promise<SkillSourceSnapshot> {
  const run = options.run ?? defaultGitProcessRunner;
  const limit = options.maxBytes ?? SKILL_SOURCE_SNAPSHOT_MAX_BYTES;
  const timeoutMs = options.timeoutMs ?? SKILL_SOURCE_GIT_TIMEOUT_MS;
  const measure = options.measureWorkspace ?? directoryBytes;
  const directory = join(options.workspace, "repository");
  const home = join(options.workspace, "home");
  await mkdir(home, { mode: 0o700, recursive: true });

  const budget = new AbortController();
  const signal = AbortSignal.any([options.signal, budget.signal]);
  const proxy = options.proxyUrl === undefined ? {} : { proxyUrl: options.proxyUrl };
  const invocation: GitProcessInvocation = {
    cwd: options.workspace,
    environment: gitSourceEnvironment(home, proxy),
    signal,
    timeoutMs,
  };
  const monitor = setInterval(() => {
    void overBudget().then((over) => {
      if (over) budget.abort();
    });
  }, 500);
  monitor.unref();
  const stopMonitoring = () => clearInterval(monitor);
  /**
   * The authoritative size check. The interval catches a clone that grows while it runs; this one
   * catches a clone that finished under the tick, so the budget does not depend on timing.
   */
  async function overBudget(): Promise<boolean> {
    try {
      return (await measure(options.workspace)) > limit;
    } catch {
      return false;
    }
  }
  try {
    const clone = await run("git", gitCloneArguments(options.source, directory, proxy), invocation).catch((error) => {
      throw gitFailure(error);
    });
    if (clone.code !== 0) throw cloneFailure();
    if (options.proxyUrl !== undefined) {
      /*
       * Recorded in the repository as well as passed per command, because a lazy blob fetch is a
       * separate `git cat-file` process that reads the repository's own configuration. Without this
       * the tree arrives through the tunnel and the blobs do not.
       */
      const configured = await run(
        "git",
        [...configArguments(), "-C", directory, "config", "http.proxy", options.proxyUrl],
        invocation,
      );
      if (configured.code !== 0) throw cloneFailure();
    }
    if (await overBudget()) throw skillSourceTooLarge();
    const tree = await run(
      "git",
      [...configArguments(options.proxyUrl), "-C", directory, "ls-tree", "-r", "-z", "HEAD"],
      {
        ...invocation,
        maxOutputBytes: 8 * 1024 * 1024,
      },
    );
    if (tree.code !== 0) throw cloneFailure();
    return gitSnapshot(directory, tree.stdout, invocation, run, stopMonitoring, options.proxyUrl);
  } catch (error) {
    stopMonitoring();
    if (budget.signal.aborted) throw skillSourceTooLarge();
    throw error;
  }
}

/** A git exit status is never surfaced: its stderr could name an internal path or a credential. */
function cloneFailure(): SkillServiceError {
  return skillSourceUnreachable();
}

function gitSnapshot(
  directory: string,
  treeListing: Buffer,
  invocation: GitProcessInvocation,
  run: GitProcessRunner,
  stopMonitoring: () => void,
  proxyUrl: string | undefined,
): SkillSourceSnapshot {
  const ids = blobIds(treeListing);
  const files = parseGitTree(treeListing);
  const cache = new Map<string, Uint8Array>();
  return {
    files,
    async read(path: string) {
      const cached = cache.get(path);
      if (cached !== undefined) return cached;
      const id = ids.get(path);
      if (id === undefined) throw skillSourceInvalid("The source no longer holds that file");
      /*
       * The promisor fetch that fills a missing blob runs inside this process, so the `-c` flags
       * (including the pinning proxy) govern it too.
       *
       * The read cap is the *unpacked* ceiling, not a smaller fixed size: a Skill may hold a single
       * file up to that bound, and a lower cap would make such a Skill readable through an upload and
       * unreadable through a repository.
       */
      const result = await run("git", [...configArguments(proxyUrl), "-C", directory, "cat-file", "blob", id], {
        ...invocation,
        maxOutputBytes: SKILL_UNPACKED_MAX_BYTES,
      }).catch((error) => {
        throw gitFailure(error);
      });
      if (result.code !== 0) throw cloneFailure();
      const body = new Uint8Array(result.stdout);
      cache.set(path, body);
      return body;
    },
    dispose() {
      stopMonitoring();
      cache.clear();
      return Promise.resolve();
    },
  };
}
