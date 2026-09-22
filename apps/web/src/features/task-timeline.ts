import type { TaskSummary, TaskTurn } from "@opentag/shared/browser";

export type TaskReport = NonNullable<TaskTurn["report"]>;
export type TaskReply = NonNullable<TaskReport["outgoingReplies"]>["replies"][number];

type Entry =
  | { kind: "request" | "status"; turn: TaskTurn }
  | { kind: "reply"; turn: TaskTurn; reply: TaskReply }
  | { kind: "report"; turn: TaskTurn; report: TaskReport; hasReplies: boolean };

export type TaskTimelineEntry = Entry & { id: string };
type OrderedEntry = TaskTimelineEntry & { at: number; order: number };

/** Lark receipts use epoch milliseconds, while imported receipts may contain an ISO date. */
export function taskReplyTime(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const at = /^\d+$/.test(value) ? Number(value) : Date.parse(value);
  return Number.isFinite(at) && Number.isFinite(new Date(at).getTime()) ? at : undefined;
}

function replyId(reply: TaskReply): string {
  return `reply:${JSON.stringify([reply.provider, reply.chatId, reply.messageId])}`;
}

/**
 * Missing times stay beside their captured neighbours. The fallback is only a sorting position,
 * never a displayed send time. This also preserves receipt order when several times are absent.
 */
function replyPositions(replies: readonly TaskReply[], reportedAt: number): number[] {
  const known = replies.map((reply) => taskReplyTime(reply.createTime));
  let next = reportedAt;
  const following = known.map(() => reportedAt);
  for (let index = known.length - 1; index >= 0; index -= 1) {
    next = known[index] ?? next;
    following[index] = next;
  }
  let previous: number | undefined;
  return known.map((at, index) => {
    previous = at ?? previous;
    return at ?? previous ?? following[index] ?? reportedAt;
  });
}

/**
 * Turns arrive oldest first across all loaded pages. Flatten their actual messages without
 * treating a runtime summary or an absorbed delivery as another sent reply. Identity-based
 * deduplication preserves separate messages with identical text and distinct stored revisions.
 */
export function buildTaskTimeline(
  turns: readonly TaskTurn[],
  provider: TaskSummary["source"]["provider"],
): TaskTimelineEntry[] {
  // An overlap between pages can carry an older snapshot; the newest page was reversed last.
  const deliveries = new Map(turns.map((turn) => [turn.deliveryId, turn]));
  const entries = new Map<string, OrderedEntry>();
  const add = (id: string, at: number, entry: Entry) => {
    if (!entries.has(id)) entries.set(id, { ...entry, id, at, order: entries.size });
  };
  for (const turn of deliveries.values()) {
    const requestedAt = Date.parse(turn.message.occurredAt);
    add(`message:${turn.message.id}`, requestedAt, { kind: "request", turn });
    if (turn.absorbedBy) continue;
    const report = turn.report;
    if (!report) {
      add(`status:${turn.deliveryId}`, requestedAt, { kind: "status", turn });
      continue;
    }
    const reportedAt = Date.parse(report.reportedAt);
    const replies = provider === "feishu" ? (report.outgoingReplies?.replies ?? []) : [];
    const positions = replyPositions(replies, reportedAt);
    for (const [index, reply] of replies.entries()) {
      add(replyId(reply), positions[index] ?? reportedAt, { kind: "reply", turn, reply });
    }
    add(`report:${report.turnId}`, Math.max(reportedAt, ...positions), {
      kind: "report",
      turn,
      report,
      hasReplies: replies.length > 0,
    });
  }
  return [...entries.values()]
    .sort((left, right) => left.at - right.at || left.order - right.order)
    .map(({ at: _at, order: _order, ...entry }) => entry);
}
