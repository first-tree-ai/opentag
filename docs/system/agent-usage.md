---
title: "Agent usage accounting"
description: "Where Agent task and token counts come from, the Provider token rules, the safe-integer bounds, and the bounded daily read shape."
soft_links:
  - /system/agent-session-computer-model.md
  - /product/cloud-computer.md
  - /system/database-read-write-standards.md
---

# Agent usage accounting

The Agent list and the Agent usage detail report the same two quantities from the same two sources: how many Turn
tasks an Agent had, and how many tokens those tasks reported. This page defines what each number includes, because a
query rewrite is easy and the arithmetic is not.

## Sources and the billing boundary

- **Local turn reports.** Each accepted IM Delivery carries one `im_message_deliveries.turn_report`. Its
  `usage.inputTokens`, `usage.cachedInputTokens` and `usage.outputTokens` fields are the Provider process's own
  numbers, and its `outcome` field marks a failed Turn.
- **Cloud ledger.** A Cloud Turn is billed from the model-call ledger (`billing.attempts`), not from the Runner's
  report. The Runner's report proves neither coverage nor amount, so a Delivery whose
  `execution_origin = 'cloud'` contributes its task count and its failure count but **no** local token counts, and it
  never counts as a measured task. The ledger is merged separately and is the only token source for Cloud work.
- The two sources are never converted into one another. A Cloud model call is not a task, and a local report is not a
  billable event.

## The window

`windowDays` is one of 1, 7, 30 or 90. The window is `[now - windowDays × 24h, now]`, both bounds inclusive, and it
is cut into calendar-day buckets in the caller's IANA `timezone` (`UTC` when omitted; the Web App passes
`Intl.DateTimeFormat().resolvedOptions().timeZone`). Every date from the first to the last calendar day of the window
in that timezone is present in the response, so a day without tasks reads as zero rather than disappearing; one
`windowDays`-day window spans `windowDays + 1` buckets (or `windowDays + 2` when a spring-forward DST transition
shortens a local day inside the `24h × windowDays` span). Both local turn reports and the Cloud ledger bucket by the
same timezone before merging. The Agent list pins the 30-day window and reports only its totals.

## Token arithmetic

| Field | Rule |
| --- | --- |
| `inputTokens` | Reported input tokens plus reported cached tokens, except for Codex. |
| `cachedInputTokens` | Reported cached tokens, kept as its own total. |
| `outputTokens` | Reported output tokens. |
| `tokens` | `inputTokens + outputTokens` after that Provider rule. |

Idle compaction before a Turn counts toward that Turn only for Pi; Claude Code and Codex do not report its tokens. See
[Idle compaction](runtime/agent-runtime-contract.md#idle-compaction).

Codex already includes cached tokens inside its input count, so adding them again would double-count; Claude Code and
Pi report them separately. `runtimeUsageTotalTokens` in `@opentag/shared` owns this rule, and both the per-task and the
aggregated paths use it.

## Missing, malformed, and out-of-range values

- **Missing** — an absent `usage` field, or a JSON `null` — means that token count was not reported. The task still
  counts, and it is not a measured task unless some other field was reported.
- **Malformed** — a value that `Number()` cannot read as a non-negative safe integer — fails the whole read with
  `Agent usage contains an invalid token count`. It is not silently zeroed, because a broken report is a defect worth
  surfacing on the Agent's own usage surface.
- **Out of range** — a total beyond `Number.MAX_SAFE_INTEGER` fails the read with `Agent usage token total exceeds the
  safe integer range` instead of losing precision. Sums are accumulated as PostgreSQL `numeric` and converted once.

## Read shape

The window is aggregated **in PostgreSQL into at most one row per calendar day in the requested timezone**, so the
number of rows the Server maps never depends on how much history the Agent has. Two details keep the aggregation exact
instead of approximate:

- The aggregate covers only values stored in the canonical decimal form of a safe integer, which is what a JSON number
  in a turn report always is. Rows whose stored text is anything else — a numeric string such as `"1e3"`, or a JSON
  number written with a scale such as `1000.00` — are read back by a second query and recomputed with the same per-row
  parser, so those rows keep the per-value rules above. The aggregate itself counts them, and the second query runs only
  when that count is not zero, so an ordinary window pays for one statement. No row is counted twice: the aggregate
  excludes any row the fallback reads.
- That correction walk is bounded by paging, not by a compatibility limit: the aggregate's own count of excluded rows
  decides how many there are, and they are read in keyset batches of at most 1,000 ordered by `(accepted_at, id)`, so
  memory stays constant however many reports need recomputation. The cursor is the exact UTC text PostgreSQL printed
  rather than a JavaScript `Date`, because a `timestamptz` carries microseconds and a millisecond-truncated cursor
  would re-read or skip every row in the current millisecond. A valid report written as `1000.00` or `1e3` is summed,
  not rejected; only a value the per-row parser refuses fails the read.
- The aggregate and the correction read run in one read-only `repeatable read` transaction, so they describe the same
  set of Deliveries even while new Turns are reported.

The caller's Account ownership, the Provider rule that shapes the totals, and the aggregate come from **one**
read-only `repeatable read` snapshot. Resolving ownership first let a transfer commit in between, so the previous
owner could still read usage the new owner now owns; the window now selects Deliveries through the Agent's IM
bindings inside the same snapshot that authorized the call.

## List activity and the unreported-Turn index

The Agent list reports whether an Agent is working or merely idle from Turns that a Computer accepted and has not
reported yet. A working Agent also carries `runningTaskCount`, the number of open Tasks (Sessions) holding such a
Turn, so several Turns in one Task count once; the list row and the Agent home show that count. The count lets a
reader see at a glance which Agents are busy and how busy without opening each one; it shows on every row, since work
in progress is a fact whatever the status. An idle Agent with nothing queued shows no activity detail, so an idle Ready
Agent reads just Ready: a "Waiting" detail only repeated what Ready already says, and read as the Agent being stuck
waiting.

Every activity state also carries `queuedTaskCount` when it is positive: the number of Tasks waiting for delivery. A
Task is one chat Session, or a whole private chat across its Sessions. It waits when one of its live Sessions, on a binding that is not disabled,
holds a pending delivery that counts for the Task and none of its Sessions has a Turn running. A pending delivery counts
when it addresses the Agent directly, or when it is an execution of a Task somebody addressed: not the channel Session's
observer copy of a message a Thread Session owns, in a Session with a direct delivery or a Thread whose root was addressed.
A Turn runs while it is accepted, unreported, before its deadline, and the Session's latest acceptance. The row and the Agent home show the count as
"N tasks waiting" on every status, beside any running count. Why: queued work behind an offline Computer, a paused
Agent, or a runtime problem is exactly what an admin needs to see to judge that the Agent is stuck; without it the row
read as quiet.

The qualification and running rules are the Task list's own, shared from `services/tasks/task-sql.ts`, so the count
matches its Queued status. The Task list stays the authority for one Task's status.

Clients declare each count separately: `x-opentag-agent-activity-task-count: 1` receives `runningTaskCount`, and
`x-opentag-agent-activity-queued-count: 1` receives `queuedTaskCount`. The Web App sends both. Older clients validate the
activity strictly, so each keeps receiving the shape it was released with. Why two headers: a released Server recognizes
only the exact value `1` of the first, so a newer Web that changed it would lose the running count from that Server.

The two running reads start from the listed Agents' active bindings' live channel and thread Sessions through
`sessions_active_channel_unique` and `sessions_active_thread_unique` (`offset 0`) and probe
`im_message_deliveries_unreported_accepted_idx` — `(session_id, accepted_at, id)` partial on `state = 'accepted' and
reported_at is null` — for each Session. Because `session_id` leads the partial index and each probe stays correlated to
its Session (`offset 0`), neither Internal Sessions, historical reported Turns of a hot Session, nor other Accounts'
unreported Turns are scanned.

The queued read is one statement in the same snapshot. It reads the listed Agents' live channel and thread Sessions binding by binding
through `sessions_active_channel_unique` and `sessions_active_thread_unique`, so Internal Sessions are not read when
these indexes are chosen, and probes each Session's waiting deliveries through `im_message_deliveries_overflow_idx`, whose
leading columns reach them directly, however long the Session's history is. Each probe stays correlated to its Session
(`offset 0`), so the planner cannot hash it against every Account's deliveries. A waiting Task then checks its own
Sessions for a running Turn, so the read does not touch other Accounts' Turns; that check reads the waiting Session's
accepted deliveries, however many. The read turns JIT off for its transaction: every probe is costed as if it found
work, so an Account with many Agents passed the JIT threshold, and compiling a read of a few milliseconds took hundreds.

The read has no recency window. Why: a Session with a valid pending delivery may have no recent message by any clock with
an index. `occurred_at` is the provider's and can already be old when a valid request arrives, and `received_at`, which
sets the delivery's deadline, has no index. A window would show a false zero for that work.

There is no hard limit on an Account's Agents or an Agent's Sessions. Channel and thread Sessions stay live until their
binding is disabled or their Agent is transferred, and nothing deletes them, so the Sessions this read probes grow with
conversation history. In `all_message` mode every new thread in a group adds one. That is accepted at current scale:
thousands of Sessions per Account stay far inside the 500 ms single-query budget. [Issue
#1319](https://github.com/first-tree-ai/opentag/issues/1319) tracks the delivery key and index that would replace the
read, and when to add them.

The list reads the Agent projection, the activity, and the 30-day usage totals in one read-only `repeatable read`
snapshot for the same reason as the detail read: the Agent query is the authorization, and the reads it enables are
keyed by the Agent IDs it returned. A transfer committing mid-read therefore cannot hand the previous owner the
transferred Agent's activity or usage. The Cloud ledger read stays outside that snapshot; it is keyed by Account and
belongs to billing.
