# SQL caller repairs: Feishu connection and Inbox drain

This closes the Feishu connection-manager and Inbox portions of IM-F3. The
manager's maintenance Promise replaces its running flag. Stop aborts existing
maintenance controllers, disconnects owned channels, joins actual pass/probe/
activation/inbound/detached observation and enrichment work, then clears the
final lease. Probe results and later maintenance effects recheck existing stop/
epoch/signal state. Concurrent stop shares one Promise; start is blocked during
stop and remains possible after it finishes. Two small channel helpers reduce
maintenance branching; existing lease/identity fencing remains unchanged.

Inbox close rejects new ingest, joins admitted transactions and existing overflow
passes, suppresses rechecks and aborts/joins optional title work. The current
transaction may finish; accepted records are retained. The existing title deadline
remains, while no title callback means no needless timer. No new SQL timeout,
queue, retry, schema or generic lifecycle framework.

**202 distinct cases pass (18 native PostgreSQL), 579 passing executions.**
Docker Linux covers all 201 cases in the six-file owning/dependency matrix, plus
the added detached-observation case selectively. Native PG17 barriers cover
post-commit/pre-handoff and runtime-notification activation, material-read
maintenance, late probe results and a detached observation after its actual SQL
completion. Stop stays pending until the held continuation ends; leases are then
cleared. Three new Inbox PGlite cases cover admitted transaction drain/new-work
rejection, overflow recheck suppression and optional title abort/actual callback
join. The maintenance control also attempts start during stop.

The first Inbox barrier used the Feishu-only admission hook with a Slack fixture;
it now pauses the actual message-authority checkpoint and passes selectively.
Two existing native snapshot controls originally failed to reach their barrier:
the helper intercepted only direct selects, while the approved binding read now
uses an existing repeatable-read transaction. It now transparently wraps those
transactions too. All four helper-consumer files pass, including both native
snapshot cases and existing MCP/GC drain controls. A type-only fault-barrier
annotation was corrected and its native case rerun. Failed attempts remain in
workspace evidence; no product isolation or gate baseline was changed.

Typecheck and repository gates pass. Evidence:
`.codex/reports/sql-caller-repairs-20261103/batch-24-*`.
Providers use controlled adapter ports; actual Feishu SDK/network shutdown is
not certified. Main does not yet await Inbox close, and complete setup-service,
Runtime/Runner/transport, other producer work and final pool ordering remain
IM-F3. No full Server, CI, merge, deployment or online acceptance is inferred.
