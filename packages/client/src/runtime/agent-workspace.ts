import { createHash } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { copyFile, cp, link, lstat, open, readdir, readlink, realpath, rename, symlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import {
  type EffectiveRuntimeSnapshot,
  RuntimeSha256Schema,
  type RuntimeSnapshotHashes,
  type SessionReconcileRequest,
} from "@opentag/shared";
import { isAgentRuntimeProviderId } from "../agent-runtime/provider-id.js";
import {
  assertRealDirectory,
  assertWithin,
  ensurePrivateDirectory,
  RuntimeStorageError,
  readDurableJson,
  readSecureFile,
  removeDurableFile,
  syncDurableDirectory,
  writeDurableJson,
} from "../storage/durable-file.js";
import { agentRuntimePaths } from "./runtime-paths.js";
import type { SessionBindingStore, SessionPreparationResult } from "./session-binding-store.js";
import type { RuntimePreparation } from "./session-reconciler.js";

interface AgentWorkspaceIdentity {
  agentId: string;
  workspaceId: string;
  provider: string;
}

interface LegacyAgentWorkspaceState extends AgentWorkspaceIdentity {
  schemaVersion: 1 | 2;
  appliedAgentRevisionSequence: number;
  appliedAgentRevisionId: string;
  agentConfigHash: string;
  managedInstructionsHash: string;
}

interface PendingAgentWorkspaceState extends AgentWorkspaceIdentity {
  schemaVersion: 3;
  layout: "legacy-files";
  transition: "pending";
  managedFiles: {
    root?: string;
    files?: string;
  };
}

export interface LocalAgentWorkspaceState extends AgentWorkspaceIdentity {
  schemaVersion: 3;
  layout: "root" | "legacy-files";
  transition: "complete";
}

type ParsedAgentWorkspaceState = LegacyAgentWorkspaceState | PendingAgentWorkspaceState | LocalAgentWorkspaceState;

const LEGACY_MANAGED_PLATFORM_PREFIX = [
  "# OpenTag managed instructions",
  "",
  "This file is managed by OpenTag. Session-specific instructions are injected per turn.",
  "",
  "## Platform",
  "",
].join("\n");
const LEGACY_MANAGED_AGENT_SEPARATOR = "\n\n## Agent\n\n";
// This exact platform transition shipped between staging.67.1 and staging.92.1, the two Issue #101 endpoints.
const KNOWN_LEGACY_PARTIAL_MIGRATIONS = [
  {
    sourcePlatform:
      "You run inside OpenTag. IM output is never sent automatically. Use an opentag_message_* tool only when you intend to write to the current IM conversation.",
    targetPlatform: "You run inside OpenTag. IM output is never sent automatically.",
  },
] as const;

export interface AgentWorkspaceManagerOptions {
  bindingStore: SessionBindingStore;
  home: string;
}

export class AgentWorkspaceManager implements RuntimePreparation {
  readonly #bindingStore: SessionBindingStore;
  readonly #home: string;

  constructor(options: AgentWorkspaceManagerOptions) {
    this.#bindingStore = options.bindingStore;
    this.#home = options.home;
  }

  async prepareAgent(snapshot: EffectiveRuntimeSnapshot, _hashes: RuntimeSnapshotHashes): Promise<void> {
    const paths = agentRuntimePaths(this.#home, snapshot.agentId);
    await ensurePrivateDirectory(this.#home, paths.workspaceStatesRoot);
    const state = await readDurableJson(paths.workspaceState, parseAgentWorkspaceState);
    const workspaceExists = await realDirectoryExists(paths.workspaceRoot);
    if (!state && workspaceExists && (await readdir(paths.workspaceRoot)).length > 0) {
      throw new RuntimeStorageError("conflict", "A non-empty Agent workspace has no valid layout state");
    }
    await ensurePrivateDirectory(this.#home, paths.workspaceRoot);

    if (!state) {
      await writeDurableJson(paths.workspaceState, completeState(snapshot, "root"));
      return;
    }
    validateWorkspaceIdentity(state, snapshot);
    if ("managedInstructionsHash" in state) {
      await beginLegacyTransition(state, snapshot, paths);
      return;
    }
    if (state.transition === "pending") {
      await finishLegacyTransition(state, snapshot, paths);
      return;
    }
  }

  async prepareSession(
    request: SessionReconcileRequest,
    hashes: RuntimeSnapshotHashes,
  ): Promise<SessionPreparationResult> {
    return this.#bindingStore.prepare(request, hashes);
  }

  verifyAgent(snapshot: EffectiveRuntimeSnapshot, hashes: RuntimeSnapshotHashes): Promise<void> {
    return this.prepareAgent(snapshot, hashes);
  }

  async stopSession(_sessionId: string, _placementGeneration: number): Promise<void> {}

  async cwd(agentId: string): Promise<string> {
    const paths = agentRuntimePaths(this.#home, agentId);
    const state = await readDurableJson(paths.workspaceState, parseAgentWorkspaceState);
    if (state?.schemaVersion !== 3 || state.transition !== "complete") {
      throw new RuntimeStorageError("invalid", "Agent workspace compatibility transition is incomplete");
    }
    const cwd = state.layout === "legacy-files" ? paths.files : paths.workspaceRoot;
    await assertRealDirectory(cwd);
    const canonicalHome = await realpath(this.#home);
    const canonicalCwd = await realpath(cwd);
    assertWithin(canonicalHome, canonicalCwd);
    return canonicalCwd;
  }

  paths(agentId: string) {
    return agentRuntimePaths(this.#home, agentId);
  }
}

async function beginLegacyTransition(
  state: LegacyAgentWorkspaceState,
  snapshot: EffectiveRuntimeSnapshot,
  paths: ReturnType<typeof agentRuntimePaths>,
): Promise<void> {
  await ensurePrivateDirectory(paths.workspaceRoot, paths.files);
  await ensurePrivateDirectory(paths.runtimeRoot, paths.workspaceTransitionRoot);
  const root = await readSecureFile(paths.legacyAgentsFile);
  const files = await readSecureFile(paths.agentsFile);
  const rootHash = root === undefined ? undefined : sha256(root);
  const managedRootHash = state.schemaVersion === 1 ? state.managedInstructionsHash : undefined;
  if (rootHash !== undefined && rootHash !== managedRootHash) {
    throw new RuntimeStorageError("conflict", "The legacy root AGENTS.md is not proven OpenTag-managed");
  }
  const filesHash = files === undefined ? undefined : sha256(files);
  const managedFilesHash =
    state.schemaVersion === 2
      ? state.managedInstructionsHash
      : root !== undefined &&
          files !== undefined &&
          (await isKnownLegacyPartialMigration(paths.agentsFile, root, files))
        ? filesHash
        : undefined;
  if (filesHash !== undefined && filesHash !== managedFilesHash) {
    throw new RuntimeStorageError("conflict", "The files/AGENTS.md is not proven OpenTag-managed");
  }
  const pending: PendingAgentWorkspaceState = {
    schemaVersion: 3,
    agentId: state.agentId,
    workspaceId: state.workspaceId,
    provider: state.provider,
    layout: "legacy-files",
    transition: "pending",
    managedFiles: {
      ...(managedRootHash && rootHash ? { root: rootHash } : {}),
      ...(managedFilesHash ? { files: managedFilesHash } : {}),
    },
  };
  await writeDurableJson(paths.workspaceState, pending);
  await finishLegacyTransition(pending, snapshot, paths);
}

async function finishLegacyTransition(
  state: PendingAgentWorkspaceState,
  snapshot: EffectiveRuntimeSnapshot,
  paths: ReturnType<typeof agentRuntimePaths>,
): Promise<void> {
  await ensurePrivateDirectory(paths.workspaceRoot, paths.files);
  await ensurePrivateDirectory(paths.runtimeRoot, paths.workspaceTransitionRoot);
  await removeProvenManagedFile(paths.legacyAgentsFile, paths.workspaceTransitionRoot, "root", state.managedFiles.root);
  await removeProvenManagedFile(paths.agentsFile, paths.workspaceTransitionRoot, "files", state.managedFiles.files);
  await writeDurableJson(paths.workspaceState, completeState(snapshot, "legacy-files"));
}

async function removeProvenManagedFile(
  path: string,
  quarantineRoot: string,
  kind: "root" | "files",
  expectedHash: string | undefined,
): Promise<void> {
  if (!expectedHash) return;
  const quarantine = resolve(quarantineRoot, `${kind}-${expectedHash}.managed`);
  assertWithin(quarantineRoot, quarantine);
  let stranded: string | undefined;
  let strandedIsReadOnly = false;
  try {
    stranded = await readSecureFile(quarantine);
    if (stranded !== undefined) strandedIsReadOnly = isReadOnlyRegularFile(await lstat(quarantine));
  } catch {
    await restoreQuarantinedEntry(quarantine, path);
    throw new RuntimeStorageError("conflict", "A non-file Workspace entry was isolated during cleanup");
  }
  if (stranded !== undefined) {
    if (sha256(stranded) !== expectedHash || !strandedIsReadOnly) {
      await restoreQuarantinedEntry(quarantine, path);
      throw new RuntimeStorageError("conflict", "A Workspace file changed while OpenTag isolated it for cleanup");
    }
    await removeDurableFile(quarantine);
    return;
  }
  const content = await readSecureFile(path);
  if (content === undefined) return;
  if (sha256(content) !== expectedHash) {
    throw new RuntimeStorageError("conflict", "A proven OpenTag-managed instruction file changed during transition");
  }
  const originalIdentity = await lstat(path);
  if (!isReadOnlyRegularFile(originalIdentity)) {
    throw new RuntimeStorageError("conflict", "A proven OpenTag-managed instruction file is no longer read-only");
  }
  await assertRealDirectory(dirname(path));
  await assertRealDirectory(quarantineRoot);
  try {
    await rename(path, quarantine);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  await syncDurableDirectory(dirname(path));
  await syncDurableDirectory(quarantineRoot);
  let isolated: string | undefined;
  try {
    const isolatedIdentity = await lstat(quarantine);
    if (
      !isolatedIdentity.isFile() ||
      isolatedIdentity.isSymbolicLink() ||
      isolatedIdentity.dev !== originalIdentity.dev ||
      isolatedIdentity.ino !== originalIdentity.ino ||
      !isReadOnlyRegularFile(isolatedIdentity)
    ) {
      await restoreQuarantinedEntry(quarantine, path);
      throw new RuntimeStorageError("conflict", "A Workspace entry was replaced during cleanup");
    }
    isolated = await readSecureFile(quarantine);
  } catch (error) {
    if (error instanceof RuntimeStorageError && error.code === "conflict") throw error;
    await restoreQuarantinedEntry(quarantine, path);
    throw new RuntimeStorageError("conflict", "A Workspace entry changed while cleanup verified it");
  }
  if (isolated === undefined || sha256(isolated) !== expectedHash) {
    await restoreQuarantinedEntry(quarantine, path);
    throw new RuntimeStorageError("conflict", "A proven OpenTag-managed instruction file changed during cleanup");
  }
  await removeDurableFile(quarantine);
}

function isReadOnlyRegularFile(identity: Stats): boolean {
  // Every historical OpenTag-managed instruction file was durably published as mode 0444.
  return identity.isFile() && !identity.isSymbolicLink() && (identity.mode & 0o222) === 0;
}

async function restoreQuarantinedEntry(quarantine: string, path: string): Promise<void> {
  let status: Awaited<ReturnType<typeof lstat>>;
  try {
    status = await lstat(quarantine);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  try {
    await lstat(path);
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    if (status.isFile() && !status.isSymbolicLink()) {
      await copyFile(quarantine, path, constants.COPYFILE_EXCL);
      await syncRestoredRegularFile(path);
    } else if (status.isSymbolicLink()) await symlink(await readlink(quarantine), path);
    else if (status.isDirectory()) {
      await cp(quarantine, path, { recursive: true, force: false, errorOnExist: true, preserveTimestamps: true });
    } else await link(quarantine, path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return;
    throw error;
  }
  await syncDurableDirectory(dirname(path));
}

async function syncRestoredRegularFile(path: string): Promise<void> {
  const restored = await lstat(path);
  if (!restored.isFile() || restored.isSymbolicLink()) return;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== restored.dev || opened.ino !== restored.ino) return;
    await handle.sync();
  } finally {
    await handle?.close();
  }
}

async function isKnownLegacyPartialMigration(
  path: string,
  provenRootContent: string,
  content: string,
): Promise<boolean> {
  const expected = knownLegacyPartialMigrationContent(provenRootContent);
  if (expected === undefined || content !== expected) return false;
  return ((await lstat(path)).mode & 0o222) === 0;
}

function knownLegacyPartialMigrationContent(provenRootContent: string): string | undefined {
  for (const migration of KNOWN_LEGACY_PARTIAL_MIGRATIONS) {
    const sourcePrefix = `${LEGACY_MANAGED_PLATFORM_PREFIX}\n${migration.sourcePlatform}${LEGACY_MANAGED_AGENT_SEPARATOR}`;
    if (!provenRootContent.startsWith(sourcePrefix)) continue;
    const agentSuffix = provenRootContent.slice(sourcePrefix.length);
    if (!agentSuffix.endsWith("\n")) return undefined;
    return `${LEGACY_MANAGED_PLATFORM_PREFIX}\n${migration.targetPlatform}${LEGACY_MANAGED_AGENT_SEPARATOR}${agentSuffix}`;
  }
  return undefined;
}

function completeState(
  snapshot: EffectiveRuntimeSnapshot,
  layout: LocalAgentWorkspaceState["layout"],
): LocalAgentWorkspaceState {
  return {
    schemaVersion: 3,
    agentId: snapshot.agentId,
    workspaceId: snapshot.workspace.workspaceId,
    provider: snapshot.provider,
    layout,
    transition: "complete",
  };
}

function parseAgentWorkspaceState(value: unknown): ParsedAgentWorkspaceState {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new RuntimeStorageError("invalid", "Agent workspace state fields are invalid");
  }
  const state = value as Record<string, unknown>;
  if (state.schemaVersion === 1 || state.schemaVersion === 2) return parseLegacyState(state);
  if (state.schemaVersion !== 3) throw new RuntimeStorageError("invalid", "Agent workspace state version is invalid");
  assertExactFields(
    state,
    state.transition === "pending"
      ? ["agentId", "layout", "managedFiles", "provider", "schemaVersion", "transition", "workspaceId"]
      : ["agentId", "layout", "provider", "schemaVersion", "transition", "workspaceId"],
  );
  validateIdentityFields(state);
  if (state.layout !== "root" && state.layout !== "legacy-files") {
    throw new RuntimeStorageError("invalid", "Agent workspace layout is invalid");
  }
  if (state.transition === "complete") return state as unknown as LocalAgentWorkspaceState;
  if (state.transition !== "pending" || state.layout !== "legacy-files") {
    throw new RuntimeStorageError("invalid", "Agent workspace transition is invalid");
  }
  const managedFiles = state.managedFiles;
  if (
    typeof managedFiles !== "object" ||
    managedFiles === null ||
    Array.isArray(managedFiles) ||
    Object.keys(managedFiles).some((key) => key !== "root" && key !== "files")
  ) {
    throw new RuntimeStorageError("invalid", "Agent workspace transition provenance is invalid");
  }
  for (const hash of Object.values(managedFiles)) {
    if (!RuntimeSha256Schema.safeParse(hash).success) {
      throw new RuntimeStorageError("invalid", "Agent workspace transition hash is invalid");
    }
  }
  return state as unknown as PendingAgentWorkspaceState;
}

function parseLegacyState(state: Record<string, unknown>): LegacyAgentWorkspaceState {
  assertExactFields(state, [
    "agentConfigHash",
    "agentId",
    "appliedAgentRevisionId",
    "appliedAgentRevisionSequence",
    "managedInstructionsHash",
    "provider",
    "schemaVersion",
    "workspaceId",
  ]);
  validateIdentityFields(state);
  if (
    typeof state.appliedAgentRevisionSequence !== "number" ||
    !Number.isSafeInteger(state.appliedAgentRevisionSequence) ||
    state.appliedAgentRevisionSequence < 0 ||
    typeof state.appliedAgentRevisionId !== "string" ||
    !RuntimeSha256Schema.safeParse(state.agentConfigHash).success ||
    !RuntimeSha256Schema.safeParse(state.managedInstructionsHash).success
  ) {
    throw new RuntimeStorageError("invalid", "Agent workspace state values are invalid");
  }
  return state as unknown as LegacyAgentWorkspaceState;
}

function validateIdentityFields(state: Record<string, unknown>): void {
  if (
    typeof state.agentId !== "string" ||
    typeof state.workspaceId !== "string" ||
    typeof state.provider !== "string" ||
    !isAgentRuntimeProviderId(state.provider)
  ) {
    throw new RuntimeStorageError("invalid", "Agent workspace identity values are invalid");
  }
}

function assertExactFields(state: Record<string, unknown>, fields: readonly string[]): void {
  if (Object.keys(state).sort().join(",") !== [...fields].sort().join(",")) {
    throw new RuntimeStorageError("invalid", "Agent workspace state fields are invalid");
  }
}

function validateWorkspaceIdentity(state: AgentWorkspaceIdentity, snapshot: EffectiveRuntimeSnapshot): void {
  if (
    state.agentId !== snapshot.agentId ||
    state.workspaceId !== snapshot.workspace.workspaceId ||
    state.provider !== snapshot.provider
  ) {
    throw new RuntimeStorageError("conflict", "Agent workspace identity cannot be changed");
  }
}

async function realDirectoryExists(path: string): Promise<boolean> {
  try {
    const status = await lstat(path);
    if (!status.isDirectory() || status.isSymbolicLink()) {
      throw new RuntimeStorageError("unsafe", "Agent workspace must be a real directory");
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
