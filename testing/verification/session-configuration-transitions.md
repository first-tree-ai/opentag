# Session configuration transitions

Date: 2026-10-22. Original red/green baseline: `3d96c8edb11ee569267eb4343dfb6bdbac90576c`.
Pre-PR integration base: `f178a0868ce0af909761e5b7ebca0be562e94fb6`.
Issue: [#980](https://github.com/first-tree-ai/opentag/issues/980).
Contracts: [Agent self-configuration](../../docs/system/runtime/agent-self-configuration.md#when-changes-apply)
and [Agent Runtime](../../docs/system/runtime/agent-runtime-contract.md).

The simplified design was approved and implemented locally after expanding the tests.
The two reported defects and related revision/preparation boundaries are covered by ordinary passing regressions.
All files, identities, messages, and reports are synthetic and live in temporary directories.

## Test boundaries

The new [unit suite](../../packages/client/src/__tests__/session-configuration-transitions.test.ts)
uses the real `SessionBindingStore`, `AgentWorkspaceManager`, and `SessionReconciler`.
Legacy fixtures persist the historical snapshot shape, historical snapshot/input hashes,
a native Provider binding, and a completed delivery receipt. They cover both supported
snapshot layouts; binding-file v1/v2 parsing remains covered by the existing store suite.

Every store transition calls `validatePreparation` before `prepare`. Reconciler cases use
preparation backed by the real store, including the preflight before Agent/workspace preparation.
Restart cases create fresh objects over the same files. Persistence interruptions are injected
at the durable writer call boundary; successful writes still use the actual atomic file writer.

The store suite verifies readiness and durable delivery custody. The complementary manager and
Client Turn suites exercise create/resume, real runtime adapters with controlled transport, report
ACK, and a subsequent completed Turn. These are component tests, not external model execution
or outbound IM acceptance. Reports used to exercise store-only deduplication are synthetic.
The interruption cases do not claim an operating-system power-loss or `fsync` fault test.

## Scenario matrix

| ID | Scenario | Baseline observation / protected behavior | Cases |
| --- | --- | --- | ---: |
| SCT-01 | Compatible legacy migration, Codex and Claude Code | Retain the native binding; use current execution policy; preserve old snapshot bytes, receipts, workspace history; repeated preparation and restart agree | 4 |
| SCT-02 | Supported format migration at unchanged sequence | Retain native binding under the existing compatibility rule | 2 |
| SCT-03 | Authentic legacy snapshot plus a newer Soul | Preflight is read-only; preparation commits successfully and repeats safely after restart | 2 |
| SCT-04 | Newer Soul through a fresh real-store reconciler | Ready and admits the pending message before and after restart | 2 |
| SCT-05 | Direct legacy-to-new-Soul store transition | Prepare successfully, clear old native binding, preserve history/receipts, and repeat safely | 2 |
| SCT-06 | Legacy-to-new-Soul reconcile and delivery admission | Ready, new message accepted once, duplicate acceptance and completed redelivery remain deduplicated | 2 |
| SCT-07 | Newer Soul/model/reasoning after migration completed | Ready; clear native binding; preserve history and receipts; new delivery gets one durable custody record | 6 |
| SCT-08 | Missing/altered snapshot, hash/Agent/workspace/Provider/artifact mismatch, stale placement/revisions, same-revision Soul conflict | Reject without changing binding, remaining snapshots, or workspace history | 22 |
| SCT-09 | Legacy Turn in accepted/starting/running/reporting phase | Both migration-only and migration-plus-Soul-change wait for recovery and preserve the entire durable state | 8 |
| SCT-10 | Unchanged current-format snapshot after restart | Retain native binding and semantic binding content; preserve immutable snapshot bytes and history | 1 |
| SCT-11 | Newer Soul/model/reasoning on current-format binding | Clear native binding and preserve historical receipts; accepted/completed redelivery stays deduplicated across restart | 3 |
| SCT-12 | Current-format same-revision model/reasoning conflict after restart | Reject without changing files | 2 |
| SCT-13 | Interruption before snapshot write, before binding write, or after binding commit, including direct legacy-to-new-Soul changes | Old binding remains usable before commit; an already committed binding is usable after restart; preserve original snapshot/receipts and avoid duplicate custody | 15 |
| SCT-14 | Current-format same-revision Soul conflict, warm versus cold reconciler | Both reject without changing durable state | 1 |
| SCT-15 | Same-revision Soul conflict rejection after restart | Reject using persisted Agent configuration and preserve all files | 1 |
| SCT-16 | Newer Soul while an in-memory Turn is running/reporting | Return busy and preserve durable state | 2 |
| SCT-17 | Independent Agent/Session version advances, equal-sequence content conflicts, mixed version changes, stale versions; with/without a native binding | Correct accept/reject after restart across current and both legacy layouts; reject without writes | 48 |
| SCT-18 | Missing original snapshot plus a changed request, with/without native binding | Reject without writes across all three layouts | 6 |
| SCT-19 | Completed/cancelled steer targets followed by configuration replacement | Completed target remains absorbed; cancelled target can acquire new custody; original report and receipts survive | 6 |
| SCT-20 | Exact-hash missing current snapshot, with/without native binding | Reconstruct the original snapshot and retain binding semantics | 2 |
| SCT-21 | Current-format Agent/Session ID, binding hash, or snapshot content conflict | Reject before Agent preparation and preserve disk state | 4 |
| SCT-22 | Legacy network widening at equal/newer versions | Equal version rejects; valid newer configuration replaces the native conversation | 4 |
| SCT-23 | Legacy self-configuration changes at equal/newer versions | Preserve published layout semantics; a represented opt-in change needs a newer Agent revision and replaces native conversation | 4 |

Total: 149 expanded cases in the new store/reconciler suite. No `fails` or `skip` markers remain.

Changing Soul before upgrading and changing it after upgrading but before this Session's first
successful migration produce the same store input: a legacy persisted snapshot plus a newer
requested Soul. SCT-03 through SCT-06 cover that shared boundary without duplicating identical
tests under two timeline labels. SCT-07 covers the distinct case where migration has already
completed before Soul changes.

## Existing complementary coverage

- [Session binding store](../../packages/client/src/__tests__/session-binding-store.test.ts):
  schema-v1/v2 binding readers, missing snapshot directory, filesystem integrity, steer receipts,
  and both legacy layouts with accepted/reporting recovery. The recovery flow uses `ClientRuntime`
  and `MvpTurnReportRecovery`, holds the report ACK, preserves the old binding until settlement,
  and checks retained report hashes.
- [Session reconciler](../../packages/client/src/__tests__/session-reconciler.test.ts):
  in-memory revision/placement checks, activity and recovery fences, duplicate reconcile requests,
  and preparation conflicts.
- [Session runtime manager](../../packages/client/src/__tests__/session-runtime-manager.test.ts):
  fake Provider factories behind the real manager, including native create/resume and configuration
  lifecycle. The new suite's cleared binding assertion alone is not evidence of model execution.
- [Shared runtime domain](../../packages/shared/src/__tests__/runtime-domain.test.ts): frozen
  published hash vectors for `0.1.0` and the self-configuration layout.

## Red/green evidence

The initial test-only baseline had 64 passing cases and five desired-behavior failures in the
new suite. Those five initially used `it.fails` alongside precise defect characterizations.
Before implementation, the markers were removed, the characterizations were updated to the
approved outcomes, and missing version, permission, receipt, persistence, manager, and recovery
cases were added.

The final four changed test files were also checked against the original production store and
reconciler: **58 failed and 206 passed (264 total)**. The two refactored source files were restored
in a `finally` block and verified byte-for-byte. Failures covered direct legacy replacement,
cold Agent validation, the explicitly tightened missing-snapshot fallback, and warm Agent-only
preparation. This reverse check does not count as a passing regression run.

The focused five-file run passed **277/277** after implementation, including the original
Session reconciler suite. The existing store scenarios for changed Soul, wider network, and
changed self-configuration opt-in intentionally now assert native replacement at valid newer
versions. Omitted opt-in remains equivalent to false and retains native conversation. The new
suite separately rejects equal-sequence content changes; integrity assertions were retained.

## Commit-history regression review

The [design audit](../design/session-configuration-transitions/README.md#commit-history-audit-and-regression-obligations)
records the reviewed commits and their protected behavior, including workspace migration,
Provider identity, accepted-work settlement, steer receipts, report recovery, permission/version
migration, and explicit reconcile error responses.

Additional component coverage added for this implementation:

- Eight manager cases: both legacy layouts on Codex and Claude Code, with/without a Soul change,
  assert actual factory create/resume selection, current prompt/policy, repeated reconcile, and restart.
- Eight Client Turn cases: both legacy layouts across accepted/starting/running/reporting; a delayed
  report ACK blocks configuration replacement, then the newer Soul starts a new native conversation
  and the next Turn completes. Original input/report hashes and duplicate delivery handling survive.
- One warm Agent-only update case: demonstrates that unchanged Session revision must not leave
  the Runtime on the old Agent snapshot. This failed before the effective-hash preparation check.
- A late `binding_changed` callback is rejected after the old Runtime is replaced and cannot
  overwrite the new binding.

## Validation

```sh
pnpm --filter @opentag/client test
pnpm --filter @opentag/client test:agent-runtime:coverage
pnpm --filter @opentag/shared test src/__tests__/runtime-domain.test.ts
pnpm --filter @opentag/server test src/__tests__/im-delivery-pinned-hash.test.ts
pnpm --filter @opentag/client typecheck
pnpm check
```

| Check | Result |
| --- | --- |
| Focused store, transitions, reconciler, manager, and Client Turn suites | 277 passed |
| Full Client suite on the pre-PR integration base | 2,710 passed, six conditionally skipped; no failures |
| Agent Runtime coverage gate on the pre-PR integration base | 675 passed; statements, branches, functions, and lines all 100% within the existing configured scope |
| Shared frozen runtime/hash contracts | 39 passed |
| Server pinned-hash validation | Four passed |
| Client typecheck and repository checks | Passed |

The initial baseline full Client run's sole failure was an update-manager subprocess importing the absent
`packages/client/dist/index.mjs` in the fresh worktree. After `pnpm --filter @opentag/client build`,
the entire 20-case update-manager suite passed. That original run plus its targeted rerun established
2,689 passing non-skipped Client tests. After integrating the latest main and rebuilding the Client,
a fresh full run passed all 2,710 non-skipped tests without a rerun. The additional tests came from
the integrated mainline change. The six existing native CLI tests were skipped by their
binary/environment/platform conditions.

The Runtime coverage percentages apply to the existing Agent Runtime gate, not every Client
source file. The Server check is a unit suite and does not require PostgreSQL. Logs and
machine-readable results remain in `.codex/reports/issue980-session-tests-20261022/` under the
parent workspace, not the repository.

No database, dependency, exports, or packaging behavior changed. PostgreSQL integration,
full-workspace CI, installed Provider execution, and real IM delivery are not established by these
local component checks. The [design record](../design/session-configuration-transitions/README.md)
tracks approval and implementation scope.

## Pre-PR self-review

The review rechecked the production diff, the callers in the workspace/Reconciler/Runtime manager,
and the corresponding tests against the approved design. It found no additional blocking defect.
Identity and placement checks, unresolved-work settlement, original receipt/report hashes,
snapshot-before-binding persistence, missing-runtime preparation, and stale native callbacks
retain their existing protections. The intentional missing-snapshot restriction and newer-legacy
replacement outcomes are documented and tested above.

The implementation keeps one private validation/selection entry point and three local helpers for
stored identity, independent revisions, and the frozen legacy projection. They reuse existing types;
no transition state, general migration framework, new interface, or persistence field was added.
The old coupled continuation/revision helpers and the second native-retention decision were removed.

The worktree was fast-forwarded to the integration base above without conflicts. Its two intervening
commits change Cloud Pi diagnostics and Web setup navigation; neither overlaps the modified files.
Client package regressions and the Runtime coverage gate were rerun because the base includes new
Client/Provider code. The original failing-test evidence remains tied to its original baseline.

## Follow-up acceptance cases

These remain external acceptance cases for an installed release; local component results above do not establish them:

1. Begin from each supported published legacy layout. Change Soul before upgrading, then deliver
   a new message to the original Session; repeat with the Soul change after upgrade but before
   the first successful Session migration.
2. Confirm the message reaches accepted/running and completes through the installed Provider.
   Keep the OpenTag Session and history, use the new Soul and current authorized execution policy,
   create a new native conversation, and do not automatically replay historical messages.
3. Upgrade without a content change and confirm compatible native conversation continuation.
4. Hold an accepted/running/reporting Turn across restart. Confirm settlement/recovery precedes
   configuration replacement, report replay retains original hashes, and no delivery executes twice.
5. Interrupt at snapshot/binding persistence boundaries and restart the actual Client. Confirm
   the pending delivery eventually executes once and the old history remains available.
6. Repeat ordinary current-format configuration changes and same-revision/stale requests in
   warm and cold processes. Observe consistent conflict decisions.
