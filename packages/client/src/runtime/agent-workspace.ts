import { createHash } from "node:crypto";
import { chmod, lstat, readdir, realpath } from "node:fs/promises";
import {
  type EffectiveRuntimeSnapshot,
  RuntimeSha256Schema,
  type RuntimeSnapshotHashes,
  type SessionReconcileRequest,
} from "@opentag/shared";
import {
  assertRealDirectory,
  assertWithin,
  ensurePrivateDirectory,
  RuntimeStorageError,
  readDurableJson,
  readSecureFile,
  writeDurableFile,
  writeDurableJson,
} from "../storage/durable-file.js";
import { agentRuntimePaths } from "./runtime-paths.js";
import type { SessionBindingStore, SessionPreparationResult } from "./session-binding-store.js";
import type { RuntimePreparation } from "./session-reconciler.js";

export interface LocalAgentWorkspaceState {
  schemaVersion: 1;
  agentId: string;
  workspaceId: string;
  provider: "codex";
  appliedAgentRevisionSequence: number;
  appliedAgentRevisionId: string;
  agentConfigHash: string;
  managedInstructionsHash: string;
}

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
    await ensurePrivateDirectory(this.#home, paths.agentControl);
    const state = await readDurableJson(paths.workspaceState, parseAgentWorkspaceState);
    const workspaceExists = await realDirectoryExists(paths.workspaceRoot);
    if (!state && workspaceExists && (await readdir(paths.workspaceRoot)).length > 0) {
      throw new RuntimeStorageError("conflict", "A non-empty Agent workspace has no valid runtime state");
    }
    const content = renderManagedInstructions(snapshot);
    const managedInstructionsHash = sha256(content);
    const next: LocalAgentWorkspaceState = {
      schemaVersion: 1,
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
    await ensurePrivateDirectory(this.#home, paths.sessions);
    await ensurePrivateDirectory(this.#home, paths.snapshots);

    if (state) {
      validateWorkspaceIdentity(state, snapshot);
      if (snapshot.revision.agent.sequence < state.appliedAgentRevisionSequence) {
        throw new RuntimeStorageError("conflict", "The Agent runtime revision is stale");
      }
      if (
        snapshot.revision.agent.sequence === state.appliedAgentRevisionSequence &&
        (snapshot.revision.agent.id !== state.appliedAgentRevisionId ||
          hashes.agentConfigHash !== state.agentConfigHash)
      ) {
        throw new RuntimeStorageError("conflict", "The Agent runtime revision conflicts with the workspace");
      }
      if (snapshot.revision.agent.sequence === state.appliedAgentRevisionSequence) {
        const existing = await readSecureFile(paths.agentsFile);
        if (existing === undefined && state.managedInstructionsHash === managedInstructionsHash) {
          await writeDurableFile(paths.agentsFile, content, 0o444);
          return;
        }
        if (existing === undefined || sha256(existing) !== state.managedInstructionsHash || existing !== content) {
          throw new RuntimeStorageError("conflict", "The managed AGENTS.md file was modified outside OpenTag");
        }
        await chmod(paths.agentsFile, 0o444);
        return;
      }
    } else if ((await readSecureFile(paths.agentsFile)) !== undefined) {
      throw new RuntimeStorageError("conflict", "OpenTag will not replace an unmanaged AGENTS.md file");
    }

    await writeDurableFile(paths.agentsFile, content, 0o444);
    if (state) await writeDurableJson(paths.workspaceState, next);
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

function parseAgentWorkspaceState(value: unknown): LocalAgentWorkspaceState {
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
    state.schemaVersion !== 1 ||
    typeof state.agentId !== "string" ||
    typeof state.workspaceId !== "string" ||
    state.provider !== "codex" ||
    typeof state.appliedAgentRevisionSequence !== "number" ||
    !Number.isSafeInteger(state.appliedAgentRevisionSequence) ||
    state.appliedAgentRevisionSequence < 0 ||
    typeof state.appliedAgentRevisionId !== "string" ||
    !RuntimeSha256Schema.safeParse(state.agentConfigHash).success ||
    !RuntimeSha256Schema.safeParse(state.managedInstructionsHash).success
  ) {
    throw new RuntimeStorageError("invalid", "Agent workspace state values are invalid");
  }
  return state as unknown as LocalAgentWorkspaceState;
}

function validateWorkspaceIdentity(state: LocalAgentWorkspaceState, snapshot: EffectiveRuntimeSnapshot): void {
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
