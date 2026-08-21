import { realpath } from "node:fs/promises";
import type { EffectiveRuntimeSnapshot, RuntimeSnapshotHashes, SessionReconcileRequest } from "@opentag/shared";
import { assertRealDirectory, assertWithin, ensurePrivateDirectory } from "../storage/durable-file.js";
import { agentRuntimePaths } from "./runtime-paths.js";
import type { SessionBindingStore, SessionPreparationResult } from "./session-binding-store.js";
import type { RuntimePreparation } from "./session-reconciler.js";

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
    await ensurePrivateDirectory(this.#home, paths.workspaceRoot);
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
    await assertRealDirectory(paths.workspaceRoot);
    const canonicalHome = await realpath(this.#home);
    const canonicalWorkspace = await realpath(paths.workspaceRoot);
    assertWithin(canonicalHome, canonicalWorkspace);
    return canonicalWorkspace;
  }

  paths(agentId: string) {
    return agentRuntimePaths(this.#home, agentId);
  }
}
