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
