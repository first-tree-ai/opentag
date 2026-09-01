const MS_PER_DAY = 86_400_000;
const MS_PER_HOUR = 3_600_000;

/** The pull request is out of scope for the sweep (draft, exempt label, exempt author). */
export const ACTION_SKIP = "skip";
/** The pull request is in scope but nothing needs to happen this run. */
export const ACTION_NONE = "none";
/** Post the inactivity notice and mark the pull request stale. */
export const ACTION_WARN = "warn";
/** Close the pull request; the notice was posted and the grace period has elapsed. */
export const ACTION_CLOSE = "close";

export function toMillis(value, field) {
  const millis = Date.parse(String(value));
  if (Number.isNaN(millis)) {
    throw new TypeError(`${field} must be an ISO 8601 timestamp, received ${JSON.stringify(value)}`);
  }
  return millis;
}

function assertPositiveNumber(value, field) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${field} must be a positive finite number, received ${JSON.stringify(value)}`);
  }
}

/**
 * Rejects a configuration that would let a pull request be closed without ever
 * having been warned, which is the one outcome this policy must never produce.
 */
export function assertPolicyConfig(config) {
  assertPositiveNumber(config.warnAfterDays, "warnAfterDays");
  assertPositiveNumber(config.closeAfterDays, "closeAfterDays");
  assertPositiveNumber(config.graceHours, "graceHours");
  if (config.closeAfterDays <= config.warnAfterDays) {
    throw new RangeError(
      `closeAfterDays (${config.closeAfterDays}) must be greater than warnAfterDays (${config.warnAfterDays})`,
    );
  }
}

function roundDays(millis) {
  return Math.round((millis / MS_PER_DAY) * 10) / 10;
}

function matchedExemptLabel(pullRequest, config) {
  return pullRequest.labels.find((label) => config.exemptLabels.includes(label)) ?? null;
}

function exemptionReason(pullRequest, config) {
  if (config.exemptDrafts && pullRequest.isDraft) {
    return "draft pull request";
  }
  const label = matchedExemptLabel(pullRequest, config);
  if (label !== null) {
    return `carries the exempt label "${label}"`;
  }
  if (pullRequest.authorKey !== null && config.exemptAuthors.includes(pullRequest.authorKey)) {
    return `opened by the exempt author "${pullRequest.authorKey}"`;
  }
  return null;
}

/**
 * A notice only counts while nobody has touched the pull request since it was
 * posted. Any human activity supersedes it, which is what resets the clock and
 * lets a revived pull request be warned again from scratch later.
 */
function effectiveNotice(pullRequest) {
  const notice = pullRequest.notice ?? null;
  if (notice === null) {
    return null;
  }
  const postedAt = toMillis(notice.postedAt, "notice.postedAt");
  return postedAt >= toMillis(pullRequest.lastActivityAt, "lastActivityAt") ? notice : null;
}

function decideStalePullRequest({ pullRequest, config, nowMillis, idleMillis, idleDays }) {
  const notice = effectiveNotice(pullRequest);
  const base = { idleDays, desiredStaleLabel: true };

  if (notice === null) {
    return { ...base, action: ACTION_WARN, reason: `idle for ${idleDays} day(s) with no active notice` };
  }
  if (idleMillis < config.closeAfterDays * MS_PER_DAY) {
    return { ...base, action: ACTION_NONE, reason: `idle for ${idleDays} day(s); notified at ${notice.postedAt}` };
  }
  const sinceNoticeMillis = nowMillis - toMillis(notice.postedAt, "notice.postedAt");
  if (sinceNoticeMillis < config.graceHours * MS_PER_HOUR) {
    return {
      ...base,
      action: ACTION_NONE,
      reason: `notified at ${notice.postedAt}; holding for the ${config.graceHours}h grace period`,
    };
  }
  return { ...base, action: ACTION_CLOSE, reason: `idle for ${idleDays} day(s); notified at ${notice.postedAt}` };
}

/**
 * Decides what should happen to a single pull request. The result is a pure
 * function of the pull request facts, the configuration and `now`, so the whole
 * policy is testable without touching the network.
 *
 * `desiredStaleLabel` is reconciled by the caller rather than expressed as an
 * action, so the label always converges on the truth even when a run is
 * interrupted between the comment and the label call.
 */
export function decidePullRequest({ pullRequest, config, now }) {
  assertPolicyConfig(config);
  const nowMillis = toMillis(now, "now");

  // Truncation means the last human activity is undatable, so the only safe
  // move is to leave the pull request exactly as it is.
  if (pullRequest.activityTruncated) {
    return {
      action: ACTION_SKIP,
      reason: "activity history is truncated; last human activity cannot be dated",
      idleDays: null,
      desiredStaleLabel: pullRequest.hasStaleLabel,
    };
  }

  const idleMillis = nowMillis - toMillis(pullRequest.lastActivityAt, "lastActivityAt");
  const idleDays = roundDays(idleMillis);

  const exemption = exemptionReason(pullRequest, config);
  if (exemption !== null) {
    return { action: ACTION_SKIP, reason: exemption, idleDays, desiredStaleLabel: false };
  }
  if (idleMillis < config.warnAfterDays * MS_PER_DAY) {
    return {
      action: ACTION_NONE,
      reason: `active ${idleDays} day(s) ago`,
      idleDays,
      desiredStaleLabel: false,
    };
  }
  return decideStalePullRequest({ pullRequest, config, nowMillis, idleMillis, idleDays });
}
