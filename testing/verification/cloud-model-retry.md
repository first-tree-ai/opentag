# Cloud model retry verification

Supports [Cloud Runner execution](../../docs/system/cloud/cloud-runner-execution.md#model-retry-ownership).

## Scope

Issue #827: one automatic retry owner for each logical Cloud model or summary call. The Pi
provider request helper owns three retries after the initial attempt; session and summary
retry loops have zero retries. OpenTag forwards each model request once. Context compaction
remains enabled. A stream that has started is not automatically replayed after failure.

No schema, query, accounting, schedule, delivery-custody, Local runtime, or dependency changes
are involved.

## Regression proof

Tests were added against the unmodified baseline `0e14583bce8e80483f0f1da9357bf87f364c656a`.
The initial run had 10 expected failures: missing response hints, the absent explicit Cloud
retry configuration, premature retry before the hint, outer session/summary retries,
over-budget hints being retried, and partial-stream replay.

The fixed code passed 313 tests across these 10 files:

```sh
pnpm exec vitest run \
  packages/client/src/__tests__/cloud-model-retry.test.ts \
  packages/client/src/__tests__/cloud-turn-worker.test.ts \
  packages/client/src/__tests__/cloud-turns.test.ts \
  packages/client/src/__tests__/pi-agent-runtime.test.ts \
  packages/client/src/__tests__/pi-agent-runtime-exhaustive.test.ts \
  packages/server/src/__tests__/cloud-model-proxy.test.ts \
  packages/server/src/__tests__/cloud-model-retry.test.ts \
  packages/server/src/__tests__/cloud-model-service.test.ts \
  packages/server/src/__tests__/cloud-model-boundaries.test.ts \
  packages/server/src/__tests__/cloud-model-grants.test.ts \
  --maxWorkers=1
```

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
- A partial model stream fails without automatic replay.
- Summary exhaustion has four requests, without another summary retry budget; a transiently
  limited summary can also recover and complete normally.
- Integer and canonical HTTP-date hints are validated; malformed or arbitrary header text is
  discarded. Permanent quota errors expose no hint.
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

Both cases included a conflicting project retry configuration and verified that it did not
override the managed settings.

## Router and deployment boundary

Read-only source inspection of LLM Router main at
`3a1fa09f2f1ecd4094c11dd67788031e116ba103` confirmed zero Router retries, zero LiteLLM retries,
and zero provider SDK retries in deployment/model configuration. Its gateway transport forwards
once. No Router source or deployed configuration was changed.

Actual deployed settings, native Linux Sandbox execution, and live-provider TPM recovery were
not exercised. Source checks, loopback CLI acceptance, merging, and deployment remain separate
evidence. Keep the issue open until the fix is merged and deployed behavior is accepted.
