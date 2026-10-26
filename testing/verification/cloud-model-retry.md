# Cloud model retry verification

Supports [Cloud Runner execution](../../docs/system/cloud/cloud-runner-execution.md#model-retry-ownership).

## Scope

Issue #827: one automatic retry owner for each logical Cloud model or summary call. The Pi
provider request helper owns three retries after the initial attempt; session and summary
retry loops have zero retries. OpenTag forwards each model request once. Context compaction
remains enabled. Transient stream failures are not replayed by session/summary retry loops. Native context-overflow recovery remains a bounded, changed-context operation.

No schema, query, accounting, schedule, delivery-custody, Local runtime, or dependency changes
are involved.

## Regression proof

Tests were added against the unmodified baseline `0e14583bce8e80483f0f1da9357bf87f364c656a`.
The initial run had 10 expected failures: missing response hints, the absent explicit Cloud
retry configuration, premature retry before the hint, outer session/summary retries,
over-budget hints being retried, and partial-stream replay.

The initial fix passed 313 tests across 10 files. Independent review then found that the real
Router wraps pre-output Provider 429 rejections inside HTTP 200 SSE. Those envelopes were
indistinguishable from uncertain in-band errors, so the companion Router patch marks only
observed HTTP 429 rejections. The corrected implementation adds bounded initial-SSE
normalization, heartbeat/cancellation tests, and an explicit native overflow recovery regression.
The complete affected test command is:

```sh
pnpm exec vitest run \
  packages/client/src/__tests__/cloud-model-retry.test.ts \
  packages/client/src/__tests__/cloud-turn-worker.test.ts \
  packages/client/src/__tests__/cloud-turns.test.ts \
  packages/client/src/__tests__/pi-agent-runtime.test.ts \
  packages/client/src/__tests__/pi-agent-runtime-exhaustive.test.ts \
  packages/server/src/__tests__/cloud-model-proxy.test.ts \
  packages/server/src/__tests__/cloud-model-initial-stream.test.ts \
  packages/server/src/__tests__/cloud-model-retry.test.ts \
  packages/server/src/__tests__/cloud-model-service.test.ts \
  packages/server/src/__tests__/cloud-model-boundaries.test.ts \
  packages/server/src/__tests__/cloud-model-grants.test.ts \
  --maxWorkers=1
```

The corrected run passed all 336 tests across these 11 files.

The Client retry tests use the installed Pi SDK, its real session/compaction logic, and its
real OpenAI-compatible provider request helper. Only HTTP responses and the clock are
controlled; neither retry loop is mocked. They also place a conflicting 99-retry project
configuration in the restored workspace. Managed Pi's existing `--no-approve` policy excludes
project settings, preserving the execution-owned retry budget.

Covered outcomes:

- A valid wait hint delays the next request and the same task completes after recovery.
- Exhaustion produces exactly four upstream completion requests and zero outer retry events.
- Missing hints use the pinned provider's jittered exponential backoff.
- Permanent HTTP 400/401/402/403 responses are not retried.
- A requested wait above 60 seconds fails after one request without retrying early.
- Cancellation and deadline interruption stop waits without later requests.
- A transient partial model stream fails without a generic retry. Native context-overflow recovery makes a changed-context request, executes no partial tool call, and stops after one unsuccessful overflow recovery.
- Summary exhaustion has four requests, without another summary retry budget; a transiently
  limited summary can also recover and complete normally.
- Integer and canonical HTTP-date hints are validated; malformed or arbitrary header text is
  discarded. Permanent quota errors expose no hint.
- A Router-shaped HTTP 200 SSE rate-limit rejection with the boolean
  `error.pre_stream_rejection: true` is normalized before any model data, including fragmented
  frames and heartbeat comments. Unmarked or uncertain errors, model data and oversized
  prefixes are preserved byte for byte. Prelude timeout and shutdown remain bounded.
- The Server sends at most one upstream completion request per received request and retains
  its existing usage-settlement and grant-revocation behavior.

Client and Server type checks and builds passed. No PostgreSQL integration run was needed:
the change does not alter persistence behavior. The model-service regression uses the existing
embedded database fixture; this is not a production accounting acceptance claim.

## Local CLI acceptance

An additional local harness launched the actual pinned Pi CLI in RPC mode, using the generated
Cloud auth/model/settings documents and the same managed isolation flags. It called the actual
OpenTag model service and Fastify proxy over loopback, with a loopback model fixture and a
fixture-only usage store. No public model, real credentials, or deployed database was used.

| Scenario | Proxy requests | Upstream completion requests | Outer retry events | Result |
| --- | ---: | ---: | ---: | --- |
| Persistent transient 429, zero-second hint | 4 | 4 | 0 | Terminal model error |
| 429 with a one-second hint, then success | 2 | 2 | 0 | Successful completion after the requested wait |
| Marked Router HTTP 200 SSE rate limit, persistent | 4 | 4 | 0 | Terminal model error |
| Marked Router HTTP 200 SSE rate limit, then success | 2 | 2 | 0 | Successful completion after the requested wait |
| Unmarked Router HTTP 200 SSE rate limit | 1 | 1 | 0 | Terminal model error |
| Model data followed by a marked rate limit | 1 | 1 | 0 | Terminal model error |

All cases included a conflicting project retry configuration and verified that it did not
override the managed settings.

## Router and deployment boundary

Source inspection of LLM Router main at
`3a1fa09f2f1ecd4094c11dd67788031e116ba103` confirmed zero Router retries, zero LiteLLM retries,
and zero provider SDK retries in deployment/model configuration. Its gateway transport forwards
once. The companion Router patch adds `error.pre_stream_rejection: true` only for observed
upstream HTTP 429 `rate_limit_exceeded` rejections and carries a validated optional
`error.retry_after` value. These fields are added to a fresh client response after the existing
ledger handling; stored errors, accounting transitions and in-band error handling are unchanged.
Provider-supplied markers are stripped. Router tests cover those boundaries, including a ledger
release failure. No additional retry layer or deployed configuration change is introduced.

Deploy the companion Router change before accepting recovery of streamed Provider 429s.
Without the marker, OpenTag conservatively preserves the SSE error and does not retry it.

Actual deployed settings, native Linux Sandbox execution, and live-provider TPM recovery were
not exercised. Source checks, loopback CLI acceptance, merging, and deployment remain separate
evidence. Keep the issue open until the fix is merged and deployed behavior is accepted.
