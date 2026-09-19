import { chmod, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  type ContextTreeExecFile,
  type ContextTreePackage,
  managedRepositoryAllowed,
  resolveContextTreePackage,
  runContextTreeCli,
} from "../runtime/context-tree.js";

/**
 * In-Sandbox Context Tree preparation for one Cloud Turn (E8).
 *
 * The packaged CLI anchors managed trees below its process HOME and places write worktrees in
 * `$TMPDIR`; both are pinned at `.opentag/context-tree/{home,tmp}` inside the Session workspace,
 * so the checkout, connection record and prepared writes persist with E5 while the scratch HOME
 * stays disposable. The record stores linkage only; proxy credentials and Git helper config stay
 * in the per-execution environment.
 *
 * Every Turn re-evaluates the current snapshot selection and execution grant. No grant means no
 * CLI call and no mutation; a failed connect/sync is reported `stale` with the preserved
 * in-workspace checkout still addressable through the pinned CLI; nothing is forced, reset or
 * discarded, and drafts of an unselected or rebinding tree stay on disk. A killed first clone can
 * leave a partial managed directory that the pinned CLI thereafter reports as unusable; it is
 * indistinguishable from preserved work, so it is reported rather than deleted. Failures never
 * throw into Turn execution, and no CLI child is left writing once preparation settles.
 */

/** Per-Session Context Tree subtree inside the Session workspace; saved and restored with it. */
export const CLOUD_CONTEXT_TREE_SUBDIRECTORY = ".opentag/context-tree";

/** Bound for Context Tree preparation inside a Turn; optional memory never delays the task long. */
export const CLOUD_CONTEXT_TREE_PREPARATION_BUDGET_MS = 30_000;

/**
 * Context Tree state for one Cloud Turn.
 *
 * - `ready`: connected and synchronized at the start of this Turn.
 * - `stale`: an addressable in-workspace checkout exists, but `connect` or `sync` failed for
 *   `reason`; the copy may be outdated or dirty and is never presented as current.
 * - `unconfigured`: the Agent currently selects no Context Tree (normal state, not a fault).
 * - `unavailable`: the tree cannot be used this Turn; `reason` is the CLI's own error code where
 *   one exists (for example GITHUB_AUTH, TIMEOUT) or one of this module's codes
 *   (PACKAGE_MISSING, CONNECT_FAILED, TREE_OUTSIDE_WORKSPACE, WORKSPACE_MISSING,
 *   SHIM_UNAVAILABLE, PREPARATION_FAILED).
 */
export type CloudContextTreeStatus =
  | { status: "ready"; treePath: string; branch?: string; sha?: string }
  | { status: "stale"; treePath: string; reason: string }
  | { status: "unconfigured" }
  | { status: "unavailable"; reason: string };

export interface CloudContextTreePreparation {
  readonly status: CloudContextTreeStatus;
  /**
   * Directory holding the agent-facing `context-tree` shim for this Turn. Present exactly when
   * the tree is active (`ready`/`stale`); the worker prepends it to the Pi PATH. The shim pins
   * the in-workspace HOME/TMPDIR and the commit identity and carries no secrets.
   */
  readonly binDirectory?: string;
}

/** The current Turn's Context Tree inputs; every field is re-evaluated per Turn by the worker. */
export interface CloudContextTreePreparationInput {
  /** In-sandbox Session workspace (the CLI project path); the tree checkout lives beneath it. */
  readonly workspace: string;
  /** The CURRENT snapshot selection (`snapshot.contextTreeRepository`); `null` unselects. */
  readonly repository: string | null;
  /**
   * The CURRENT per-execution proxy manifest environment (GitHub handle, `GIT_CONFIG_*`,
   * `OPENTAG_GITHUB_REPOSITORIES` grant metadata, proxy routing keys). It is the only credential
   * source the CLI children receive; there is no ambient-environment fallback.
   */
  readonly environment: Readonly<Record<string, string>>;
  /** PATH for the CLI children (the worker-built in-sandbox PATH). */
  readonly path: string;
  /** Per-Turn scratch root; the generated shim is written here and dies with the Turn. */
  readonly scratch: string;
  /** Current Agent slug when the platform instructions carry one; used for commit identity. */
  readonly agentSlug?: string;
  /** Effective execution signal: caller stop, Turn deadline and preparation budget combined. */
  readonly signal?: AbortSignal;
}

export type PrepareCloudContextTree = (input: CloudContextTreePreparationInput) => Promise<CloudContextTreePreparation>;

/** Test-only internals; production callers use the defaults. */
export interface CloudContextTreeInternals {
  readonly contextTreePackage?: ContextTreePackage | null;
  readonly execFile?: ContextTreeExecFile;
  readonly nodePath?: string;
}

const FALLBACK_AGENT_IDENTITY = "opentag-cloud-agent";

/**
 * Extract the current Agent slug from the rendered platform instructions. The Server renders
 * them through `renderPlatformInstructions` (`OpenTag Agent slug: <slug>`) and fails closed on a
 * malformed name, so an anchored, charset-strict match is exactly the identity the Server vetted.
 */
export function cloudAgentSlug(platformInstructions: string): string | undefined {
  return /(?:^|\n)OpenTag Agent slug: ([a-z0-9][a-z0-9-]*)(?=\n|$)/.exec(platformInstructions)?.[1];
}

/**
 * Prepare the Session's Context Tree for one Cloud Turn. Total by contract: every failure is
 * reported in the returned status and nothing throws into Turn execution.
 */
export const prepareCloudContextTree: (
  input: CloudContextTreePreparationInput,
  internals?: CloudContextTreeInternals,
) => Promise<CloudContextTreePreparation> = async (input, internals = {}) => {
  try {
    return await prepare(input, internals);
  } catch {
    // Optional memory never blocks the base task; a preparation defect degrades honestly.
    return { status: { status: "unavailable", reason: "PREPARATION_FAILED" } };
  }
};

async function prepare(
  input: CloudContextTreePreparationInput,
  internals: CloudContextTreeInternals,
): Promise<CloudContextTreePreparation> {
  const workspace = resolve(input.workspace);
  const treeHome = join(workspace, CLOUD_CONTEXT_TREE_SUBDIRECTORY, "home");
  const treeTmp = join(workspace, CLOUD_CONTEXT_TREE_SUBDIRECTORY, "tmp");
  const contextTreePackage =
    internals.contextTreePackage === undefined
      ? resolveContextTreePackage()
      : (internals.contextTreePackage ?? undefined);
  const run = (pack: ContextTreePackage, args: readonly string[], network: boolean) =>
    runContextTreeCli(pack, args, {
      cwd: workspace,
      // Pinned variables always win over the manifest so the arrangement cannot be redirected.
      env: { ...input.environment, HOME: treeHome, LANG: "C.UTF-8", PATH: input.path, TMPDIR: treeTmp },
      network,
      ...(internals.execFile ? { execFile: internals.execFile } : {}),
      ...(internals.nodePath ? { nodePath: internals.nodePath } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    });

  // Unselected trees make no CLI call and leave the preserved record and drafts untouched.
  if (input.repository === null) return { status: { status: "unconfigured" } };
  const repository = input.repository;
  if (!contextTreePackage) return { status: { status: "unavailable", reason: "PACKAGE_MISSING" } };
  if (!(await directoryExists(workspace))) return { status: { status: "unavailable", reason: "WORKSPACE_MISSING" } };

  // The current execution must actively grant this exact repository the `context_tree` role.
  // Without it nothing is read, nothing is written, and no CLI process runs at all.
  if (!managedRepositoryAllowed(input.environment, repository)) {
    return { status: { status: "unavailable", reason: "GITHUB_PERMISSION" } };
  }

  await mkdir(treeHome, { mode: 0o700, recursive: true });
  await mkdir(treeTmp, { mode: 0o700, recursive: true });

  const status = await connectAndSync(
    (args, network) => run(contextTreePackage, args, network),
    workspace,
    treeHome,
    repository,
  );
  if (status.status !== "ready" && status.status !== "stale") return { status };
  try {
    const binDirectory = await writeContextTreeShim({
      agentSlug: input.agentSlug ?? FALLBACK_AGENT_IDENTITY,
      cliPath: contextTreePackage.cliPath,
      home: treeHome,
      nodePath: internals.nodePath ?? process.execPath,
      scratch: input.scratch,
      tmp: treeTmp,
    });
    return { binDirectory, status };
  } catch {
    return { status: { status: "unavailable", reason: "SHIM_UNAVAILABLE" } };
  }
}

type RunCli = (args: readonly string[], network: boolean) => Promise<{ payload: unknown; failureCode?: string }>;

/**
 * One `connect` (clone, reattach, or rebind) and, on success, one `sync`. Connect failures fall
 * back to the preserved checkout only for this exact repository and workspace.
 */
async function connectAndSync(
  run: RunCli,
  workspace: string,
  treeHome: string,
  repository: string,
): Promise<CloudContextTreeStatus> {
  const connected = await run(["connect", repository, "--project-path", workspace, "--json"], true);
  const treePath = connected.failureCode === undefined ? payloadTreePath(connected.payload) : undefined;
  if (treePath === undefined) {
    if (connected.failureCode === undefined) return { status: "unavailable", reason: "CONNECT_FAILED" };
    const preserved = await preservedCheckout(treeHome, workspace, repository);
    return preserved === undefined
      ? { status: "unavailable", reason: connected.failureCode }
      : { status: "stale", treePath: preserved, reason: connected.failureCode };
  }
  // The checkout must be the per-Session copy inside the saved workspace; anything else fails
  // closed instead of being adopted.
  if (!isWithin(await realpath(workspace), treePath)) {
    return { status: "unavailable", reason: "TREE_OUTSIDE_WORKSPACE" };
  }
  const synced = await run(["sync", "--project-path", workspace], true);
  return synced.failureCode === undefined
    ? readyStatus(treePath, synced.payload)
    : { status: "stale", treePath, reason: synced.failureCode };
}

interface StoredConnection {
  readonly projectPath?: unknown;
  readonly tree?: { readonly kind?: unknown; readonly path?: unknown; readonly repository?: unknown };
}

/**
 * Address the checkout that a previous Turn connected, even when this Turn cannot validate it
 * (a dirty checkout or a failed clone). Reads only the pinned CLI's schema-versioned record for
 * this exact workspace path; the CLI remains the owner of the record. The repository must match
 * the CURRENT selection, so a rebind can never address the old tree.
 */
async function preservedCheckout(treeHome: string, workspace: string, repository: string): Promise<string | undefined> {
  let raw: string;
  try {
    raw = await readFile(join(treeHome, ".context-tree", "connections.json"), "utf8");
  } catch {
    return undefined;
  }
  let connections: unknown;
  try {
    const parsed = JSON.parse(raw) as { connections?: unknown; schemaVersion?: unknown };
    if (parsed.schemaVersion !== 1) return undefined;
    connections = parsed.connections;
  } catch {
    return undefined;
  }
  if (!Array.isArray(connections)) return undefined;
  const canonical = await realpath(workspace).catch(() => undefined);
  const record = connections.find((candidate): candidate is StoredConnection => {
    if (!candidate || typeof candidate !== "object") return false;
    const { projectPath, tree } = candidate as StoredConnection;
    return (
      (projectPath === canonical || projectPath === resolve(workspace)) &&
      tree?.kind === "github" &&
      typeof tree.repository === "string" &&
      tree.repository.toLowerCase() === repository.toLowerCase()
    );
  });
  const treePath = record?.tree?.path;
  return typeof treePath === "string" && isWithin(canonical ?? resolve(workspace), treePath) ? treePath : undefined;
}

function payloadTreePath(payload: unknown): string | undefined {
  const treePath = (payload as { tree?: { path?: unknown } } | undefined)?.tree?.path;
  return typeof treePath === "string" && treePath.length > 0 ? treePath : undefined;
}

function readyStatus(treePath: string, payload: unknown): CloudContextTreeStatus {
  const record = payload as { branch?: unknown; sha?: unknown } | undefined;
  return {
    status: "ready",
    treePath,
    ...(typeof record?.branch === "string" ? { branch: record.branch } : {}),
    ...(typeof record?.sha === "string" ? { sha: record.sha } : {}),
  };
}

/**
 * The agent-facing `context-tree` command for one Turn. It pins the packaged CLI entrypoint and
 * Node runtime (so PATH resolution cannot substitute another install), the in-workspace tree
 * HOME/TMPDIR (so skill-driven commands operate on this Session's preserved checkout and
 * prepared writes land in the saved workspace), and a commit identity (the Sandbox has no user
 * Git identity, and the execution GIT_CONFIG_GLOBAL is a read-only mount). Proxy and grant
 * variables flow from the Pi process environment, never from this file: the shim carries no
 * secrets.
 */
async function writeContextTreeShim(input: {
  agentSlug: string;
  cliPath: string;
  home: string;
  nodePath: string;
  scratch: string;
  tmp: string;
}): Promise<string> {
  const bin = join(input.scratch, "context-tree-bin");
  await mkdir(bin, { mode: 0o700, recursive: true });
  const quote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;
  const shim = join(bin, "context-tree");
  await writeFile(
    shim,
    `${[
      "#!/bin/sh",
      "# Generated by OpenTag for this Cloud Turn; edits are overwritten.",
      `HOME=${quote(input.home)}`,
      `TMPDIR=${quote(input.tmp)}`,
      `GIT_AUTHOR_NAME=${quote(input.agentSlug)}`,
      `GIT_AUTHOR_EMAIL=${quote(`${input.agentSlug}@localhost`)}`,
      `GIT_COMMITTER_NAME=${quote(input.agentSlug)}`,
      `GIT_COMMITTER_EMAIL=${quote(`${input.agentSlug}@localhost`)}`,
      "export HOME TMPDIR GIT_AUTHOR_NAME GIT_AUTHOR_EMAIL GIT_COMMITTER_NAME GIT_COMMITTER_EMAIL",
      `exec ${quote(input.nodePath)} ${quote(input.cliPath)} "$@"`,
    ].join("\n")}\n`,
    { mode: 0o700 },
  );
  await chmod(shim, 0o700);
  return bin;
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
