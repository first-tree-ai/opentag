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
| `CLAUDE_CODE_RETRY_WATCHDOG_MAX_USAGE_LIMIT_WAIT_MS` | 7 days |
| `CLAUDE_CODE_RETRY_WATCHDOG_MAX_WAIT_MS` | 7 days (it counts every retry wait, quota waits included) |

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

A reset more than 7 days away makes Claude Code fail the Run at once with the quota error.

## Persisted resume

> **Planned — not yet implemented.** Tracking: #1519

Codex and Pi have no in-process wait, and a daemon restart loses Claude Code's. For these, a
`provider_quota_exceeded` failure of kind `usage_window` is kept in the work's existing durable record (the IM
Turn's retry record, or the Session message's inbox record) with a resume time of the reset plus 2 minutes, and
run again then in the same conversation. Codex takes the reset from `account/rateLimits/updated` (`resetsAt`);
Pi, which reports none, backs off conservatively. A new message that reaches a Session while its work waits is
merged into the waiting item like a steer, and runs with it once.

## Notice

> **Planned — not yet implemented.** Tracking: #1519

The waiting conversation gets one notice, "模型额度已用完，约 HH:mm 自动继续", edited in place when the wait gets
longer. The creating Session of an internal Session is not told.
