---
title: "Quota auto-resume"
description: "Proposal: a Local Client keeps work interrupted by a used-up model quota and resumes it about two minutes after the quota resets, reusing the existing retry records and Session inbox."
soft_links:
  - /system/server-client-boundary.md
  - /system/messaging/im-feedback.md
  - /system/messaging/internal-session-collaboration.md
---

# Quota auto-resume

> **Proposal under review, not a decision.** Owners decide the points under [Decision points](#decision-points).

## Problem

When a Claude subscription window (5-hour or weekly) is used up, Claude Code answers every request at once with a
synthetic `You've hit your weekly limit · resets 4pm (Asia/Singapore)`. It doesn't wait. The Client classifies this
as `provider_quota_exceeded` with a `retryAt` (from the `rate_limit_event` reset). That code isn't in the
[automatic retry](../server-client-boundary.md#automatic-retry-of-accepted-work) set, so the work fails for good.
It continues only when a person or another Session sends a new message. Clients without that classification report
`provider_rate_limited`, spend their two 30-second retries within a minute, and then fail.

## Mechanism

1. **Classify.** A quota failure is `provider_quota_exceeded` with `retryAt`, taken from these sources in order:
   (a) a `rate_limit_event` whose window is `rejected` (`resetsAt`, current behaviour);
   (b) `rate_limit_info.resetsAt` on the synthetic assistant error (`apiError: usage_limit_reached`), if the
   stream carries it;
   (c) the `resets <time> (<IANA zone>)` text, read as the next such time in that zone;
   (d) none of these: a backoff of 15, 30, then 60 minutes, capped at 60.
   A `retryAt` more than 7 days away is treated as missing.
2. **Wait durably, without a Run.** The work is put back in its existing durable record with a `resumeAt`, and the
   provider process ends. Nothing new is stored:
   - An **IM Turn** keeps its `turn-retries/<session>.json` record. That record gains an optional `resumeAt`, and its
     `interruption.reason` gains the value `provider_quota_exceeded`. The Turn stays accepted and unreported, as a
     pending retry does today.
   - A **Session message**, including a scheduled one (schedules arrive as Session messages), becomes `retryable`
     with `nextAttemptAt = resumeAt` in the existing inbox.
   - After a restart, the daemon's existing startup scan finds both records and schedules them for `resumeAt`
     instead of right away.
3. **Resume time.** `resumeAt = retryAt + 120 s + spread`. A quota wait doesn't use the shared count of
   2 automatic retries. It has its own limit: 3 quota waits in a row. A run that lasts 5 minutes or more resets that
   limit. When the limit is used up, the work gets today's terminal quota report.
4. **One gate per account.** The Client keeps an in-memory quota gate for each provider credential: the provider
   plus the login or API-key fingerprint the Run used. Every waiting item on that account joins the gate, and the
   gate's reset time is the latest `retryAt` among them. At reset + 120 s, the gate releases the item that failed
   first; this run is the probe. If the probe succeeds, the other items follow 20 s apart, oldest first. If the probe
   hits the quota again, the gate takes the new `retryAt` and every item waits for it. After a restart, the gate is
   rebuilt from the records.
5. **Continue the same conversation.** The resume reuses the retry path: the same provider conversation, the
   continuation notice, the original input and any steers. A new reason text reads: `the model quota (<window>)
   was used up at <time>; it reset at <retryAt>, so OpenTag resumed automatically`.
6. **New input during the wait.**
   - A message steered into a waiting IM Turn is acknowledged into its record, up to the existing 16-steer limit,
     without a provider process. The resume replays it. Steers past the limit stay deferred, so the Server keeps them.
   - Session messages to the same target queue behind the waiting one, as they do today.
   - Input that arrives before the gate opens doesn't start a provider run. Every run would fail the same way, and
     each failure would push the wait back.
   - Cancelling the Turn on the Web, or `session stop`, ends the wait with the usual cancelled report.
7. **Server timeouts.** The Run budget counts only actual run time, so a long wait doesn't cause `turn_timeout`.
   The Server never expires accepted, unreported IM custody, and a Session message sends its outcome notice only
   when it's terminal. So the wait reports no failures by itself. One gap needs checking: after the ingress deadline,
   `sessionIsRunning` in the Task list stops counting the waiting Turn. A queued Turn could then reach the Client
   while a Turn is still waiting there (D2).
8. **Telling people.** By the current rule, nothing is reported while a retry is pending. A wait of hours needs one
   notice when it starts: "model quota used up; resumes automatically around <resumeAt>" (G1, D3). The reset time is
   already in the quota card copy (`retryAt`).

## Providers

The mechanism doesn't depend on the provider; only step 1 is provider-specific. Codex maps `usageLimitExceeded` to
`provider_quota_exceeded`. Its adapter should fill in `retryAt` when the error includes a reset time, which needs
checking against the current Codex protocol. Pi reports quota as an HTTP status plus a JSON body with no reset time,
so it uses the backoff in (d). An API-key account that runs into a 402 or billing error gets no `retryAt`. Waiting
on a balance that may never come back is pointless, so it keeps failing as it does now (D4).

## Testing

- Unit tests with a fake clock: the `retryAt` sources and their order, including text with a zone and an
  invalid or past time; the gate's probe, release and push-back; the limit of 3 waits; restart rebuilding the gate
  from the records.
- Runtime tests with a fake Claude CLI that emits a rejected `rate_limit_event` set to reset in 60 s. Cases: an IM
  Turn, a Session message and a scheduled message each resume about 2 minutes later in the same conversation; a
  daemon restart during the wait; a steer during the wait; a cancel during the wait.
- Local end-to-end: point `ANTHROPIC_BASE_URL` at a stub that returns 429 with a rejected unified rate-limit header
  and a near reset. This checks the real CLI's events.

## Decision points

- **岳增五 (Session/runtime)**
  - D1: Wait without a Run, stored in the existing records, versus holding the Run open in-process; the limit of
    3 waits and the 20 s release spacing.
  - D2: What happens when a new Turn reaches a Session whose Turn is still waiting. Recommended: the waiting Turn's
    input joins the new Turn, so there is one waiting item per Session.
  - D3: Whether the start-of-wait notice needs a Server change (a non-terminal report), or the Client sends it.
- **Gandy (IM copy)** — G1: the wording and form of the "waiting for quota, resumes around HH:mm" notice, and
  whether it appears once or is also updated when the wait gets longer.
- **刘超 (other)**
  - L1: Whether the start-of-wait notice also goes to the creating Session of an internal Session.
  - L2: D4 (no auto-resume on a billing error), and the extra 2 minutes after the reset.
