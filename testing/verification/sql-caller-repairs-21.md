# SQL caller repairs: operator database clients

Batch 8c closes OP-F1. Three benchmark raw admin/fixture/EXPLAIN connections now
reuse createDatabaseClient(max: 1). Official connect/statement/idle settings and
the existing driver elapsed deadline apply to each query. Every owned benchmark
client uses native end({ timeout: 5 }); the Agent admin's existing bound remains.
Independent client/container cleanup and error aggregation are retained. No new
wrapper, retry, migration budget, schema or timeout increase.

**102 distinct Vitest cases pass (2 native PostgreSQL), 202 passing executions.**
The 100 existing benchmark orchestration cases pass on host and Docker Linux.
Two new native PG17 cases use the real administrative port and TCP fault proxy:
shared settings read as 30s/1min; a lost reply expires around 35 seconds, followed
by recovery after observing the old connection's close; native close releases
an ongoing blackholed query in about five seconds with CONNECTION_DESTROYED.
No application retry or claim of atomic transport cancellation is added.

Initial native expectations queried again before observing native socket close
and expected CONNECTION_ENDED instead of the driver's CONNECTION_DESTROYED.
Both corrected tests pass. A first src test import crossed the server rootDir;
the test now resides with the script integration tests, retaining product build
boundaries. Failed attempts remain in workspace evidence.

Both actual CLI benchmarks also ran against their own Docker PostgreSQL:
Task has 13 measured cases, 73 migrations and 100,000 rows per application table;
Agent/Session has seven measured cases. Both reports contain no case errors and
containerRemoved=true; Docker inventory confirms no owned benchmark remains.
Maximum fixture statement times were 2,115 ms and 2,128 ms, within the unchanged
30-second statement / 35-second elapsed budgets. These are local measurements,
not production capacity or private billing implementation acceptance.

Typecheck and repository gates pass. Evidence:
`.codex/reports/sql-caller-repairs-20261103/batch-21-*` includes frozen CLI reports
and all logs. Independent review follows the exact commit; CI/merge/deployment
and the final Server shutdown chain are not covered by this batch.
