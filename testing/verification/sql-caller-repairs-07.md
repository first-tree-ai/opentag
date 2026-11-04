# SQL caller repairs: Runtime test and approval enqueue

2026-11-03, local batch on the refreshed main recorded in the
[remediation tracker](../sql-caller-remediation.md). No schema, migration, new
timeout, retry queue or transport replay is added.

| Finding | Repair | Fault evidence |
| --- | --- | --- |
| AP-F1 | Hold current Computer/connection and expected approval status through synchronous enqueue. Return the send promise in an envelope so SQL commits before awaiting the socket callback. Observe rejection immediately while commit is pending. | Five new native cases: with a one-connection pool, delayed success and failure free the Computer and approval locks; acknowledged status survives late failure. Replaced connection/status and expired rows enqueue nothing. |
| AG-F2 original Runtime test | Dispatch with an observed rejection handler and await the existing result promise immediately. Existing finish owns TTL, abort, close and result; its listener cleanup is preserved. | Four new real-registry unit cases: timeout, caller abort, close and successful result all settle while socket callback is pending. A late send error cannot finish a subsequent test. |

**59 distinct passing cases: 53 host unit/API and six native PostgreSQL in
Docker.** Native scope includes the existing actual Runtime no-write test.
The PostgreSQL lock/pool assertions use independent connections; socket callbacks
are controlled. There is no live network-backpressure or whole-binary shutdown
claim. Native cases passed before type-only fixture tightening (required approval
title/description and explicit assertions). Final server typecheck and repository
checks pass. Initial fixture type/lint failures are retained in workspace logs.
No independent agent review, CI, merge, deployment or private-source acceptance
is claimed. There is no new server export/bundling change, so no repeated build.

Workspace evidence: `.codex/reports/sql-caller-repairs-20261103/batch-07-*`.
AP-F1 is repaired locally. AG-F2 is **partial**: lifecycle and original Runtime
test are repaired; the actual Provider preparation fallback/close wait remains.
IM-F2 sending after asynchronous preparation remains a separate next batch.
