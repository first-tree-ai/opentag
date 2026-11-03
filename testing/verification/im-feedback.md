# IM feedback and safe recovery

Contract: [IM task feedback and safe recovery](../../docs/system/messaging/im-feedback.md).

## Regression scope

`packages/server/src/__tests__/im-feedback.test.ts` uses a migrated PGlite database and real custody reports.
It covers normal start/terminal projections on both providers, atomic failure persistence, reaction failure
independent of card delivery, ambiguous sends and lost DB acknowledgement, generation revocation, revision races,
retained custody repair, explicit retry identity, immutable original reports, actor/confirmation fences, source
edits, retention, unknown workspace operations, exact save proof, explicit save failure, and result upgrades.

`im-feedback-messenger.test.ts` intercepts both native SDKs. It checks original conversation addressing,
supported Feishu reaction names and ownership, idempotent Slack reaction errors, bounded readback identity,
missing/ambiguous responses, the SDK's real `WebAPIRateLimitedError` and Retry-After on sends/reactions/updates/readback, credential fencing, private callback responses and bound-message updates.
HTTP and callback tests exercise Account authentication, browser origin/CSRF, strict input, verified Slack
signatures, strict approval parsing, and Feishu callback scope. Worker regressions also preserve the longest rate-limit delay when reaction and card operations fail together. All credentials are synthetic.

`integration/im-feedback.test.ts` uses real PostgreSQL and independent pool connections:

- Concurrent retry clicks create one new attempt and preserve the original report.
- Concurrent save/discard decisions admit one operation; cloud I/O starts outside the admission transaction.
- A lost COMMIT response resolves through the stable action identity.
- Source and feedback row locks remain obtainable while a provider send is blocked.
- With 2,000 additional inputs, `EXPLAIN (ANALYZE, BUFFERS)` selects the due-work index and the unique
  message/Session/attempt index for their bounded lookup paths.

Web behavior and [browser verification](../web-ui/im-feedback/README.md) cover owner confirmation, safe refresh,
unknown results, locale layout, keyboard control and accessibility.

## Local validation

Focused server validation: 61 feedback tests and 60 affected delivery-worker tests passed. The new feedback
implementation has 90.12% line coverage and 83.92% statement coverage in the focused feedback run. Five PostgreSQL feedback
checks passed, including the populated query plans. Shared package validation passed 781 tests. The changed managed
IM instruction checks passed 65 client tests; the change does not alter Agent Runtime coverage-owned implementation.
The complete workspace build and all package types passed. Web behavior, CSRF and Kumo contract checks passed 27 tests;
English/Chinese screenshots cover the current owned controls. Twelve custody regression cases and eleven PostgreSQL
feedback/Cloud custody cases also passed after the retained-report hook change.

The full local Web run recorded 2,386 passed and three Kumo contract failures; all three were repaired and their owning
checks passed. The full PostgreSQL run recorded 1,084 passed and fifteen failures: eight needed the built CLI artifact,
six hit their five-second test windows, and one was a subsequent schema-creation failure. After the complete build and
container isolation, all fifteen original failure cases passed with their existing assertions and timeouts. These
results are combined verification across runs, not a claim that one local full-suite invocation passed. CI must pass
for the PR's current head.

An initial concurrent full integration run was interrupted after several disconnected-DB failures. A serial
investigation observed a PostgreSQL container removed while its test connection was active, followed by Docker
409 "removal already in progress". The installed Testcontainers reaper can reuse an existing reaper's session ID.
The isolated full rerun uses `TESTCONTAINERS_RYUK_DISABLED=true`; each test's explicit container cleanup remains
active. This environment setting changes no production source or test assertions.

## Native acceptance still required

Use an explicitly authorized test installation for both Slack and Feishu, including a visible Local and Cloud
Session. Verify one working lifecycle, quiet routine execution, native failure cards in the original thread,
original-sender retry authorization, Account-only save/discard confirmation, stale allocation rejection,
verified result editing of the original card, and provider permissions/readback failure behavior. Include
lost-response and restart paths. Check reactions owned by another user are preserved.

No real-user IM send, task replay, workspace discard, production migration, deployment or native provider
acceptance was performed by these local checks. Unknown provider outcomes remain unresolved until evidence exists.
Keep the issue open until its applicable acceptance requirements have evidence.

## Main-branch admission integration

After integrating the accepted-receipt dispatch fence, feedback retry admission reuses the same canonical Agent
custody lock helper. Both feedback hooks and the receipt fence remain in the custody store. The combined selector,
receipt, Local/Cloud worker, custody and feedback checks passed 273 unit tests across fourteen files. The nine-file
PostgreSQL group passed 100 tests, including receipt recovery/admission, process restart, steered recovery, claim
queries, Cloud parking, feedback concurrency and Cloud custody. Server types and repository checks also passed.


## Review corrections

The review regression run passed 71 feedback/API/callback/native-transport cases, with 90.68% line and 84.55%
statement coverage. It adds HTTP and direct-service rejection of missing/false permanent-loss acknowledgement,
placement changes with an unchanged allocation, a frozen initial batch with a failed/not-started root, concurrent
completion followed by a definitely-not-applied card send, and unknown-send dormancy after the action deadline.
Slack SDK 429 responses no longer count toward the shared outage circuit. Feishu topic readback uses the provider's
thread container without time-range filters. All 28 focused Web behavior, CSRF and owned-control contract checks
passed; the discard POST contains the explicit acknowledgement and the batch page explains why replay is unavailable.
Server and Web types passed, as did repository checks.

The complete review-correction PostgreSQL integration run passed all **1,121 tests across 91 files** in 414.53 seconds, using explicit test-container cleanup with `TESTCONTAINERS_RYUK_DISABLED=true`. All five real PostgreSQL feedback cases passed. With 2,000 additional inputs, query plans also select the delivery,
card-owner, and source-message feedback indexes for their respective hot lookup paths. Only the unmerged feedback
migration was regenerated; merged migrations remain unchanged. The unique delivery index is still built without
`CONCURRENTLY`, so the compatible release plan must account for its write lock. The local lock measurement below does not establish
production migration duration or production row count.

The user explicitly deferred the additional cooldown table on 2026-11-03. A subsequent necessity review found the existing installation timestamp sufficient for conservative shared cooldown; the user confirmed that existing-state design. The original additional-table proposal remains deferred. Exact method isolation is not implemented; the accepted behavior delays all designated feedback methods of the same installation. Per-target Retry-After and outage-circuit classification do not by themselves provide
cross-worker rate-limit coordination. No review correction establishes native provider acceptance or deployment.


### Local delivery-index build and lock measurement

On an isolated PostgreSQL 17.11 container (aarch64), a shadow table copied with `LIKE im_message_deliveries
INCLUDING DEFAULTS INCLUDING CONSTRAINTS` contained 100,000 synthetic pending rows with distinct UUID message/Session
pairs. It intentionally omitted foreign keys and existing indexes to isolate the replacement unique-index build.
`CREATE UNIQUE INDEX ... USING btree (message_id, session_id, attempt_ordinal)` took **53.60 ms**. The transaction
remained open after index creation; an independent connection's INSERT with `lock_timeout = '100ms'` failed with
`55P03`. After commit, the same INSERT succeeded. This verifies that writes are blocked until the index transaction
commits, not merely until the index build statement returns. It does not measure constraint validation, the full
migration transaction, production hardware or table size. Production rollout must preserve service availability
and account for this write-lock interval using the existing compatible CI release process.


## Workspace recovery on frozen batches

A subsequent presentation correction restricts the batch-replay block to task retry. A workspace-failed batch root
keeps both save/release and discard links and the paused-Session guidance on Slack and Feishu; the Account page
likewise keeps recovery controls without the task-replay warning. Both provider cards and the Account page have
regressions. The focused Server suite passed 72 tests, the Web/CSRF/owned-control group passed 29 tests, and Server/Web
types and repository checks passed. This correction changes rendering only; the previously passing 1,121-test
PostgreSQL run remains the persistence evidence, and was not repeated for this presentation-only change. No cooldown
table, migration, provider operation, task retry or workspace action was added or executed.


## Shared cooldown without a schema change

The owner confirmed reuse of the existing installation timestamp after a separate necessity review. The transport
checks the active installation/generation before each designated SDK method, records confirmed 429 deadlines with
`greatest` using the database clock, and defers other targets and methods conservatively. No cooldown table, column,
index or migration was added. Legacy native cleanup uses the same stored deadline. Persistence failures stop the
worker pass and preserve definite non-submission instead of inventing an unknown card creation.

The focused Server run passed 84 tests. The two-file PostgreSQL feedback/native-status run passed 45 tests, including
10 feedback cases. Real SDK HTTP 429 injection proves that two due targets and an independent restarted connection
make only the initial request before cooldown, a different installation can send, same-installation methods defer,
and expiry permits another request. Concurrent extenders preserve the longer deadline; real reauthorization
preserves an existing deadline and fences late responses. Installation row locks remain available while HTTP is
blocked. Successful or rate-limited legacy settlement and actual expired-feedback deletion cannot clear the shared
deadline. Mock credentials and HTTP are synthetic; no live provider calls were made.
