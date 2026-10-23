# Database disconnect recovery

Supports [database timeouts and readiness](../../docs/operations/observability.md).

Run `pnpm --filter @opentag/server exec vitest run src/__tests__/integration/database-disconnect.test.ts`
with Docker available. Every fault scenario runs in its own Node process against a disposable PostgreSQL container;
there is no exception handler that keeps a crashed process alive. The parent requires normal exit and completion events.

| Fault | Continuations checked |
| --- | --- |
| Terminate a backend with an active query and 120 pending statements | Query before reuse, query after reuse, callback return, callback throw, nested savepoint |
| Terminate an idle transaction backend | The same five continuations |
| Let the configured idle transaction timeout close the backend | The same five continuations |

After closure the test reuses the only pool connection for a new transaction before resuming the old callback.
The new transaction ID must stay unchanged, its deliberate rollback must succeed, and the table must contain no
escaped or committed rows. In-flight and queued operations, the resumed callback, and normal pool shutdown must
finish within the child's deadlines. Fresh application queries and the independent readiness probe must work.

A separate process fills a three-connection application pool with an idle transaction holding a table lock and two
blocked writers. Readiness must still answer through its independent connection. The idle timeout must release the
root lock, both writers must finish, the application pool must work again, and the process must survive the old
callback's completion.

`database-timeouts.test.ts` covers statement cancellation, the query deadline, network black holes, commit/savepoint
waits, and a healed connection delivering a late nested callback. Keep those checks when replacing the pinned
postgres.js patch. These tests do not establish production business completion or resolve unknown commit outcomes.
