# SQL caller repairs: RuntimeSession and scheduler drain

This closes only the RuntimeSession/scheduler portions of IM-F3. Handshake and
heartbeat Promise fields replace running booleans. The existing registration
callback remains nonblocking during normal registration but is retained for
close, with a stop check before starting it. Session close stops admission,
aborts its existing signal, starts exact disconnect and waits for control,
callback and actual business tasks. Late registration keeps its existing exact
unregister/disconnect cleanup. No credential, frame or SQL identity changes.

KeyedTaskScheduler close now shares one Promise resolved by its existing active
counter after admitted runs finish. Queued tasks are still dropped once; new
admission stays closed. No extra task collection is added. ImFailureReactions
already joins its own existing pending promises, so it needs no second drain.
The IM worker still needs its own actual-operation/maintenance tails, beyond a
scheduler's deadline wrapper, in a later IM-F3 component.

**74 distinct cases pass (7 native PostgreSQL), 253 passing executions.** All
67 owning unit/PGlite cases and seven native PG17 cases pass in Docker Linux.
The new scheduler gate verifies active work, failed-task settlement, idempotent
close, queued drop and rejection of later enqueue. Native sessions use real
MachineAuthService and ComputerService, actual issued credentials and protocol
v2 over a controlled socket. Auth, registration, heartbeat, disconnect,
registration callback and business SQL continuations are held after their real
query; close waits, emits no late frames and clears the exact Computer instance.
Each pool remains healthy until disposal and then has no backend in
pg_stat_activity. A separate registration row-lock case is ended by PostgreSQL's
1.5-second test statement budget, without firing the 5-second elapsed watchdog;
rollback, close and subsequent pool use succeed. Production budgets are unchanged.

The first native fault helper installed a spy before capturing its original
method and recursively called the spy. Only that labelled disposable test runner
was stopped; originals are now captured first. A focused auth case and the full
74-case Docker matrix pass after correction. Logs, including the interrupted
attempt, remain in `.codex/reports/sql-caller-repairs-20261103/batch-26-*`.
Typecheck and repository gates pass without baseline changes.

Runtime routes still need to retain instances and await this port, including
authentication/disconnect after the physical socket closes. Actual WebSocket,
Runner, transport, other owner and final main ordering remain IM-F3. No full
Server signal, CI, merge, deployment or online acceptance is inferred.
