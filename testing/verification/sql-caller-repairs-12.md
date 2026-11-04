# SQL caller repairs: Setup authority and summaries

2026-11-03, AG-F4/AG-S1/AG-S2 in the [tracker](../sql-caller-remediation.md).
No schema, migration, public input, timeout, retry or long transaction is added.

Slack callbacks retain the selected binding ID/generation and Computer. A narrow
joined read requires the same active owned Agent, current owned Computer and
current Slack binding before CLI admission and before connected success. Changed
targets return the existing configuration conflict; completed Slack work is not
undone, replayed or rebound. The weaker post-install placement-only query is
removed in favor of that common final check. SQL-to-network atomicity is not
promised; no transaction spans CLI execution.

Agent detail and setup share one authorized joined summary query. Detail still
loads activity on its existing read-only Repeatable Read executor. Setup and
preparation consume only the summary, removing discarded activity enrichment and
the corresponding detail transaction wrappers. Final setup revision/Computer
checks remain. The current native setup fixture uses five SELECTs/eight total
statements (Messaging retains its own BEGIN/SET/COMMIT), and preparation uses two.
The frozen audit's old 9-to-5 total is not presented as the current statement count.
Creation-intent replay after the failed transaction now calls its existing single
joined SELECT directly, deleting its single-use transaction wrapper.

**162 distinct passing cases: 141 unit/API and 21 native PostgreSQL in Docker.**
Fourteen new native cases cover six actual target changes (unbind, replacement,
credential rotation, Account transfer, rebind and suspend), each before callback
admission and after a real correlated Runtime send; a current success control;
and summary/projection equivalence with actual SQL counts. Real mutation services
perform changes. Post-result database snapshots are unchanged by the denied old
operation. A one-connection pool is usable during the CLI wait. Existing native
ownership snapshots and install/rebind guards pass.

Initial unit scope passed 138 and failed three obsolete probes: one expected
stop payload omitted the Agent revision introduced in batch 2c, and two pauses
relied on removed activity reads. They now observe the actual complete Messaging
read (after its SQL releases) and the actual suspended revision; all three pass
selectively. The initial native count probe omitted Messaging's three retained
transaction-control statements; the one corrected identity passes. All failures
are retained in logs, and no successful identity was rerun. Final server typecheck,
build and repository gates pass with unchanged baselines.

Workspace evidence: `.codex/reports/sql-caller-repairs-20261103/batch-12-*`.
These three items are repaired locally. IM-F3's admitted installation/result and
other owner drains remain open. No independent agent review, full Server shutdown,
live Slack, CI, merge, deployment or private billing acceptance is claimed.
