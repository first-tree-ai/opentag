---
title: "Ownership gate reconciliation"
description: "How ownership verdict writers are serialized across event-driven runs, reconciliation sweeps, and status retries."
---

# Ownership gate reconciliation

The [Ownership Gate workflow](https://github.com/first-tree-ai/opentag/blob/main/.github/workflows/ownership-gate.yml) publishes
the `ownership-gate` commit status using the policy from the default branch.
[Code ownership](https://github.com/first-tree-ai/opentag/blob/main/CONTRIBUTING.md#code-ownership) defines the review rules.
The gate evaluates every open pull request sharing a head and posts the worst
verdict for that commit.

## One status writer

Every trigger uses the fixed workflow-level concurrency group
`ownership-gate-writer`. The slot covers checkout, policy and pull request reads,
status publication, all retry backoffs and attempts, and operational-error
publication. A waiting run reads current inputs after acquiring the slot.
The group must not depend on the triggering head: a sweep judges multiple heads,
and a numbered pull request can advance to a new head before evaluation.

This prevents a sweep holding an earlier success from posting it after a newer
event-driven failure. Re-reading before a POST alone cannot provide the same
guarantee: another writer could publish after that read, including during a
later POST retry. The complete read/write interval needs exclusion.

`cancel-in-progress: false` preserves the running writer. `queue: max` retains
multiple waiting runs instead of replacing the sole pending run, which could
discard a verdict for an unrelated head. GitHub permits up to 100 waiting runs
in this queue and cancels additional arrivals; see its
[concurrency documentation](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency).

## Reconciliation and limits

Different heads wait behind the same writer, including an entire sweep and its
rate-limit backoffs. Queue saturation or a missing review relay can delay a
verdict until a later scheduled sweep. A policy change on `main` also triggers
a sweep. No queue ordering assumption is needed: each run evaluates after
acquiring the slot rather than using the triggering event's review snapshot.

The slot coordinates this workflow's writers; it does not lock GitHub reviews.
A dismissal during a run can leave a transient success until the next run
evaluates it. Manual cancellation, already-running older workflow revisions,
out-of-band status writers, and a request applied late after an ambiguous
transport failure are outside this exclusion guarantee. This is not an atomic
transaction between reading reviews and writing a commit status.

The queue changes no approval, author, or shared-head policy. In particular,
dismissed reviews revoke approval, and the existing policy still accepts
approvals of earlier commits after a push. During pull request evaluation, the
gate also trims redundant `requested_reviewers` so at most one eligible owner
(`bestony` or `yuezengwu`) remains requested, and removes remaining pending
requests once an eligible owner has reviewed. No branch protection or ruleset is
configured by this workflow.

Keep task verification results and live-platform limitations in the task's GitHub PR or Issue.
