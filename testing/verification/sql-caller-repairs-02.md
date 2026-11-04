# SQL caller repairs: Skill/Schedule authority and retained reports

Continues the [remediation checklist](../sql-caller-remediation.md) after batch 1
at `507d70aba75a5d89e14197d796322f7353c9f55d`, based on main `8cb997b2`.
The user confirmed the complete internal source contract on 2026-11-03. No schema,
migration, dependency, public input, retention, timeout or self-edit policy change.

| Finding | Implementation | Native evidence |
| --- | --- | --- |
| SK-F1 | Account and Computer reads share authority and row selection in a read-only snapshot. Runtime calls preserve the complete authenticated source through presets and upload. Every final mutation guards the current owned Agent; Runtime then guards binding/Session/placement/Computer/proof, using the existing proof service and transaction executor. Existing quota/name admission, revision CAS, unique object keys and uncertain-commit cleanup remain. | Actual Account transfer, rebind, source replacement/end/revocation and connection changes reject stale reads/writes. PUT remains outside SQL, rejected replacement cleans only unreferenced objects, and three independent legacy-writer races retain revision CAS and referenced objects. |
| SC-F1 | Management reads use an authorized snapshot; writes acquire Agent before Schedule. Runtime carries exact source identity through final validation. Remove redundant unlocked Account preflight checks. | Predicted-revision delete cannot cross a committed Account transfer. Revoked/replaced/ended/rebound Runtime scopes reject without changing Schedule revision or enablement. Existing timing, fixed target, dispatch and provenance suites pass. |
| IM-F5 | Skip empty retained manifests; lock live Session NO KEY UPDATE before placement UPDATE, explicitly scoped to each table. Exclude foreign-Session claims before locking their placement. | Both old 40P01 reproductions pass on the unchanged current-main source. Repaired empty/nonempty report interleavings settle without deadlock and retain the stored terminal report/hash. Foreign placement locks cannot stall an unrelated claim. |

The proof query and Local/Cloud live checks are shared, without a general
permission framework or credential cache. New internal proof ID is already
stored in PostgreSQL; raw tokens are not retained. Account operations keep their
existing undeleted-Agent semantics. Skill/Schedule still work when Agent config
self editing is disabled. Object work and cleanup run outside guarded SQL.

## Validation

**294 distinct passing cases: 153 native PostgreSQL cases in Docker, 135 host
unit/API cases and six Docker unit cases.** There are 21 new native cases (18
Skill/Schedule, three retained-report). Passing executions total 344 because
selective retries repeat controls; skipped tests are excluded. Baseline defect
probes (five Skill/Schedule, two retained-lock cases) are separate reproduction
evidence and are excluded from repaired passing counts.

| Run | Passed | Failed | Disposition |
| --- | ---: | ---: | --- |
| Skill/preset unit | 21 | 0 | Actual stored Local proofs in the harness. |
| Initial affected unit/API | 110 | 6 | Old route arguments and transaction fault ports needed contract updates; two old single-connection PGLite interleavings cannot represent the new Agent guard. One additional async error was emitted by a timed-out interleaving. |
| Selective unit/API retry | 31 | 0 | Updated route/transaction ports. The two obsolete interleavings were removed and replaced with three real independent-connection CAS races, rather than claiming those identities passed. |
| First native authority run | 11 | 0 | Actual transfer and source invalidation paths. |
| Extended authority and native regressions | 88 | 5 | Seven new authority cases plus one changed control; existing native suites. Five failed attempts came from old acknowledgement ports or a cleanup test that incorrectly expected two guarded modern writers to overlap. |
| Corrected selective native regressions | 22 | 0 | Includes 13 existing IM recovery lock cases. Cleanup now uses a separate legacy writer that bypasses the new guard; acknowledgement ports fail the actual INSERT transaction. All five failed native identities pass. |
| Final retained/steered/custody regressions | 43 | 0 | Re-runs three retained cases after correcting a test's stored-report field, plus 34 steered recovery and six custody unit cases on changed production code. |
| Retained simplification checks | 18 | 0 | Two nine-case runs after removing a repeated placement query and separating per-claim work. Distinct counts do not increase. |

The intermediate retained run used an incorrect test assertion field; typecheck
caught it, and the final run asserts the actual stored `turnReport`. Its earlier
success is not used as sole acceptance evidence. No failing run is discarded.

Source and shared build are mounted read-only into immutable Docker image
`opentag-io-audit-tests:20261028-verified`
(`sha256:bb943ad238115b31f78fc0c28dbc20e2a9c323f8723e306a9b318586d22e095d`),
Node 24.22.1/Linux arm64, PostgreSQL 17-alpine, 73 migrations. Host checks use
Node 24.20.0. Test identities, logs, patch and source snapshot are kept under the
workspace-only `.codex/reports/sql-caller-repairs-20261103/` directory.

Server typecheck and repository gates pass. Diff review checks transaction
executor propagation, Agent-first lock compatibility, source/target Agent identity,
object I/O outside locks, preserved revision/quota semantics, API wiring and
actual proof fixtures. Independent PR review, CI, live providers, full binary
shutdown, deployment and private billing acceptance are not claimed. The Cloud
case uses actual Cloud database/HMAC proof logic with controlled connection and
execution liveness ports. Timing/dispatch-only fixtures intentionally stub those
proof ports; they do not independently prove Runtime source authorization.

The complexity gate initially rejected the enlarged claim callback. Removing its
redundant placement query and separating per-claim work preserves the same
transaction while reducing the actual branching; no baseline or exception changed.

These three findings are repaired locally. All remaining original defects and
simplifications keep their own revalidation, implementation and test requirements.
