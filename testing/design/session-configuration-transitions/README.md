# Session configuration transition proposal

Status: simplified design approved by the user on 2026-10-22 and implemented locally.
Validation results and remaining external acceptance are recorded in the linked verification page.
Baseline: `3d96c8edb11ee569267eb4343dfb6bdbac90576c`, 2026-10-22.
History review and pre-PR integration: through `origin/main` at `f178a0868ce0af909761e5b7ebca0be562e94fb6`.
The intervening Cloud Pi diagnostics and Web setup-navigation changes do not modify the transition implementation.
Evidence: [scenario matrix and validation](../../verification/session-configuration-transitions.md).
Contract: [when Agent configuration changes apply](../../../docs/system/runtime/agent-self-configuration.md#when-changes-apply).

## Findings that constrain the design

1. Both legacy layouts reject a legitimate newer Soul before delivery admission (SCT-03/04).
   The same Soul change succeeds after a format-only migration (SCT-07). Format migration and
   configuration replacement therefore need independent decisions.
2. The baseline current-format reconciler rejected a same-revision Soul conflict while warm but accepted it
   after restart (SCT-14). The saved snapshot already contains Agent revision and content; a cold
   process can verify them without extending the binding schema. This additional gap is covered by the approved repair.
3. Snapshot-before-binding persistence already supports interruption/restart at the tested writer
   boundaries (SCT-13). Native bindings, historical input/result hashes, retained reports, workspace
   history, and unresolved work remain important independent invariants (SCT-01/07/09/16 and the
   existing recovery tests).

## Proposed implementation boundary

Keep the implementation in `session-binding-store.ts`. Use the existing preparation flow and
existing snapshot, hash, binding, and error types. The three checks discussed earlier describe
execution order; they do not need separate architectural stages or interfaces.

Replace the overlapping private checks with one shared entry point, provisionally named
`#validateAndSelectRuntimeBinding`. It reads the saved snapshot, verifies its identity, checks
the requested Agent and Session revisions, and then returns the existing native binding if it
can be retained. Otherwise it returns `undefined`. Invalid requests throw the existing typed
errors before selection. The return value is `AgentRuntimeBinding | undefined`; there is no new
transition object, action enum, migration interface, or persisted state.

Use ordinary conditionals and the existing hash/layout helpers inside that flow. Keep a small
revision-check or legacy-comparison helper if it makes the code easier to read; do not build a
general comparison engine or force unrelated logic into one large function.

The two callers stay where they are:

- `validatePreparation` calls the shared check before Agent/workspace preparation and discards
  the return value.
- `prepare` calls it again after re-reading under the existing Session lock, then includes the
  returned native binding if present. Existing snapshot-before-binding writes and receipt carryover
  remain in `prepare`.

Keep identity, placement, and unresolved-work guards in their existing order, including the
unchanged unresolved-Turn return path. The Runtime manager already resumes a saved native binding
or creates a new conversation when it is absent. Reuse that behavior, current policy construction,
and recovery lifecycle. The Reconciler's activity checks and error responses stay in place.

## How the two defects are resolved

### Legacy snapshot plus a valid newer Soul (#980)

Today `#canContinueLegacy` rejects changed content even when the requested revision is valid.
After verifying the old snapshot and the new revisions, the shared check returns `undefined`
for a real Soul change. Preparation writes the requested snapshot and a binding without the
previous `runtimeBinding`; the existing Runtime manager creates a conversation with the new Soul.
The OpenTag Session ID, Agent workspace, historical snapshot files, and delivery receipts remain.
Historical messages are not replayed into the new native conversation automatically. Native
conversation context consequently does not continue across this real configuration change.

An unresolved Turn still settles under its original configuration before this flow can commit.
A compatible format/permission upgrade with no other content change still retains the native
binding; the Provider-specific binding replacement hook remains authoritative when it requires
a fresh native conversation for its own format.

### Same-revision Soul conflict accepted after restart

The baseline warm Reconciler checks Agent configuration in memory; its durable check covers only
Session configuration. The shared check reads both from the saved snapshot, so restart does not
lose the Agent comparison. For the same placement, an equal sequence requires equal revision ID
and content, subject to the existing narrow legacy representation exception described below;
a lower sequence rejects. Check Agent and Session separately, even when no native
binding has been saved. A newer Session must not hide an equal-sequence Agent conflict.

This fixes the reproduced same-Session restart gap without adding Agent version fields back to
workspace state. It does not introduce a global persisted Agent revision index across Sessions.
Existing warm Agent-wide checks remain. Warm and cold processes must agree on acceptance;
the existing in-memory and durable error-reason mappings need not become a new wire contract.

## Decision rules

| Input | Proposed result | Tests |
| --- | --- | --- |
| Invalid identity or required historical snapshot/hash | Conflict without writes | SCT-08 and existing store integrity cases |
| Missing current snapshot, request exactly matches the saved identity/hash | Recreate the same snapshot without changing conversation ownership | Existing store missing-snapshot case |
| Stale placement/revision | Reject according to existing ownership/revision fences | SCT-08/12 and existing reconciler tests |
| Active or unresolved work requiring a configuration switch | Wait for completion or existing recovery/settlement | SCT-09/16 and existing ACK/recovery tests |
| Unchanged current-format snapshot | Retain native conversation | SCT-10 |
| Explicitly supported compatible legacy transition | Retain native conversation and apply current authorized policy | SCT-01/02 |
| Genuine configuration change at valid newer revisions | Replace native conversation within the original OpenTag Session | SCT-05/06/07/11 |
| Genuine same-revision content conflict | Reject in both warm and cold processes | SCT-08/12/15 |

For the same placement, validate both the Agent and Session revision/content dimensions from
persisted state. A newer Session revision alone must not conceal a conflicting Agent revision.
For placement changes, retain the existing ownership and unresolved-work rules; this proposal
does not redefine placement authority.

The compatibility exception must describe the supported historical format/permission transition
explicitly. Keep its treatment of absent old fields, historical self-configuration opt-in, and
known permission tightening contained in the compatibility comparison. It must not exempt all
same-sequence changes, ignore arbitrary current fields, or restore old permissions for new work.
A legitimate newer configuration outside that compatible transition follows replacement rather
than failing merely because content changed.

Keep the current legacy projection explicit and local: use the old revision only for comparison,
omit `allowCommands`, account for historical `approvalPolicy: never`, preserve self-configuration
in the layout that already had it, and permit the existing Codex network tightening comparison.
Never apply that comparison snapshot to a running Provider. Actual preparation always uses the
requested current snapshot and its current authorized policy. Do not normalize Soul, model,
reasoning, or a network widening into equality.

Check nondecreasing revisions before legacy compatibility. At an unchanged sequence, allow only
the proven historical representation/permission equivalence for that dimension; a genuine Soul
or model change still needs a newer corresponding revision. Comparing the two dimensions
independently avoids using a compatible Session projection to hide an Agent conflict.

Three existing legacy store scenarios need intentional expectation changes: `changed input`,
`looser network`, and a newer self-configuration opt-in change previously rejected because they
could not retain the old conversation. Under this
proposal, a newer change accepted by current policy may replace the native binding. A network
widening must never qualify for compatible native retention; an unsupported policy or a genuine
same-revision change still rejects. Split these cases before changing production code, rather
than deleting the tests or silently turning their rejection assertions green.

If the original snapshot is missing and the request has a different effective hash, the proposed
durable revision check cannot verify prior Agent content. Reject this transition even when there
is no saved native binding. Preserve the existing exact-hash reconstruction path above. This tightens the previous no-native-binding fallback under the approved design and is covered
by SCT-18; exact-hash reconstruction is covered by SCT-20.

Preserve ordinary current-format conversation replacement behavior. Do not introduce a new
global semantic hash or broaden conversation reuse for unrelated revision changes as part of
this work.

## Code to replace and protections to retain

| Code | Proposed treatment | Reason |
| --- | --- | --- |
| `#canContinueLegacy` | Replace with the shared validation/selection entry point and a local legacy comparison | A legitimate content change returns no retained binding instead of rejecting preparation |
| `changed content` rejection for any non-equivalent legacy request | Replace with revision validation followed by native replacement for valid newer requests | Resolves #980 without reusing a conversation with stale configuration |
| `legacyContinuation` parameter in `#assertRevision` | Remove the global exemption; check each revision dimension and its narrow legacy equivalence explicitly | A compatible dimension must not conceal a conflict in the other |
| `retainedRuntimeBinding(current, hash, legacy)` | Delete; `prepare` directly includes the selected existing binding when present | No second reuse decision or transition result object |
| Current-format early return from `#canContinueLegacy` | Replace with verified current-state loading and both-dimension checks | Resolves the cold-restart Agent conflict gap |
| `legacySnapshotLayout` | Keep the existing small helper unless inlining is clearer; retain both supported layouts | It does not justify a new migration abstraction |
| `validatePreparation` and locked validation in `prepare` | Keep both; share the calculation | Preflight avoids known-invalid preparation; the lock-time recheck protects against intervening changes |
| Frozen snapshot/input hashes, binding v1/v2 readers, old snapshots | Keep | Offline Sessions and old delivery/report identities still depend on them |
| Identity/placement checks, unresolved fences, receipt/result processing, atomic writes | Keep | These are independent correctness mechanisms, not redundant migration workarounds |
| `KNOWN_LEGACY_PARTIAL_MIGRATIONS` in Agent workspace | Keep outside this change | It protects user files during the older prompt/layout transition |

A newer Client version does not prove that every local or offline Session has migrated. Removal
of historical readers or stored snapshots needs a separately evidenced compatibility-retirement
policy. Applied database migrations, including `0059`, are not deletion candidates.

## Commit-history audit and regression obligations

The audit used local `git log`, `git show`, and line history for the affected decisions, not only
commit titles. Links identify the reviewed changes; historical test claims are not new run results.

| Commit / PR | Original behavior or failure | Constraint for this proposal |
| --- | --- | --- |
| [`557f0958` / #35](https://github.com/first-tree-ai/opentag/commit/557f0958b23179216a8f8191e606009b3fb78bdf) | Centralized native create/resume, replacement, durable binding persistence, and shutdown cleanup | Reuse the manager lifecycle; keep in-flight startup/close and stale callback guards |
| [`4c9577f5` / #46](https://github.com/first-tree-ai/opentag/commit/4c9577f5f516ae7546d8b29a081a3cc66f7d7a70) | Provider artifact identity became part of durable Session identity | Never adopt another Provider/artifact/workspace as a configuration update |
| [`769e4d52` / #108](https://github.com/first-tree-ai/opentag/commit/769e4d52afd8d14df42f22e13a00e1831bb63180) | Moved managed instructions to native prompts; workspace state tracks layout and preserves user-modified legacy files | Read previous Agent configuration from the Session snapshot; keep workspace migration and file ownership rules |
| [`88724ed0` / #197](https://github.com/first-tree-ai/opentag/commit/88724ed0efa78b6b046a24caa731827446aee18b) | Added typed steer receipts, absorbed redelivery, and schema-v3 receipts | Carry the receipt union unchanged; do not reset receipts when clearing a native binding |
| [`892c1b6a` / #593](https://github.com/first-tree-ai/opentag/commit/892c1b6a91392d428bcde856d60d69bf2b5ba926) | After report recovery, unchanged reconcile could report ready without a prepared Runtime | Keep `requiresSessionPreparation` for a missing manager entry; test ACK followed by the next Turn, not just ready |
| [`acad69b7` / #778](https://github.com/first-tree-ai/opentag/commit/acad69b7c63cecf26aee659f715d2d15b10798c3) | A steer targeting an incomplete Turn must be dispatchable again | Keep `failedTargetSteerReceipt`; completed targets remain deduplicated |
| [`2a34f352` / #773](https://github.com/first-tree-ai/opentag/commit/2a34f352f60fcce90ff7d0296d95fd0415b4aa18) | Added self-configuration opt-in to Agent hash identity | Keep the intermediate published hash layout distinct from 0.1.0 |
| [`1f270516` / #750](https://github.com/first-tree-ai/opentag/commit/1f270516ffe3a75abd752e02c148d34921fa1b41), [`6550f413` / #836](https://github.com/first-tree-ai/opentag/commit/6550f413f16c8b459705e7d03f556258d805a7c0) | Permissions changed effective snapshots without initially advancing revisions; migration 0059 repaired revisions | Preserve the narrow known legacy upgrade rule, but never use it as a generic same-revision exemption |
| [`23d20150` / #856](https://github.com/first-tree-ai/opentag/commit/23d201506c1b959f1a6d5e7d20e7894049c87431) | Preserved upgrade access and accepted-work settlement; introduced the combined legacy continuation check | Replace the coupled check; retain original report/hash validation and snapshotless stopped recovery |
| [`03632f92` / #866](https://github.com/first-tree-ai/opentag/commit/03632f920719ad2708619d2eda05439d6fba645f) | Removed generic business admission gates while adding the self-configuration layout | Retain narrow snapshot compatibility at the connection boundary; do not add global version rejection or new retry machinery |
| [`e94a7be3` / #838](https://github.com/first-tree-ai/opentag/commit/e94a7be332dbc96372575a2ffea997a19e8258d6) | Durable conflicts escaped reconcile without a result, leaving Server retries queued | Keep preflight-before-Agent-preparation and typed rejection mapping; storage/I/O failures still propagate |
| [`51a294d1` / #480](https://github.com/first-tree-ai/opentag/commit/51a294d1a8e18d34eaced48765af445afb517bef) | Distinguished malformed JSON/schema storage failures and surfaced fatal durability errors | Do not catch all loading errors as a replaceable configuration conflict |

The missing combinations identified in this review are now covered:

| Obligation | Implemented coverage |
| --- | --- |
| Agent-only / Session-only revisions, mixed conflicts, cold processes, no native binding | SCT-17; warm Agent-only manager regression |
| Compatible permissions versus changed network/opt-in | SCT-22/23; original store expectations updated explicitly |
| Direct legacy create/resume on Codex and Claude, current prompt/policy, restart | Eight real-manager cases in `session-runtime-manager.test.ts` |
| Four unresolved phases, delayed ACK, newer Soul, and completion of the next Turn | Eight cases in `client-turn.integration.test.ts` with real runtime adapters and controlled transport |
| Steer receipt semantics and late native callbacks | SCT-19 and the existing manager lifecycle case extended with a stale callback |
| Missing snapshots, secure files, interrupted writes | SCT-18/20/21 and expanded SCT-13; existing store/durability suites |

The warm Agent-only test exposed one necessary consumer adjustment: `shouldPrepareSession`
previously looked only for a newer Session revision and could publish ready with a stale Runtime
when only the Agent changed. It now compares the effective snapshot hash, replacing the redundant
Session-sequence preparation condition. Revision admission checks remain separate and unchanged.
The test was recorded failing before this one-condition change. No Runtime manager production
changes were needed.

## Implementation and validation

The user approved the simplified read/write design and both defect repairs before implementation.
The initial Client refactor changes `session-binding-store.ts` and one preparation condition in
`session-reconciler.ts`. The approved review follow-up below also changes the Server revision
write and adds one data repair migration. No new schema, transition object, public interface,
or background mechanism was added.

Tests were expanded before the refactor. The final four changed test files were also run against
the original two production files: 58 cases failed and 206 passed. The refactored files were then
restored and verified byte-for-byte. The focused five-file regression passed all 277 cases without
expected-failure markers. See the [verification record](../../verification/session-configuration-transitions.md)
for final package-wide checks and external acceptance limits.

## Review follow-up: runtime revision source (approved)

The reviews on PR #986 at `72357155` found a missing cross-package invariant. The Server sets
both snapshot sequences from `agent_runtime_configs.revision`, while the Agent content identity
also includes `agents.self_configuration_enabled`. An owner toggle updates `agents.revision`
but leaves the runtime sequence unchanged. A new test using the real `AgentService`, embedded
PostgreSQL, and `EffectiveRuntimeSnapshotAssembler` reproduces this: the Agent identity changes
but the sequence stays at 1. The earlier synthetic Client matrix did not establish this Server
guarantee. The prior self-review conclusion is superseded by this blocking finding.

The user approved the complete repair and its one-time conversation-reset impact before implementation:

1. In the existing `AgentService.updateById` transaction, compare the locked old opt-in with the
   returned updated Agent. Pass that concrete change flag to `#applyRuntimeConfigUpdate`. Skip
   the runtime-config write only when neither its stored content nor opt-in changed. Otherwise
   reuse the existing single update and `nextval('runtime_config_revision_sequence')`. Combined
   opt-in/config changes allocate one new revision; repeated same-value updates and profile-only
   edits retain the current runtime revision. Keep existing locks, compare-and-swap, and rollback.
2. Repair already-emitted same-sequence changes with one data-only migration, following 0059:
   `UPDATE agent_runtime_configs SET revision = nextval('runtime_config_revision_sequence');`.
   Old toggles cannot be reliably identified from current rows because their prior values are not
   recorded there. Advancing all rows lets every existing/offline Session receive an unambiguously
   newer snapshot. No schema or API change is needed. Bump the migration-count assertion and keep
   migration metadata consistent.
3. Preserve Client revision fences and the #980 native replacement behavior. Update the contract
   to identify the shared runtime-config sequence as the authority. `agents.name` is currently
   immutable through the update API; no speculative rename mechanism is added.
4. Add real-service tests for enable, disable, no-op, profile-only, combined updates, and stale
   requests. Run PostgreSQL tests for atomic writes and the upgrade migration, the full required
   integration suite for the new migration, and the relevant Client transitions/Runtime coverage.

The one-time migration makes current-format Sessions start a new native conversation on their
next eligible Turn, even if that Agent never toggled opt-in. The OpenTag Session, workspace,
history, receipts, and unresolved-work settlement remain intact. This broader conversation-reset
impact was explicitly included in the approved design.

Alternative: keep the PR Client-only by removing the new durable Agent same-sequence conflict
check. This restores the previous cold-restart behavior but leaves the warm-path toggle failure
and the Server revision mismatch unresolved. It narrows the previously approved second repair.

The Server repair reuses its existing transaction and runtime-config update; the only added input
is the concrete opt-in-change boolean. Migration `0066_self_configuration_runtime_revision`
repairs existing rows without changing their content or the schema. PostgreSQL regressions cover
rollback of the owner write, upgrade from the preceding journal, migration rollback, ledger
idempotence, unchanged data, and subsequent owner updates. SCT-25 covers warm/cold enable and
disable; SCT-26 verifies the revision-only migration replaces the conversation and retains history.

The review also raised a possible preflight/accepted-work race. SCT-24 records accepted work
after successful preflight and then retries preparation: the existing store settlement guard
rejects the changed hash without writes. No additional Runtime-manager guard or abstraction
is needed for that trigger.

The Server follow-up also rechecked `94947523` (#932) and `8ff8bc7b` (#954):
owner scoping, the existing Agent/runtime-row lock order, and Computer `FOR NO KEY UPDATE`
remain unchanged. The opt-in flag is compared only after the Agent row is locked; its revision
write uses the already-locked runtime row in the same transaction. Migration 0066 follows the
existing 0059 repair pattern; historical migration SQL is untouched and its generated schema
snapshot differs from 0065 only in snapshot IDs.
