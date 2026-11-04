# SQL caller repairs: Agent and Task authority

Supports [Agent self configuration](../../docs/system/runtime/agent-self-configuration.md),
[management authority](../../docs/system/agent-session-computer-model.md) and
[Task reads](../../docs/product/tasks.md). Full sequence and remaining findings:
[remediation checklist](../sql-caller-remediation.md).

Base: `8cb997b2abbf7785b871b1a0534e998c4d97c8d7`, 2026-11-03. Implements the
previously recorded minimum designs confirmed by the user's instruction to fix
all findings progressively. No schema, migration, dependency, transfer/retention
policy or public input change.

| Finding | Implementation | Result |
| --- | --- | --- |
| AG-F11 | Only the self wrapper supplies `agent-self` to `updateById`; the existing Agent lock guards the final opt-in check. Account remains the default source. | Native authenticated proof → owner opt-out → current-revision write rejects with 403, with instructions unchanged. Normal self writes, stale revision conflicts and Account writes while disabled pass. |
| TK-F1 | Reply-specific stored-message scope and reply selection share one read-only Repeatable Read executor. Runtime Session CTEs are not introduced. | Native actual transfer and confirmed outbound capture cannot add a new owner's reply to the admitted old snapshot. Later old-owner access denies; new owner sees the capture. Existing first-reply/no-Session, topic, pagination and Account separation regressions pass. |
| AG-F1 | Agent detail projection and activity share a read-only snapshot. IM summary/config/setup captured-row reads share their owner check's snapshot; activity uses that executor, with readiness outside its transaction. | Native actual transfer/new-owner activity and all three IM read surfaces retain only facts visible to the authorized snapshot. Fresh old-owner requests deny. |

No mutation lock is added to reads. A small private IM snapshot helper replaces
the old read-check-only helper; no new pool, timer, queue, authority cache or global
query framework. Shared one-query get-config and other ordinary callers retain
their existing execution pattern. The private activity return type is inferred
instead of repeated; the existing IM file-size exception does not grow.

## Reproduction and regression

New source regressions use independent PostgreSQL connections and actual
suspend/transfer/reactivate and outbound persistence. Pauses occur after a real
authority query, also on transaction executors. Self cases authenticate an actual
stored Local proof. No provider credentials, same-transaction trigger pretending
to be another writer or live provider calls are used.

| Run | Pass | Fail | Meaning |
| --- | ---: | ---: | --- |
| Docker baseline authority RED | 2 | 3 | All three original disputed behaviors reproduced on current main; normal self/Account controls pass. |
| Docker IM RED | 0 | 3 | All three IM metadata surfaces reproduce the transfer snapshot mismatch. |
| Docker initial repaired run | 18 | 1 | New five cases and 13 reply cases pass. One existing SQL-trace test observes only pool calls and misses transaction SQL. This run remains failed evidence. |
| Docker selective trace/IM run | 4 | 0 | Fixed trace port observes the transaction executor and still forbids Runtime table reads; three new IM snapshot cases pass. Earlier successes are not rerun here. |
| Docker affected native suites | 161 | 0 | Agent, self, list/usage snapshot/index and IM binding suites. |
| Host unit/API suites | 92 | 0 | Agent service, Agent API, Runtime self API and IM binding API. |

**275 distinct passing cases: 183 native PostgreSQL in Docker and 92 host
unit/API cases.** Eight native cases are new. The two baseline success controls
also ran after implementation, so passing executions are 277, not 277 distinct
cases. Seven failed attempts consist of six expected RED failures and one trace
instrumentation failure; all failed case identities subsequently pass. Skips and
the nonexistent selected `agent-activity.test.ts` do not contribute to counts.

Environment: current source and shared build, read-only mounts into immutable
`opentag-io-audit-tests:20261028-verified`
(`sha256:bb943ad238115b31f78fc0c28dbc20e2a9c323f8723e306a9b318586d22e095d`),
Node 24.22.1/Linux arm64, PostgreSQL 17-alpine and 73 migrations. Host unit checks
use Node 24.20.0. Logs, immutable batch source snapshot, patch and case manifest
are workspace-only under `.codex/reports/sql-caller-repairs-20261103/`.

Server type checking and `pnpm check` pass. Fresh worktree preset packages were
built for type resolution. An initial gate rejected three extra IM file lines;
inferencing the private helper's obvious return type removes the redundant
annotation and keeps its file within the existing baseline. No exception, date
or gate policy was relaxed. Latest main already carries updated exception dates,
so the historical audit's expired-exception blocker is not reused as a current
explanation. Diff review covers executor propagation, source defaults, preserved
read projections and external readiness outside SQL; independent PR review and
production acceptance are not claimed.

This closes these three findings locally, including the recorded IM extension.
The full remediation is not complete. Skill/Schedule's additional internal proof
scope contract was separately confirmed; all remaining batches keep their own
validation and review requirements. No merge, deployment, live provider, full
binary shutdown or private billing acceptance is inferred.
