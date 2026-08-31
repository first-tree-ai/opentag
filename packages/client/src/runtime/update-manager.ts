import { type ChannelName, compareSemVer, type RuntimeChannelTarget } from "@opentag/shared";
import { type ClientLogger, createLogger } from "../observability/logger.js";

/**
 * Durable record of one automatic-upgrade attempt. The attempt is recorded before any install work
 * starts, so a crash or supervisor kill mid-install still counts: an interrupted attempt becomes a
 * blocked state instead of a silent retry, which is what keeps restart loops from becoming storms.
 */
export interface UpdaterAttempt {
  target: string;
  startedAt: string;
  finishedAt?: string;
  result?: "installed" | "failed";
  failureReason?: string;
}

export type UpdaterStateName = "idle" | "awaiting_protected_work" | "installing" | "blocked" | "installed";

/** Persisted updater status, also the source for `daemon status` update reporting. */
export interface UpdaterStateSnapshot {
  schemaVersion: 1;
  currentVersion: string;
  state: UpdaterStateName;
  target?: string;
  lastAttempt?: UpdaterAttempt;
  attempts: Record<string, UpdaterAttempt>;
}

export interface ProtectedWorkCount {
  /** Zero means no local state could lose or duplicate an accepted Turn or IM delivery. */
  total: number;
}

export interface UpdateManagerOptions {
  /** This build's release channel; advertisements for any other channel are ignored. */
  channel: ChannelName;
  /** This build's exact version. */
  currentVersion: string;
  logger?: ClientLogger;
  /** Authoritative protected-work count from the Session runtime boundary. */
  protectedWork(): ProtectedWorkCount;
  /**
   * Atomically close new-work admission before checking the protected-work snapshot. The returned
   * function reopens admission if the target is superseded or the attempt fails.
   */
  quiesce?(): () => void;
  /**
   * Install the exact target and refresh the daemon service definition through the newly installed
   * binary. Resolves when the new version is live on disk; rejects with the failure reason.
   */
  executeUpdate(target: string): Promise<void>;
  /**
   * Hand the process off to the supervisor (reserved restart exit code) after a successful install.
   * Errors are logged and swallowed: the install already succeeded and must not be re-attempted.
   */
  onHandoff(): void | Promise<void>;
  loadState(): Promise<UpdaterStateSnapshot | undefined>;
  saveState(state: UpdaterStateSnapshot): Promise<void>;
  /** Protected-work re-check cadence. This is a poll interval, never a force timeout. */
  checkIntervalMs?: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

const DEFAULT_CHECK_INTERVAL_MS = 5_000;
const QUIET_LOG_THROTTLE_MS = 60_000;

const defaultSleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref();
  });

/**
 * Drives automatic upgrades for the portable install mode. One decision loop, one durable attempt
 * per exact target, monotonic SemVer comparisons only (never an automatic downgrade), and an
 * indefinite protected-work gate: the updater adds no force timeout of its own, because the Session
 * module already bounds every unit of protected work (Turn budgets, delivery deadlines, report
 * retries with terminal outcomes) and therefore owns hang prevention.
 *
 * npm-global installs never attach a manager: they upgrade only through the manual CLI command.
 */
export class UpdateManager {
  readonly #options: UpdateManagerOptions;
  readonly #logger: ClientLogger;
  readonly #now: () => number;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #checkIntervalMs: number;
  #latestTarget?: string;
  #deciding?: Promise<void>;
  #stopped = false;
  #blockedLoggedTarget?: string;

  constructor(options: UpdateManagerOptions) {
    this.#options = options;
    this.#logger = (options.logger ?? createLogger("updater")).child({ channel: options.channel });
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? defaultSleep;
    this.#checkIntervalMs = positive(options.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS, "checkIntervalMs");
  }

  /**
   * Reconcile durable status with the binary that actually started. This runs once before runtime
   * traffic begins, so `daemon status` always has a current version even when no update has ever
   * been advertised. If a previously blocked/installed target is now the running version, the
   * supervisor handoff (or a manual restart) succeeded and that record converges to installed.
   */
  async syncRunningVersion(): Promise<void> {
    try {
      const stored = await this.#options.loadState();
      const state = stored ?? emptyState(this.#options.currentVersion);
      let changed = stored === undefined || state.currentVersion !== this.#options.currentVersion;
      state.currentVersion = this.#options.currentVersion;
      if (state.target) {
        const comparison = compareSemVer(state.target, this.#options.currentVersion);
        if (comparison === 0 && state.state !== "installed") {
          state.state = "installed";
          const attempt = state.attempts[state.target];
          if (attempt) {
            attempt.finishedAt ??= new Date(this.#now()).toISOString();
            attempt.result = "installed";
            delete attempt.failureReason;
            state.lastAttempt = attempt;
          }
          changed = true;
        } else if (comparison < 0) {
          state.state = "idle";
          delete state.target;
          changed = true;
        }
      }
      if (changed) await this.#options.saveState(state);
    } catch (error) {
      this.#logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        "Automatic upgrade state could not be reconciled with the running version",
      );
    }
  }

  /** Record a Server-advertised channel target. Cheap and safe to call on every heartbeat. */
  observe(advertisement: RuntimeChannelTarget): void {
    if (this.#stopped) return;
    if (advertisement.channel !== this.#options.channel) {
      this.#logger.warn(
        { advertisedChannel: advertisement.channel, version: advertisement.version },
        "Server advertised a target for another channel; ignoring it",
      );
      return;
    }
    const comparison = compareSemVer(advertisement.version, this.#options.currentVersion);
    if (comparison === 0) {
      this.#latestTarget = advertisement.version;
      this.#logger.debug({ version: advertisement.version }, "Server target matches the running version");
      this.#deciding ??= this.#recordSatisfiedTarget(advertisement.version).finally(() => {
        this.#deciding = undefined;
      });
      void this.#deciding.catch((error: unknown) => {
        this.#logger.warn(
          { error: error instanceof Error ? error.message : String(error) },
          "Automatic upgrade status could not record the satisfied channel target",
        );
      });
      return;
    }
    if (comparison < 0) {
      // Monotonic forward motion only: an older advertisement is never an automatic downgrade.
      this.#logger.info(
        { current: this.#options.currentVersion, target: advertisement.version },
        "Server target is older than the running version; ignoring it",
      );
      return;
    }
    if (this.#latestTarget && compareSemVer(advertisement.version, this.#latestTarget) <= 0) return;
    this.#latestTarget = advertisement.version;
    this.#logger.info(
      { current: this.#options.currentVersion, target: advertisement.version },
      "Server advertised a newer channel target",
    );
    this.#deciding ??= this.#decide().finally(() => {
      this.#deciding = undefined;
    });
    void this.#deciding.catch((error: unknown) => {
      this.#logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        "Automatic upgrade decision failed",
      );
    });
  }

  async #recordSatisfiedTarget(target: string): Promise<void> {
    const stored = await this.#options.loadState();
    const state = stored ?? emptyState(this.#options.currentVersion);
    const attempt = state.attempts[target];
    const desiredState: UpdaterStateName = attempt?.result === "installed" ? "installed" : "idle";
    if (
      stored &&
      state.currentVersion === this.#options.currentVersion &&
      state.target === target &&
      state.state === desiredState
    ) {
      return;
    }
    state.currentVersion = this.#options.currentVersion;
    state.target = target;
    state.state = desiredState;
    if (attempt?.result === "installed") state.lastAttempt = attempt;
    await this.#options.saveState(state);
  }

  stop(): void {
    this.#stopped = true;
  }

  async #decide(): Promise<void> {
    while (!this.#stopped) {
      const target = this.#latestTarget;
      if (!target) return;
      if (await this.#settleNonNewerTarget(target)) return;
      const stored = await this.#options.loadState();
      const state = stored ?? emptyState(this.#options.currentVersion);
      state.currentVersion = this.#options.currentVersion;
      if (await this.#settleExistingAttempt(target, state)) return;
      if ((await this.#attemptTarget(target, state)) === "finished") return;
    }
  }

  async #settleNonNewerTarget(target: string): Promise<boolean> {
    const comparison = compareSemVer(target, this.#options.currentVersion);
    if (comparison === 0) await this.#recordSatisfiedTarget(target);
    return comparison <= 0;
  }

  async #settleExistingAttempt(target: string, state: UpdaterStateSnapshot): Promise<boolean> {
    const attempt = state.attempts[target];
    if (!attempt) return false;
    if (attempt.result === "installed") {
      // Installed but not yet handed off (the supervisor restart is still pending).
      state.state = "installed";
      state.target = target;
      state.lastAttempt = attempt;
      await this.#options.saveState(state);
      return true;
    }

    // A finished failure or an interrupted attempt: blocked until a new target or a manual
    // upgrade records a fresh outcome for this one.
    attempt.result = "failed";
    attempt.finishedAt ??= new Date(this.#now()).toISOString();
    attempt.failureReason ??= "The previous upgrade attempt was interrupted before it completed";
    state.state = "blocked";
    state.target = target;
    state.lastAttempt = attempt;
    await this.#options.saveState(state);
    this.#logBlockedTarget(target, attempt.failureReason);
    return true;
  }

  #logBlockedTarget(target: string, failureReason: string): void {
    if (this.#blockedLoggedTarget === target) return;
    this.#blockedLoggedTarget = target;
    this.#logger.warn(
      { target, failureReason },
      "Automatic upgrade is blocked after a failed attempt; run the CLI upgrade command to retry manually or wait for a newer target",
    );
  }

  async #attemptTarget(target: string, state: UpdaterStateSnapshot): Promise<"finished" | "superseded"> {
    state.state = "awaiting_protected_work";
    state.target = target;
    await this.#options.saveState(state);
    const resumeAdmission = this.#options.quiesce?.() ?? (() => undefined);
    let keepQuiesced = false;
    try {
      await this.#waitForProtectedWork(target);
      if (this.#stopped) return "finished";
      if (this.#latestTarget !== target) return "superseded";
      const started = await this.#recordStartedAttempt(target, state);
      if (!(await this.#executeAttempt(target, state, started))) return "finished";
      keepQuiesced = true;
      await this.#requestHandoff(target);
      return "finished";
    } finally {
      if (!keepQuiesced) resumeAdmission();
    }
  }

  async #recordStartedAttempt(target: string, state: UpdaterStateSnapshot): Promise<UpdaterAttempt> {
    const started: UpdaterAttempt = { target, startedAt: new Date(this.#now()).toISOString() };
    state.attempts[target] = started;
    state.state = "installing";
    state.target = target;
    state.lastAttempt = started;
    await this.#options.saveState(state);
    return started;
  }

  async #executeAttempt(target: string, state: UpdaterStateSnapshot, started: UpdaterAttempt): Promise<boolean> {
    try {
      await this.#options.executeUpdate(target);
    } catch (error) {
      started.finishedAt = new Date(this.#now()).toISOString();
      started.result = "failed";
      started.failureReason = error instanceof Error ? error.message : String(error);
      state.state = "blocked";
      state.lastAttempt = started;
      await this.#options.saveState(state);
      this.#logger.warn(
        { target, failureReason: started.failureReason },
        "Automatic upgrade attempt failed; blocked until a new target or a manual upgrade",
      );
      return false;
    }
    started.finishedAt = new Date(this.#now()).toISOString();
    started.result = "installed";
    state.state = "installed";
    state.lastAttempt = started;
    await this.#options.saveState(state);
    return true;
  }

  async #requestHandoff(target: string): Promise<void> {
    try {
      await this.#options.onHandoff();
    } catch (error) {
      this.#logger.warn(
        { target, error: error instanceof Error ? error.message : String(error) },
        "The supervisor handoff failed after a successful install; restart the daemon to run the new version",
      );
    }
  }

  /**
   * Wait for the Session module to report no protected work. Indefinite by design: there is no
   * force timeout here, because the Session module owns the bounded lifetime of every protected
   * unit. The wait is re-checked on a fixed cadence and logged at a throttled rate.
   */
  async #waitForProtectedWork(target: string): Promise<void> {
    let lastLogAt = Number.NEGATIVE_INFINITY;
    while (!this.#stopped) {
      const work = this.#options.protectedWork();
      if (work.total === 0) return;
      const now = this.#now();
      if (now - lastLogAt >= QUIET_LOG_THROTTLE_MS) {
        lastLogAt = now;
        this.#logger.info(
          { target, protectedWork: work.total },
          "Automatic upgrade is waiting for protected work to finish",
        );
      }
      await this.#sleep(this.#checkIntervalMs);
    }
  }
}

function emptyState(currentVersion: string): UpdaterStateSnapshot {
  return { schemaVersion: 1, currentVersion, state: "idle", attempts: {} };
}

function positive(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive safe integer`);
  return value;
}
