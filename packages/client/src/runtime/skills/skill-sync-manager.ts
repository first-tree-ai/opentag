import { randomUUID } from "node:crypto";
import { readdir, rename, rm } from "node:fs/promises";
import { resolve } from "node:path";
import {
  computeAgentSkillsDigest,
  EMPTY_AGENT_SKILLS_DIGEST,
  type RuntimeAgentSkills,
  type RuntimeSkillEntry,
  type SkillsChangedFrame,
} from "@opentag/shared";
import type { OpenTagApi } from "../../api.js";
import { type ClientLogger, createLogger } from "../../observability/logger.js";
import { ensurePrivateDirectory } from "../../storage/durable-file.js";
import { extractSkillArchive, sha256Hex } from "./skill-archive.js";
import {
  type LocalSkillEntry,
  type LocalSkillsManifest,
  readLocalSkillsManifest,
  SKILLS_MANIFEST_FILE,
  skillsRootPath,
  verifyLocalSkills,
  writeLocalSkillsManifest,
} from "./skill-manifest-store.js";
import { projectSkills } from "./skill-projection.js";

/**
 * Keeps each Agent Home's `.skills/` equal to the skill set the Server assigns to that agent.
 *
 * Sync is best-effort and never blocks Session admission: callers fire `reconcile` or `verify`
 * and continue; failures are recorded in the local manifest and the workspace state, then retried
 * with exponential backoff. Work is serialized per agent inside this manager rather than under
 * the Session reconciler's agent lock, because holding that lock across archive downloads would
 * stall every reconcile for the agent while the network is slow. Directory swaps are atomic
 * renames, so a Session that starts mid-sync sees either the previous or the new skill tree.
 */

export const SKILL_SYNC_INITIAL_RETRY_DELAY_MS = 60_000;
export const SKILL_SYNC_MAX_RETRY_DELAY_MS = 30 * 60_000;
export const SKILL_SYNC_VERIFY_INTERVAL_MS = 60_000;
export const SKILL_SYNC_SWEEP_INTERVAL_MS = 10 * 60_000;

export interface SkillSyncState {
  digest: string;
  syncedAt: string;
  lastError?: string;
}

export type SkillSyncApi = Pick<OpenTagApi, "runtimeSkillsManifest" | "downloadRuntimeSkillArchive">;

export interface SkillSyncTimers {
  setTimeout(callback: () => void, delayMs: number): { unref?(): unknown };
  clearTimeout(handle: { unref?(): unknown }): void;
}

export interface SkillSyncManagerOptions {
  readonly api: SkillSyncApi;
  readonly machineToken: string;
  /** Resolve the Agent Home; throws while the workspace is not complete. */
  readonly agentHome: (agentId: string) => Promise<string>;
  /** Persist the sync outcome next to the workspace layout state. */
  readonly recordState?: (agentId: string, state: SkillSyncState) => Promise<void>;
  readonly logger?: ClientLogger;
  readonly now?: () => number;
  readonly timers?: SkillSyncTimers;
  readonly initialRetryDelayMs?: number;
  readonly maxRetryDelayMs?: number;
  readonly verifyIntervalMs?: number;
  readonly sweepIntervalMs?: number;
}

export interface SkillSyncOutcome {
  readonly status: "synced" | "unchanged" | "failed" | "skipped";
  readonly digest?: string;
  readonly error?: string;
}

export class SkillSyncError extends Error {
  override readonly name = "SkillSyncError";
}

interface InstallationResult {
  readonly installed: Record<string, LocalSkillEntry>;
  readonly errors: readonly string[];
}

interface AgentSyncState {
  tail: Promise<unknown>;
  queued?: Promise<SkillSyncOutcome>;
  failures: number;
  retryTimer?: { unref?(): unknown };
  lastVerifiedAt?: number;
  lastDigest?: string;
}

const defaultTimers: SkillSyncTimers = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 512);
}

function localEntry(skill: RuntimeSkillEntry): LocalSkillEntry {
  return { digest: skill.digest, archiveSha256: skill.archiveSha256, manifest: skill.manifest };
}

export class SkillSyncManager {
  readonly #api: SkillSyncApi;
  readonly #machineToken: string;
  readonly #agentHome: SkillSyncManagerOptions["agentHome"];
  readonly #recordState?: SkillSyncManagerOptions["recordState"];
  readonly #logger: ClientLogger;
  readonly #now: () => number;
  readonly #timers: SkillSyncTimers;
  readonly #initialRetryDelayMs: number;
  readonly #maxRetryDelayMs: number;
  readonly #verifyIntervalMs: number;
  readonly #sweepIntervalMs: number;
  readonly #agents = new Map<string, AgentSyncState>();
  #sweepTimer?: ReturnType<typeof setInterval>;
  #closed = false;

  constructor(options: SkillSyncManagerOptions) {
    this.#api = options.api;
    this.#machineToken = options.machineToken;
    this.#agentHome = options.agentHome;
    this.#recordState = options.recordState;
    this.#logger = options.logger ?? createLogger("runtime-skill-sync");
    this.#now = options.now ?? Date.now;
    this.#timers = options.timers ?? defaultTimers;
    this.#initialRetryDelayMs = options.initialRetryDelayMs ?? SKILL_SYNC_INITIAL_RETRY_DELAY_MS;
    this.#maxRetryDelayMs = options.maxRetryDelayMs ?? SKILL_SYNC_MAX_RETRY_DELAY_MS;
    this.#verifyIntervalMs = options.verifyIntervalMs ?? SKILL_SYNC_VERIFY_INTERVAL_MS;
    this.#sweepIntervalMs = Math.max(10, options.sweepIntervalMs ?? SKILL_SYNC_SWEEP_INTERVAL_MS);
  }

  /** Agents this manager has been asked about since the daemon started. */
  knownAgentIds(): string[] {
    return [...this.#agents.keys()];
  }

  /**
   * Bring the agent's `.skills/` in line with the Server. Calls for one agent run one at a time;
   * a call that arrives while another is still waiting to start joins that waiting run.
   */
  reconcile(agentId: string, options: { expectedDigest?: string } = {}): Promise<SkillSyncOutcome> {
    const state = this.#state(agentId);
    if (state.queued) return state.queued;
    const run = state.tail.then(() => {
      state.queued = undefined;
      return this.#reconcileLocked(agentId, options.expectedDigest);
    });
    state.queued = run;
    state.tail = run;
    return run;
  }

  /**
   * Cheap local check: when the Server-advertised digest differs from the last known local digest,
   * or a listed file is missing or altered, a full `reconcile` follows. Repeated calls inside the
   * verify interval are skipped so per-Turn admission stays cheap.
   */
  verify(agentId: string, options: { expectedDigest?: string } = {}): Promise<SkillSyncOutcome> {
    const state = this.#state(agentId);
    const digestChanged = options.expectedDigest !== undefined && options.expectedDigest !== state.lastDigest;
    if (digestChanged) return this.reconcile(agentId, { expectedDigest: options.expectedDigest });
    if (state.lastVerifiedAt !== undefined && this.#now() - state.lastVerifiedAt < this.#verifyIntervalMs) {
      return Promise.resolve({ status: "skipped" });
    }
    const run = state.tail.then(() => this.#verifyLocked(agentId));
    state.tail = run;
    return run;
  }

  /** `skills:changed` names the agents whose assignment changed; only agents with a prepared workspace are synced. */
  async handleSkillsChanged(frame: SkillsChangedFrame): Promise<void> {
    await Promise.all(
      frame.agents
        .filter((agent) => this.#agents.has(agent.agentId))
        .map((agent) => this.reconcile(agent.agentId, { expectedDigest: agent.digest })),
    );
  }

  /** Periodic safety net for missed frames: verify every known agent. */
  async sweep(): Promise<void> {
    await Promise.all(this.knownAgentIds().map((agentId) => this.verify(agentId)));
  }

  /** Start the periodic sweep that catches missed `skills:changed` frames; idempotent. */
  startSweep(): void {
    if (this.#sweepTimer || this.#closed) return;
    this.#sweepTimer = setInterval(() => void this.sweep(), this.#sweepIntervalMs);
    this.#sweepTimer.unref();
  }

  close(): void {
    this.#closed = true;
    if (this.#sweepTimer) clearInterval(this.#sweepTimer);
    this.#sweepTimer = undefined;
    for (const state of this.#agents.values()) {
      if (state.retryTimer) this.#timers.clearTimeout(state.retryTimer);
      state.retryTimer = undefined;
    }
  }

  #state(agentId: string): AgentSyncState {
    let state = this.#agents.get(agentId);
    if (!state) {
      state = { tail: Promise.resolve(), failures: 0 };
      this.#agents.set(agentId, state);
    }
    return state;
  }

  async #verifyLocked(agentId: string): Promise<SkillSyncOutcome> {
    if (this.#closed) return { status: "skipped" };
    try {
      const agentHome = await this.#agentHome(agentId);
      const local = await this.#readLocal(agentHome);
      if (local && (await verifyLocalSkills(agentHome, local)).ok) {
        this.#markVerified(agentId, local.digest);
        return { status: "unchanged", digest: local.digest };
      }
    } catch (error) {
      this.#logger.debug({ agentId, error: describeError(error) }, "Skill verification could not read local state");
    }
    return this.#reconcileLocked(agentId, undefined);
  }

  async #reconcileLocked(agentId: string, expectedDigest: string | undefined): Promise<SkillSyncOutcome> {
    if (this.#closed) return { status: "skipped" };
    let agentHome: string | undefined;
    try {
      agentHome = await this.#agentHome(agentId);
      const outcome = await this.#sync(agentId, agentHome, expectedDigest);
      this.#clearRetry(agentId);
      this.#markVerified(agentId, outcome.digest);
      return outcome;
    } catch (error) {
      const message = describeError(error);
      this.#logger.warn({ agentId, error: message }, "Skill sync failed");
      if (agentHome) await this.#recordFailure(agentId, agentHome, message);
      this.#scheduleRetry(agentId);
      return { status: "failed", error: message };
    }
  }

  async #sync(agentId: string, agentHome: string, expectedDigest: string | undefined): Promise<SkillSyncOutcome> {
    const local = await this.#readLocal(agentHome);
    const verification = local ? await verifyLocalSkills(agentHome, local) : undefined;
    const intact = local !== undefined && verification?.ok === true;
    if (intact && expectedDigest !== undefined && local.digest === expectedDigest) {
      return { status: "unchanged", digest: local.digest };
    }
    const remote = await this.#fetchRemote(agentId);
    if (intact && local.digest === remote.digest) {
      await projectSkills(agentHome, Object.keys(local.skills));
      return { status: "unchanged", digest: local.digest };
    }
    const result = await this.#installAll(agentHome, remote, local, new Set(verification?.damaged ?? []));
    return this.#publish(agentId, agentHome, remote, result);
  }

  async #installAll(
    agentHome: string,
    remote: RuntimeAgentSkills,
    local: LocalSkillsManifest | undefined,
    damaged: ReadonlySet<string>,
  ): Promise<InstallationResult> {
    const installed: Record<string, LocalSkillEntry> = {};
    const errors: string[] = [];
    for (const skill of remote.skills) {
      const current = local?.skills[skill.name];
      const currentIntact = current !== undefined && !damaged.has(skill.name);
      if (currentIntact && current.digest === skill.digest) {
        installed[skill.name] = localEntry(skill);
        continue;
      }
      try {
        await this.#install(agentHome, skill, currentIntact ? current : undefined);
        installed[skill.name] = localEntry(skill);
      } catch (error) {
        errors.push(`${skill.name}: ${describeError(error)}`);
        if (currentIntact) installed[skill.name] = current;
      }
    }
    return { installed, errors };
  }

  /** Remove what the Server no longer lists, refresh the projection, and record the outcome durably. */
  async #publish(
    agentId: string,
    agentHome: string,
    remote: RuntimeAgentSkills,
    result: InstallationResult,
  ): Promise<SkillSyncOutcome> {
    const names = Object.keys(result.installed);
    await removeUnlistedEntries(skillsRootPath(agentHome), new Set(names));
    await projectSkills(agentHome, names);
    const digest =
      result.errors.length === 0
        ? remote.digest
        : computeAgentSkillsDigest(
            names.map((name) => ({ name, digest: (result.installed[name] as LocalSkillEntry).digest })),
          );
    const syncedAt = new Date(this.#now()).toISOString();
    const lastError = result.errors.length > 0 ? result.errors.join("; ").slice(0, 2_048) : undefined;
    await writeLocalSkillsManifest(agentHome, {
      schemaVersion: 1,
      agentId,
      digest,
      skills: result.installed,
      syncedAt,
      ...(lastError ? { lastError } : {}),
    });
    await this.#recordState?.(agentId, { digest, syncedAt, ...(lastError ? { lastError } : {}) });
    if (lastError) throw new SkillSyncError(lastError);
    this.#logger.info({ agentId, skillCount: names.length }, "Skills synchronized");
    return { status: "synced", digest };
  }

  async #install(agentHome: string, skill: RuntimeSkillEntry, current: LocalSkillEntry | undefined): Promise<void> {
    const download = await this.#api.downloadRuntimeSkillArchive(
      this.#machineToken,
      skill.name,
      current ? { etag: current.archiveSha256 } : {},
    );
    if (download.status === 304) {
      // The local copy is intact but its digest differs from the Server's; an unchanged archive
      // cannot explain that, so the local copy is kept and the disagreement is surfaced.
      throw new SkillSyncError("the server reported an unchanged archive for a skill whose manifest changed");
    }
    const bytes = download.bytes;
    if (bytes.length !== skill.archiveBytes || sha256Hex(bytes) !== skill.archiveSha256) {
      throw new SkillSyncError("the downloaded archive does not match its advertised checksum");
    }
    const skillsRoot = await ensurePrivateDirectory(agentHome, skillsRootPath(agentHome));
    const temporary = resolve(skillsRoot, `.tmp-${skill.name}-${randomUUID()}`);
    try {
      await extractSkillArchive(bytes, {
        manifest: skill.manifest,
        digest: skill.digest,
        destination: temporary,
        root: skillsRoot,
      });
      await swapDirectory(skillsRoot, temporary, skill.name);
    } catch (error) {
      await rm(temporary, { recursive: true, force: true });
      throw error;
    }
  }

  async #fetchRemote(agentId: string): Promise<RuntimeAgentSkills> {
    const manifest = await this.#api.runtimeSkillsManifest(this.#machineToken, { agentId });
    return (
      manifest.agents.find((agent) => agent.agentId === agentId) ?? {
        agentId,
        digest: EMPTY_AGENT_SKILLS_DIGEST,
        skills: [],
      }
    );
  }

  async #readLocal(agentHome: string): Promise<LocalSkillsManifest | undefined> {
    try {
      return await readLocalSkillsManifest(agentHome);
    } catch (error) {
      this.#logger.warn({ error: describeError(error) }, "Local skills manifest is unreadable; resynchronizing");
      return undefined;
    }
  }

  async #recordFailure(agentId: string, agentHome: string, lastError: string): Promise<void> {
    try {
      const local = await this.#readLocal(agentHome);
      if (local) await writeLocalSkillsManifest(agentHome, { ...local, lastError });
      await this.#recordState?.(agentId, {
        digest: local?.digest ?? EMPTY_AGENT_SKILLS_DIGEST,
        syncedAt: local?.syncedAt ?? new Date(this.#now()).toISOString(),
        lastError,
      });
    } catch (error) {
      this.#logger.debug({ agentId, error: describeError(error) }, "Skill sync failure could not be recorded");
    }
  }

  #markVerified(agentId: string, digest: string | undefined): void {
    const state = this.#state(agentId);
    state.lastVerifiedAt = this.#now();
    if (digest !== undefined) state.lastDigest = digest;
  }

  #scheduleRetry(agentId: string): void {
    const state = this.#state(agentId);
    state.failures += 1;
    const delay = Math.min(this.#initialRetryDelayMs * 2 ** (state.failures - 1), this.#maxRetryDelayMs);
    if (state.retryTimer) this.#timers.clearTimeout(state.retryTimer);
    if (this.#closed) return;
    const timer = this.#timers.setTimeout(() => {
      state.retryTimer = undefined;
      void this.reconcile(agentId);
    }, delay);
    timer.unref?.();
    state.retryTimer = timer;
    this.#logger.debug({ agentId, delayMs: delay, failures: state.failures }, "Skill sync retry scheduled");
  }

  #clearRetry(agentId: string): void {
    const state = this.#state(agentId);
    state.failures = 0;
    if (state.retryTimer) this.#timers.clearTimeout(state.retryTimer);
    state.retryTimer = undefined;
  }
}

/** Replace `<root>/<name>` with `temporary` so the directory is always either the old or the new tree. */
async function swapDirectory(root: string, temporary: string, name: string): Promise<void> {
  const target = resolve(root, name);
  const trash = resolve(root, `.trash-${name}-${randomUUID()}`);
  let displaced = false;
  try {
    await rename(target, trash);
    displaced = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await rename(temporary, target);
  if (displaced) await rm(trash, { recursive: true, force: true });
}

/** `.skills/` is fully managed: anything that is not a kept skill or the manifest is removed. */
async function removeUnlistedEntries(root: string, keep: ReadonlySet<string>): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    if (entry === SKILLS_MANIFEST_FILE || keep.has(entry)) continue;
    await rm(resolve(root, entry), { recursive: true, force: true });
  }
}
