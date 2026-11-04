# SQL caller repairs: Background drain and GC bounds

2026-11-03, BG-F1/BG-F3 and the GC extension of IM-F3 in the
[tracker](../sql-caller-remediation.md). No database schema, migration, extra
controller, timer, retry queue or persistent cursor is added.

MCP and Skill GC retain one actual pass Promise instead of a running boolean.
Stop permanently closes admission, clears the timer and awaits that pass;
repeated callers await the same underlying work. Checks between stages/rows
avoid admitting new work. Issued OAuth exchange and object deletion keep their
existing owners/bounds and finish their outcome. Manual passes after stop return
zero/empty summaries, and start cannot reopen a stopped worker. Main already
awaits both stop ports. Cleanup errors remain observable and do not prevent the
existing resource cleanup helper from disposing later resources.

GC keeps its 500 successful-delete cap and gains a positive page quota, default
10 x 200 entries per pass. One in-memory cursor advances across bounded passes
and wraps at listing end. Mid-page cap leftovers return on a later wrap. Failed
LIST clears a possibly unusable cursor without an inline retry; failed deletes
and skipped entries still spend scan quota. Exact prefix, grace and final
reference checks remain. The default hourly cadence admits 2,000 entries/hour;
no production bucket-size or cleanup-SLA measurement is inferred. The quota is
the small bounded option recorded in the confirmed audit proposal.

**87 distinct passing cases: 59 native PostgreSQL in Docker and 28 host unit.**
Five native fault cases join actual paused scan/reference SQL before pool disposal,
observe 57014 during drain while later cleanup still runs, let an issued OAuth
refresh finish real claim/generation/envelope writes, and bound failed-delete
reference work while progressing across pages. Token HTTP and object storage
ports are controlled. The 54 existing MCP management cases cover actual service
and refresh behavior. Ten new GC unit cases cover skips, failures, wrap/revisit,
invalid cursor/quota, delayed list/delete and repeated stop; 18 old unit cases pass.
One copied referenced-row fixture initially omitted required archive fields; the
single failed identity passes after tightening. Initial type/lint failures remain
in workspace logs. No successful case needed repetition.

Final server typecheck, build and repository gates pass. Historical implementation
comments are removed, and existing complexity/size baselines are unchanged.
Workspace evidence: `.codex/reports/sql-caller-repairs-20261103/batch-10-*`.
BG-F1/BG-F3 are repaired locally. IM-F3 remains partial: actual Runtime route
close order and other owner tails need repair/test before full Server shutdown
acceptance. No independent agent review, live provider, CI, merge, deployment or
private billing acceptance is claimed.
