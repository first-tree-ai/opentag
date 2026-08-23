import { imAttrs, outcomeAttrs } from "./attributes.js";
import { setActiveSpanAttributes, trace, withSpan } from "./otel-helpers.js";

export type SlackInboundFailureCode =
  | "SLACK_INBOUND_DATABASE_FAILED"
  | "SLACK_INBOUND_FAILED"
  | "SLACK_INBOUND_IDENTITY_MISMATCH"
  | "SLACK_INBOUND_NORMALIZE_FAILED"
  | "SLACK_INBOUND_SIGNATURE_INVALID"
  | "SLACK_INBOUND_UNROUTABLE"
  | "SLACK_INBOUND_UNSUPPORTED_EVENT";

export const SLACK_ATTR = {
  ENVELOPE_TYPE: "slack.envelope_type",
  EVENT_TYPE: "slack.event_type",
  IGNORED_REASON: "slack.ignored_reason",
  INGEST_DURATION_MS: "slack.ingest.duration_ms",
  MINUTE_RATE_LIMITED: "slack.minute_rate_limited",
  RETRY_NUM: "slack.retry_num",
  RETRY_REASON: "slack.retry_reason",
  SUBTYPE: "slack.subtype",
} as const;

export const SLACK_RATE_LIMITED_EVENT = "slack.app_rate_limited";

/** Documented `X-Slack-Retry-Reason` values; anything else is reported as `other`. */
const RETRY_REASONS = new Set([
  "connection_failed",
  "http_error",
  "http_timeout",
  "ssl_error",
  "too_many_redirects",
  "unknown_error",
]);
const MAX_RETRY_NUM = 1_000;

export interface SlackRetryMetadata {
  num: number;
  reason: string | undefined;
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Reads Slack's retry headers. Slack redelivers an event up to three times (`X-Slack-Retry-Num` 1..3)
 * after a non-2xx or slow response; the same `event_id` is then short-circuited by provider-event
 * uniqueness, and telemetry records the retry so those duplicates are distinguishable from new traffic.
 */
export function parseSlackRetryHeaders(
  headers: Record<string, string | string[] | undefined>,
): SlackRetryMetadata | undefined {
  const rawNum = headerValue(headers["x-slack-retry-num"])?.trim();
  if (!rawNum || !/^\d{1,4}$/.test(rawNum)) return undefined;
  const num = Number.parseInt(rawNum, 10);
  if (num < 1 || num > MAX_RETRY_NUM) return undefined;
  const rawReason = headerValue(headers["x-slack-retry-reason"])?.trim().toLowerCase();
  return { num, reason: rawReason === undefined ? undefined : RETRY_REASONS.has(rawReason) ? rawReason : "other" };
}

/** Bounds a Slack-controlled label (event type, subtype) before it becomes a span attribute. */
export function safeSlackLabel(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  return /^[a-z0-9_.]{1,64}$/i.test(value) ? value : "other";
}

export function slackInboundAttrs(input: {
  bindingId?: string;
  providerEventId?: string;
  envelopeType?: string;
  eventType?: string;
  subtype?: string;
  retry?: SlackRetryMetadata;
}): Record<string, unknown> {
  return {
    ...imAttrs({ provider: "slack", bindingId: input.bindingId, providerEventId: input.providerEventId }),
    [SLACK_ATTR.ENVELOPE_TYPE]: safeSlackLabel(input.envelopeType),
    [SLACK_ATTR.EVENT_TYPE]: safeSlackLabel(input.eventType),
    [SLACK_ATTR.SUBTYPE]: safeSlackLabel(input.subtype),
    [SLACK_ATTR.RETRY_NUM]: input.retry?.num,
    [SLACK_ATTR.RETRY_REASON]: input.retry?.reason,
  };
}

export interface SlackInboundTrace {
  /** Adds bounded identifiers once routing or classification resolved them. */
  setAttributes(attrs: Record<string, unknown>): void;
  /** Names the failure class that a subsequent throw should be reported as. */
  setFailureCode(code: SlackInboundFailureCode): void;
  /** Records a permanent rejection that the route answers with a non-2xx status. */
  reject(code: SlackInboundFailureCode): void;
  /** Records traffic that OpenTag acknowledges with 200 but deliberately does not process. */
  ignore(reason: string, code?: SlackInboundFailureCode): void;
  /** Records Slack's `app_rate_limited` notice as a span event. */
  recordRateLimited(minuteRateLimited: number | undefined): void;
  /** Times the persistence phase and records it as `slack.ingest.duration_ms`. */
  measureIngest<T>(fn: () => Promise<T>): Promise<T>;
}

/**
 * One `im.inbound.process` span per signed Slack delivery, nested under the HTTP request span so the
 * `x-trace-id` Slack observed leads straight to the ingest outcome. Outcomes are `succeeded`,
 * `ignored` (acknowledged, not processed), `rejected` (non-2xx), or `failed` (thrown).
 */
export async function traceSlackInbound<T>(
  attrs: Record<string, unknown>,
  fn: (inbound: SlackInboundTrace) => Promise<T>,
): Promise<T> {
  return withSpan("im.inbound.process", attrs, async () => {
    let failureCode: SlackInboundFailureCode = "SLACK_INBOUND_FAILED";
    let settled = false;
    const inbound: SlackInboundTrace = {
      setAttributes: (extra) => setActiveSpanAttributes(extra),
      setFailureCode: (code) => {
        failureCode = code;
      },
      reject: (code) => {
        settled = true;
        setActiveSpanAttributes(outcomeAttrs("rejected", code));
      },
      ignore: (reason, code) => {
        settled = true;
        setActiveSpanAttributes({
          ...outcomeAttrs("ignored", code),
          [SLACK_ATTR.IGNORED_REASON]: safeSlackLabel(reason),
        });
      },
      recordRateLimited: (minuteRateLimited) => {
        try {
          trace
            .getActiveSpan()
            ?.addEvent(
              SLACK_RATE_LIMITED_EVENT,
              typeof minuteRateLimited === "number" && Number.isFinite(minuteRateLimited)
                ? { [SLACK_ATTR.MINUTE_RATE_LIMITED]: minuteRateLimited }
                : {},
            );
        } catch {
          // Telemetry never replaces the acknowledgement Slack is waiting for.
        }
      },
      measureIngest: async (run) => {
        const startedAt = performance.now();
        try {
          return await run();
        } finally {
          setActiveSpanAttributes({ [SLACK_ATTR.INGEST_DURATION_MS]: Math.round(performance.now() - startedAt) });
        }
      },
    };
    try {
      const result = await fn(inbound);
      if (!settled) setActiveSpanAttributes(outcomeAttrs("succeeded"));
      return result;
    } catch (error) {
      setActiveSpanAttributes(outcomeAttrs("failed", failureCode));
      throw error;
    }
  });
}
