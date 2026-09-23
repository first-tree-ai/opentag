import type { TaskReply as CapturedTaskReply, TaskSummary, TaskTurn } from "@opentag/shared/browser";

export type TaskReport = NonNullable<TaskTurn["report"]>;
export type TaskReply = NonNullable<TaskReport["outgoingReplies"]>["replies"][number];
export type { CapturedTaskReply };

type Entry =
  | { kind: "request" | "status"; turn: TaskTurn }
  | { kind: "reply"; turn: TaskTurn; reply: TaskReply }
  | { kind: "captured"; reply: CapturedTaskReply; legacyReply?: TaskReply }
  | { kind: "report"; turn: TaskTurn; report: TaskReport; hasReplies: boolean };

export type TaskTimelineEntry = Entry & { id: string };
type OrderedEntry = TaskTimelineEntry & { at: number; order: number };

/** Lark receipts use epoch milliseconds, while imported receipts may contain an ISO date. */
export function taskReplyTime(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const at = /^\d+$/.test(value) ? Number(value) : Date.parse(value);
  return Number.isFinite(at) && Number.isFinite(new Date(at).getTime()) ? at : undefined;
}

/**
 * One sent message's entry id: its native identity across every source — provider, conversation
 * and platform message id. A legacy Local receipt and the Server's stored row for the same message
 * therefore share a React key and `data-task-entry-id`, so the stored row replaces the receipt in
 * place without disturbing scroll anchoring.
 */
function replyEntryId(provider: string, conversationId: string, messageId: string): string {
  return `reply:${JSON.stringify([provider, conversationId, messageId])}`;
}

function legacyEntryId(reply: TaskReply): string {
  return replyEntryId(reply.provider, reply.chatId, reply.messageId);
}

function capturedEntryId(reply: CapturedTaskReply): string {
  return replyEntryId(reply.provider, reply.channelId, reply.externalMessageId);
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
 * One Turn's legacy receipts against the captured records. A receipt whose native identity the
 * Server also captured never becomes a second entry — the Server record wins — but the whole
 * receipt is carried beside the record so an unavailable capture can still render its rich
 * content.
 */
function mergeLegacyReplies(input: {
  turn: TaskTurn;
  replies: readonly TaskReply[];
  positions: readonly number[];
  reportedAt: number;
  entries: Map<string, OrderedEntry>;
  add: (id: string, at: number, entry: Entry) => void;
}): void {
  for (const [index, reply] of input.replies.entries()) {
    const id = legacyEntryId(reply);
    const existing = input.entries.get(id);
    if (existing?.kind === "captured") {
      if (!existing.reply.contentAvailable && existing.legacyReply === undefined) {
        input.entries.set(id, { ...existing, legacyReply: reply });
      }
      continue;
    }
    input.add(id, input.positions[index] ?? input.reportedAt, { kind: "reply", turn: input.turn, reply });
  }
}

/**
 * Turns arrive oldest first across all loaded pages. Flatten their actual messages without
 * treating a runtime summary or an absorbed delivery as another sent reply. Identity-based
 * deduplication preserves separate messages with identical text and distinct stored revisions.
 *
 * Captured Server records (`capturedReplies`, from the Task replies subresource) merge into the
 * same chronological flow. A legacy Local Feishu receipt with the same native identity never
 * duplicates a Server record — the Server record wins — but it may still supply the display body
 * when the Server record's own content is unavailable. Neither source ever falls back to
 * `finalText`.
 */
export function buildTaskTimeline(
  turns: readonly TaskTurn[],
  provider: TaskSummary["source"]["provider"],
  capturedReplies: readonly CapturedTaskReply[] = [],
): TaskTimelineEntry[] {
  // An overlap between pages can carry an older snapshot; the newest page was reversed last.
  const deliveries = new Map(turns.map((turn) => [turn.deliveryId, turn]));
  const entries = new Map<string, OrderedEntry>();
  const add = (id: string, at: number, entry: Entry) => {
    if (!entries.has(id)) entries.set(id, { ...entry, id, at, order: entries.size });
  };
  // Stored rows claim their native identity first, so a repeated observation or a legacy receipt
  // never displaces the Server's own record.
  for (const reply of capturedReplies) {
    add(capturedEntryId(reply), Date.parse(reply.occurredAt), { kind: "captured", reply });
  }
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
    mergeLegacyReplies({ turn, replies, positions, reportedAt, entries, add });
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
