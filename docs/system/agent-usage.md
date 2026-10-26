---
title: "Agent usage accounting"
description: "Where Agent task and token counts come from, the Provider token rules, the safe-integer bounds, and the bounded UTC-day read shape."
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
is cut into **UTC** day buckets. Every date from the first to the last day of the window is present in the response,
so a day without tasks reads as zero rather than disappearing; one 30-day window therefore has 31 buckets, because
both ends are inclusive. The Agent list pins the 30-day window and reports only its totals.

## Token arithmetic

| Field | Rule |
| --- | --- |
| `inputTokens` | Reported input tokens plus reported cached tokens, except for Codex. |
| `cachedInputTokens` | Reported cached tokens, kept as its own total. |
| `outputTokens` | Reported output tokens. |
| `tokens` | `inputTokens + outputTokens` after that Provider rule. |

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

The window is aggregated **in PostgreSQL into at most one row per UTC day**, so the number of rows the Server maps
never depends on how much history the Agent has. Two details keep the aggregation exact instead of approximate:

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
reported yet. Two reads answer that question over the Agent's IM bindings, and
`im_message_deliveries_unreported_accepted_idx` — partial on `state = 'accepted' and reported_at is null` — is the
access path for both. Without it the reads join every Session of a binding to reach an answer, which is
proportional to the Agent's history rather than to the Turns actually outstanding.

The list reads the Agent projection, the activity, and the 30-day usage totals in one read-only `repeatable read`
snapshot for the same reason as the detail read: the Agent query is the authorization, and the reads it enables are
keyed by the Agent IDs it returned. A transfer committing mid-read therefore cannot hand the previous owner the
transferred Agent's activity or usage. The Cloud ledger read stays outside that snapshot; it is keyed by Account and
belongs to billing.
