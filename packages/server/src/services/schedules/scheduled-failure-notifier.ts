import { setTimeout as delay } from "node:timers/promises";
import type { AgentScheduleLastDispatch } from "@opentag/shared";
import { and, desc, eq, sql } from "drizzle-orm";
import type { DatabaseClient } from "../../db/client.js";
import {
  agentSchedules,
  imBindings,
  imMessages,
  sessionMessages,
  sessionPlacements,
  sessions,
} from "../../db/schema/index.js";
import type { ServiceLogger } from "../../observability/service-logger.js";
import { FEEDBACK_LABELS, type FeedbackLanguage, failureCopy, textLanguage } from "../im/im-feedback-copy.js";
import { FeedbackProviderError, type ImFeedbackMessenger } from "../im/im-feedback-messenger.js";
import { plainText, textLink } from "../im/im-feedback-text.js";
import type {
  RunOutcomeNoticeInput,
  RunOutcomeNoticeStatus,
  RunOutcomeNotifier,
  SessionCollaborationService,
} from "../sessions/session-collaboration-service.js";
import { runOutcomeNoticeMessageId } from "../sessions/session-run-outcome-notice.js";
import { formatScheduleLocal } from "./calculator.js";
import { scheduleDetailUrl } from "./service.js";

/*
 * Scheduled messages have no sender and no native IM input, so neither the sender notice nor the
 * IM failure message can report a failed occurrence. The Agent no longer posts a start message either
 * (issue #1352), so this is the one path that tells the conversation a scheduled task did not
 * finish: a plain message from the Session's own Bot, in the Session's own chat or thread.
 *
 * It writes nothing to the database. A failed Run is retried by its durable reporter, which
 * resends the report while this answers `retry`. A Local report frame never waits for the IM send:
 * it answers `retry`, the send runs in bounded background work, and a later report gets the result.
 * Cloud settlement waits for the answer, as it does for creator notices. A missed occurrence has no
 * reporter, so it gets a few attempts in this process; a Server stop or a long IM outage loses that
 * message, and the schedule's Web summary still shows the miss.
 */

/** The occurrence facts a failure message displays and routes by. */
export interface ScheduledOccurrence {
  agentId: string;
  name: string;
  /** Only decides the message's language, by the same rule as other IM failure messages. */
  prompt: string;
  scheduleId: string;
  scheduledFor: string;
  targetSessionId: string;
  timezone: string;
}

/**
 * `missed`: provably never reached the Agent. `unconfirmed`: the hand-off's fate is unknown.
 * `disabled`: missed, and the schedule turned itself off.
 */
export type ScheduledMissKind = "disabled" | "missed" | "unconfirmed";

export interface ScheduledMissNotices {
  notifyMissed(
    input: { occurrence: ScheduledOccurrence; kind: ScheduledMissKind; requestId: string },
    signal: AbortSignal,
  ): Promise<void>;
}

/** Owner or management actions: the person who caused them does not need telling. */
const SELF_INFLICTED_CODES: ReadonlySet<string> = new Set([
  "agent_deleted",
  "agent_suspended",
  "binding_invalid",
  "schedule_changed",
  "schedule_deleted",
  "schedule_disabled",
]);

/** Server-held delivery (#1353) answers with this while it may still deliver the occurrence. */
const STILL_DELIVERING_CODE = "delivery_held";

/** What the IM conversation hears about one dispatch or skip result, or nothing. */
export function scheduledMissKind(input: {
  outcome: AgentScheduleLastDispatch["outcome"];
  code: string | null;
  previous: AgentScheduleLastDispatch | null;
  disabled?: boolean;
}): ScheduledMissKind | undefined {
  // A null code on `unknown` is a duplicate dispatcher or a stop, neither of which is a failure.
  if (input.outcome === "accepted" || input.code === null || SELF_INFLICTED_CODES.has(input.code)) return undefined;
  if (input.code === STILL_DELIVERING_CODE) return undefined;
  if (input.disabled) return "disabled";
  // One cause, one message: a Computer offline overnight must not post on every occurrence.
  if (input.previous?.outcome === input.outcome && input.previous.code === input.code) return undefined;
  return input.outcome === "unknown" ? "unconfirmed" : "missed";
}

/** A schedule can be turned off for its stored timezone, so that timezone may not format. */
function scheduledTimeText(occurrence: ScheduledOccurrence): string {
  try {
    return `${formatScheduleLocal(new Date(occurrence.scheduledFor), occurrence.timezone)} (${occurrence.timezone})`;
  } catch {
    return `${occurrence.scheduledFor} (UTC)`;
  }
}

type Provider = "slack" | "feishu";

const TEXT = {
  subject: {
    zh: (name: string, time: string) => `定时任务“${name}”（计划时间 ${time}）`,
    en: (name: string, time: string) => `Scheduled task "${name}" (scheduled for ${time})`,
  },
  miss: {
    missed: {
      zh: ["没有运行。", "Agent 没有收到这次任务，所以没有执行任何操作，也不会补跑。", "请查看这个定时任务的状态。"],
      en: [
        "didn't run.",
        "The Agent never received it, so no operations were run, and it won't be rerun.",
        "Check the schedule's status.",
      ],
    },
    unconfirmed: {
      zh: [
        "可能没有运行。",
        "无法确认 Agent 是否收到了这次任务，所以可能已经执行了部分操作。",
        "先看看结果，再决定下一步。",
      ],
      en: [
        "may not have run.",
        "We can't confirm that the Agent received it, so some operations may have run.",
        "Check the results before deciding what to do next.",
      ],
    },
    disabled: {
      zh: [
        "没有运行，这个定时任务已被停用。",
        "Agent 没有收到这次任务，所以没有执行任何操作。",
        "恢复之前它不会再运行。",
      ],
      en: [
        "didn't run, and the schedule has been turned off.",
        "The Agent never received it, so no operations were run.",
        "It won't run again until someone resumes it.",
      ],
    },
  },
  runEffects: {
    zh: "可能已经执行了部分操作，也不会自动重跑。",
    en: "Some operations may already have run, and it won't be rerun automatically.",
  },
  runNext: { zh: "先看看结果，再决定下一步。", en: "Check the results before deciding what to do next." },
} satisfies Record<string, unknown>;

/** Same shape as other IM failure messages: what happened, whether operations ran, what to do next, and a link. */
function message(
  occurrence: ScheduledOccurrence,
  language: FeedbackLanguage,
  provider: Provider,
  publicUrl: string,
  [what, effects, next]: readonly [string, string, string],
): string {
  const link = textLink(
    provider,
    scheduleDetailUrl(publicUrl, occurrence.agentId, occurrence.scheduleId),
    FEEDBACK_LABELS.details[language],
  );
  return [what, effects, `${next} ${link}`].join("\n\n");
}

const subject = (occurrence: ScheduledOccurrence, language: FeedbackLanguage): string =>
  TEXT.subject[language](plainText(occurrence.name), scheduledTimeText(occurrence));

const RUN_OUTCOME_REASON = { timed_out: "turn_timeout", unknown: "turn_state_unknown" } as const;

export function renderRunFailure(
  occurrence: ScheduledOccurrence,
  outcome: Exclude<RunOutcomeNoticeInput["outcome"], "cancelled">,
  code: string,
  publicUrl: string,
  provider: Provider,
): string {
  const language = textLanguage(occurrence.prompt);
  const reason = outcome === "failed" ? code : RUN_OUTCOME_REASON[outcome];
  const separator = language === "zh" ? "：" : ": ";
  return message(occurrence, language, provider, publicUrl, [
    `${subject(occurrence, language)}${separator}${failureCopy(reason, language).cause}`,
    TEXT.runEffects[language],
    TEXT.runNext[language],
  ]);
}

export function renderMiss(
  occurrence: ScheduledOccurrence,
  kind: ScheduledMissKind,
  publicUrl: string,
  provider: Provider,
): string {
  const language = textLanguage(occurrence.prompt);
  const [what, effects, next] = TEXT.miss[kind][language] as unknown as [string, string, string];
  const space = language === "zh" ? "" : " ";
  return message(occurrence, language, provider, publicUrl, [
    `${subject(occurrence, language)}${space}${what}`,
    effects,
    next,
  ]);
}

const MISS_SEND_ATTEMPTS = 3;
const MISS_RETRY_DEFAULT_MS = 5_000;
const MISS_RETRY_MAX_MS = 30_000;
/** Matches the Local creator notices' limit: excess reports stay with their durable reporter. */
const MAX_BACKGROUND_SENDS = 16;
/** Enough to answer every report still in its retry backoff; a forgotten one may send again. */
const MAX_REMEMBERED_RESULTS = 1024;

interface ScheduledRunNotice {
  requestId: string;
  sessionId: string;
  render(provider: Provider): string;
}

type SendResult = { status: "sent" | "dropped" } | { status: "retry"; retryAfterMs?: number };

export interface ScheduledFailureNotifierOptions {
  database: DatabaseClient;
  logger?: Pick<ServiceLogger, "warn">;
  messenger: Pick<ImFeedbackMessenger, "postConversationText">;
  publicUrl: string;
  /** Reports for everything that is not a scheduled message on a visible Session. */
  runOutcomes: Pick<SessionCollaborationService, "notifyRunOutcome" | "notifyRunOutcomeInBackground">;
  retryDelayMs?: number;
}

export class ScheduledFailureNotifier implements RunOutcomeNotifier, ScheduledMissNotices {
  readonly #options: ScheduledFailureNotifierOptions;
  readonly #backgroundSends = new Map<string, Promise<void>>();
  readonly #results = new Map<string, RunOutcomeNoticeStatus>();
  #closing = false;

  constructor(options: ScheduledFailureNotifierOptions) {
    this.#options = options;
  }

  /** The Cloud entry: its settlement journal and bounded attempts wait for this answer. */
  async notifyRunOutcome(input: RunOutcomeNoticeInput): Promise<RunOutcomeNoticeStatus> {
    const scheduled = await this.#scheduledNotice(input);
    if (scheduled === undefined) return this.#options.runOutcomes.notifyRunOutcome(input);
    if (typeof scheduled === "string") return scheduled;
    return this.#runFailureStatus(await this.#send(scheduled.sessionId, scheduled.render, scheduled.requestId));
  }

  /** The Local entry. See the file comment; the reporter keeps its durable report throughout. */
  async notifyRunOutcomeInBackground(input: RunOutcomeNoticeInput): Promise<RunOutcomeNoticeStatus> {
    const scheduled = await this.#scheduledNotice(input);
    if (scheduled === undefined) return this.#options.runOutcomes.notifyRunOutcomeInBackground(input);
    if (typeof scheduled === "string") return scheduled;
    const remembered = this.#results.get(scheduled.requestId);
    if (remembered) return remembered;
    if (
      !this.#closing &&
      !this.#backgroundSends.has(scheduled.requestId) &&
      this.#backgroundSends.size < MAX_BACKGROUND_SENDS
    ) {
      const send = this.#sendInBackground(scheduled).finally(() => this.#backgroundSends.delete(scheduled.requestId));
      this.#backgroundSends.set(scheduled.requestId, send);
    }
    return "retry";
  }

  /** Stop starting background sends and wait for the running ones, each bounded by its provider call. */
  async close(): Promise<void> {
    this.#closing = true;
    await Promise.all(this.#backgroundSends.values());
  }

  async #sendInBackground(notice: ScheduledRunNotice): Promise<void> {
    const status = this.#runFailureStatus(await this.#send(notice.sessionId, notice.render, notice.requestId));
    if (status === "retry") return;
    if (this.#results.size >= MAX_REMEMBERED_RESULTS) {
      const oldest = this.#results.keys().next().value;
      if (oldest !== undefined) this.#results.delete(oldest);
    }
    this.#results.set(notice.requestId, status);
  }

  #runFailureStatus(sent: SendResult): RunOutcomeNoticeStatus {
    if (sent.status === "sent") return "notified";
    return sent.status === "retry" ? "retry" : "ignored";
  }

  /** The notice for a report, a final answer without a send, or undefined when it is not scheduled. */
  async #scheduledNotice(
    input: RunOutcomeNoticeInput,
  ): Promise<ScheduledRunNotice | RunOutcomeNoticeStatus | undefined> {
    let scheduled: { occurrence: ScheduledOccurrence; authorized: boolean } | undefined;
    try {
      scheduled = await this.#readScheduledRun(input);
      if (scheduled?.authorized && input.outcome !== "cancelled")
        await this.#recordRunFailure(scheduled.occurrence, input.reason);
    } catch {
      return "retry";
    }
    if (!scheduled) return undefined;
    // A stopped Run was stopped by someone; only the reporting placement may speak for the Session.
    if (input.outcome === "cancelled" || !scheduled.authorized) return "ignored";
    const { occurrence } = scheduled;
    const { outcome } = input;
    return {
      // Not the message id: that identifies this occurrence's earlier "may not have run" notice, and
      // Feishu would drop this failure as a repeat of it.
      requestId: runOutcomeNoticeMessageId(input.childSessionId, input.messageId),
      sessionId: scheduled.occurrence.targetSessionId,
      render: (provider) => renderRunFailure(occurrence, outcome, input.reason, this.#options.publicUrl, provider),
    };
  }

  async notifyMissed(
    input: { occurrence: ScheduledOccurrence; kind: ScheduledMissKind; requestId: string },
    signal: AbortSignal,
  ): Promise<void> {
    // It has no conversation. The miss stays in the schedule's summary, and nobody is messaged for it.
    if (await this.#targetIsInternal(input.occurrence.targetSessionId)) return;
    const render = (provider: Provider) => renderMiss(input.occurrence, input.kind, this.#options.publicUrl, provider);
    for (let attempt = 1; attempt <= MISS_SEND_ATTEMPTS; attempt += 1) {
      const sent = await this.#send(input.occurrence.targetSessionId, render, input.requestId);
      if (sent.status !== "retry") return;
      if (attempt === MISS_SEND_ATTEMPTS) break;
      const wait = Math.min(
        this.#options.retryDelayMs ?? sent.retryAfterMs ?? MISS_RETRY_DEFAULT_MS,
        MISS_RETRY_MAX_MS,
      );
      try {
        await delay(wait, undefined, { signal, ref: false });
      } catch {
        break;
      }
    }
    this.#options.logger?.warn(
      { code: "SCHEDULED_FAILURE_NOTICE_UNDELIVERED", scheduleId: input.occurrence.scheduleId },
      "A missed scheduled occurrence could not be reported to its conversation",
    );
  }

  async #targetIsInternal(sessionId: string): Promise<boolean> {
    const [row] = await this.#options.database
      .select({ kind: sessions.kind })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);
    return row?.kind === "internal";
  }

  /**
   * Keep the reason the message leaves out reachable from its details link: the schedule summary, while it
   * still describes this occurrence. A Run proves the hand-off landed, so this also settles an `unknown`
   * one. The hand-off's own result can arrive later, and `recordMessageOutcome` leaves this in place.
   */
  async #recordRunFailure(occurrence: ScheduledOccurrence, reason: string): Promise<void> {
    await this.#options.database
      .update(agentSchedules)
      .set({
        lastDispatch: sql`${agentSchedules.lastDispatch} || jsonb_build_object('outcome', 'accepted', 'code', ${reason}::text)`,
      })
      .where(
        and(
          eq(agentSchedules.id, occurrence.scheduleId),
          sql`${agentSchedules.lastDispatch} ->> 'scheduledFor' = ${occurrence.scheduledFor}`,
          sql`${agentSchedules.lastDispatch} ->> 'outcome' in ('accepted', 'unknown')`,
          sql`${agentSchedules.lastDispatch} ->> 'code' is distinct from ${reason}`,
        ),
      );
  }

  /** The scheduled facts of a reported message whose target is a visible Session, else undefined. */
  async #readScheduledRun(
    input: RunOutcomeNoticeInput,
  ): Promise<{ occurrence: ScheduledOccurrence; authorized: boolean } | undefined> {
    const [row] = await this.#options.database
      .select({
        agentId: imBindings.agentId,
        computerId: sessionPlacements.computerId,
        kind: sessions.kind,
        content: sessionMessages.content,
        origin: sessionMessages.scheduledOrigin,
        placementGeneration: sessionPlacements.generation,
      })
      .from(sessionMessages)
      .innerJoin(sessions, eq(sessions.id, sessionMessages.targetSessionId))
      .innerJoin(imBindings, eq(imBindings.id, sessions.imBindingId))
      .innerJoin(sessionPlacements, eq(sessionPlacements.sessionId, sessions.id))
      .where(and(eq(sessionMessages.id, input.messageId), eq(sessionMessages.targetSessionId, input.childSessionId)))
      .limit(1);
    if (!row?.origin || row.kind === "internal") return undefined;
    return {
      authorized:
        row.computerId === input.source.computerId && row.placementGeneration === input.source.placementGeneration,
      occurrence: {
        agentId: row.agentId,
        name: row.origin.name,
        prompt: row.content,
        scheduleId: row.origin.scheduleId,
        scheduledFor: row.origin.scheduledFor,
        targetSessionId: input.childSessionId,
        timezone: row.origin.timezone,
      },
    };
  }

  /** Never throws. `requestId` makes Feishu drop a repeat of the same occurrence's send. */
  async #send(sessionId: string, render: (provider: Provider) => string, requestId: string): Promise<SendResult> {
    let provider: "slack" | "feishu" | undefined;
    try {
      const target = await this.#conversation(sessionId);
      if (!target) {
        this.#options.logger?.warn(
          { code: "SCHEDULED_FAILURE_NOTICE_NO_CONVERSATION", sessionId },
          "A scheduled failure has no conversation that can receive it",
        );
        return { status: "dropped" };
      }
      provider = target.provider;
      await this.#options.messenger.postConversationText(target, render(target.provider), requestId);
      return { status: "sent" };
    } catch (error) {
      if (!(error instanceof FeedbackProviderError)) return { status: "retry" };
      this.#options.logger?.warn(
        { code: "SCHEDULED_FAILURE_NOTICE_SEND_FAILED", reason: error.code, sessionId },
        "A scheduled failure message was not sent",
      );
      if (error.permanent) return { status: "dropped" };
      // Slack has no request identity, so a send that may have landed is not repeated there.
      if (!error.knownNotApplied && provider !== "feishu") return { status: "dropped" };
      return error.retryAfterMs === undefined
        ? { status: "retry" }
        : { status: "retry", retryAfterMs: error.retryAfterMs };
    }
  }

  async #conversation(sessionId: string) {
    const { database } = this.#options;
    const [row] = await database
      .select({
        bindingGeneration: imBindings.credentialGeneration,
        bindingId: imBindings.id,
        bindingStatus: imBindings.status,
        channelId: sessions.channelId,
        installationId: imBindings.slackInstallationId,
        kind: sessions.kind,
        provider: imBindings.provider,
        threadKey: sessions.threadKey,
      })
      .from(sessions)
      .innerJoin(imBindings, eq(imBindings.id, sessions.imBindingId))
      .where(eq(sessions.id, sessionId))
      .limit(1);
    if (!row || row.kind === "internal" || row.bindingStatus !== "active") return undefined;
    const base = {
      bindingGeneration: row.bindingGeneration,
      bindingId: row.bindingId,
      channelId: row.channelId,
      installationId: row.installationId,
      provider: row.provider,
      threadKey: row.threadKey,
    };
    // Feishu reaches a thread only by replying to a message in it.
    if (row.provider !== "feishu" || row.threadKey === null) return base;
    const [anchor] = await database
      .select({ externalMessageId: imMessages.externalMessageId })
      .from(imMessages)
      .where(
        and(
          eq(imMessages.imBindingId, row.bindingId),
          eq(imMessages.channelId, row.channelId),
          eq(imMessages.threadKey, row.threadKey),
          // A recall is its own revision row, and the message's earlier rows stay behind.
          sql`not exists (select 1 from im_messages recalled where recalled.im_binding_id = ${imMessages.imBindingId} and recalled.channel_id = ${imMessages.channelId} and recalled.external_message_id = ${imMessages.externalMessageId} and recalled.operation = 'deleted')`,
        ),
      )
      .orderBy(desc(imMessages.occurredAt))
      .limit(1);
    return anchor ? { ...base, replyToExternalId: anchor.externalMessageId } : undefined;
  }
}
