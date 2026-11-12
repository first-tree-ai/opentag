---
title: "Quota auto-resume"
description: "When a model subscription window is used up, the Client waits for its reset and continues the same work; the Server is not involved."
---

# Quota auto-resume

When a Provider's subscription usage window (for example Claude's 5-hour or weekly window) is used up, the work
waits for the window to reset and then continues in the same conversation. Nobody has to send a new message.
Everything happens in the Local Client: the Server, the database and the runtime protocol do not change.

A billing failure (no balance, no credit, HTTP 402, `insufficient_quota`) is not a used-up window. It stays
terminal and is reported at once, because a balance may never come back.

## Claude Code: wait in the Provider process

OpenTag starts Claude Code with its unattended retry mode, which `--print` stream-json supports, unlike the
interactive `autoContinueAtUsageLimit` setting:

| Variable | Value |
|---|---|
| `CLAUDE_CODE_RETRY_WATCHDOG` | `1` |
| `CLAUDE_CODE_RETRY_WATCHDOG_MAX_USAGE_LIMIT_WAIT_MS` | the wait cap below |
| `CLAUDE_CODE_RETRY_WATCHDOG_MAX_WAIT_MS` | the wait cap below (it counts every retry wait, quota waits included) |

The wait cap is set for each Run. The Run's credential execution lives at most 24 hours
(`RUNTIME_EXECUTION_MAX_LIFETIME_MS`), and the Run may still use its remaining budget besides waiting. So the cap is
24 hours less the remaining budget and a 30-minute margin: 23 hours for the default 30-minute budget. Under 1 hour,
the mode stays off and a used-up window fails the Run at once.
A value already set in the daemon's environment wins. With this mode, a rejected window does not fail the Run:
Claude Code emits a `rate_limit_event` with `status: rejected` and `resetsAt`, then a `system/api_retry` frame
with `error_status: 429` about every 30 seconds, and retries the same request at the reset. The Run then finishes
as usual, without a new prompt.

The Claude adapter turns this into the Provider-neutral `quota_wait_changed` Run event: `waiting: true` with
`resetsAt` at the first 429 retry after a rejected window (again when a later rejected event moves the reset), and
`waiting: false` at the next frame of any other kind. An `allowed` window clears the remembered reset, so a later
plain 429 is a rate limit, not a quota wait.

While a Run is waiting:

- The Run's duration budget stands still, for an IM Turn and for a Session message alike, so a wait of hours does
  not end in `turn_timeout`. The budget resumes with what was left when the wait ends, and so does the
  notice before the Run's limit.
- The wait is not run time: it is not recorded toward the budget or the 5-minute retry-count reset.
- Cancelling the Turn on the Web or `session stop` ends the Run and the wait as usual.
- 529 and other capacity retries are not quota waits; the budget keeps running through them.

A reset further away than the cap, such as a weekly window, makes Claude Code fail the Run at once with the quota
error; the persisted resume below takes over.

## Persisted resume

A failed Run carries a Client-only `quotaKind` with `provider_quota_exceeded`: `usage_window` for a subscription
window that resets by itself (Claude Code sets it when a rejected window failed the Run), `billing` for no balance or
credit. Only `usage_window` waits; `billing`, or no kind, is reported at once.

An IM Turn whose Run failed on a used-up window keeps its accepted delivery and its retry record
(`turn-retries/<session>.json`), which gains an interruption `provider_quota_exceeded` with a `resumeAt`:

- `resumeAt` is the reset plus 2 minutes. A reset already past counts as now; a missing reset, or one more than 7 days
  away, gets a backoff of 15, 30, then 60 minutes for the 1st, 2nd and 3rd wait in a row.
- Quota waits have their own limit, 3 in a row, and do not use the count of automatic retries. A run of 5 minutes or
  more starts the count over. Past the limit, the Turn gets its terminal quota report.
- The daemon waits until `resumeAt` and runs the Turn again in the same conversation, with the continuation notice
  (`… because the model quota was used up; OpenTag waited for it to reset and resumed automatically`) and the original
  input. Nothing is reported while it waits.
- After a daemon restart the startup scan finds the record, and the request to recover its Session is sent at
  `resumeAt`, not at once; the Turn stays pending until then.
- A message steered into the Turn while it waits joins it, as the issue's D2 decided: with no Provider process to
  take it, the Client adds it to the retry record and records its steer receipt, up to the limit of 16 steered
  messages, and the resumed attempt runs it once with the original input. Past the limit, or when it cannot be
  recorded, the steer is `deferred` and the Server delivers it after the Turn. So is a steer that arrives while the
  Turn is pending after a daemon restart, since no Turn is live in the daemon then.

A Session message, a scheduled one included, waits the same way in the inbox: its record becomes `retryable` with
`nextAttemptAt` at the resume time, the interruption `provider_quota_exceeded` and a local `quotaWaits` count, under
the same rules (reset plus 2 minutes or the backoff, 3 waits in a row, a 5-minute run starts over, `billing` reported
at once). The Session stays held while it waits, so a later message to it queues behind or steers into the resumed
Run. A restarted daemon restores the record and still waits until `nextAttemptAt`; the sender gets no outcome notice
until the message ends.

### Codex and Pi

Codex and Pi have no in-process wait, so a used-up window ends the Run and the persisted resume above takes over.

- **Codex:** `usageLimitExceeded` is a `usage_window` quota. Its reset comes from the account rate limits the App
  Server reports during the Run (`account/rateLimits/updated`): the latest `resetsAt` among the windows at 100 %.
  A later update without a used-up window does not clear it. Without one, the backoff applies.
- **Pi:** Pi reports a model failure as text, often `<status>: <JSON error>`. Billing text (`insufficient_quota`,
  `insufficient_credit`, `billing`, `available balance`, `out of budget`, `credit balance`, or HTTP 402) is a `billing`
  quota and is reported at once. A subscription usage limit is a `usage_window` quota: the code `usage_limit_reached` or OpenCode's
  `GoUsageLimitError` / `FreeUsageLimitError`, or pi-ai's "You have hit your ChatGPT usage limit … Try again in ~N
  min". pi-ai writes the same text without the reset for every ChatGPT HTTP 429 and for `usage_not_included`,
  billing and access included, so that text alone keeps its ordinary classification. The reset is taken from
  `resets_at`, `resets_in_seconds` or "Try again in ~N min" when present; otherwise the backoff applies. A plain rate limit keeps
  its ordinary 429 retry.

## Notice

> **Planned — not yet implemented.** Tracking: #1519

The waiting conversation gets one notice, "模型额度已用完，约 HH:mm 自动继续", edited in place when the wait gets
longer. The creating Session of an internal Session is not told.
