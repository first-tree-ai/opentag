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

## Transport disposal, readiness and startup bounds

`database-availability.test.ts` adds controlled stream faults while fresh connections remain healthy:

- Freeze all 20 application connections and require the original pool to accept fresh work after their deadlines.
- Expire queued INSERT and BEGIN operations without killing their healthy holder or executing them later.
- Abort multi-host initialization without replaying an expired write, while retaining normal multi-host failover.
- Reject queued writes when graceful close begins while allowing an already admitted transaction to commit.
- Deliver COMMIT to PostgreSQL but withhold its response; retain the single committed row and never replay the callback.
- Keep dedicated connectivity healthy while exhausting the shared pool; require `/readyz` 503, `/healthz` 200,
  then `/readyz` 200 after the holder releases.
- Keep healthy slow autocommit queries alive while readiness expires, both on direct dispatch and after a reserved
  holder releases a queue containing a business query followed by a probe.
- Withhold TCP closing acknowledgement and require a child process to exit normally after bounded database close,
  including a case where the active query completes before the peer withholds FIN.

Both multi-host cases build the raw authority with a port on each candidate and assert the driver's parsed
host and port arrays before issuing SQL. Every candidate must target the disposable proxy. URL `host` or
`hostname` setters must not construct this authority: they can collapse the candidate list or leave an entry
using PostgreSQL's default port instead of the controlled fixture.

`server-startup.test.ts` additionally combines a rejected listen call with a real Fastify `onClose` resource
failure. It requires later outer billing and telemetry cleanup to run, including when those also reject,
`startServer()` to resolve with exit code 1, and one redacted report preserving the original and nested cleanup
errors. A pre-creation failure plus rejected telemetry cleanup covers the stderr fallback. These regressions
fail against the previous unguarded startup catch.

`database-startup.test.ts` runs on PostgreSQL 16 and 17 and checks native session settings, the 2 s advisory-lock wait, the 5 s statement limit,
the 10 s transaction or total-operation limit across individually shorter statements, rollback, and silent established migration
and verification connections. Startup work must not reconnect and continue after losing its dedicated session.
`config.test.ts` also advances a progressing migration beyond the single 15 s operation budget and checks the
10 s verification budget. URL parameters cannot disable the startup timeout policy.

Run these with the existing timeout/disconnect cases or use the complete Server integration command:
`pnpm --filter @opentag/server test:integration`. Tests use disposable PostgreSQL instances and local TCP
proxies; they do not exercise production deployment, cluster failover, or all worker shutdown paths. Shortened
application deadlines make the transport cases quick; the startup policy tests exercise the actual configured limits.

## Independent review and Docker verification

The lifecycle change was independently reviewed with isolated PostgreSQL reproductions. Confirmed issues were
fixed and rechecked: multi-host initialization stranding a pool slot, global work surviving graceful close,
premature graceful-close completion before TCP FIN, and readiness cancelling healthy pipelined work. A separate
shutdown review checked cleanup ordering, rejection handling, resource diagnostics and secret redaction.

The Docker verification uses Linux ARM64, Node 24.22.1, PostgreSQL 16.15 and 17.11, frozen dependencies and the
repository Dockerfile's runtime target. The full Server unit and integration suites run in a development test
image; the built runtime image runs the following end-to-end checks:

| Runtime scenario | Required result |
| --- | --- |
| Fresh migration and browser email signup | Ready, authenticated profile read and profile write succeed |
| Freeze 20 application sockets and the dedicated probe | Readiness 503, liveness 200; requests settle, old sockets close, original pool recovers with no Server restart |
| Pause and resume PostgreSQL | Readiness fails during the pause and recovers; authenticated reads succeed afterward |
| Start against an existing ledger with auto-migration disabled | Verification succeeds on PostgreSQL 16 and 17 |
| Migration advisory lock held by another session | Startup exits 1 after the native 2 s lock limit |
| Startup TCP connection accepts but never responds | Startup exits 1 within its short connect/transport bounds |
| Listen fails while a scheduler cleanup rejects | One redacted report retains both failures, no database sockets remain, and the process exits 1 without an uncaught rejection |
| Healthy SIGTERM | Normal exit 0 |
| SIGTERM with an active request and persistent database black hole | Every resource cleanup is attempted, failures are logged with resource and cause, exit 1 without an unhandled rejection |

The PostgreSQL 17 runtime black-hole case retains the application defaults of 30/35/60 s and observes the client
deadline at approximately 35 s. PostgreSQL 16 transport and faulted-shutdown cases use 1/2.5/5 s test overrides;
startup migration limits remain unchanged. The faulted full-process shutdown takes approximately 9.3 s with
those overrides; the 1 s database-close bound does not include HTTP draining or worker stop waits.

The Alpine test image needs a frozen install of the complete workspace for CLI/Client source fixtures, the
checked-in workflow fixture files, `git-daemon` for local `git http-backend`, OpenSSL, and a passwd entry for the
Cloud Git fixture's UID 10000. Container-side Testcontainers must reach the Docker bridge gateway when Docker
Desktop's host-published ports do not forward PostgreSQL traffic. The integration invocation uses a 15 s default
test-runner timeout for VM overhead; explicit fault deadlines and production timeout settings are unchanged.
Full integration and unit runs are serialized on an 8 GiB Docker VM. The unit container uses 4 GiB of memory
and a 1 GiB Node old-space limit to avoid kernel OOM kills seen when broad suites and builds ran concurrently.
The completed run passes 1,030 integration tests in 81 files and 4,519 unit tests in 246 files, with one existing
unit file containing 15 skipped tests. The final runs have no unhandled errors or kernel OOM kills.
No production environment, managed-database failover or complete TLS/platform matrix is established by this run.

## PostgreSQL caller lifecycle

Run `pnpm --filter @opentag/server exec vitest run src/__tests__/integration/postgres-caller-lifecycle.test.ts`
with Docker available. It uses a fresh migrated database, real Server/admin entrypoint subprocesses and a local
TCP proxy. Child processes must exit normally within the harness deadline; killing a hung child is a failure.

| Caller fault | Required result |
| --- | --- |
| Cloud-model initialization fails on established SQL before App creation | Original permission failure is reported, exit 1, no application-pool sessions remain |
| MCP rollout CLI completes its read while the peer withholds FIN | Status JSON is preserved and the CLI exits 0 after its bounded close |
| MCP rollout CLI encounters a SQL error while the peer withholds FIN | Original query failure is retained and the CLI exits 1 after its bounded close |
| Six scheduled handoffs target an unready Cloud Session and expire | Scheduler slots and Cloud tails converge, cancelled entries start no later preparation, healthy SQL still works |
| Stop overlaps those queued/preparing Cloud handoffs | Only the already-started allocation runs, no frame leaves, no new preparation starts after stop |

The Cloud cases use the actual Scheduler, Session service, collaboration owner, durable-work store and PostgreSQL;
only the allocation port reports a pending local fixture. The budget case scales the existing 20 s preparation /
50 s scheduled handoff budgets to 200 / 500 ms. No real Cloud allocation, model, or messaging provider is called.
Already-issued I/O keeps its independent bound; these tests do not assert that cancellation undoes it.

The focused `server-startup`, `session-collaboration-scheduled`, and `cloud-session-collaboration-owner` unit tests
also cover cleanup rejection before App creation, App close failing before its hook, cancelled queue entries with
live FIFO successors, cancellation during model/Sandbox/durable reads, stopped readiness polling, late allocation
completion with and without parent cancellation, final admission waiting, and post-send custody completion.
Accepted custody is never downgraded or replayed because the caller stopped waiting.
