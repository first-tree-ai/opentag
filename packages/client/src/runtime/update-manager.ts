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

export type UpdaterRecoveryStatus = "upgrade_required" | "authentication_repair" | "retryable_connectivity";

/** Persisted updater status, also the source for `daemon status` update reporting. */
export interface UpdaterStateSnapshot {
  schemaVersion: 1;
  currentVersion: string;
  state: UpdaterStateName;
  recoveryStatus?: UpdaterRecoveryStatus;
  target?: string;
  lastAttempt?: UpdaterAttempt;
  attempts: Record<string, UpdaterAttempt>;
}

/**
 * Whether the supervisor can restart the service right now. `ready: true` with `uncertain` means the
 * check could not decide; the handoff proceeds because a broken check must never block every upgrade.
 */
export type HandoffReadiness = { ready: true; uncertain?: string } | { ready: false; reason: string };

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
   * Whether the upgrade may interrupt running work. Absent or false means the updater waits for
   * protected work before installing.
   */
  canInterruptWork?(): boolean;
  /**
   * Atomically close new-work admission, before the handoff or the protected-work wait. The returned
   * function reopens admission if the target is superseded or the attempt fails.
   */
  quiesce?(): () => void;
  /**
   * Install the exact target and refresh the daemon service definition through the newly installed
   * binary. Resolves when the new version is live on disk; rejects with the failure reason.
   * Rejecting with `{ transient: true }` marks a pre-stage download failure that withdraws the
   * attempt and retries with bounded exponential backoff instead of blocking the target.
   */
  executeUpdate(target: string): Promise<void>;
  /**
   * Hand the process off to the supervisor (reserved restart exit code) after a successful install.
   * Errors are logged and swallowed: the install already succeeded and must not be re-attempted.
   */
  onHandoff(): void | Promise<void>;
  /**
   * Checked after a successful install, before admission closes for the handoff. While it reports
   * not ready, the running version keeps serving work and the check repeats; a rejection or an
   * uncertain answer hands off immediately. Absent means the supervisor can always restart.
   */
  handoffReadiness?(): Promise<HandoffReadiness>;
  /** Re-check cadence while the handoff is deferred. */
  handoffRetryIntervalMs?: number;
  /** Longest handoff deferral; after it the handoff proceeds even if the check still reports not ready. */
  maxHandoffDeferralMs?: number;
  loadState(): Promise<UpdaterStateSnapshot | undefined>;
  saveState(state: UpdaterStateSnapshot): Promise<void>;
  /** Re-check cadence of the protected-work wait. This is a poll interval, never a force timeout. */
  checkIntervalMs?: number;
  /** Read the configured release channel without relying on a runtime heartbeat. */
  discoverTarget?: () => Promise<RuntimeChannelTarget | undefined>;
  /** Successful release discovery cadence. Failed reads use bounded exponential backoff. */
  discoveryIntervalMs?: number;
  discoveryMaxBackoffMs?: number;
  /** Initial backoff after a transient download failure before staging. */
  installRetryIntervalMs?: number;
  /** Maximum backoff after repeated transient download failures. */
  installRetryMaxBackoffMs?: number;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

const DEFAULT_CHECK_INTERVAL_MS = 5_000;
const DEFAULT_DISCOVERY_INTERVAL_MS = 300_000;
const DEFAULT_DISCOVERY_MAX_BACKOFF_MS = 1_800_000;
const DEFAULT_INSTALL_RETRY_INTERVAL_MS = 5_000;
const DEFAULT_HANDOFF_RETRY_INTERVAL_MS = 300_000;
const DEFAULT_MAX_HANDOFF_DEFERRAL_MS = 86_400_000;
const QUIET_LOG_THROTTLE_MS = 60_000;

const defaultSleep = (milliseconds: number): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref();
  });

/**
 * Drives automatic upgrades for the portable install mode. One decision loop, one durable attempt
 * per exact target, and monotonic SemVer comparisons only (never an automatic downgrade). The
 * upgrade interrupts running Sessions, because the restarted daemon recovers them; `quiesce` closes
 * admission only for the handoff itself. When the connected Server could not recover them
 * (`canInterruptWork` is false), the updater closes admission and waits for protected work instead.
 *
 * npm-global installs never attach a manager: they upgrade only through the manual CLI command.
 */
export class UpdateManager {
  readonly #options: UpdateManagerOptions;
  readonly #logger: ClientLogger;
  readonly #now: () => number;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #checkIntervalMs: number;
  readonly #discoveryIntervalMs: number;
  readonly #discoveryMaxBackoffMs: number;
  readonly #installRetryIntervalMs: number;
  readonly #installRetryMaxBackoffMs: number;
  readonly #handoffRetryIntervalMs: number;
  readonly #maxHandoffDeferralMs: number;
  #latestTarget?: string;
  #deciding?: Promise<void>;
  #stopped = false;
  #blockedLoggedTarget?: string;
  #discoveryStarted = false;
  #discoveryFailures = 0;
  #discoveryTimer?: ReturnType<typeof setTimeout>;
  #discoveryInFlight?: Promise<boolean>;
  #installFailures = 0;
  #installRetryTimer?: ReturnType<typeof setTimeout>;
  #recoveryKeepAlive = 0;
  #stateWriteTail: Promise<void> = Promise.resolve();
  /** A target installed by this process whose handoff waits for the supervisor. */
  #deferredHandoff?: { target: string; since: number };
  #wakeHandoffRetry?: () => void;

  constructor(options: UpdateManagerOptions) {
    this.#options = options;
    this.#logger = (options.logger ?? createLogger("updater")).child({ channel: options.channel });
    this.#now = options.now ?? Date.now;
    this.#sleep = options.sleep ?? defaultSleep;
    this.#checkIntervalMs = positive(options.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS, "checkIntervalMs");
    this.#discoveryIntervalMs = positive(
      options.discoveryIntervalMs ?? DEFAULT_DISCOVERY_INTERVAL_MS,
      "discoveryIntervalMs",
    );
    this.#discoveryMaxBackoffMs = positive(
      options.discoveryMaxBackoffMs ?? DEFAULT_DISCOVERY_MAX_BACKOFF_MS,
      "discoveryMaxBackoffMs",
    );
    this.#installRetryIntervalMs = positive(
      options.installRetryIntervalMs ?? DEFAULT_INSTALL_RETRY_INTERVAL_MS,
      "installRetryIntervalMs",
    );
    this.#installRetryMaxBackoffMs = positive(
      options.installRetryMaxBackoffMs ?? this.#discoveryMaxBackoffMs,
      "installRetryMaxBackoffMs",
    );
    this.#handoffRetryIntervalMs = positive(
      options.handoffRetryIntervalMs ?? DEFAULT_HANDOFF_RETRY_INTERVAL_MS,
      "handoffRetryIntervalMs",
    );
    this.#maxHandoffDeferralMs = positive(
      options.maxHandoffDeferralMs ?? DEFAULT_MAX_HANDOFF_DEFERRAL_MS,
      "maxHandoffDeferralMs",
    );
  }

  /**
   * Reconcile durable status with the binary that actually started. This runs once before runtime
   * traffic begins, so `daemon status` always has a current version even when no update has ever
   * been advertised. If a previously blocked/installed target is now the running version, the
   * supervisor handoff (or a manual restart) succeeded and that record converges to installed.
   */
  async syncRunningVersion(): Promise<void> {
    try {
      await this.#withStateLock(async () => {
        const stored = await this.#options.loadState();
        const state = stored ?? emptyState(this.#options.currentVersion);
        const changed = stored === undefined || reconcileStoredState(state, this.#options.currentVersion, this.#now());
        if (changed) await this.#options.saveState(state);
      });
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
    if (advertisement.version === this.#options.currentVersion) {
      this.#latestTarget = advertisement.version;
      this.#installFailures = 0;
      this.#clearInstallRetry();
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
    const comparison = compareSemVer(advertisement.version, this.#options.currentVersion);
    if (comparison < 0) {
      // Monotonic forward motion only: an older advertisement is never an automatic downgrade.
      this.#logger.info(
        { current: this.#options.currentVersion, target: advertisement.version },
        "Server target is older than the running version; ignoring it",
      );
      return;
    }
    if (this.#latestTarget === advertisement.version) return;
    if (this.#latestTarget && compareSemVer(advertisement.version, this.#latestTarget) < 0) return;
    this.#latestTarget = advertisement.version;
    this.#installFailures = 0;
    this.#clearInstallRetry();
    this.#logger.info(
      { current: this.#options.currentVersion, target: advertisement.version },
      "Server advertised a newer channel target",
    );
    this.#wakeHandoffRetry?.();
    this.#startDecision();
  }

  /** Start the single heartbeat-independent release discovery loop. */
  startDiscovery(): void {
    if (this.#stopped || !this.#options.discoverTarget || this.#discoveryStarted) return;
    this.#discoveryStarted = true;
    this.#scheduleDiscovery(0);
  }

  /** Trigger one coalesced metadata read, for example after a capability rejection. */
  async discoverNow(): Promise<void> {
    if (this.#stopped || !this.#options.discoverTarget) return;
    if (this.#discoveryTimer) {
      clearTimeout(this.#discoveryTimer);
      this.#discoveryTimer = undefined;
    }
    await this.#runDiscovery();
    if (this.#discoveryStarted && !this.#stopped) this.#scheduleDiscovery(this.#nextDiscoveryDelay());
  }

  /** Keep the discovery loop referenced while the daemon waits for recovery. */
  holdRecoveryAlive(): () => void {
    if (this.#stopped || !this.#options.discoverTarget) return () => undefined;
    this.#recoveryKeepAlive += 1;
    this.#discoveryTimer?.ref?.();
    this.#installRetryTimer?.ref?.();
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.#recoveryKeepAlive = Math.max(0, this.#recoveryKeepAlive - 1);
      if (this.#recoveryKeepAlive === 0) {
        this.#discoveryTimer?.unref?.();
        this.#installRetryTimer?.unref?.();
      }
    };
  }

  /** Persist a local recovery diagnosis without changing the install-attempt state machine. */
  async recordRecoveryStatus(status: UpdaterRecoveryStatus | undefined): Promise<void> {
    try {
      await this.#withStateLock(async () => {
        const stored = await this.#options.loadState();
        const state = stored ?? emptyState(this.#options.currentVersion);
        if (state.recoveryStatus === status) return;
        if (status === undefined) delete state.recoveryStatus;
        else state.recoveryStatus = status;
        await this.#options.saveState(state);
      });
    } catch (error) {
      this.#logger.warn(
        { error: error instanceof Error ? error.message : String(error), status },
        "Automatic upgrade recovery status could not be recorded",
      );
    }
  }

  async #recordSatisfiedTarget(target: string): Promise<void> {
    await this.#withStateLock(() => this.#recordSatisfiedTargetUnlocked(target));
  }

  async #recordSatisfiedTargetUnlocked(target: string): Promise<void> {
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
    this.#wakeHandoffRetry?.();
    if (this.#discoveryTimer) clearTimeout(this.#discoveryTimer);
    this.#discoveryTimer = undefined;
    this.#clearInstallRetry();
  }

  #startDecision(): void {
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

  #clearInstallRetry(): void {
    if (this.#installRetryTimer) clearTimeout(this.#installRetryTimer);
    this.#installRetryTimer = undefined;
  }

  #scheduleInstallRetry(delay: number): void {
    if (this.#stopped) return;
    this.#clearInstallRetry();
    const timer = setTimeout(() => {
      this.#installRetryTimer = undefined;
      if (this.#stopped) return;
      if (this.#deciding) {
        void this.#deciding.finally(() => {
          if (!this.#stopped) this.#startDecision();
        });
        return;
      }
      this.#startDecision();
    }, delay);
    this.#installRetryTimer = timer;
    if (this.#recoveryKeepAlive > 0) timer.ref?.();
    else timer.unref?.();
  }

  #nextInstallRetryDelay(): number {
    const exponent = Math.min(Math.max(0, this.#installFailures - 1), 10);
    const backoff = this.#installRetryIntervalMs * 2 ** exponent;
    return Math.min(this.#installRetryMaxBackoffMs, backoff);
  }

  #scheduleDiscovery(delay: number): void {
    if (this.#stopped || !this.#discoveryStarted || !this.#options.discoverTarget) return;
    if (this.#discoveryTimer) clearTimeout(this.#discoveryTimer);
    const timer = setTimeout(() => {
      this.#discoveryTimer = undefined;
      void this.#runDiscovery().then(() => {
        if (!this.#stopped) this.#scheduleDiscovery(this.#nextDiscoveryDelay());
      });
    }, delay);
    this.#discoveryTimer = timer;
    if (this.#recoveryKeepAlive > 0) timer.ref?.();
    else timer.unref?.();
  }

  #nextDiscoveryDelay(): number {
    if (this.#discoveryFailures === 0) return this.#discoveryIntervalMs;
    const backoff = this.#discoveryIntervalMs * 2 ** Math.min(this.#discoveryFailures, 5);
    return Math.min(this.#discoveryMaxBackoffMs, backoff);
  }

  #runDiscovery(): Promise<boolean> {
    if (this.#discoveryInFlight) return this.#discoveryInFlight;
    const discoverTarget = this.#options.discoverTarget;
    if (!discoverTarget || this.#stopped) return Promise.resolve(false);
    this.#discoveryInFlight = (async () => {
      try {
        const target = await discoverTarget();
        this.#discoveryFailures = 0;
        if (target) this.observe(target);
        this.#logger.debug(
          { discovered: target !== undefined, version: target?.version },
          "Portable release metadata discovery completed",
        );
        return true;
      } catch (error) {
        this.#discoveryFailures = Math.min(this.#discoveryFailures + 1, 31);
        this.#logger.warn(
          {
            backoffMs: this.#nextDiscoveryDelay(),
            error: error instanceof Error ? error.message : String(error),
          },
          "Portable release metadata discovery failed; retry is bounded",
        );
        return false;
      } finally {
        this.#discoveryInFlight = undefined;
      }
    })();
    return this.#discoveryInFlight;
  }

  async #decide(): Promise<void> {
    while (!this.#stopped) {
      await this.#withStateLock(() => this.#decideTarget());
      const deferred = this.#deferredHandoff;
      if (!deferred || this.#stopped) return;
      // The deferral runs outside the state lock so recovery diagnostics keep recording meanwhile.
      const decidedTarget = this.#latestTarget;
      if ((await this.#awaitHandoffReadiness(deferred, decidedTarget)) === "superseded") continue;
      if (this.#stopped) return;
      const handedOff = await this.#withStateLock(() => this.#completeDeferredHandoff(deferred, decidedTarget));
      if (handedOff) return;
    }
  }

  async #decideTarget(): Promise<void> {
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
    if (target === this.#options.currentVersion) {
      await this.#recordSatisfiedTargetUnlocked(target);
      return true;
    }
    const comparison = compareSemVer(target, this.#options.currentVersion);
    return comparison < 0;
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
    let resumeAdmission: (() => void) | undefined;
    let keepQuiesced = false;
    try {
      if (!this.#canInterruptWork()) {
        state.state = "awaiting_protected_work";
        state.target = target;
        await this.#options.saveState(state);
        resumeAdmission = this.#options.quiesce?.() ?? (() => undefined);
        await this.#waitForProtectedWork(target);
        if (this.#canInterruptWork()) {
          // Recovery became available: new work no longer has to wait through the install.
          resumeAdmission();
          resumeAdmission = undefined;
        }
      }
      const cancelled = this.#cancellation(target);
      if (cancelled) return cancelled;
      const previousAttempt = state.lastAttempt;
      const started = await this.#recordStartedAttempt(target, state);
      const cancelledDuringWrite = this.#cancellation(target);
      if (cancelledDuringWrite) {
        await this.#withdrawAttempt(target, state, previousAttempt);
        return cancelledDuringWrite;
      }
      // Without a wait there is nothing to drain: Sessions keep running and new work keeps arriving
      // through the install, and a failed install costs them nothing.
      const outcome = await this.#executeAttempt(
        target,
        state,
        started,
        previousAttempt,
        resumeAdmission !== undefined,
      );
      if (outcome !== "installed") return outcome;
      // Deferring returns with admission reopened: the running version keeps serving meanwhile.
      const deferral = this.#options.handoffReadiness ? await this.#deferHandoff(target) : "handoff";
      if (deferral !== "handoff") return deferral;
      this.#deferredHandoff = undefined;
      resumeAdmission ??= this.#options.quiesce?.() ?? (() => undefined);
      keepQuiesced = true;
      await this.#requestHandoff(target);
      return "finished";
    } finally {
      if (!keepQuiesced) resumeAdmission?.();
    }
  }

  #canInterruptWork(): boolean {
    return this.#options.canInterruptWork?.() ?? false;
  }

  /** Why a new attempt must not start: the awaits before it can outlive a stop or a newer target. */
  #cancellation(target: string): "finished" | "superseded" | undefined {
    if (this.#stopped) return "finished";
    return this.#latestTarget === target ? undefined : "superseded";
  }

  /**
   * Remove an attempt whose install never staged or activated changes. Left in place, it would read
   * as an interrupted attempt after a restart and block this target.
   */
  async #withdrawAttempt(
    target: string,
    state: UpdaterStateSnapshot,
    previous: UpdaterAttempt | undefined,
  ): Promise<boolean> {
    delete state.attempts[target];
    state.state = "idle";
    if (previous) state.lastAttempt = previous;
    else delete state.lastAttempt;
    try {
      await this.#options.saveState(state);
      return true;
    } catch (error) {
      this.#logger.warn(
        { target, error: error instanceof Error ? error.message : String(error) },
        "An attempt whose install never started could not be withdrawn; the target stays blocked",
      );
      return false;
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

  async #executeAttempt(
    target: string,
    state: UpdaterStateSnapshot,
    started: UpdaterAttempt,
    previousAttempt: UpdaterAttempt | undefined,
    quiesced: boolean,
  ): Promise<"installed" | "finished" | "superseded"> {
    try {
      await this.#options.executeUpdate(target);
    } catch (error) {
      const failureReason = error instanceof Error ? error.message : String(error);
      // Only withdraw and schedule background retries when the attempt ran without pausing
      // admission (`runtime.sessionRecovery` active). When the fallback path had to quiesce and
      // drain protected work first, the installer has already run its bounded in-attempt download
      // retries; repeating full attempts would repeatedly pause admission for the same target.
      if (isTransientUpdateError(error) && !quiesced && this.#canInterruptWork()) {
        return this.#retryTransientAttempt(target, state, previousAttempt, failureReason);
      }
      this.#installFailures = 0;
      this.#clearInstallRetry();
      started.finishedAt = new Date(this.#now()).toISOString();
      started.result = "failed";
      started.failureReason = failureReason;
      state.state = "blocked";
      state.lastAttempt = started;
      await this.#options.saveState(state);
      this.#logger.warn(
        { target, failureReason: started.failureReason },
        "Automatic upgrade attempt failed; blocked until a new target or a manual upgrade",
      );
      return this.#cancellation(target) ?? "finished";
    }
    this.#installFailures = 0;
    this.#clearInstallRetry();
    started.finishedAt = new Date(this.#now()).toISOString();
    started.result = "installed";
    state.state = "installed";
    state.lastAttempt = started;
    try {
      await this.#options.saveState(state);
    } catch (error) {
      this.#logger.warn(
        { target, error: error instanceof Error ? error.message : String(error) },
        "The update was installed but its durable state could not be recorded; continuing supervisor handoff",
      );
    }
    return "installed";
  }

  async #retryTransientAttempt(
    target: string,
    state: UpdaterStateSnapshot,
    previousAttempt: UpdaterAttempt | undefined,
    failureReason: string,
  ): Promise<"finished" | "superseded"> {
    const withdrawn = await this.#withdrawAttempt(target, state, previousAttempt);
    if (!withdrawn) return "finished";
    const cancelled = this.#cancellation(target);
    if (cancelled) return cancelled;
    this.#installFailures = Math.min(this.#installFailures + 1, 31);
    const backoffMs = this.#nextInstallRetryDelay();
    this.#scheduleInstallRetry(backoffMs);
    this.#logger.warn(
      { target, backoffMs, failureReason },
      "Automatic upgrade download failed transiently; attempt withdrawn and retry scheduled",
    );
    return "finished";
  }

  /**
   * Check once right after the install. Anything but `handoff` records the handoff as owed: a stop or
   * a newer target observed during the asynchronous check must not hand off this target now.
   */
  async #deferHandoff(target: string): Promise<"handoff" | "finished" | "superseded"> {
    const readiness = await this.#readHandoffReadiness(target, false);
    // A deferral superseded by this newer install keeps its start, so the bound covers the whole wait.
    const since = this.#deferredHandoff?.since ?? this.#now();
    const cancelled = this.#cancellation(target);
    if (!cancelled && (readiness.ready || this.#deferralExpired(target, readiness.reason, since))) return "handoff";
    this.#deferredHandoff = { target, since };
    if (cancelled) return cancelled;
    if (!readiness.ready) this.#logDeferral(target, readiness.reason, since);
    return "finished";
  }

  /**
   * Retry a deferred handoff while the supervisor reports that it cannot restart the service, for
   * example a launchd GUI domain in on-demand-only mode. The new version is already live on disk, so
   * deferring only delays it. A stop or a newly observed target interrupts the wait, and the
   * deferral is bounded.
   */
  async #awaitHandoffReadiness(
    deferred: { target: string; since: number },
    decidedTarget: string | undefined,
  ): Promise<"ready" | "superseded"> {
    while (!this.#stopped) {
      await this.#sleepUntilWoken(this.#handoffRetryIntervalMs);
      if (this.#stopped) break;
      if (this.#latestTarget !== decidedTarget) return "superseded";
      const readiness = await this.#readHandoffReadiness(deferred.target, true);
      if (this.#stopped) break;
      if (this.#latestTarget !== decidedTarget) return "superseded";
      if (readiness.ready || this.#deferralExpired(deferred.target, readiness.reason, deferred.since)) break;
      this.#logDeferral(deferred.target, readiness.reason, deferred.since);
    }
    return "ready";
  }

  /**
   * Hand off a deferred install. False keeps the handoff owed and returns to the decision loop: a newer
   * target arrived, or the supervisor became unavailable again while protected work drained.
   */
  async #completeDeferredHandoff(
    deferred: { target: string; since: number },
    decidedTarget: string | undefined,
  ): Promise<boolean> {
    if (this.#stopped) return true;
    if (this.#latestTarget !== decidedTarget) return false;
    const resumeAdmission = this.#options.quiesce?.() ?? (() => undefined);
    if (!this.#canInterruptWork()) {
      const drained = await this.#drainForDeferredHandoff(deferred, decidedTarget);
      if (drained !== "handoff") {
        resumeAdmission();
        return drained === "stopped";
      }
    }
    this.#deferredHandoff = undefined;
    await this.#requestHandoff(deferred.target);
    return true;
  }

  /**
   * Admission reopened during the deferral, so drain the work it accepted. The drain has no time
   * limit, so the supervisor is checked again before handing off.
   */
  async #drainForDeferredHandoff(
    deferred: { target: string; since: number },
    decidedTarget: string | undefined,
  ): Promise<"handoff" | "retry" | "stopped"> {
    await this.#waitForProtectedWork(deferred.target);
    if (this.#stopped) return "stopped";
    if (this.#latestTarget !== decidedTarget) return "retry";
    const readiness = await this.#readHandoffReadiness(deferred.target, false);
    if (this.#stopped) return "stopped";
    if (this.#latestTarget !== decidedTarget) return "retry";
    if (readiness.ready || this.#deferralExpired(deferred.target, readiness.reason, deferred.since)) return "handoff";
    this.#logDeferral(deferred.target, readiness.reason, deferred.since);
    return "retry";
  }

  #deferralExpired(target: string, reason: string, since: number): boolean {
    const deferredMs = this.#now() - since;
    if (deferredMs < this.#maxHandoffDeferralMs) return false;
    this.#logger.warn(
      { target, reason, deferredMs },
      "Supervisor still reports that it cannot restart the service after the maximum deferral; handing off anyway",
    );
    return true;
  }

  #logDeferral(target: string, reason: string, since: number): void {
    this.#logger.warn(
      { target, reason, deferredMs: this.#now() - since, retryMs: this.#handoffRetryIntervalMs },
      "Supervisor cannot restart the service now; keeping the running version and retrying the handoff later",
    );
  }

  async #sleepUntilWoken(milliseconds: number): Promise<void> {
    let wake!: () => void;
    const woken = new Promise<void>((resolve) => {
      wake = resolve;
    });
    this.#wakeHandoffRetry = wake;
    try {
      await Promise.race([this.#sleep(milliseconds), woken]);
    } finally {
      if (this.#wakeHandoffRetry === wake) this.#wakeHandoffRetry = undefined;
    }
  }

  /** A failed or uncertain check reads as ready: a broken check must never block every upgrade. */
  async #readHandoffReadiness(target: string, deferred: boolean): Promise<HandoffReadiness> {
    const check = this.#options.handoffReadiness;
    if (!check) return { ready: true };
    let readiness: HandoffReadiness;
    try {
      readiness = await check();
    } catch (error) {
      this.#logger.warn(
        { target, error: error instanceof Error ? error.message : String(error) },
        "Supervisor restart readiness could not be checked; continuing the handoff",
      );
      return { ready: true };
    }
    if (readiness.ready && readiness.uncertain) {
      this.#logger.warn(
        { target, detail: readiness.uncertain },
        "Supervisor restart readiness is uncertain; continuing the handoff",
      );
    } else if (readiness.ready && deferred) {
      this.#logger.info({ target }, "Supervisor can restart the service again; continuing the deferred handoff");
    }
    return readiness;
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
   * The fallback while the connected Server could not recover interrupted work: wait for the Session
   * module to report no protected work, or for that to change (a reconnect or a Server upgrade). There
   * is no force timeout here, because an interruption would surface as a failure. The wait is
   * re-checked on a fixed cadence and logged at a throttled rate.
   */
  async #waitForProtectedWork(target: string): Promise<void> {
    let lastLogAt = Number.NEGATIVE_INFINITY;
    while (!this.#stopped) {
      const work = this.#options.protectedWork();
      if (work.total === 0 || this.#canInterruptWork()) return;
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

  // Serialize complete load-modify-save lifetimes so recovery diagnostics cannot overwrite a newer attempt.
  async #withStateLock<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.#stateWriteTail;
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(
      () => current,
      () => current,
    );
    this.#stateWriteTail = queued;
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.#stateWriteTail === queued) this.#stateWriteTail = Promise.resolve();
    }
  }
}

function emptyState(currentVersion: string): UpdaterStateSnapshot {
  return { schemaVersion: 1, currentVersion, state: "idle", attempts: {} };
}

function reconcileRunningVersion(state: UpdaterStateSnapshot, currentVersion: string): boolean {
  if (state.currentVersion === currentVersion) return false;
  state.currentVersion = currentVersion;
  delete state.recoveryStatus;
  return true;
}

function reconcileStoredState(state: UpdaterStateSnapshot, currentVersion: string, now: number): boolean {
  let changed = reconcileRunningVersion(state, currentVersion);
  if (!state.target) return changed;
  const comparison = compareSemVer(state.target, currentVersion);
  if (state.target === currentVersion && state.state !== "installed") {
    state.state = "installed";
    const attempt = state.attempts[state.target];
    if (attempt) {
      attempt.finishedAt ??= new Date(now).toISOString();
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
  return changed;
}

function positive(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive safe integer`);
  return value;
}

function isTransientUpdateError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "transient" in error &&
    (error as { transient?: unknown }).transient === true
  );
}
