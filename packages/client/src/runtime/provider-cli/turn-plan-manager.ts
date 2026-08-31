import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { link, lstat, readdir, rm } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import {
  ensurePrivateDirectory,
  RuntimeStorageError,
  syncDurableDirectory,
  validatePrivateDirectory,
  writeDurableFile,
} from "../../storage/durable-file.js";
import { type ProviderCliAccountLayout, resolveProviderCliAccountLayout } from "./account-layout.js";
import { computeFileIdentity, computeTargetFingerprint, ProviderCliFileError } from "./fingerprint.js";
import {
  type ProviderCliSelectionRecord,
  providerCliSelectionTargetPath,
  readProviderCliSelection,
} from "./selection-store.js";
import { writeProviderCliTurnLauncher } from "./turn-launcher.js";
import {
  assertIdentity,
  assertPlanWithinRoot,
  deriveProviderCliHomeNamespace,
  deriveProviderCliSessionKey,
  isProviderCliSessionKey,
  managedArtifactDigest,
  type ProviderCliTurnPlan,
  ProviderCliTurnPlanError,
  providerCliCommandForProvider,
  providerCliPlanHomeDir,
  providerCliPlanSessionDir,
  providerCliTurnLauncherPath,
  providerCliTurnPlanPath,
  publishProviderCliTurnPlanExclusive,
  readProviderCliTurnPlan,
} from "./turn-plan.js";
import type { ProviderCliProvider } from "./types.js";

export interface ProviderCliTurnPlanManagerDeps {
  /** OS account home (from the account record), never caller $HOME. */
  readonly accountHome: string;
  /** Canonical OpenTag Home used as the irreversible plans namespace. */
  readonly openTagHome: string;
  /** Absolute argv that starts the current daemon Node and loads the runner module. */
  readonly runnerInvocation: readonly string[];
  readonly platform?: NodeJS.Platform;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface ProviderCliTurnPlanPrepareInput {
  readonly provider: ProviderCliProvider;
  readonly sessionId: string;
  readonly runId: string;
}

export interface ProviderCliPreparedTurnPlan {
  readonly plan: ProviderCliTurnPlan;
  readonly planPath: string;
  readonly launcherPath: string;
  readonly sessionDir: string;
  readonly homeNamespace: string;
}

interface SessionLockRecord {
  readonly pid: number;
  readonly token: string;
}

/**
 * Publishes and recovers per-Run exact-target plans under the account-global plans
 * root. Plans are isolated first by canonical OpenTag Home namespace, then by
 * irreversible Session key. This manager does not touch AgentTurnRunner,
 * SessionMessageInbox, SessionRuntimeManager, or daemon readiness.
 */
export class ProviderCliTurnPlanManager {
  readonly #deps: ProviderCliTurnPlanManagerDeps;
  readonly #layout: ProviderCliAccountLayout;
  readonly #openTagHome: string;
  readonly #homeNamespace: string;

  constructor(deps: ProviderCliTurnPlanManagerDeps) {
    this.#deps = deps;
    this.#layout = resolveProviderCliAccountLayout(deps.accountHome, deps.platform ?? process.platform);
    if (!isAbsolute(deps.openTagHome)) {
      throw new ProviderCliTurnPlanError("invalid_identity", "The OpenTag Home must be an absolute path");
    }
    this.#openTagHome = realpathSync(deps.openTagHome);
    this.#homeNamespace = deriveProviderCliHomeNamespace(this.#openTagHome);
  }

  get layout(): ProviderCliAccountLayout {
    return this.#layout;
  }

  get homeNamespace(): string {
    return this.#homeNamespace;
  }

  sessionDir(sessionId: string): string {
    return providerCliPlanSessionDir(this.#layout, this.#homeNamespace, deriveProviderCliSessionKey(sessionId));
  }

  /**
   * Read the exact current selection, verify its canonical target and fingerprint,
   * and atomically publish an immutable Run plan. A different active Run for the
   * same Session is rejected; the same Run is idempotent even if selection later
   * changes.
   */
  async prepare(input: ProviderCliTurnPlanPrepareInput): Promise<ProviderCliPreparedTurnPlan> {
    const sessionId = assertIdentity("sessionId", input.sessionId);
    const runId = assertIdentity("runId", input.runId);
    const sessionKey = deriveProviderCliSessionKey(sessionId);
    const sessionDir = providerCliPlanSessionDir(this.#layout, this.#homeNamespace, sessionKey);
    assertPlanWithinRoot(this.#layout.plans, sessionDir);
    await ensurePrivateDirectory(this.#layout.root, sessionDir);
    return await this.#withSessionLock(sessionDir, () => this.#prepareLocked(input, sessionId, runId, sessionDir));
  }

  /** Remove the matching Run's plan and launcher. Other Runs and Home namespaces are left untouched. */
  async cleanup(input: ProviderCliTurnPlanPrepareInput): Promise<void> {
    const sessionId = assertIdentity("sessionId", input.sessionId);
    const runId = assertIdentity("runId", input.runId);
    const sessionDir = this.sessionDir(sessionId);
    assertPlanWithinRoot(this.#layout.plans, sessionDir);
    try {
      if (!(await validatePrivateDirectory(this.#layout.root, sessionDir))) return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw mapStorageSafetyError(error);
    }
    await this.#withSessionLock(sessionDir, async () => {
      const existing = await this.#readExistingPlan(sessionDir);
      if (!existing) return;
      this.#assertMatchingHome(existing);
      if (existing.sessionId !== sessionId) {
        throw new ProviderCliTurnPlanError("session_mismatch", "Provider CLI Turn plan session does not match");
      }
      if (existing.runId !== runId) {
        throw new ProviderCliTurnPlanError("run_mismatch", "Provider CLI Turn cleanup run does not match");
      }
      if (existing.provider !== input.provider) {
        throw new ProviderCliTurnPlanError("provider_mismatch", "Provider CLI Turn cleanup provider does not match");
      }
      await rm(providerCliTurnPlanPath(sessionDir), { force: true });
      await rm(providerCliTurnLauncherPath(sessionDir, existing.command), { force: true });
    });
    // Keep the private Session directory. Removing it after releasing the lock can
    // race with a new Run that has just acquired the same lock and published a plan.
    // Startup recovery removes abandoned directories for this OpenTag Home.
  }

  /**
   * Crash recovery for this canonical OpenTag Home only. Sibling Home namespaces under
   * the same account-global plans root are never listed or removed.
   */
  async recover(): Promise<void> {
    const homeDir = providerCliPlanHomeDir(this.#layout, this.#homeNamespace);
    assertPlanWithinRoot(this.#layout.plans, homeDir);
    let entries: readonly { name: string; isDirectory(): boolean; isSymbolicLink(): boolean }[];
    try {
      if (!(await validatePrivateDirectory(this.#layout.root, homeDir))) return;
      entries = await readdir(homeDir, { encoding: "utf8", withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw mapStorageSafetyError(error);
    }
    for (const entry of entries) {
      if (!isProviderCliSessionKey(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) continue;
      const sessionDir = join(homeDir, entry.name);
      assertPlanWithinRoot(homeDir, sessionDir);
      await rm(sessionDir, { recursive: true, force: true });
    }
  }

  #prepared(plan: ProviderCliTurnPlan, sessionDir: string): ProviderCliPreparedTurnPlan {
    return {
      plan,
      planPath: providerCliTurnPlanPath(sessionDir),
      launcherPath: providerCliTurnLauncherPath(sessionDir, plan.command),
      sessionDir,
      homeNamespace: this.#homeNamespace,
    };
  }

  async #readExistingPlan(sessionDir: string): Promise<ProviderCliTurnPlan | undefined> {
    return readProviderCliTurnPlan(providerCliTurnPlanPath(sessionDir));
  }

  async #prepareLocked(
    input: ProviderCliTurnPlanPrepareInput,
    sessionId: string,
    runId: string,
    sessionDir: string,
  ): Promise<ProviderCliPreparedTurnPlan> {
    const existing = await this.#readExistingPlan(sessionDir);
    if (existing) return this.#reuseExistingPlan(input, sessionId, runId, sessionDir, existing);
    return this.#publishNewPlan(input.provider, sessionId, runId, sessionDir);
  }

  async #reuseExistingPlan(
    input: ProviderCliTurnPlanPrepareInput,
    sessionId: string,
    runId: string,
    sessionDir: string,
    existing: ProviderCliTurnPlan,
  ): Promise<ProviderCliPreparedTurnPlan> {
    this.#assertMatchingHome(existing);
    if (existing.sessionId !== sessionId) {
      throw new ProviderCliTurnPlanError("session_mismatch", "Provider CLI Turn plan session does not match");
    }
    if (existing.runId !== runId || existing.provider !== input.provider) {
      throw new ProviderCliTurnPlanError(
        "active_run_conflict",
        "The Session already has a different active Provider CLI Turn Run",
      );
    }
    await this.#writeLauncher(sessionDir, existing);
    return this.#prepared(existing, sessionDir);
  }

  async #publishNewPlan(
    provider: ProviderCliProvider,
    sessionId: string,
    runId: string,
    sessionDir: string,
  ): Promise<ProviderCliPreparedTurnPlan> {
    const record = await this.#readSelection(provider);
    const plan = await this.#planFromSelection(provider, sessionId, runId, record);
    await this.#writeLauncher(sessionDir, plan);
    const published = await publishProviderCliTurnPlanExclusive(providerCliTurnPlanPath(sessionDir), plan);
    if (published === "created") return this.#prepared(plan, sessionDir);

    const raced = await this.#readExistingPlan(sessionDir);
    if (!raced) throw new ProviderCliTurnPlanError("plan_invalid", "Provider CLI Turn plan publish raced");
    return this.#reuseExistingPlan({ provider, sessionId, runId }, sessionId, runId, sessionDir, raced);
  }

  async #readSelection(provider: ProviderCliProvider): Promise<ProviderCliSelectionRecord> {
    let record: ProviderCliSelectionRecord | undefined;
    try {
      record = await readProviderCliSelection(this.#layout, provider);
    } catch (error) {
      if (error instanceof RuntimeStorageError && error.code === "unsafe") {
        throw new ProviderCliTurnPlanError("unsafe", error.message);
      }
      throw new ProviderCliTurnPlanError(
        "selection_invalid",
        error instanceof Error ? error.message : "Provider CLI selection is malformed",
      );
    }
    if (!record) {
      throw new ProviderCliTurnPlanError("selection_missing", "Provider CLI selection is missing");
    }
    return record;
  }

  async #planFromSelection(
    provider: ProviderCliProvider,
    sessionId: string,
    runId: string,
    record: ProviderCliSelectionRecord,
  ): Promise<ProviderCliTurnPlan> {
    const selection = record.selection;
    const storedPath = providerCliSelectionTargetPath(selection);
    const identity = await computeFileIdentity(storedPath).catch((error: unknown) => {
      throw mapPrepareTargetError(error);
    });
    if (identity.path !== storedPath) {
      throw new ProviderCliTurnPlanError("artifact_drifted", "Provider CLI selection target path drifted");
    }
    const managedDigest = selection.kind === "managed" ? managedArtifactDigest(selection.artifactId) : undefined;
    const fingerprint = computeTargetFingerprint(identity, selection.version, managedDigest);
    if (fingerprint !== selection.fingerprint) {
      throw new ProviderCliTurnPlanError("artifact_drifted", "Provider CLI selection fingerprint drifted");
    }
    const command = providerCliCommandForProvider(provider);
    const shared = {
      schemaVersion: 1 as const,
      provider,
      command,
      selectionVersion: selection.version,
      selectionGeneration: record.generation,
      targetPath: identity.path,
      fingerprint,
      homeNamespace: this.#homeNamespace,
      sessionId,
      runId,
    };
    if (selection.kind === "managed") {
      return { ...shared, selectionKind: "managed", artifactId: selection.artifactId };
    }
    return { ...shared, selectionKind: "external" };
  }

  async #writeLauncher(sessionDir: string, plan: ProviderCliTurnPlan): Promise<void> {
    const launcherPath = providerCliTurnLauncherPath(sessionDir, plan.command);
    assertPlanWithinRoot(sessionDir, launcherPath);
    await writeProviderCliTurnLauncher(launcherPath, {
      provider: plan.provider,
      runId: plan.runId,
      planPath: providerCliTurnPlanPath(sessionDir),
      runnerInvocation: this.#deps.runnerInvocation,
    });
  }

  #assertMatchingHome(plan: ProviderCliTurnPlan): void {
    if (plan.homeNamespace !== this.#homeNamespace) {
      throw new ProviderCliTurnPlanError("home_mismatch", "Provider CLI Turn plan home namespace does not match");
    }
  }

  async #withSessionLock<T>(sessionDir: string, run: () => Promise<T>): Promise<T> {
    const sleep = this.#deps.sleep ?? defaultSleep;
    const lockPath = join(sessionDir, ".lock");
    const token = randomUUID();
    const candidatePath = join(sessionDir, `.lock-${token}.candidate`);
    await writeDurableFile(
      candidatePath,
      JSON.stringify({ pid: process.pid, token } satisfies SessionLockRecord),
      0o600,
    );
    let acquired = false;
    try {
      acquired = await acquireSessionLock(candidatePath, lockPath, sessionDir, sleep);
      if (!acquired) {
        throw new ProviderCliTurnPlanError("runner_failed", "Another process holds the Provider CLI Turn plan lock");
      }
      try {
        return await run();
      } finally {
        await releaseSessionLock(candidatePath, lockPath);
      }
    } finally {
      await rm(candidatePath, { force: true });
    }
  }
}

async function acquireSessionLock(
  candidatePath: string,
  lockPath: string,
  sessionDir: string,
  sleep: (ms: number) => Promise<void>,
): Promise<boolean> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await link(candidatePath, lockPath);
      await syncDurableDirectory(sessionDir);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (attempt + 1 < 50) await sleep(20);
    }
  }
  return false;
}

async function releaseSessionLock(candidatePath: string, lockPath: string): Promise<void> {
  try {
    const [candidate, lockStatus] = await Promise.all([lstat(candidatePath), lstat(lockPath)]);
    if (candidate.dev === lockStatus.dev && candidate.ino === lockStatus.ino) {
      await rm(lockPath, { force: true });
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function mapStorageSafetyError(error: unknown): Error {
  if (error instanceof RuntimeStorageError && error.code === "unsafe") {
    return new ProviderCliTurnPlanError("unsafe", error.message);
  }
  return error instanceof Error ? error : new Error("Provider CLI Turn storage validation failed");
}

function mapPrepareTargetError(error: unknown): ProviderCliTurnPlanError {
  if (error instanceof ProviderCliTurnPlanError) return error;
  if (error instanceof ProviderCliFileError) {
    if (error.code === "too-large") {
      return new ProviderCliTurnPlanError("too_large", error.message);
    }
    if (error.code === "missing") {
      return new ProviderCliTurnPlanError("target_invalid", error.message);
    }
    if (error.code === "not-regular-file") {
      return new ProviderCliTurnPlanError("unsafe", error.message);
    }
    return new ProviderCliTurnPlanError("artifact_drifted", error.message);
  }
  return new ProviderCliTurnPlanError(
    "target_invalid",
    error instanceof Error ? error.message : "Provider CLI selection target is invalid",
  );
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
