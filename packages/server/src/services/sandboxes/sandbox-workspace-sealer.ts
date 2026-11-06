import type { sandboxes } from "../../db/schema/index.js";
import { getCurrentPerformanceLogger, type PerformanceLogger } from "../../observability/performance-logger.js";
import type { CloudRunAdmin } from "../cloud-run/index.js";
import { WorkspaceSaveError } from "./errors.js";
import type { RunnerHub } from "./runner-hub.js";
import { WORKSPACE_SAVE_FAILED, WORKSPACE_SAVE_REQUIRED } from "./sandbox-runner-state.js";
import type { WorkspaceObjectScope, WorkspaceObjectStore } from "./workspace-object-store.js";

export interface SandboxWorkspace {
  store: WorkspaceObjectStore;
  sealTimeoutMs: number;
}

export interface SandboxWorkspaceSealerOptions {
  cloud: CloudRunAdmin;
  hub: RunnerHub;
  workspace: SandboxWorkspace | undefined;
  now: () => Date;
  performanceLogger: PerformanceLogger | undefined;
  emitLifecycleLog: (operation: string, fields: Record<string, unknown>) => void;
}

export class SandboxWorkspaceSealer {
  readonly #cloud: CloudRunAdmin;
  readonly #hub: RunnerHub;
  readonly #workspace: SandboxWorkspace | undefined;
  readonly #now: () => Date;
  readonly #perfLogger: PerformanceLogger | undefined;
  readonly #emitLifecycleLog: SandboxWorkspaceSealerOptions["emitLifecycleLog"];

  constructor(options: SandboxWorkspaceSealerOptions) {
    this.#cloud = options.cloud;
    this.#hub = options.hub;
    this.#workspace = options.workspace;
    this.#now = options.now;
    this.#perfLogger = options.performanceLogger;
    this.#emitLifecycleLog = options.emitLifecycleLog;
  }

  /**
   * The seal half of E5 release, shared by explicit stop and automatic idle reclamation: a save
   * is owed exactly when the durable marker says so, and the proven archive short-circuits the
   * Runner round-trip so a crash/retry never re-extracts or re-seals. A provider-absent or
   * different-UID resource has no local copy to protect and is skipped; the caller still decides
   * whether physical cleanup is complete.
   */
  async sealWorkspaceIfOwed(row: typeof sandboxes.$inferSelect): Promise<void> {
    if (!this.#workspace) return;
    const resourceName = row.currentResourceName;
    const resourceUid = row.currentResourceUid;
    const saveOwed = row.lastErrorCode === WORKSPACE_SAVE_REQUIRED || row.lastErrorCode === WORKSPACE_SAVE_FAILED;
    if (resourceName === null || resourceUid === null || !saveOwed) return;
    const view = await this.#cloud.getInstance(resourceName);
    if (view?.uid === resourceUid && view.workspacePersistence === false && row.idleReclaimAt !== null) {
      // An older Instance may contain the only local copy even after Server persistence is
      // enabled. Automatic cleanup cannot inherit explicit stop's legacy discard behavior.
      throw new WorkspaceSaveError("the existing Instance cannot persist its workspace automatically");
    }
    if (view !== undefined && view.uid === resourceUid && view.workspacePersistence !== false) {
      await this.sealWorkspaceForRelease(row);
    }
  }

  /**
   * Prove the sealed archive for the exact current environment before deletion. The Runner's
   * ack alone is never proof: the object metadata read-back must show a saved, sealed archive
   * owned by this exact environment generation. A stored proof short-circuits the Runner
   * round-trip, so a retry after a dropped ack or a Server crash needs no live Runner.
   */
  async sealWorkspaceForRelease(row: typeof sandboxes.$inferSelect): Promise<void> {
    const workspace = this.#workspace;
    if (!workspace) return;
    const scope: WorkspaceObjectScope = {
      storageUri: row.storageUri,
      sandboxId: row.id,
      sessionId: row.sessionId,
      environmentGeneration: row.environmentGeneration,
    };
    if (await this.workspaceSealProven(scope, row.environmentGeneration)) return;
    const sealStartedAtMs = this.#now().getTime();
    const perfHandle = (this.#perfLogger ?? getCurrentPerformanceLogger())?.startOperation({
      module: "sandboxes",
      category: "service",
      operation: "sandbox.lifecycle.seal",
      sandboxId: row.id,
      sessionId: row.sessionId,
      environmentGeneration: row.environmentGeneration,
    });
    const socket = this.#hub.currentSocket(row.id);
    const snapshot = this.#hub.describe(row.id);
    if (
      !socket ||
      !snapshot.connected ||
      snapshot.scope === null ||
      snapshot.scope.sessionId !== row.sessionId ||
      snapshot.scope.environmentGeneration !== row.environmentGeneration ||
      snapshot.scope.resourceName !== row.currentResourceName
    ) {
      const err = new WorkspaceSaveError("no live Runner holds the current allocation");
      perfHandle?.fail(err);
      throw err;
    }
    let result: Awaited<ReturnType<RunnerHub["requestWorkspaceSeal"]>>;
    try {
      result = await this.#hub.requestWorkspaceSeal(row.id, { timeoutMs: workspace.sealTimeoutMs, socket });
    } catch (error) {
      const err = new WorkspaceSaveError(
        error instanceof Error ? error.message : "the workspace seal could not be requested",
      );
      perfHandle?.fail(err);
      throw err;
    }
    if (!result.ok) {
      const err = new WorkspaceSaveError(
        `the Runner reported a failed workspace save (${result.code ?? "workspace_save_failed"})`,
      );
      perfHandle?.fail(err);
      throw err;
    }
    if (!(await this.workspaceSealProven(scope, row.environmentGeneration))) {
      const err = new WorkspaceSaveError("the saved workspace archive could not be verified");
      perfHandle?.fail(err);
      throw err;
    }
    const sealDurationMs = Math.max(0, this.#now().getTime() - sealStartedAtMs);
    perfHandle?.complete();
    this.#emitLifecycleLog("sandbox.lifecycle.seal", {
      sandboxId: row.id,
      sessionId: row.sessionId,
      environmentGeneration: row.environmentGeneration,
      resourceName: row.currentResourceName,
      durationMs: sealDurationMs,
    });
  }

  /** The only proof bar: saved + sealed + exact current owner generation, from a fresh read. */
  async workspaceSealProven(scope: WorkspaceObjectScope, ownerGeneration: number): Promise<boolean> {
    const workspace = this.#workspace;
    if (!workspace) return false;
    let head: Awaited<ReturnType<WorkspaceObjectStore["head"]>>;
    try {
      head = await workspace.store.head(scope);
    } catch {
      // A store read failure is not proof of anything; the caller keeps the allocation and retries.
      return false;
    }
    return (
      head !== undefined && head.saved === true && head.sealed === true && head.ownerGeneration === ownerGeneration
    );
  }
}
