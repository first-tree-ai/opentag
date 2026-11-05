import { chmod, mkdir, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ContextTreeConnection } from "@opentag/shared";
import {
  type ContextTreePackage,
  hasManagedGitHubTransport,
  resolveContextTreePackage,
} from "../runtime/context-tree.js";
import { CONTEXT_TREE_COMMAND_CLIENT_SOURCE } from "../runtime/context-tree-commands.js";
import {
  type ContextTreeStatus as CloudContextTreeStatus,
  configureContextTrees,
  preparedConnections,
} from "../runtime/context-tree-connections.js";

export const CLOUD_CONTEXT_TREE_SUBDIRECTORY = ".opentag/context-tree";
/** Upper bound on local preparation; preparation never contacts a tree remote. */
export const CLOUD_CONTEXT_TREE_PREPARATION_BUDGET_MS = 30_000;

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
  readonly nodePath?: string;
}

/**
 * Persist the selection and write the `context-tree` shim. Preparation never syncs: the Agent
 * syncs through the command gateway at task boundaries, so the managed prompt carries no
 * per-revision snapshot path or commit.
 */
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
  input.signal?.throwIfAborted();
  const binDirectory = await writeContextTreeShim({
    home,
    cliPath: pack.cliPath,
    nodePath: internals.nodePath ?? process.execPath,
    scratch: input.scratch,
    agentSlug: input.agentSlug ?? "opentag-cloud-agent",
  });
  return { status: preparedConnections(input.contextTrees, project), binDirectory };
}

/**
 * The Agent reads Context only through the packaged `context-tree-read` Skill and syncs only
 * through the command gateway, so a source without either is reported unavailable rather than
 * advertised with a read rule the Agent cannot follow.
 */
export function withContextTreeReadPath(
  status: CloudContextTreeStatus,
  readPath: { readonly skills: boolean; readonly gateway: boolean },
): CloudContextTreeStatus {
  const reason = !readPath.gateway ? "GATEWAY_UNAVAILABLE" : !readPath.skills ? "SKILLS_UNAVAILABLE" : undefined;
  if (!reason || status.status !== "configured") return status;
  return {
    status: "configured",
    connections: status.connections.map((connection) =>
      connection.status === "available" ? { ...sourceOf(connection), status: "unavailable", reason } : connection,
    ),
  };
}

function sourceOf(connection: ContextTreeConnection & { readonly projectPath?: string }): ContextTreeConnection {
  const { projectPath: _projectPath, ...source } = connection;
  return source;
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
