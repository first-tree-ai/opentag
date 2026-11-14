import { createHash } from "node:crypto";
import { and, asc, eq, gt, isNotNull, isNull, lt, or, sql } from "drizzle-orm";
import type { DatabaseClient } from "../../db/client.js";
import { agents, computers, imBindings } from "../../db/schema/index.js";
import type { ServiceLogger } from "../../observability/service-logger.js";
import { computerOfflineAlertText, computerRecoveredText } from "../im/im-feedback-card-copy.js";
import type { FeedbackLanguage } from "../im/im-feedback-copy.js";
import { type DirectTextTarget, FeedbackProviderError } from "../im/im-feedback-messenger.js";
import type { ImBindingService } from "../im-bindings/index.js";
import { COMPUTER_PRESENCE_TIMEOUT_MS } from "./cloud-computer.js";

const PAGE_SIZE = 100;
/** Pages one alert pass may read; reserved Computers leave the candidate set, so later passes continue. */
const MAX_ALERT_PAGES = 10;
const DEFAULT_INTERVAL_MS = 60_000;
/**
 * Offline periods that began longer ago than this never alert. Without the bound, the first sweep after this
 * feature ships, or after the threshold is raised, would alert for every Computer that went quiet long ago.
 */
const MAX_ALERT_AGE_MS = 24 * 60 * 60_000;

export interface OfflineAlertCandidate {
  id: string;
  displayName: string;
  lastSeenAt: Date;
}

export interface RecoveryCandidate {
  id: string;
  displayName: string;
  periodStart: Date;
  bindingId: string | null;
  connectedAt: Date | null;
  online: boolean;
}

export interface AlertSender {
  bindingId: string;
  provider: "feishu" | "slack";
  ownerExternalUserId: string;
  teamBrand: string | null;
}

/**
 * Durable state of the owner's offline alert, on the Computer row. `offline_alert_period_start` is the frozen
 * `last_seen_at` of the period that was alerted; every transition is one conditional UPDATE whose RETURNING row
 * is the only permission to send, so Server instances and restarts never repeat an alert or a recovery notice.
 * A reservation commits before provider I/O: a crash loses a message rather than repeating it.
 */
export class ComputerOfflineAlertStore {
  constructor(readonly database: DatabaseClient) {}

  /** Local Computers that connected before and have been offline past the threshold, with no alert reserved. */
  async offlineCandidates(now: Date, thresholdMs: number): Promise<OfflineAlertCandidate[]> {
    const rows = await this.database
      .select({ id: computers.id, displayName: computers.displayName, lastSeenAt: computers.lastSeenAt })
      .from(computers)
      .where(offlineSince(now, thresholdMs))
      .orderBy(asc(computers.lastSeenAt), asc(computers.id))
      .limit(PAGE_SIZE);
    return rows.flatMap((row) => (row.lastSeenAt ? [{ ...row, lastSeenAt: row.lastSeenAt }] : []));
  }

  /**
   * The Bot that reaches the Computer's owner: the oldest active Agent on it that the owner created, with an
   * active binding whose authorizing IM user is known. Bindings created before that identity was recorded have
   * none and are never asked to reauthorize for it.
   */
  async sender(computerId: string): Promise<AlertSender | undefined> {
    const [row] = await this.database
      .select({
        bindingId: imBindings.id,
        provider: imBindings.provider,
        ownerExternalUserId: imBindings.ownerExternalUserId,
        teamBrand: imBindings.externalTeamBrand,
      })
      .from(agents)
      .innerJoin(computers, eq(computers.id, agents.computerId))
      .innerJoin(imBindings, eq(imBindings.agentId, agents.id))
      .where(
        and(
          eq(agents.computerId, computerId),
          eq(agents.status, "active"),
          eq(agents.createdByUserId, computers.ownerAccountId),
          eq(imBindings.status, "active"),
          isNotNull(imBindings.ownerExternalUserId),
        ),
      )
      .orderBy(asc(agents.createdAt), asc(agents.id))
      .limit(1);
    if (!row?.ownerExternalUserId) return undefined;
    return { ...row, ownerExternalUserId: row.ownerExternalUserId };
  }

  /**
   * Reserves the alert of the current offline period; eligibility is evaluated again by the UPDATE itself. A
   * Computer whose owner cannot be reached is reserved without a Bot, so it leaves the candidate set for the
   * whole period instead of filling every page.
   */
  async reserveAlert(
    computerId: string,
    bindingId: string | null,
    now: Date,
    thresholdMs: number,
  ): Promise<Date | undefined> {
    const [reserved] = await this.database
      .update(computers)
      .set({ offlineAlertPeriodStart: sql`${computers.lastSeenAt}`, offlineAlertBindingId: bindingId })
      .where(and(eq(computers.id, computerId), offlineSince(now, thresholdMs)))
      .returning({ periodStart: computers.offlineAlertPeriodStart });
    return reserved?.periodStart ?? undefined;
  }

  /** Gives back an alert the provider definitely did not deliver, so a later pass may try again. */
  async releaseAlert(computerId: string, periodStart: Date): Promise<void> {
    await this.database
      .update(computers)
      .set({ offlineAlertPeriodStart: null, offlineAlertBindingId: null })
      .where(and(eq(computers.id, computerId), eq(computers.offlineAlertPeriodStart, periodStart)));
  }

  /** Keeps the period alerted but drops its Bot, so a rejected alert gets no recovery notice either. */
  async forgetAlertBinding(computerId: string, periodStart: Date): Promise<void> {
    await this.database
      .update(computers)
      .set({ offlineAlertBindingId: null })
      .where(and(eq(computers.id, computerId), eq(computers.offlineAlertPeriodStart, periodStart)));
  }

  /** Puts back a recovery notice the provider definitely did not deliver, unless a new period began meanwhile. */
  async restoreAlert(computerId: string, periodStart: Date, bindingId: string): Promise<void> {
    await this.database
      .update(computers)
      .set({ offlineAlertPeriodStart: periodStart, offlineAlertBindingId: bindingId })
      .where(
        and(
          eq(computers.id, computerId),
          isNull(computers.offlineAlertPeriodStart),
          isNull(computers.deletedAt),
          isNull(computers.disconnectedAt),
        ),
      );
  }

  /**
   * Computers with an outstanding alert that reconnected, or that can no longer be helped by a recovery notice
   * (deleted or revoked). A reconnect rewrites `last_seen_at` past the alerted period.
   */
  async recoveryCandidates(now: Date): Promise<RecoveryCandidate[]> {
    const online = and(
      isNull(computers.deletedAt),
      isNull(computers.disconnectedAt),
      isNotNull(computers.currentInstanceId),
      gt(computers.lastSeenAt, computers.offlineAlertPeriodStart),
      gt(computers.lastSeenAt, new Date(now.getTime() - COMPUTER_PRESENCE_TIMEOUT_MS)),
    );
    const rows = await this.database
      .select({
        id: computers.id,
        displayName: computers.displayName,
        periodStart: computers.offlineAlertPeriodStart,
        bindingId: computers.offlineAlertBindingId,
        connectedAt: computers.connectedAt,
        online: sql<boolean>`coalesce(${online}, false)`,
      })
      .from(computers)
      .where(
        and(
          isNotNull(computers.offlineAlertPeriodStart),
          or(online, isNotNull(computers.deletedAt), isNotNull(computers.disconnectedAt)),
        ),
      )
      .orderBy(asc(computers.id))
      .limit(PAGE_SIZE);
    return rows.flatMap((row) => (row.periodStart ? [{ ...row, periodStart: row.periodStart }] : []));
  }

  /** Ends the alerted period; only the instance whose UPDATE returns a row sends the recovery notice. */
  async clearAlert(computerId: string, periodStart: Date): Promise<boolean> {
    const cleared = await this.database
      .update(computers)
      .set({ offlineAlertPeriodStart: null, offlineAlertBindingId: null })
      .where(and(eq(computers.id, computerId), eq(computers.offlineAlertPeriodStart, periodStart)))
      .returning({ id: computers.id });
    return cleared.length > 0;
  }

  /** The stored Bot of an alert, if it can still send: active binding of an active Agent, with a known owner. */
  async storedSender(bindingId: string): Promise<AlertSender | undefined> {
    const [row] = await this.database
      .select({
        bindingId: imBindings.id,
        provider: imBindings.provider,
        ownerExternalUserId: imBindings.ownerExternalUserId,
        teamBrand: imBindings.externalTeamBrand,
      })
      .from(imBindings)
      .innerJoin(agents, eq(agents.id, imBindings.agentId))
      .where(and(eq(imBindings.id, bindingId), eq(imBindings.status, "active"), eq(agents.status, "active")))
      .limit(1);
    if (!row?.ownerExternalUserId) return undefined;
    return { ...row, ownerExternalUserId: row.ownerExternalUserId };
  }
}

/** Offline past the threshold, by the same rule the Web uses, within the alert age bound and not yet alerted. */
function offlineSince(now: Date, thresholdMs: number) {
  const cutoff = new Date(now.getTime() - Math.max(thresholdMs, COMPUTER_PRESENCE_TIMEOUT_MS));
  return and(
    eq(computers.kind, "local"),
    isNull(computers.deletedAt),
    isNull(computers.disconnectedAt),
    isNull(computers.offlineAlertPeriodStart),
    lt(computers.lastSeenAt, cutoff),
    gt(computers.lastSeenAt, new Date(now.getTime() - thresholdMs - MAX_ALERT_AGE_MS)),
  );
}

export interface ComputerOfflineAlertWorkerOptions {
  store: ComputerOfflineAlertStore;
  bindings: Pick<ImBindingService, "getFeishuConnectionMaterial" | "getSlackConnectionMaterial">;
  messenger: { postDirectText(target: DirectTextTarget, text: string, requestId: string): Promise<string> };
  publicUrl: string;
  /** Alert threshold; zero disables the worker. */
  thresholdMs: number;
  logger?: Pick<ServiceLogger, "info" | "warn">;
  intervalMs?: number;
  now?: () => Date;
}

/**
 * Messages a Computer's owner once when it has been offline past the threshold, and once more when it
 * reconnects, through a Bot of one of its Agents. Cloud Computers start and stop on demand and are never
 * alerted; Computers that never connected, deleted or revoked Computers, and inactive Agents are excluded.
 */
export class ComputerOfflineAlertWorker {
  readonly #options: ComputerOfflineAlertWorkerOptions;
  readonly #now: () => Date;
  #timer: ReturnType<typeof setInterval> | undefined;
  #running: Promise<void> | undefined;
  #stopped = false;

  constructor(options: ComputerOfflineAlertWorkerOptions) {
    this.#options = options;
    this.#now = options.now ?? (() => new Date());
  }

  get enabled(): boolean {
    return this.#options.thresholdMs > 0;
  }

  start(): void {
    if (!this.enabled) return;
    this.#timer = setInterval(() => void this.runOnce(), this.#options.intervalMs ?? DEFAULT_INTERVAL_MS);
    this.#timer.unref?.();
    void this.runOnce();
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer) clearInterval(this.#timer);
    await this.#running;
  }

  /** One pass; overlapping calls join the pass in flight. */
  runOnce(): Promise<void> {
    if (this.#stopped || !this.enabled) return Promise.resolve();
    this.#running ??= this.#pass().finally(() => {
      this.#running = undefined;
    });
    return this.#running;
  }

  async #pass(): Promise<void> {
    try {
      await this.#recoveries();
      await this.#alerts();
    } catch (error) {
      this.#options.logger?.warn(
        { code: "COMPUTER_OFFLINE_ALERT_PASS_FAILED", error: error instanceof Error ? error.message : String(error) },
        "Computer offline alert pass failed",
      );
    }
  }

  async #alerts(): Promise<void> {
    const now = this.#now();
    const seen = new Set<string>();
    for (let page = 0; page < MAX_ALERT_PAGES && !this.#stopped; page += 1) {
      const candidates = await this.#options.store.offlineCandidates(now, this.#options.thresholdMs);
      const fresh = candidates.filter((computer) => !seen.has(computer.id));
      for (const computer of fresh) {
        if (this.#stopped) return;
        seen.add(computer.id);
        await this.#alert(computer, now);
      }
      if (candidates.length < PAGE_SIZE || fresh.length === 0) return;
    }
  }

  async #alert(computer: OfflineAlertCandidate, now: Date): Promise<void> {
    const { store, thresholdMs } = this.#options;
    const sender = await store.sender(computer.id);
    const target = sender && (await this.#target(sender));
    const periodStart = await store.reserveAlert(computer.id, target ? sender.bindingId : null, now, thresholdMs);
    if (!periodStart) return;
    if (!sender || !target) {
      // Reserved without a Bot: logged by the one instance that reserved it, once per period.
      this.#options.logger?.info(
        { code: "COMPUTER_OFFLINE_ALERT_NO_OWNER_CONTACT", computerId: computer.id },
        "Computer is offline but none of its Agents has a Bot that can reach the owner",
      );
      return;
    }
    const text = computerOfflineAlertText(language(sender), {
      computerName: computer.displayName,
      offlineMs: now.getTime() - periodStart.getTime(),
      computersUrl: new URL("/agents/computers", this.#options.publicUrl).toString(),
    });
    await this.#send(target, text, `offline:${computer.id}:${periodStart.getTime()}`, {
      notSent: () => store.releaseAlert(computer.id, periodStart),
      rejected: () => store.forgetAlertBinding(computer.id, periodStart),
    });
  }

  async #recoveries(): Promise<void> {
    const now = this.#now();
    const { store } = this.#options;
    for (const computer of await store.recoveryCandidates(now)) {
      if (this.#stopped) return;
      if (!(await store.clearAlert(computer.id, computer.periodStart))) continue;
      const bindingId = computer.bindingId;
      if (!computer.online || !bindingId) continue;
      const sender = await store.storedSender(bindingId);
      const target = sender && (await this.#target(sender));
      if (!sender || !target) continue;
      const text = computerRecoveredText(language(sender), {
        computerName: computer.displayName,
        offlineMs: (computer.connectedAt ?? now).getTime() - computer.periodStart.getTime(),
      });
      await this.#send(target, text, `recovered:${computer.id}:${computer.periodStart.getTime()}`, {
        notSent: () => store.restoreAlert(computer.id, computer.periodStart, bindingId),
      });
    }
  }

  async #target(sender: AlertSender): Promise<DirectTextTarget | undefined> {
    if (sender.provider === "slack") {
      const material = await this.#options.bindings.getSlackConnectionMaterial(sender.bindingId);
      if (!material) return undefined;
      return {
        provider: "slack",
        bindingId: sender.bindingId,
        bindingGeneration: material.generation,
        installationId: material.installationId,
        userId: sender.ownerExternalUserId,
      };
    }
    const material = await this.#options.bindings.getFeishuConnectionMaterial(sender.bindingId);
    if (!material) return undefined;
    return {
      provider: "feishu",
      bindingId: sender.bindingId,
      bindingGeneration: material.generation,
      installationId: null,
      userId: sender.ownerExternalUserId,
    };
  }

  async #send(
    target: DirectTextTarget,
    text: string,
    key: string,
    onFailure: { notSent?: () => Promise<void>; rejected?: () => Promise<void> } = {},
  ): Promise<void> {
    try {
      await this.#options.messenger.postDirectText(target, text, requestId(key));
    } catch (error) {
      // Known not applied and retryable: a later pass may send it. Rejected: Feishu or Slack refused it for good.
      const known = error instanceof FeedbackProviderError && error.knownNotApplied;
      const notSent = known && !error.permanent;
      if (notSent) await onFailure.notSent?.();
      else if (known) await onFailure.rejected?.();
      this.#options.logger?.warn(
        {
          code: "COMPUTER_OFFLINE_ALERT_SEND_FAILED",
          bindingId: target.bindingId,
          provider: target.provider,
          errorCode: error instanceof FeedbackProviderError ? error.code : undefined,
          retried: notSent && onFailure.notSent !== undefined,
        },
        "Computer offline alert could not be sent",
      );
    }
  }
}

/** No per-person language is stored: Chinese for a Feishu workspace, English for Lark and Slack. */
function language(sender: AlertSender): FeedbackLanguage {
  return sender.provider === "feishu" && sender.teamBrand !== "lark" ? "zh" : "en";
}

/** Feishu's send idempotency key, at most 50 characters, stable for one message of one period. */
function requestId(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 32);
}
