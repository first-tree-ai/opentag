# Independent SQL caller PR review

Reviewer: `/root/sql_pr_independent_review`, a read-only agent explicitly requested by the user.

- Reviewed source head: `cb39dcb308c71f13075df4ad9d01ceab585eb192`.
- Real base ref initially verified locally: `e769c66b372d21be1137c7bcd144d26778daaf9e`. The latest base follow-up below verifies `01c26ad17575b67525bae3bedc857adc4466600d` (`origin/main`).
- Earlier feature checkpoint also reviewed: `2b8c75c0bcacc03d7b0f49f63c6cc1c81ea619f2` against original implementation base `8cb997b2abbf7785b871b1a0534e998c4d97c8d7`.
- Result: **no outstanding actionable findings in the reviewed final source**. One integration issue found during review was corrected before the source commit.

## Review scope

Reviewed the full feature production-change manifest and remediation ledger, with deeper call-chain checks of:

- Account/Agent/Task Repeatable Read snapshots and final Agent, binding, Session, placement, Computer, and exact-proof guards for Skill/Schedule mutation.
- Local lifecycle stop admission, 16 workers, the shared 30-second sending budget, Domain capacity response, original result settlement, proof revocation CAS, and the exact bound request port in real main composition.
- Auth adapter transactions and the pinned Google native token exchange signal through response parsing; MCP pre-dispatch credential retention, exact refresh/consent fences, and bounded discovery.
- IM direct/steer cancellation, retained custody restoration, late results, SQL/provider failure separation, and late-root metadata selection.
- Physical Cloud ownership/capacity, exact terminal-record replacement, Session collaboration and proof execution lifetime.
- Actual work ownership through HTTP phases, Runtime/Runner connections and route close, credentials/transports and capture, provider preparation, Feishu setup/connection/QR/card callbacks, workers, and final shared-resource disposal.
- Context Tree child-process bounds, Cloud routing hints and cleanup, literal Git subtree verification, and bounded object/metadata reads.

For the 18-commit main integration, rechecked the resolved overlap in Runtime/Runner performance wrapping, inbound-receipt admission and nonblocking selector claim, retained-report feedback restoration, Cloud delivery/steer status handling, Task reply Session fallback in the same snapshot, Slack working clear-only behavior, Feishu callback admission/drain, and main producer/resource order. The final PR diff contains no new UI or schema/migration changes relative to this base; those main features were preserved.

This is a review of the remediation and its integration, not a fresh full SQL-site audit of all new main features.

## Finding resolved during review

**P1 — Late IM feedback workspace jobs could escape a shutdown snapshot.**

The first conflict resolution started `imFeedback.close()` in parallel with producer shutdown. Its existing implementation snapshots detached workspace jobs. A submission already blocked inside SQL admission could therefore enqueue a new workspace job after that snapshot, and the HTTP handler could return while the new job still needed SQL.

The final source moves `imFeedback.close()` to the application final `closeResources` callback, after producer and actual HTTP work drain and before shared pool disposal. No new persistence behavior or generic tracking framework was introduced.

The native integration control holds an actual PostgreSQL feedback-row lock while an HTTP workspace action is already admitted, begins app shutdown, releases SQL admission, holds the detached workspace operation after the HTTP response, and verifies that SQL stays open until the final real feedback result commits. The separate startup control verifies the real index composition uses this phase order. `pr-feedback-final-docker.log` reports 30/30 passing cases across the two files; the native shutdown control took 250 ms. Earlier failures were investigated: a stale mock needed reset, and the diagnostic HTTP client retained an idle socket. The fixture now sends `Connection: close`; production connection policy was not changed.

A missing `sql` import in the uncommitted selector resolution was also corrected before this source head.

## Validation evidence and limits

This reviewer performed source inspection and read acceptance logs; **did not rerun tests independently**, modify repository source/docs, or take GitHub actions.

Read back:

- `pr-feedback-final-docker.log`: 2 files / 30 cases pass, including the native final-result/pool-order control.
- `pr-client-runtime-coverage.log`: 32 files / 821 cases pass; 100% of 4,926 statements, 3,686 branches, 854 functions, and 4,381 lines.
- `git diff --check e769c66b cb39dcb3 -- ':!patches/**'`: clean. The SDK patch itself retains upstream tab-indented unified-diff context, so default whitespace scanning of that nested patch text is not a source whitespace defect.

The parent owns the Server regression matrix and repository type/build/gate results. The initial review preceded matrix completion; the validation follow-up below records the subsequently inspected complete logs and fixture corrections. This review is not a CI pass, merge approval, deployment, or live-provider acceptance. Private billing source is unavailable. The audit's retained CR-R1/IM-R1/TK-R1 observations retain their stated dispositions and are not newly classified as code defects.

A later documentation-only evidence commit may be reviewed as a delta without rerunning unchanged-source tests. Any later production change or new real base requires a corresponding review update.

## Real base follow-up: 01c26ad1

The target branch ref advanced to `01c26ad17575b67525bae3bedc857adc4466600d` while the reviewed source head remains `cb39dcb308c71f13075df4ad9d01ceab585eb192`. Read-only Git verification finds exactly one new base commit, PR #1177, with four added lines only in `apps/web/src/__tests__/agent-computers.test.tsx`. It adds an assertion for the existing “Continue setup” link; production source, package manifests, lockfile, SQL, migrations, and Server/Client test configuration are unchanged.

`git merge-tree --write-tree --name-only HEAD origin/main` exits 0 with merge tree `97e85b4476c2b8b073ffabd1846f2bcc4b2fad8e` and no conflict paths. This PR has no Web changes relative to the previously reviewed base, so the added base assertion does not overlap the remediation. No new code issue or local Server/Client validation scope is introduced. Repeating unchanged Server tests solely for this base movement is not necessary; the already-running full matrices still test the reviewed Server source. GitHub CI must nevertheless be evaluated on the actual PR head and real latest base/attempt before any future merge; no old green status is carried forward as merge authorization.

This follow-up is local source/base verification only. No repository files, dependency installations, tests, remote reviews, or GitHub writes were performed by the reviewer.

## Fixture and validation follow-up

Read-only review of the three pending integration-test changes finds no weakened production-behavior assertion:

- `im-thread-root.test.ts` narrows SQL debug capture to `ranked_thread_messages`. Main introduced a separate single-delivery feedback scope query containing the previous broad `thread_key is not null` substring. The test still replays the actual late-root query against the independent old-selection oracle in exact ID/order, then checks actual Thread deliveries.
- `slack-live-admission.test.ts` gates only this test's Inbox instance using an independent real PostgreSQL advisory key on the same four-slot application pool, then calls the original real `ingest`. Main's receipt acceptance now locks the production Agent custody key before ACK, so the prior test lock no longer represented post-ACK Inbox saturation. Four signed HTTP 200 ACKs, exactly two real SQL waiters, shared-pool health, four durable receipts, two immediate completions, lease-based overflow recovery to four messages/deliveries, and duplicate non-expansion remain asserted. The instance spy is restored by cleanup.
- `im-send-cancellation.test.ts` adds an actual accepted-root precondition, and waits for either the actual placement-lock fault point or early `runOnce` completion. If the worker finishes before entering custody, it fails immediately with current pending/root state and diagnostics. The diagnostic SQL runs only on that abnormal branch. The successful path keeps the real placement lock, 400 ms operation budget, no-frame assertion, and durable correlation/pending assertions. No production timeout was changed.

Read back complete logs: Server unit matrix has 4,989 passed / 15 skipped in 268 files (`pr-unit-docker.log`). The initial native matrix has 1,360 passed / four failed in 122 files (`pr-native-docker.log`) and its command exited nonzero. After the two main-contract fixture adaptations and the accepted-root precondition, all 20 cases in the three affected files passed (`pr-native-fixtures-docker.log`); after the final Cloud gate diagnostic change, its entire nine-case file passed (`pr-steer-final-docker.log`). Together these runs exercise all 1,364 native case identities; **they are not a clean single full-matrix command**.

The original Cloud test's five-second timeout occurred both in the full matrix and in a subsequent original three-file serial run. Two isolated phase-diagnostic runs and the later full affected-file runs passed, preserving the actual SQL-lock/deadline/no-send behavior. Adding a root precondition or diagnostic gate does **not** establish the original timing root cause or prove that timing sensitivity is eliminated. That remains an explicit validation limitation; the logs do not establish a production regression. Do not call all four original failures diagnosed-and-fixed or the original full native matrix green.

Production source remains the reviewed `cb39dcb3` checkpoint; these fixture/document updates still need their final commit identity recorded.

## Real base follow-up: e91b6557

The target branch ref was re-read as `e91b6557a6ce1375dc3de3f73a715f358804cab7`. Relative to `01c26ad17575b67525bae3bedc857adc4466600d`, four commits (#1176, #1178, #1179, #1163) affect Web UI/tests/translations, Web/Task presentation documentation, and one e2e assertion. The diff contains 19 files, 322 additions, and 95 deletions. There are no package/lockfile, Server, Client, shared-schema, or migration changes. The Task documentation changes describe Web projection of existing replies/final text and do not change the Server reply-snapshot contract modified by this PR.

A read-only merge calculation for reviewed source head `cb39dcb3` and this real base exits 0 with no conflicts (merge tree `dc3c6858f671129dea44372b396e123fb59d2cad`). No additional Server/Client test scope or production finding follows from this base-only movement. Current GitHub head/base/attempt gates must still be verified before any future merge; no GitHub write or test rerun was performed by this reviewer.
