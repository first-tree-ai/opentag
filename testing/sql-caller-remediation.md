# SQL caller remediation

Applies the [database read/write standards](../docs/system/database-read-write-standards.md)
to the findings from the public caller audit at
`bc8adb15b4f3681812d2eec62751c528af57599a`. Implementation starts from refreshed main
`8cb997b2abbf7785b871b1a0534e998c4d97c8d7` on 2026-11-03, in branch
`fix/sql-caller-authority`. The original audit branch/checklist remains unchanged
as historical evidence; its completed source coverage does not certify newer main.

The user's instruction to progressively fix all findings confirms the concrete
minimum proposals already recorded. Revalidate each affected chain on the current
base before editing; present any materially different persistence/authority design
for confirmation. Keep each batch small enough to review and validate independently.
A repaired original case does not close another extension of the same finding.

## Sequence and tracking

| Batch | Findings and simplifications | State |
| --- | --- | --- |
| 1 — Agent/Task authority snapshot | AG-F11, TK-F1, AG-F1 including IM metadata | [Verified locally](verification/sql-caller-repairs-01.md): 275 distinct cases (183 native PG), server typecheck and pnpm check pass. |
| 2a — Skill/Schedule and compatible locks | SK-F1, SC-F1, IM-F5 | [Verified locally](verification/sql-caller-repairs-02.md): 294 distinct cases (153 native PG); full source contract and Session-first retained claims. |
| 2b — Final setup/Context authority | AG-F3, AG-F5 | [Verified locally](verification/sql-caller-repairs-03.md): final locked expected Computer and post-SQL abort checks; 137 distinct cases, 88 native PG. |
| 2c — Lifecycle stop authority | AG-F12; AG-F2 lifecycle extensions | [Verified locally](verification/sql-caller-repairs-04.md): Agent revision and final enqueue guards, exact proof CAS, no redundant dispatch wait; 270 distinct cases (79 native PG). AG-F2 Runtime-test and preparation extensions remain open in batch 4. |
| 3 — Contention and admission | IM-F1, IM-F6, CR-F1; CR-S1 | [Verified locally](verification/sql-caller-repairs-05.md): nonblocking claim, bounded durable Slack admission and per-call usage isolation; 201 distinct cases (77 native PG). Historical expiry scan remains an explicit scale boundary. |
| 4 — External effects and result fences | SW-F1, IM-F2, IM-F4, CR-F2, AG-F2, AP-F1 | Pending revalidation; preserve custody, exact status/attempt/Turn identities and failure classification. Official approval idle backstop remains; AP-F1 is bounded latency. |
| 5 — Stop, drain and owner resources | IM-F3, BG-F1, BG-F3, AG-F4, AG-F7, AG-F9 | Pending revalidation of actual owners; stop admission and join underlying work, not only deadline wrappers. Reuse existing owner/cursor stores. |
| 6 — Auth and OAuth recovery | AA-F1, AA-F2, BG-F2, MC-F1, AG-F13 | Pending revalidation against current Better Auth/MCP changes. Use official transactions/transport and distinguish preparation from uncertain exchange. |
| 7 — Stable Cloud ownership/recovery | SB-F1, SB-F2, AG-F10 | Pending concrete latest-source resource/placement/lock design; preserve physical UID facts and workspace compatibility. |
| 8 — Bounded reads, bodies and operator cleanup | IM-F7, BG-F4, AG-F6, AG-F8, OP-F1 | Pending revalidation; reuse existing limits/stream cancellation/owned container cleanup. |
| With owning batch — Simplification | AA-S1, AG-S1, AG-S2, AG-S3, AG-S4, AG-S5, AG-S6, DW-S1 | Pending current-source revalidation; remove demonstrated redundancy while retaining distinct admission, refresh, quota and recovery safeguards. |
| Observations | AA-R1, CR-R1, IM-R1, IM-R2, TK-R1 | Review measured limits/consumer contracts separately; no outage or necessary code change inferred from a size observation. TK legacy projection requires consumer migration before retirement. |
| Private billing | Unavailable implementation | Blocked by absent source; public adapter review is not an implementation audit. |

The table accounts for all 37 defect IDs, nine simplification IDs and five
observation IDs. Do not mark all 51 as code defects or automatically implement
extra budgets for them. No merge, release or online database action is authorized
by a completed local batch.

## Batch 1 design

No schema, migration, dependency, ownership transfer, retention or public HTTP
contract change. The following implements previously recorded minimum proposals.

| Finding | Concrete query/authority change | Preserved behavior and verification |
| --- | --- | --- |
| AG-F11 | Add the existing `account`/`agent-self` source convention to `AgentService.updateById`, defaulting to Account. Only `AgentSelfService.updateConfig` supplies `agent-self`. Under the existing Agent mutation lock, reject a disabled switch before revision/write. | No additional SELECT/lock/pool or public input field. Human updates while disabled, self request narrowing, revision CAS, Router preflight outside SQL and atomic Agent/runtime update remain. Native actual proof authentication → owner opt-out → admitted write with current revision must reject without changing instructions. |
| TK-F1 | Run reply-specific authorized scope and reply-row selection in one read-only Repeatable Read transaction. Pass its executor into both existing helpers. | Keep the reply-specific scope independent of runtime Session CTEs: captured first replies must work without a Session. Preserve topic/private-chat rules, 404, cursor and ordering. Native actual transfer plus confirmed outbound capture must be excluded from the old snapshot; fresh old-owner read denies and new owner sees it. |
| AG-F1, detail | Run `getById` ownership projection and activity queries on one read-only Repeatable Read executor, following existing list/usage pattern. | No mutation lock, authorization retry, extra snapshot for ordinary get-config or changed projection. Native actual suspend/transfer/reactivate plus new-owner activity leaves the admitted old snapshot idle; later old-owner read denies. IM metadata extensions use the same local read-only snapshot boundary; readiness is computed after releasing that transaction. |

Tests use independent PostgreSQL connections and pause after an actual authority
query, including a transaction executor; they do not simulate a concurrent writer
using a trigger in the same transaction. Self tests authenticate an actual stored
Local proof. Each case asserts post-operation state and later access, in addition
to the initial rejection/response.

## Validation and progress

Batch 1 latest-main RED regressions reproduced all six disputed interleavings
(three original cases and three IM read surfaces). Local fixes and affected native
regressions pass; type checking passes after building workspace preset dependencies.
Repository gates and diff review pass. [Batch 1 evidence](verification/sql-caller-repairs-01.md) records 275 distinct cases. [Batch 2a evidence](verification/sql-caller-repairs-02.md) records Skill/Schedule and retained-report fixes; all other batches remain open. Tests/probes do not establish live provider or full
binary shutdown acceptance. Never label the whole remediation complete while a
batch or unavailable boundary remains open.

## Confirmed design: complete Skill and Schedule authority

The Account-only fixes in the original proposal do not by themselves close the
Runtime variants. Latest-source inspection confirms that Runtime Skill routes
retain only `agentId`, and `ScheduleService.authenticate` discards the Computer,
connection and placement fields from `SessionCliSourceContext`. A final Agent
owner check cannot distinguish an old proof/request from a new execution with the
same Agent after rebind/recovery. The user confirmed the following complete internal authority contract on
2026-11-03. Implement it after the lock compatibility check, without requesting
confirmation again for this same design.

1. Preserve the authenticated `SessionCliSourceContext` through Skill upload,
   bundle/list/preset and Schedule self operations, rather than retaining Agent ID
   alone. Add the already-stored `proofId` to that internal context. Keep Account
   ownership captured for the operation. No raw proof token, new HTTP field,
   database column, migration or credential cache is introduced.
2. Reuse `SessionCliProofService` for final source validation on the caller's
   supplied executor, sharing its existing joined source checks and Local/Cloud
   live-connection rules. Compare the captured proof ID, Agent, Session, Computer,
   placement generation, installation and connection instance; reject an ended
   Session, disabled binding, replaced proof/placement or dead source. Do not
   replace Cloud execution liveness with a database-only approximation.
3. Mutations first guard the owned Agent with `NO KEY UPDATE`, then the source
   binding/Session, placement, Computer and proof in the existing source lock
   order before the Skill or Schedule row. Hold the relevant proof/placement guards
   through mutation so revocation/rebind cannot pass between final authorization
   and the write. Check compatibility against mint/revoke, Session creation/end,
   transfer and scheduler dispatch before editing; avoid a schedule-first Agent
   lock inversion. All SQL uses one transaction executor.
4. Account Skill enable/remove/replace and Account Schedule pause/resume/delete
   use the same final owned-Agent guard, followed by existing row/revision CAS.
   New Skill insertion retains its locked count/name limit. Read authorization
   and row selection share a read-only snapshot where they span statements.
5. Archive/object preparation and reads stay outside mutation transactions. On
   final denial, retain reference-aware unknown-commit cleanup and unique keys;
   leave previous objects to existing GC grace/recheck. Preserve Schedule timing,
   fixed target, provenance, revision and database-clock semantics. Schedule and
   Skill do not acquire the Agent config self-opt-in policy.
6. Native tests: real Account transfer (including predicted Schedule revision),
   rebind, placement/proof replacement, source Session end and concurrent revoke;
   final rejection leaves rows/revisions/quota unchanged. Run actual Local proof
   and controlled live Cloud authority ports, plus upload/unknown-ack/GC and
   scheduled dispatch regressions. State limits of component proof tests; no live
   provider/binary-shutdown claim.

This adds source identity to existing internal service calls; it does not create
a general authorization framework. Do not close SK-F1/SC-F1 after only their
Account reproductions pass. If the lock compatibility check requires a different
persistence design, present that change separately.

## Batch 2a outcome

The confirmed Skill/Schedule contract is implemented. Lock compatibility inspection
reproduced IM-F5 on current main, so its previously proposed Session-first retained
claim repair moved into this batch. No schema or timeout change is needed.
[Evidence](verification/sql-caller-repairs-02.md) records the 21 new native fault
cases, affected regressions, controlled Cloud boundary and replaced obsolete unit
interleavings. Six original defects are now repaired locally across batches 1 and
2a; 31 original defects, nine simplifications, five observations and the absent
private implementation retain their explicit remaining scope.

Batch 2b then closes AG-F3/AG-F5. Batch 2c closes AG-F12 and only the lifecycle
portion of AG-F2. Nine original defects are repaired locally; 28 defects, nine
simplifications, five observations and the unavailable implementation remain.

Batch 3 closes IM-F1/IM-F6/CR-F1 and CR-S1. Twelve original defects and one
simplification are repaired locally; 25 defects and eight simplifications remain.
Five observations and unavailable private source retain their separate scope.
