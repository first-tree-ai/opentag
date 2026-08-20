import { createHash } from "node:crypto";
import { chmod, lstat, readdir, realpath } from "node:fs/promises";
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
  writeDurableFile,
  writeDurableJson,
} from "../storage/durable-file.js";
import { agentRuntimePaths } from "./runtime-paths.js";
import type { SessionBindingStore, SessionPreparationResult } from "./session-binding-store.js";
import type { RuntimePreparation } from "./session-reconciler.js";

interface AgentWorkspaceStateFields {
  agentId: string;
  workspaceId: string;
  provider: string;
  appliedAgentRevisionSequence: number;
  appliedAgentRevisionId: string;
  agentConfigHash: string;
  managedInstructionsHash: string;
}

interface LegacyAgentWorkspaceState extends AgentWorkspaceStateFields {
  schemaVersion: 1;
}

export interface LocalAgentWorkspaceState extends AgentWorkspaceStateFields {
  schemaVersion: 2;
}

type ParsedAgentWorkspaceState = LegacyAgentWorkspaceState | LocalAgentWorkspaceState;

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

  async prepareAgent(snapshot: EffectiveRuntimeSnapshot, hashes: RuntimeSnapshotHashes): Promise<void> {
    const paths = agentRuntimePaths(this.#home, snapshot.agentId);
    await ensurePrivateDirectory(this.#home, paths.workspaceStatesRoot);
    const state = await readDurableJson(paths.workspaceState, parseAgentWorkspaceState);
    const workspaceExists = await realDirectoryExists(paths.workspaceRoot);
    if (!state && workspaceExists && (await readdir(paths.workspaceRoot)).length > 0) {
      throw new RuntimeStorageError("conflict", "A non-empty Agent workspace has no valid runtime state");
    }
    const content = renderManagedInstructions(snapshot);
    const managedInstructionsHash = sha256(content);
    const next: LocalAgentWorkspaceState = {
      schemaVersion: 2,
      agentId: snapshot.agentId,
      workspaceId: snapshot.workspace.workspaceId,
      provider: snapshot.provider,
      appliedAgentRevisionSequence: snapshot.revision.agent.sequence,
      appliedAgentRevisionId: snapshot.revision.agent.id,
      agentConfigHash: hashes.agentConfigHash,
      managedInstructionsHash,
    };
    if (!state) await writeDurableJson(paths.workspaceState, next);
    await ensurePrivateDirectory(this.#home, paths.workspaceRoot);
    await ensurePrivateDirectory(this.#home, paths.files);

    const current = state ?? next;
    validateWorkspaceIdentity(current, snapshot);
    validateWorkspaceRevision(current, snapshot, hashes);
    if (current.schemaVersion === 1) {
      await migrateLegacyWorkspace(current, next, paths, content);
      return;
    }
    await prepareCurrentWorkspace(current, next, paths, content, managedInstructionsHash);
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
    await assertRealDirectory(paths.files);
    const canonicalHome = await realpath(this.#home);
    const canonicalFiles = await realpath(paths.files);
    assertWithin(canonicalHome, canonicalFiles);
    return canonicalFiles;
  }

  paths(agentId: string) {
    return agentRuntimePaths(this.#home, agentId);
  }
}

export function renderManagedInstructions(snapshot: EffectiveRuntimeSnapshot): string {
  return [
    "# OpenTag managed instructions",
    "",
    "This file is managed by OpenTag. Session-specific instructions are injected per turn.",
    "",
    "## Platform",
    "",
    snapshot.instructions.platform,
    "",
    "## Agent",
    "",
    snapshot.instructions.agent,
    "",
  ].join("\n");
}

function parseAgentWorkspaceState(value: unknown): ParsedAgentWorkspaceState {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).sort().join(",") !==
      [
        "agentConfigHash",
        "agentId",
        "appliedAgentRevisionId",
        "appliedAgentRevisionSequence",
        "managedInstructionsHash",
        "provider",
        "schemaVersion",
        "workspaceId",
      ]
        .sort()
        .join(",")
  ) {
    throw new RuntimeStorageError("invalid", "Agent workspace state fields are invalid");
  }
  const state = value as Record<string, unknown>;
  if (
    (state.schemaVersion !== 1 && state.schemaVersion !== 2) ||
    typeof state.agentId !== "string" ||
    typeof state.workspaceId !== "string" ||
    !isAgentRuntimeProviderId(state.provider) ||
    typeof state.appliedAgentRevisionSequence !== "number" ||
    !Number.isSafeInteger(state.appliedAgentRevisionSequence) ||
    state.appliedAgentRevisionSequence < 0 ||
    typeof state.appliedAgentRevisionId !== "string" ||
    !RuntimeSha256Schema.safeParse(state.agentConfigHash).success ||
    !RuntimeSha256Schema.safeParse(state.managedInstructionsHash).success
  ) {
    throw new RuntimeStorageError("invalid", "Agent workspace state values are invalid");
  }
  return state as unknown as ParsedAgentWorkspaceState;
}

function validateWorkspaceIdentity(state: ParsedAgentWorkspaceState, snapshot: EffectiveRuntimeSnapshot): void {
  if (
    state.agentId !== snapshot.agentId ||
    state.workspaceId !== snapshot.workspace.workspaceId ||
    state.provider !== snapshot.provider
  ) {
    throw new RuntimeStorageError("conflict", "Agent workspace identity cannot be changed");
  }
}

function validateWorkspaceRevision(
  state: ParsedAgentWorkspaceState,
  snapshot: EffectiveRuntimeSnapshot,
  hashes: RuntimeSnapshotHashes,
): void {
  if (snapshot.revision.agent.sequence < state.appliedAgentRevisionSequence) {
    throw new RuntimeStorageError("conflict", "The Agent runtime revision is stale");
  }
  if (
    snapshot.revision.agent.sequence === state.appliedAgentRevisionSequence &&
    (snapshot.revision.agent.id !== state.appliedAgentRevisionId || hashes.agentConfigHash !== state.agentConfigHash)
  ) {
    throw new RuntimeStorageError("conflict", "The Agent runtime revision conflicts with the workspace");
  }
}

async function migrateLegacyWorkspace(
  state: LegacyAgentWorkspaceState,
  next: LocalAgentWorkspaceState,
  paths: ReturnType<typeof agentRuntimePaths>,
  content: string,
): Promise<void> {
  const legacy = await readSecureFile(paths.legacyAgentsFile);
  if (legacy !== undefined && sha256(legacy) !== state.managedInstructionsHash) {
    throw new RuntimeStorageError("conflict", "The legacy managed AGENTS.md file was modified outside OpenTag");
  }
  const current = await readSecureFile(paths.agentsFile);
  if (current !== undefined && current !== content) {
    throw new RuntimeStorageError("conflict", "OpenTag will not replace a conflicting AGENTS.md file in the Agent cwd");
  }
  if (current === undefined) await writeDurableFile(paths.agentsFile, content, 0o444);
  else await chmod(paths.agentsFile, 0o444);
  if (legacy !== undefined) await removeDurableFile(paths.legacyAgentsFile);
  await writeDurableJson(paths.workspaceState, next);
}

async function prepareCurrentWorkspace(
  state: LocalAgentWorkspaceState,
  next: LocalAgentWorkspaceState,
  paths: ReturnType<typeof agentRuntimePaths>,
  content: string,
  managedInstructionsHash: string,
): Promise<void> {
  if ((await readSecureFile(paths.legacyAgentsFile)) !== undefined) {
    throw new RuntimeStorageError("conflict", "A legacy AGENTS.md file conflicts with the current Agent workspace");
  }
  const existing = await readSecureFile(paths.agentsFile);
  const sameRevision = next.appliedAgentRevisionSequence === state.appliedAgentRevisionSequence;
  if (existing === undefined) {
    if (!sameRevision || state.managedInstructionsHash !== managedInstructionsHash) {
      throw new RuntimeStorageError("conflict", "The managed AGENTS.md file was removed outside OpenTag");
    }
    await writeDurableFile(paths.agentsFile, content, 0o444);
    return;
  }
  if (sha256(existing) !== state.managedInstructionsHash) {
    throw new RuntimeStorageError("conflict", "The managed AGENTS.md file was modified outside OpenTag");
  }
  if (sameRevision) {
    if (existing !== content) {
      throw new RuntimeStorageError(
        "conflict",
        "The managed AGENTS.md file conflicts with the current runtime snapshot",
      );
    }
    await chmod(paths.agentsFile, 0o444);
    return;
  }
  await writeDurableFile(paths.agentsFile, content, 0o444);
  await writeDurableJson(paths.workspaceState, next);
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
