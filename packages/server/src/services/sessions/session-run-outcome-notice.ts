import { createHash } from "node:crypto";
import { SESSION_RUN_OUTCOME_NOTICE_HEADER, type SessionMessageRunOutcome } from "@opentag/shared";

/** The RFC 9562 URL namespace; the notice id derives from the reported message identity. */
const RUN_OUTCOME_NOTICE_NAMESPACE = "6ba7b811-9dad-11d1-80b4-00c04fd430c8";

/**
 * UUIDv5 over `opentag:session-run-outcome:<childSessionId>:<messageId>`. One reported message
 * yields exactly one notice id, so report retries, Runner settlement replays, and
 * concurrent reports converge on the same SessionMessage row instead of a second notice.
 */
export function runOutcomeNoticeMessageId(childSessionId: string, messageId: string): string {
  const namespace = Buffer.from(RUN_OUTCOME_NOTICE_NAMESPACE.replaceAll("-", ""), "hex");
  const name = `opentag:session-run-outcome:${childSessionId}:${messageId}`;
  const digest = createHash("sha1").update(namespace).update(name, "utf8").digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

const NOTICE_IDENTITY = /^Session: ([0-9a-f-]{36})\nMessage: ([0-9a-f-]{36})\n/;

/**
 * Whether a stored message is a notice openTag wrote. The header alone proves nothing: ordinary content
 * can start with it, for example when quoting a notice. A real notice's id derives from the Session and
 * message it names, and that Session sent it, which a quote under its own id does not satisfy. Ordinary
 * create/send cannot record a new version 5 id, so only the Server can.
 */
export function isRunOutcomeNotice(message: { id: string; sourceSessionId: string | null; content: string }): boolean {
  const header = `${SESSION_RUN_OUTCOME_NOTICE_HEADER}\n`;
  if (!message.content.startsWith(header)) return false;
  const named = NOTICE_IDENTITY.exec(message.content.slice(header.length));
  if (!named?.[1] || !named[2] || named[1] !== message.sourceSessionId) return false;
  return message.id === runOutcomeNoticeMessageId(named[1], named[2]);
}

const OUTCOME_SUMMARY: Record<SessionMessageRunOutcome, string> = {
  timed_out: "it reached its maximum Run duration and was stopped",
  failed: "it failed",
  cancelled: "it was cancelled",
  unknown: "its result is unknown because the execution was interrupted",
};

/**
 * The Server-generated notice text. It names the child, the outcome, and the stable reason only;
 * it never includes provider output or error text, and it is deterministic for one report so the
 * idempotent message row never conflicts with itself.
 */
export function renderRunOutcomeNotice(input: {
  childSessionId: string;
  messageId: string;
  outcome: SessionMessageRunOutcome;
  reason: string;
}): string {
  return [
    SESSION_RUN_OUTCOME_NOTICE_HEADER,
    `Session: ${input.childSessionId}`,
    `Message: ${input.messageId}`,
    `Outcome: ${input.outcome} (reason: ${input.reason})`,
    "",
    `That Session stopped working on that message because ${OUTCOME_SUMMARY[input.outcome]}.`,
    "This notice was written by openTag, not by that Session. openTag will not rerun the message automatically.",
    "That Session is still active and keeps its conversation context; work it did before stopping may be partial.",
    `To continue it, send it a follow-up: opentag session send ${input.childSessionId} --message "<what to do next>"`,
    "Decide whether to continue, retry differently, or report the result; tell the user only what is useful.",
  ].join("\n");
}
