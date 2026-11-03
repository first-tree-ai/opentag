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
| 4a — SQL classification and terminal fences | SW-F1, IM-F4, CR-F2 | [Verified locally](verification/sql-caller-repairs-06.md): SQL failures stay outside provider accounting; current attempt and exact terminal-record CAS; 289 distinct cases (90 native PG). |
| 4b — Runtime test and approval enqueue | AP-F1; AG-F2 Runtime-test portion | [Verified locally](verification/sql-caller-repairs-07.md): lock lifetime ends at synchronous enqueue, existing Runtime test result budget; 59 distinct cases (6 native PG). AG-F2 preparation remains open. |
| 4c — Send cancellation | IM-F2 | [Verified locally](verification/sql-caller-repairs-08.md): forward the existing operation signal, final reconcile admission, no new sends/allocation after deadline; 217 distinct cases (45 native PG). |
| 4d — Preparation deadline | AG-F2 preparation portion | [Verified locally](verification/sql-caller-repairs-09.md): one existing preparation budget covers admitted dispatch waits and readiness; 65 distinct cases, including 2 native PG and 63 Docker unit cases. |
| 5a — Background stop and GC work bound | BG-F1, BG-F3; IM-F3 GC portion | [Verified locally](verification/sql-caller-repairs-10.md): actual pass Promises replace running flags; page quota/cursor; 87 distinct cases (59 native PG). Main already awaits these stop ports. |
| 5b — Stop, drain and owner resources | IM-F3, AG-F9 | AG-F9 [verified locally](verification/sql-caller-repairs-22.md). IM-F3 [verified locally](verification/sql-caller-repairs-37.md): component owners, actual HTTP work, main composition and built Server PG17 signal controls. Separate Google transport observation AA-R1 and final broad validation remain. |
| 5c — Client Context Tree resources | AG-F7, AG-F8 | [Verified locally](verification/sql-caller-repairs-11.md): memoized cleanup and bounded UTF-8 collection; 94 distinct cases, 27 repeated in Docker. AG-F8 moves from batch 8 to share the same client validation scope. |
| 5d — Setup authority and read simplification | AG-F4; AG-S1, AG-S2 | [Verified locally](verification/sql-caller-repairs-12.md): exact callback target before send/success; shared one-query summary and direct creation replay; 162 distinct cases (21 native PG). |
| 6a — Account/auth | AA-F1, AA-F2; AA-S1 | [Verified locally](verification/sql-caller-repairs-13.md): official adapter transaction and scoped internal Account read, precise errors and simpler setup; 199 distinct cases (106 native PG). |
| 6b — MCP OAuth recovery | BG-F2, MC-F1 | [Verified locally](verification/sql-caller-repairs-14.md): preserve unspent refresh state and end failed consent, fenced against newer flows; 213 distinct cases (104 native PG). |
| 6c — MCP discovery bounds | AG-F13 | [Verified locally](verification/sql-caller-repairs-15.md): deduplication, four-candidate admission and shared 30-second outbound budget; 254 distinct cases (18 native PG). |
| 7a — Stable Cloud ownership | SB-F1, SB-F2 | [Verified locally](verification/sql-caller-repairs-17.md): retained placement ownership and final locked reservation; 301 distinct cases (88 native PG). |
| 7b — Cloud workspace routing | AG-F10 | [Verified locally](verification/sql-caller-repairs-18.md): workspace-owned hints, independent confirmed settlement and actual rebind/gateway recovery; 283 distinct cases, all repeated in Docker Linux. |
| 8a — Bounded metadata and Thread root | IM-F7, BG-F4 | [Verified locally](verification/sql-caller-repairs-19.md): one projected root and streaming metadata bounds; 59 distinct cases (6 native PG). |
| 8b — Git subtree verification | AG-F6 | [Verified locally](verification/sql-caller-repairs-20.md): literal selected-path and separate ancestor entry listing; 41 host/Docker cases, existing process bounds retained. |
| 8c — Operator cleanup | OP-F1 | [Verified locally](verification/sql-caller-repairs-21.md): shared client defaults and native five-second close; 102 Vitest cases and both actual Docker benchmark CLIs, owned containers removed. |
| 6d — Remaining simplification | AG-S3, AG-S4, AG-S5, AG-S6, DW-S1 | [Verified locally](verification/sql-caller-repairs-16.md): direct Settings credential read, Local-only query removal, one owner read, locked MCP check and unreachable quota deletion; 225 distinct cases (94 native PG). |
| Observations | AA-R1, CR-R1, IM-R1, IM-R2, TK-R1, LC-R1 | AA-R1 [fixed locally](verification/sql-caller-repairs-38.md) with native token-exchange budget. CR/IM measured costs do not establish a required rewrite; TK legacy projection requires external API compatibility review before retirement; Web already uses paged sections. IM-R2 [fixed locally](verification/sql-caller-repairs-40.md): same-output SQL selection avoids unrelated full payloads after native scale/equivalence checks. LC-R1 lifecycle fan-out was omitted from the initial ledger; native scale/busy-domain tests confirm excessive preparation and partial stop. Its supplemental policy below awaits confirmation. |
| Private billing | Unavailable implementation | Blocked by absent source; public adapter review is not an implementation audit. |

The table accounts for all 37 defect IDs, nine simplification IDs and six
observation IDs. Do not mark all 52 as code defects or automatically implement
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

Batch 4a closes SW-F1/IM-F4/CR-F2. Fifteen original defects and one simplification
are repaired locally; 22 defects, eight simplifications and the separate
observations/unavailable boundary remain.

Batch 4b closes AP-F1 and the original Runtime-test portion of AG-F2. Sixteen
original defects and one simplification are repaired locally; 21 defects and eight
simplifications remain. AG-F2 preparation and IM-F2 cancellation remain open.

Batch 4c closes IM-F2 across Local/Cloud direct/steer and allocation stages.
Seventeen original defects and one simplification are repaired locally; 20 defects
and eight simplifications remain, including Provider preparation under AG-F2.

Batch 4d closes the remaining AG-F2 preparation portion. Eighteen original
defects and one simplification are repaired locally; 19 defects and eight
simplifications remain. Ending an admitted wait is not joining its underlying
SQL/socket work: IM-F3 still owns final shutdown composition and drain.

Batch 5a closes BG-F1/BG-F3 and only the GC portion of IM-F3. Twenty original
defects and one simplification are repaired locally; 17 defects and eight
simplifications remain. Final Runtime/route close order and other IM-F3 owners
remain open; native component resource cleanup does not certify Server shutdown.

Batch 5c closes AG-F7/AG-F8. Twenty-two original defects and one simplification
are repaired locally; 15 defects and eight simplifications remain. Other owner
drains, final Server shutdown order and independent review remain open.

Batch 5d closes AG-F4/AG-S1/AG-S2. Twenty-three original defects and three
simplifications are repaired locally; 14 defects and six simplifications remain.
All five observations and unavailable private implementation remain separate.

Batch 6a closes AA-F1/AA-F2/AA-S1. Twenty-five original defects and four
simplifications are repaired locally; 12 defects and five simplifications remain.
Previously stranded Accounts are not silently reclaimed, overwritten or deleted.

[Independent review 1](verification/sql-caller-independent-review-01.md) confirms
no actionable finding in batches 1/2a at commit 29f57a53. It is a read-only
review, without a new Docker rerun. [Independent review 2](verification/sql-caller-independent-review-02.md) covers
completed batches 03–13 at 9e3babd9 without actionable findings. Neither review
reran Docker; pending batches are not certified by them.

Batch 6b closes BG-F2/MC-F1. Twenty-seven original defects and four
simplifications are repaired locally; ten defects and five simplifications remain.
AG-F13 discovery bounds and final Server shutdown are still open.

Batch 6c closes AG-F13. Twenty-eight original defects and four simplifications
are repaired locally; nine defects and five simplifications remain. Independent
review of batch 14 at 1ab43c77 also found no actionable issue (no test rerun).

Batch 6d closes the remaining five simplification IDs. Twenty-eight defects and
all nine justified simplifications are repaired locally; nine defects remain.
Independent source reviews of batches 14 and 15 at 1ab43c77/f8eca399 found no
actionable issue; neither reviewer reran tests or certified final Server shutdown.

## Batch 7a concrete design

SB-F1/SB-F2 use existing placement facts, without a new owner column. Cloud
Computer owners are stable, one Cloud Computer exists per Account, Cloud/Local
rebind is forbidden, and transfer retains ended Session placements. Borrow moves
one exact UID only between same-Account Sandbox rows. Production has no caller of
the low-level movePlacement helper. Physical count/read/report/cleanup and the
three runner candidate/holder joins therefore follow Sandbox → Session placement
→ Cloud Computer owner. Managed execution separately requires the current Agent
Computer/owner and active Account/Agent/binding/Session. Agent overview keeps
current Agent ownership; it may use owned historical Cloud placements after detach,
without exposing a transferred Agent to its former Account.

Reservation retains capacity advisory as first lock, then Account NO KEY UPDATE,
Agent UPDATE (captured preflight revision), binding UPDATE, Session NO KEY UPDATE,
placement UPDATE, Computer UPDATE, Sandbox UPDATE. All final checks use that
executor. Read/stop continue locking Sandbox only; physical owner joins and the
borrow candidate check remain ordinary reads. Remove ensureIngressAllocation's
ineffective autocommit Sandbox lock: actual start revalidates in its reservation
transaction. Provider/storage I/O remains outside SQL, with the existing generation,
operation, resource-name and UID fences and unknown-outcome retention.

Independent source/design review found no confirmed reverse lock cycle: ensure
and rebind serialize on Agent; idle work barriers only read placement/durable
rows; borrow takes no authority locks after Sandbox. Native validation must prove
committed-first withdrawal, in-flight serialization, preserved original-owner
capacity/status/cleanup after actual suspend/transfer, and existing borrow/recovery.

Batch 7a closes SB-F1/SB-F2. Thirty defects and all nine simplifications are
repaired locally; seven defects remain. Independent review of batch 16 at
573157e4 found no actionable issue (source review, no test rerun).

## Batch 7b concrete design

AG-F10 keeps the Local filesystem route. Cloud supplies a small session-hint I/O
port to the existing gateway, executed through its existing NativeSandbox exec
path. Only `{id, source}` is written under
`/workspace/.opentag/context-tree/command-sessions/<uuid>.json`, alongside the
already archived CLI HOME/project/draft. UUID, 4-KiB, schema and current configured
source checks remain; directory/file permissions are 0700/0600. Reads reject links,
special files and oversized data. No execution handle/token is persisted. Gateway
close never deletes a retained write hint. Successful abort, published and unchanged outcomes
remove it; unknown outcomes retain it for explicit recovery. A fresh Runner host
or rebind can recover entirely from the workspace, without a host hint or a new
prepare/publish attempt. Existing exec cancellation bounds file work.

Independent review found a cancellation window after confirmed CLI completion:
request cancellation could prevent writing the recovery hint or deleting a
finished one. Confirmed settlement now uses the existing 5-second Sandbox exec
bound independently of request cancellation; gateway close still joins that actual
work. Reads remain cancellable. No new timer or background queue is introduced.

Batch 7b closes AG-F10. Thirty-one defects and all nine simplifications are
repaired locally; six defects remain. [Independent review 3](verification/sql-caller-independent-review-03.md)
records exact completed ranges and the corrected Cloud hint cancellation window.

## Batch 8a concrete design

IM-F7 projects the row provider's root (`threadTs` for Slack, `rootId` otherwise),
filters missing/empty roots in SQL and retains occurredAt/revision/ID descending
order with LIMIT 1. Binding/Channel/Thread/inbound predicates and no-root fallback
remain; no schema/index/cache/transaction is added. Native actual Inbox and EXPLAIN
must verify one materialized root and existing direct-root inheritance semantics.

BG-F4 Channel uses existing readBoundedJson's 256-KiB byte limit and 10-second
request signal, cancelling non-OK bodies and retaining its last-good target. The
published staging pointer was read on 2026-11-03 at
https://dl.opentag.build/releases/staging/latest.json: HTTP 200, 1,868 bytes,
0.1.5-staging.48.1 (workspace frozen evidence retained). S3 LIST uses a 4-MiB byte
limit while streaming before UTF-8 decode, replacing its late 4-Mi-character check.
Normal Skill keys/pages fit that bound; multibyte bodies are explicitly subject
to bytes. Preserve typed invalid_response, existing request timeout and no retries.
Test no Content-Length, cancellation, split UTF-8 and subsequent normal recovery.

Batch 8a closes IM-F7/BG-F4. Thirty-three defects and all nine simplifications
are repaired locally; AG-F6, OP-F1, AG-F9 and final IM-F3 remain. Independent
review confirmed batch 18 at 7a257f49, including its corrected P2 settlement window.

## Batch 8b concrete design

AG-F6 lists each selected path component's exact nonrecursive entry separately,
then recursively lists only the literal selected subtree. Git ls-tree treats its
path arguments as patterns; combining ancestor and child patterns can still list
unrelated siblings. Use --literal-pathspecs and one entry query per component,
sequentially under the existing operation signal/process bounds. Each ancestor must be exactly one 040000 tree entry; missing paths or ordinary
files fail immediately rather than multiplying process launches. Reject 120000/160000 modes before
checkout, retain filesystem ancestor checks and pinned CLI verification. Root
selection still lists the whole repository. Do not enlarge the 1-MiB output bound,
change full fetch/checkout, cache or introduce parallel Git processes.

Batch 8b closes AG-F6. Thirty-four defects and all nine simplifications are
repaired locally; OP-F1, AG-F9 and final IM-F3 remain. Batch 19 independent
review at b846c5e9 found no actionable issue.

## Batch 8c concrete design

OP-F1 replaces the three benchmark raw admin/fixture/EXPLAIN clients with the
existing createDatabaseClient(max: 1), retaining the shared official connect,
statement and idle-transaction settings and the existing elapsed deadline.
The tracked Agent/Session and Task fixture statements measured at most 2,875 ms
and 1,844 ms respectively; the existing 30-second statement / 35-second elapsed
budgets fit these separate benchmark operations without widening Server or
startup migration budgets. Retain the Agent admin's five-second native end and
apply that same bound to other owned benchmark clients. Existing independent
cleanup/error aggregation still reaches owned-container removal. No benchmark
framework, schema, retry or timeout wrapper. Test the native admin through a
lossy PostgreSQL proxy and run the actual fixture/CLI against disposable Docker.

Batch 8c closes OP-F1. Thirty-five defects and all nine simplifications are
repaired locally; AG-F9 and the final IM-F3 composition remain. Batch 20
independent review P2 is corrected at 7b1b81fe and reviewer-confirmed closed.

AG-F9 component reclamation is verified locally. Thirty-six defects and all
nine simplifications are repaired at component scope; final IM-F3 remains,
including async admission/stop races and listener lifetime through owner drain.

## Final IM-F3 composition work

[Provider preparation drain](verification/sql-caller-repairs-23.md) is verified at
component scope. It introduces an awaitable close port; actual route/main wiring
still needs to join it. [Independent review 4](verification/sql-caller-independent-review-04.md)
records batches 19–22 and the pinned shutdown dependency findings.

Remaining work reuses each existing owner and applicable signal/task collection:

- Runtime Domain: stop admission, join preparations/completions and custody releases.
- RuntimeSession / RunnerConnection: join registration, heartbeat, frame/business,
  disconnect and transport-close work; socket close alone is insufficient.
- Credential owner / provider transport: stop admission, join broker/stream and
  revalidation SQL, then unsubscribe execution/URL-handle listeners.
- IM worker / Inbox: join actual operation work after deadline grace, queued drop,
  maintenance, overflow and admitted ingest continuations.
- Feishu: replace maintaining flag with its pass Promise; join detached observation,
  enrichment, inbound and setup work before releasing the final lease and pool.
- Slack setup / Context Tree: join complete high-level runs, including final SQL
  after a remote result or client disconnect; do not track every internal query.
- Approval poll/request work, OAuth callback probe and Cloud detach proof cleanup:
  join the actual detached Promise at their existing owning boundary.
- Main / actual async execution plugin: root preClose initiates all stop ports
  without throwing/blocking websocket preClose; onClose joins them; the earliest
  registered final hook releases readiness/pool/telemetry even after close errors.

Final native Docker verification must use actual createApp child-plugin boot,
SQL barriers, disconnected clients, late results and close failures, and inspect
final custody/leases/transactions and absence of post-disposal queries. Ordinary
single-query HTTP calls and non-SQL Channel polling do not acquire extra owner
collections merely to make the checklist uniform. IM-F3 remains open until that
composition and the remaining observations are resolved and reviewed.

[Feishu connection and Inbox drain](verification/sql-caller-repairs-24.md) is
verified at component scope (205 cumulative cases, 21 native PG, including its review correction). New close ports still need
actual main/route composition. Complete Feishu setup service, Runtime/Runner and
transport, high-level Slack/Context Tree, approval/OAuth/Cloud cleanup and IM
worker work remain; IM-F3 stays open. No issue count is advanced for a partial
shutdown repair. Batch 23 review P2 is corrected at 0efff524 and reviewer-confirmed.

[Runtime Domain drain](verification/sql-caller-repairs-25.md) is verified at
component scope (73 cumulative cases, two native PG, including its review correction). It joins starting dispatches and
pending releases as well as preparation/completion/send work. Actual route/main
awaiting and the remaining owner/connection composition still keep IM-F3 open.
Batch 24's late adapter/callback P2 findings are corrected at 4d6969bd and
reviewer-confirmed closed; the earlier component counts include that correction.

[RuntimeSession and scheduler drain](verification/sql-caller-repairs-26.md) is
verified at component scope (74 cases, seven native PG). Instances expose an
awaitable close, but actual Runtime route retention/join, Runner/transport,
remaining owners and final main ordering remain open IM-F3. Failure-reaction
ownership already used its existing pending map and was left simple. Batch 25's
omitted-read/admission P2 is corrected at 0b09a346 and reviewer-confirmed closed.

[Runtime and Runner route drain](verification/sql-caller-repairs-27.md) now joins
retained connections even after physical peer disconnect. Ninety-three distinct
cases pass, including two native PG controls through actual asynchronous plugin
boot and an unrelated failing close. Remaining owners/transport and final main
composition still keep IM-F3 open. Batch 26 independent review found no action.

[Credential and provider transport drain](verification/sql-caller-repairs-28.md)
joins actual SQL/stream work and retains revocation listeners until it settles.
Two hundred distinct cases pass, including 41 native PostgreSQL cases. Batch 27
independent review found no actionable defect. Remaining IM worker, setup,
approval and detached tails plus actual main composition still keep IM-F3 open.

Batch 28 independent review found two P2 windows (late response handles and
missing broker-to-task-policy cancellation). The correction uses existing signals
and passes 143 cases, five native PG; cumulative component coverage is 263 cases,
41 native PG. Exact correction review is pending. Default outbound capture raw
query tails remain included in final IM-F3 ownership work.

[IM worker and ready-wakeup drain](verification/sql-caller-repairs-29.md) retains
actual work past deadline grace, maintenance and detached reads. Its 132 distinct
cases pass, 19 native PostgreSQL. Batch 28 P2 corrections at 6c87b97c are independently
confirmed closed. IM-F3 remains open for setup, high-level services, approval,
detached callback/proof/capture tails and final main composition.

[Complete service and approval drain](verification/sql-caller-repairs-30.md)
passes 116 cases, 25 native PostgreSQL. High-level Slack/Context Tree runs now
expose close ports through their final SQL, including a disconnected HTTP peer;
main wiring is still required. Approval polling and admitted requests/decisions/
completions drain through the Runtime route. Batch 29 review found no actionable
defect. Feishu setup, detached callback/proof/capture tails and main remain IM-F3.


[Feishu setup actual-work drain](verification/sql-caller-repairs-31.md) passes
355 distinct Docker cases, including 129 native PostgreSQL. It retains SDK and
readiness work behind cancellation wrappers, includes late QR commit cleanup and
preserves durable candidates. Pre-commit review P2 is corrected with two native
late-slot controls; exact committed review remains pending. Batch 30 review found
no actionable defect. Detached OAuth/proof/capture tails and main composition
still keep IM-F3 open; no defect count is advanced for a partial global repair.

The next component gives ImOutboundCapture ownership of its actual persistence
and driver-pending work, joined after credential/transport drain. MCP probes use
one owner at McpAuthorizationService (all OAuth/API callers share it), since the
management routes also start detached probes. Its existing route registration
starts probe shutdown and joins it; no new timeout or SQL pool.

Cloud follow-up must additionally cover the proof COMMIT window, beyond a final
in-transaction check, and original allocation convergence behind its timeout
race. Proof mint is awaited by the Runner frame chain; exact revoke must remain
owned through late commit. These remain open IM-F3, alongside main composition.


[Outbound capture and detached MCP probe drain](verification/sql-caller-repairs-32.md)
passes 172 distinct Docker cases, 33 native PostgreSQL. Raw capture SQL survives
its public deadline in the owner; all MCP probe callers share one close port.
Batch 31 exact review confirms its P2 closed with no new actionable defect.
Batch 32 source review found no actionable regression; exact review is pending.
Cloud proof COMMIT/detach, original allocation convergence and actual main
composition remain open IM-F3. Fixed/simplified totals remain 36/37 and 9/9.


[Cloud proof commit and Runner cleanup](verification/sql-caller-repairs-33.md)
passes 176 distinct Docker cases, 10 native PostgreSQL. Proof mint revalidates
post-upsert and post-COMMIT; Runner joins exact detach cleanup through peer loss.
Shared and replacement proofs retain their existing semantics. Batch 32 exact
review found no actionable defect. Batch 33 source review found no actionable
regression; exact review is pending. Original Cloud allocation convergence and
actual main composition still keep IM-F3 open. No defect count is advanced.

The next Cloud component retains whole admitted deliver/reconcile/cancel work
and raw allocation convergence in the collaboration owner. Closing admission and
aborting existing observation/caller signals stop subsequent dispatch; existing
per-target serialization and actual-task settlement are joined before SQL pool
cleanup. External allocation already issued may complete and is retained until
its original Promise settles. No new budget, retry, durable state or abstraction.


[Actual Cloud allocation and collaboration drain](verification/sql-caller-repairs-34.md)
passes 195 distinct Docker cases, 14 native PostgreSQL. Original allocation tails
and complete admitted delivery/recovery/cancellation now have explicit ownership.
Batch 33 exact review found no actionable defect; batch 34 source review found
none and exact review remains pending. IM-F3 still requires actual main shutdown
composition and final fault acceptance. Fixed/simplified totals remain 36/37, 9/9.

Main composition will register final resource cleanup before app/plugin hooks,
start all producer/owner stops in preClose without waiting for websocket-dependent
work, join them after child routes close, then close billing/readiness/SQL and
telemetry with the existing error-collecting helper. High-level Slack/Context Tree,
Inbox, Cloud and MCP ports must be included. No private hook mutation or generic
lifecycle framework; late callback facts remain owned by their existing routes.


[Application request work and shutdown phases](verification/sql-caller-repairs-35.md)
passes 228 individually identified Docker cases (230 passing executions),
26 native PostgreSQL. One app boundary owns
actual asynchronous request phases through lost clients, avoiding new service
owners for OAuth and HTTP ingress. Two scoped auth hooks become route options;
RuntimeWeb's redundant race is removed while its response deadline stays intact.
CloudModel/billing preClose cannot block subsequent connection teardown. Batch 34
exact review found no actionable defect; batch 35 source review found none and
exact review remains pending. Main wiring and actual signal/fault acceptance are
still open IM-F3. Totals remain 36/37 fixes and 9/9 recorded simplifications.


[Main shutdown composition](verification/sql-caller-repairs-36.md) passes 74
Docker cases, 23 native PostgreSQL, and Server build. Main starts all stop ports
before child teardown and disposes shared resources once after actual work. Two
redundant HTTP service owners are deleted; the shared app owner now covers their
lost-peer final SQL. Batch 35 exact review found no actionable defect; batch 36
source review found no composition defect. Actual Server signal/fault tests and
the pending-listen/prewarm boundary remain open IM-F3. Fixed/simplified totals
remain 36/37 and 9/9 until that final acceptance.


[Actual Server process and pending-listen shutdown](verification/sql-caller-repairs-37.md)
passes 26 identified Docker cases (29 passing executions), four actual built Server
PG17 cases. Signal shutdown retains real listen work, preserves SQL through exact
Runtime registration cleanup, prevents late prewarm/readiness and exits without
application backends under release, official timeout, bind-failure and DNS controls.
IM-F3 is now repaired locally: all 37 recorded defects and nine simplifications
have local fixes. Batch 36 exact review found no actionable defect; batch 37 exact
review and final broad checks remain. The remediation is not yet complete because
AA-R1 is independently actionable, and IM-R2 still needs representative measurement.

AA-R1 minimal follow-up: preserve built-in Google and its existing subject,
issuer, state/code, token parsing, redirect refusal and final official transaction.
Pinned 1.7.2 exposes no fetch/timeout/signal provider option. Apply a narrow pinned
core patch that forwards a native AbortSignal to its existing token helper and
creates a ten-second Google token-exchange budget, covering headers and body.
Do not cancel a fully parsed token's final SQL because the browser disconnects;
do not retry an uncertain one-time code. No JWKS change (not reachable through
OpenTag's published flow), global fetch override, new SQL/pool or provider migration.
Validate paused headers/body, exactly one exchange, new-flow recovery, healthy SQL
and confirmed-token persistence during shutdown before broader Server regression.


[Native Google token-exchange budget](verification/sql-caller-repairs-38.md)
passes 83 identified Docker cases, 40 native PostgreSQL. AA-R1 is fixed locally
with a pinned native-signal patch covering headers/body, one-time-code recovery
and confirmed-token SQL after lost client/shutdown. Frozen install, typecheck and
Server build pass; the precise SDK overlay is recorded. Batch 37 exact review
found no actionable defect; batch 38 source review found none and exact review
remains pending. IM-R2 measurement/strict selection equivalence and final broad
Server/covered Client Runtime validation remain before full completion.


[Nested shutdown failure diagnostics](verification/sql-caller-repairs-39.md)
repairs a logging regression exposed by the new wrapper depth: the existing
formatter now preserves resource leaves and secret redaction with fewer branches.
Twenty-two host and Docker component cases pass, including simultaneous scheduler,
worker and pool-close errors. No SQL/ownership behavior changes. Batch 38 exact
review found no actionable defect; batch 39 source review found none. IM-R2 scale
measurement and final broad owning validation remain.


[Late-root SQL selection](verification/sql-caller-repairs-40.md) addresses IM-R2:
50,000 unrelated messages previously returned about 134 MB of JSON objects;
only matching full rows now cross the database boundary. Two native provider
oracles preserve exact ordered results, including global revision masking and
root fallback. The owning matrix passes 155 distinct cases, 121 native PostgreSQL.
No new cap, index or transaction semantics are introduced. Batch 39 exact review
found none; batch 40 source review found none. The 37 defect and nine
simplification fixes remain locally complete; final broad regression is pending.


[Broad owning regression](verification/sql-caller-repairs-41.md) covers the full
Server unit/native matrices with successful affected reruns, plus 818 covered
Client Runtime cases at 100 percent. Original failed command logs remain failed;
no cases were waived. Test-only fixtures/collection were corrected without
product changes. The original audit's 52 IDs are all accounted for. LC-R1 now
has representative native cost/failure evidence and needs the specific Local-stop
policy below before implementation; the overall remediation is not complete.

## LC-R1 supplemental design — awaiting human confirmation

The original audit contains six observations, not five: LC-R1 was absent from the
initial remediation ledger. It concerns unbounded Local lifecycle stop fan-out,
not the authority/drain defects already fixed. Native actual lifecycle calls
show that 4,096 targets start 4,096 proof preparations before the shared domain's
1,024 pending limit is checked. A full domain still performs about 24,585 SQL
statements and sends no stop frames. An independent database connection remains
healthy; these samples do not demonstrate a global outage. They do establish
avoidable work and partial stop under a large single-Agent operation.

Simply batching complete result Promises would multiply the existing 30-second
request wait by the number of batches. The following adds a specific Local-stop
operation policy and therefore needs confirmation before implementation:

1. Process at most **16 complete Local stop operations concurrently**, including
   proof preparation, final locked authority, enqueue and the actual result.
   A small fixed worker loop replaces the eager flatMap/Promise array; no generic
   queue/scheduler, Session-count cap, extra pool or increased domain limit.
2. Share one **30-second Local-stop dispatch budget**, matching the existing
   default Runtime request budget. Pass its native AbortSignal through the
   existing requestReconcile signal port. Start the budget at entry to
   stopAgentSessions, after the committed lifecycle mutation and existing Cloud
   cancellation. It does not promise the entire lifecycle HTTP call finishes in
   30 seconds, nor multiply the budget for each batch. An already-enqueued
   request retains its original per-request result timer: one sent near the
   dispatch cutoff can wait about another 30 seconds, followed by actual SQL
   cleanup. Acceptance must not assert a hard 30-second total duration.
3. At the deadline, stop admitting remaining targets and fence later enqueue.
   Existing SQL already issued must settle under the shared official timeouts;
   join all started operations. Check the shared signal at admission entry so
   proof preparation completing after the cutoff does not begin a new authority
   transaction. An authority transaction already entered keeps its existing SQL
   and final enqueue signal fence. Do not race away real work or claim that an
   AbortSignal cancels an already-issued database statement.
4. If the shared domain returns capacity, stop taking additional targets, allow
   already-started work to settle under the same budget and surface the existing
   AGENT_SESSION_STOP_FAILED diagnostic. Other individual failures retain their
   existing aggregate failure behavior. Never retry an uncertain stop send.
5. Preserve the committed suspend/delete/rebind result and final Agent revision,
   Session, placement and exact-proof fences. An unattempted or unconfirmed target
   is not marked stopped; its proof is not broadly deleted. The API retains its
   existing best-effort notification contract. **No new automatic retry/recovery
   is introduced for remaining targets**; only a later existing reconciliation
   that actually confirms stop establishes that outcome. This residual-work
   behavior is part of the policy being submitted for confirmation.
6. Keep Cloud's currently serial cancellation and CR-R1 observation separate.
   This change bounds the Local fan-out; it does not establish a Session-count
   limit, make the initial metadata selection globally bounded, or define a new
   Cloud/overall HTTP latency contract.

Acceptance: native 64/1,024/4,096 valid targets with real proof/guard SQL, max-one
and normal pools, timely results, no results and an already-full shared domain;
all small/normal targets still stop, preparation peaks at 16, and no work starts
after the deadline/capacity boundary. Retain Account lifecycle/authority and
replacement-proof tests. Gate late preparation, an Agent-row wait crossing the
cutoff, results/revocation after the cutoff and a capacity error while the other
started targets still settle. Check actual proof rows, committed Agent state, no idle
transaction, healthy same-pool and independent controls, owner shutdown and late
result behavior. Do not implement this supplemental policy before confirmation.
