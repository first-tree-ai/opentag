import { chmod, mkdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ContextTreeConnection } from "@opentag/shared";
import {
  type ContextTreeExecFile,
  type ContextTreePackage,
  managedRepositoryAllowed,
  resolveContextTreePackage,
  runContextTreeCli,
} from "../runtime/context-tree.js";
import {
  connectedTree,
  reconcileContextTreeConnections,
  StoredConnectionsSchema,
  syncedTree,
} from "../runtime/context-tree-connections.js";

/**
 * In-Sandbox Context Tree preparation for one Cloud Turn (E8).
 *
 * The packaged CLI anchors managed trees below its process HOME and places write worktrees in
 * `$TMPDIR`; both are pinned at `.opentag/context-tree/{home,tmp}` inside the Session workspace,
 * so the checkout, connection record and prepared writes persist with E5 while the scratch HOME
 * stays disposable. The record stores linkage only; proxy credentials and Git helper config stay
 * in the per-execution environment.
 *
 * Every Turn re-evaluates the current snapshot selection and execution grant. Revoked grants are detached locally without
 * network preparation; a failed connect/sync is reported `stale` with the preserved
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
  | { status: "configured"; connections: CloudContextTreeResult[] }
  | { status: "ready"; treePath: string; branch?: string; sha?: string }
  | { status: "stale"; treePath: string; reason: string }
  | { status: "unconfigured" }
  | { status: "unavailable"; reason: string };

export type CloudContextTreeResult = ContextTreeConnection &
  Exclude<CloudContextTreeStatus, { status: "configured" } | { status: "unconfigured" }>;

export interface CloudContextTreePreparation {
  readonly status: CloudContextTreeStatus;
  /**
   * Directory holding the agent-facing `context-tree` shim for this Turn. Present exactly when
   * at least one tree is active (`ready`/`stale`); the worker prepends it to the Pi PATH. The shim pins
   * the in-workspace HOME/TMPDIR and the commit identity and carries no secrets.
   */
  readonly binDirectory?: string;
}

/** The current Turn's Context Tree inputs; every field is re-evaluated per Turn by the worker. */
export interface CloudContextTreePreparationInput {
  /** In-sandbox Session workspace (the CLI project path); the tree checkout lives beneath it. */
  readonly workspace: string;
  /** The CURRENT snapshot selection (`snapshot.contextTrees`); an empty list disables memory. */
  readonly contextTrees: readonly ContextTreeConnection[];
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
    return await prepare(
      {
        ...input,
        signal: AbortSignal.any([
          ...(input.signal ? [input.signal] : []),
          AbortSignal.timeout(CLOUD_CONTEXT_TREE_PREPARATION_BUDGET_MS),
        ]),
      },
      internals,
    );
  } catch {
    // Optional memory never blocks the base task; a preparation defect degrades honestly.
    return failedPreparation(input.contextTrees, "PREPARATION_FAILED");
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

  if (!contextTreePackage)
    return input.contextTrees.length
      ? failedPreparation(input.contextTrees, "PACKAGE_MISSING")
      : { status: { status: "unconfigured" } };
  if (!(await directoryExists(workspace))) return failedPreparation(input.contextTrees, "WORKSPACE_MISSING");
  await mkdir(treeHome, { mode: 0o700, recursive: true });
  await mkdir(treeTmp, { mode: 0o700, recursive: true });
  const runCli: RunCli = (args, network) => run(contextTreePackage, args, network);
  const allowed = input.contextTrees.filter((entry) => managedRepositoryAllowed(input.environment, entry.repository));
  // Reconcile even when no trees remain authorized, before any agent-facing shim can exist.
  const reconciliation = await reconcileContextTreeConnections(runCli, workspace, allowed);
  if (reconciliation.failureCode) return failedPreparation(input.contextTrees, reconciliation.failureCode);
  if (!input.contextTrees.length) return { status: { status: "unconfigured" } };
  const connections: CloudContextTreeResult[] = [];
  for (const connection of input.contextTrees)
    connections.push(await prepareConnection(runCli, input, workspace, treeHome, connection));
  const status: CloudContextTreeStatus = { status: "configured", connections };
  if (!connections.some((entry) => entry.status === "ready" || entry.status === "stale")) return { status };
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
    return failedPreparation(input.contextTrees, "SHIM_UNAVAILABLE");
  }
}

async function prepareConnection(
  run: RunCli,
  input: CloudContextTreePreparationInput,
  workspace: string,
  treeHome: string,
  connection: ContextTreeConnection,
): Promise<CloudContextTreeResult> {
  if (!managedRepositoryAllowed(input.environment, connection.repository))
    return { ...connection, status: "unavailable", reason: "GITHUB_PERMISSION" };
  if (input.signal?.aborted) return { ...connection, status: "unavailable", reason: "TIMEOUT" };
  try {
    return { ...connection, ...(await connectAndSync(run, workspace, treeHome, connection)) };
  } catch {
    return { ...connection, status: "unavailable", reason: input.signal?.aborted ? "TIMEOUT" : "PREPARATION_FAILED" };
  }
}

function failedPreparation(connections: readonly ContextTreeConnection[], reason: string): CloudContextTreePreparation {
  return {
    status: connections.length
      ? { status: "configured", connections: connections.map((entry) => ({ ...entry, status: "unavailable", reason })) }
      : { status: "unavailable", reason },
  };
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
  connection: ContextTreeConnection,
): Promise<Exclude<CloudContextTreeStatus, { status: "configured" } | { status: "unconfigured" }>> {
  const connected = await run(
    ["connect", connection.repository, "--as", connection.alias, "--project-path", workspace, "--json"],
    true,
  );
  const treePath = connected.failureCode === undefined ? connectedTree(connected.payload, connection)?.path : undefined;
  if (treePath === undefined) {
    if (connected.failureCode === undefined) return { status: "unavailable", reason: "CONNECT_FAILED" };
    const preserved = await preservedCheckout(treeHome, workspace, connection);
    return preserved === undefined
      ? { status: "unavailable", reason: connected.failureCode }
      : { status: "stale", treePath: preserved, reason: connected.failureCode };
  }
  // The checkout must be the per-Session copy inside the saved workspace; anything else fails
  // closed instead of being adopted.
  if (!isWithin(await realpath(workspace), await realpath(treePath).catch(() => treePath))) {
    return { status: "unavailable", reason: "TREE_OUTSIDE_WORKSPACE" };
  }
  const synced = await run(["sync", "--tree", connection.alias, "--project-path", workspace], true);
  const entry = syncedTree(synced.payload, connection);
  if (!entry) return { status: "stale", treePath, reason: synced.failureCode ?? "SYNC_FAILED" };
  return entry.ok
    ? readyStatus(treePath, entry)
    : { status: "stale", treePath, reason: entry.error?.code ?? "SYNC_FAILED" };
}

/** Recover only the exact workspace/alias/repository record from the current upstream format. */
async function preservedCheckout(
  treeHome: string,
  workspace: string,
  connection: ContextTreeConnection,
): Promise<string | undefined> {
  try {
    const parsed = StoredConnectionsSchema.safeParse(
      JSON.parse(await readFile(join(treeHome, ".context-tree", "connections.json"), "utf8")),
    );
    if (!parsed.success) return undefined;
    const canonical = await realpath(workspace);
    const record = parsed.data.connections.find(
      (entry) =>
        (entry.projectPath === canonical || entry.projectPath === resolve(workspace)) &&
        entry.alias === connection.alias &&
        entry.tree.kind === "github" &&
        entry.tree.repository.toLowerCase() === connection.repository.toLowerCase(),
    );
    if (!record) return undefined;
    const path = await realpath(record.tree.path);
    return isWithin(canonical, path) && (await directoryExists(path)) ? path : undefined;
  } catch {
    return undefined;
  }
}

function readyStatus(treePath: string, payload: unknown): Extract<CloudContextTreeStatus, { status: "ready" }> {
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
