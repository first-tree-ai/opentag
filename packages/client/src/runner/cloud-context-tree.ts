import { chmod, mkdir, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { ContextTreeConnection } from "@opentag/shared";
import {
  type ContextTreeExecFile,
  type ContextTreePackage,
  hasManagedGitHubTransport,
  resolveContextTreePackage,
  runContextTreeCli,
} from "../runtime/context-tree.js";
import { CONTEXT_TREE_COMMAND_CLIENT_SOURCE } from "../runtime/context-tree-commands.js";
import {
  type ContextTreeResult as CloudContextTreeResult,
  type ContextTreeStatus as CloudContextTreeStatus,
  configureContextTrees,
  syncedTree,
} from "../runtime/context-tree-connections.js";

export const CLOUD_CONTEXT_TREE_SUBDIRECTORY = ".opentag/context-tree";
export const CLOUD_CONTEXT_TREE_PREPARATION_BUDGET_MS = 30_000;
const RECOVERY_BUDGET_MS = 5_000;

export type { ContextTreeStatus as CloudContextTreeStatus } from "../runtime/context-tree-connections.js";
export interface CloudContextTreePreparation {
  readonly status: CloudContextTreeStatus;
  readonly binDirectory?: string;
}
export interface CloudContextTreePreparationInput {
  readonly workspace: string;
  readonly contextTrees: readonly ContextTreeConnection[];
  readonly environment: Readonly<Record<string, string>>;
  readonly path: string;
  readonly scratch: string;
  readonly agentSlug?: string;
  readonly signal?: AbortSignal;
}
export type PrepareCloudContextTree = (input: CloudContextTreePreparationInput) => Promise<CloudContextTreePreparation>;
export interface CloudContextTreeInternals {
  readonly contextTreePackage?: ContextTreePackage | null;
  readonly execFile?: ContextTreeExecFile;
  readonly nodePath?: string;
  readonly preparationBudgetMs?: number;
  readonly recoveryBudgetMs?: number;
}

/** Persist selection first; refresh once. An interrupted refresh cannot lose the connection. */
export const prepareCloudContextTree = async (
  input: CloudContextTreePreparationInput,
  internals: CloudContextTreeInternals = {},
): Promise<CloudContextTreePreparation> => {
  try {
    return await prepare(input, internals);
  } catch {
    return failedPreparation(input.contextTrees, input.signal?.aborted ? "TIMEOUT" : "PREPARATION_FAILED");
  }
};

async function prepare(
  input: CloudContextTreePreparationInput,
  internals: CloudContextTreeInternals,
): Promise<CloudContextTreePreparation> {
  const workspace = await realpath(resolve(input.workspace));
  const authorized = hasManagedGitHubTransport(input.environment);
  const project = await configureContextTrees(workspace, authorized ? input.contextTrees : []);
  if (!input.contextTrees.length) return { status: { status: "unconfigured" } };
  if (!authorized) return failedPreparation(input.contextTrees, "GITHUB_PERMISSION");
  const pack = internals.contextTreePackage === undefined ? resolveContextTreePackage() : internals.contextTreePackage;
  if (!pack) return failedPreparation(input.contextTrees, "PACKAGE_MISSING");
  const home = join(workspace, CLOUD_CONTEXT_TREE_SUBDIRECTORY, "home");
  await mkdir(home, { recursive: true, mode: 0o700 });
  const run = syncRunner(input, internals, pack, workspace, home, project);
  const refreshed = await run(false);
  const needsRecovery = input.contextTrees.some((source) => !syncedTree(refreshed.payload, source)?.ok);
  const cached = needsRecovery && !input.signal?.aborted ? await run(true) : undefined;
  const connections = await Promise.all(
    input.contextTrees.map((source) => resolveResult(source, refreshed, cached, project, home)),
  );
  const status: CloudContextTreeStatus = { status: "configured", connections };
  if (!connections.some((entry) => entry.status === "ready" || entry.status === "stale")) return { status };
  const binDirectory = await writeContextTreeShim({
    home,
    cliPath: pack.cliPath,
    nodePath: internals.nodePath ?? process.execPath,
    scratch: input.scratch,
    agentSlug: input.agentSlug ?? "opentag-cloud-agent",
  });
  return { status, binDirectory };
}
function syncRunner(
  input: CloudContextTreePreparationInput,
  internals: CloudContextTreeInternals,
  pack: ContextTreePackage,
  workspace: string,
  home: string,
  project: string,
) {
  return (offline: boolean) =>
    runContextTreeCli(pack, ["sync", "--project-path", project, ...(offline ? ["--offline"] : [])], {
      cwd: workspace,
      network: !offline,
      env: { ...input.environment, HOME: home, LANG: "C.UTF-8", PATH: input.path },
      ...(internals.execFile ? { execFile: internals.execFile } : {}),
      ...(internals.nodePath ? { nodePath: internals.nodePath } : {}),
      signal: AbortSignal.any([
        ...(input.signal ? [input.signal] : []),
        AbortSignal.timeout(
          offline
            ? (internals.recoveryBudgetMs ?? RECOVERY_BUDGET_MS)
            : (internals.preparationBudgetMs ?? CLOUD_CONTEXT_TREE_PREPARATION_BUDGET_MS - RECOVERY_BUDGET_MS),
        ),
      ]),
    });
}
type CliResult = Awaited<ReturnType<typeof runContextTreeCli>>;
async function resolveResult(
  source: ContextTreeConnection,
  refreshed: CliResult,
  cached: CliResult | undefined,
  project: string,
  home: string,
): Promise<CloudContextTreeResult> {
  const fresh = syncedTree(refreshed.payload, source);
  const fallback = cached && syncedTree(cached.payload, source);
  const entry = fresh?.ok ? fresh : fallback?.ok ? fallback : undefined;
  const reason = fresh && !fresh.ok ? fresh.error.code : (refreshed.failureCode ?? "SYNC_FAILED");
  if (!entry || ["DIRTY_TREE", "INVALID_TREE"].includes(reason)) {
    return { ...source, status: "unavailable", reason };
  }
  const treePath = await realpath(entry.treeRoot);
  if (entry.connection.projectRoot !== project || !isWithin(home, treePath)) {
    return { ...source, status: "unavailable", reason: "TREE_OUTSIDE_WORKSPACE" };
  }
  return fresh?.ok
    ? { ...source, status: "ready", treePath, projectPath: project, branch: source.ref, sha: entry.repository?.sha }
    : { ...source, status: "stale", treePath, projectPath: project, reason };
}

function failedPreparation(sources: readonly ContextTreeConnection[], reason: string): CloudContextTreePreparation {
  return {
    status: sources.length
      ? { status: "configured", connections: sources.map((source) => ({ ...source, status: "unavailable", reason })) }
      : { status: "unavailable", reason },
  };
}

async function writeContextTreeShim(input: {
  agentSlug: string;
  cliPath: string;
  home: string;
  nodePath: string;
  scratch: string;
}): Promise<string> {
  const bin = join(input.scratch, "context-tree-bin");
  await mkdir(bin, { mode: 0o700, recursive: true });
  const quote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`;
  const shim = join(bin, "context-tree");
  await writeFile(join(bin, "context-tree-client.mjs"), CONTEXT_TREE_COMMAND_CLIENT_SOURCE, { mode: 0o600 });
  await writeFile(
    shim,
    `${[
      "#!/bin/sh",
      "# Generated by OpenTag for this Cloud Turn; edits are overwritten.",
      `HOME=${quote(input.home)}`,
      `GIT_AUTHOR_NAME=${quote(input.agentSlug)}`,
      `GIT_AUTHOR_EMAIL=${quote(`${input.agentSlug}@localhost`)}`,
      `GIT_COMMITTER_NAME=${quote(input.agentSlug)}`,
      `GIT_COMMITTER_EMAIL=${quote(`${input.agentSlug}@localhost`)}`,
      "export HOME GIT_AUTHOR_NAME GIT_AUTHOR_EMAIL GIT_COMMITTER_NAME GIT_COMMITTER_EMAIL",
      `exec ${quote(input.nodePath)} ${quote(join(bin, "context-tree-client.mjs"))} ${quote(input.cliPath)} "$@"`,
    ].join("\n")}\n`,
    { mode: 0o700 },
  );
  await chmod(shim, 0o700);
  return bin;
}

function isWithin(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate));
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
