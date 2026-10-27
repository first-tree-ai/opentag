# Cloud model retry verification

Supports [Cloud Runner execution](../../docs/system/cloud/cloud-runner-execution.md#model-retry-ownership).

## Scope

Issue #827: one retry owner and one bounded attempt/deadline budget per managed model or summary
call. The model proxy retries confirmed HTTP 429 rejections at most three times after the initial
attempt. Pi session, summary, provider and SDK retries are zero. Native context compaction remains
enabled; its bounded changed-context overflow recovery does not execute partial tool calls.

The generated provider declares `x-opentag-model-retry-owner: proxy` only with retries disabled.
Older requests without that declaration are forwarded once, preventing retry multiplication
across Runner/proxy version skew. No schema, query, accounting, schedule, delivery-custody, Local
runtime or dependency changes are involved.

## Regression proof

The previous implementation at `bd1044e4a7cd4e67c68fed4307063d3e0d01475e` used Pi's generic
provider retry helper. Four focused probes reproduced all review blockers: HTTP 502, HTTP 504
and a statusless transport loss each made four requests instead of one; a heartbeat followed by
clean EOF returned HTTP 200 instead of terminal uncertainty. The corrected policy disables that
generic helper, including the unclassified-5xx and unusable-2xx paths.

The affected test command is:

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
  packages/server/src/__tests__/cloud-agent-runtime-tester.test.ts \
  packages/server/src/__tests__/cloud-model-catalog.test.ts \
  --maxWorkers=1
```

The final run passed all 391 tests across these 13 files.

Client tests use the installed Pi SDK and real session, summary and provider code. Only HTTP
responses and the clock are controlled. A conflicting 99-retry project configuration is present;
managed `--no-approve` excludes it. The tests assert one HTTP request for 400/401/402/403,
408/409/429, 500/502/503/504 and statusless transport loss. Summary exhaustion cannot start an
outer retry loop; native compaction and changed-context overflow recovery remain exercised.

Proxy tests use the actual route, model service and loopback HTTP fixture. Only the backoff
clock is replaced in most route tests. Real waits test cancellation, request deadline, grant
revocation and shutdown. Coverage includes:

- Exactly four upstream attempts for one persistent confirmed rate-limit request; two on recovery.
- One attempt for ambiguous 408/409/5xx, including a false rate-limit code on HTTP 503 and a Router
  502 with or without `x-router-dispatch: not_dispatched`.
- One attempt and one Router idempotency key after a post-dispatch transport loss.
- Valid integer/HTTP-date hints, malformed hints, native jitter bounds and the 60-second wait cap.
- Marked initial Router SSE rejections, split frames and comments; unmarked, uncertain, post-data
  and oversized prefixes remain preserved without retry.
- Terminal HTTP 400 for zero-byte EOF, heartbeat-only EOF, incomplete-event EOF and prelude
  timeout/read failure. Explicit revocation/shutdown still returns HTTP 401.
- Cancellation during an actual backoff releases admission and makes no later request.
- One forwarding attempt for legacy requests without the ownership declaration.

Client/Server type checks, builds and `pnpm check` cover the changed packages. No PostgreSQL
integration run is required: persistence behavior is unchanged. The model-service regression uses
the existing embedded database fixture; this is not a production accounting acceptance claim.

## Local CLI acceptance

A local harness launches the actual pinned Pi CLI in RPC mode with generated Cloud documents
and managed isolation flags. It calls the actual OpenTag model service and proxy over loopback.
A loopback model fixture and fixture-only usage store avoid public models, real credentials and
deployed databases. For explicit summary commands only, the fixture reduces native
`keepRecentTokens` to force a summary with short history; retry settings are unmodified.

All 18 cases passed, including the following attempt counts:

| Scenario | Proxy requests | Upstream completions | Outer retry events | Result |
| --- | ---: | ---: | ---: | --- |
| Persistent HTTP 429 | 1 | 4 | 0 | Terminal rate limit |
| HTTP 429 with a one-second hint, then success | 1 | 2 | 0 | Successful completion after the wait |
| Persistent marked HTTP 200 SSE rate limit | 1 | 4 | 0 | Terminal rate limit |
| Marked SSE rate limit with a one-second hint, then success | 1 | 2 | 0 | Successful completion after the wait |
| Unmarked or post-data rate-limit error | 1 | 1 | 0 | Terminal model error |
| HTTP 502/504 or false rate-limit code on 503 | 1 | 1 | 0 | Terminal model error |
| Pi-to-proxy or Router transport loss | 1 | 1 | 0 | Terminal model error |
| Invalid HTTP 200, empty/heartbeat EOF or prelude timeout | 1 | 1 | 0 | Terminal model error |
| Requested wait above 60 seconds | 1 | 1 | 0 | Terminal rate limit |
| Initial call plus summary rate-limit recovery | 2 | 3 | 0 | Summary completes |
| Initial call plus summary exhaustion | 2 | 5 | 0 | Summary fails after four summary attempts |

Every request declared proxy ownership. All cases excluded conflicting project retry settings;
the ambiguous outcomes had exactly one Router call key. Wait hints were measured before the next
upstream attempt. The source, route and CLI checks prove separate parts of the same budget.

## Router and deployment boundary

LLM Router source at `3a1fa09f2f1ecd4094c11dd67788031e116ba103` configures zero Router,
LiteLLM and provider-SDK retries. The companion Router change marks only observed upstream HTTP
429 rate-limit rejections, with an optional validated string wait hint in the fresh client error.
Stored errors, accounting transitions and in-band error handling remain unchanged; forged
Provider markers are stripped. Deploy that Router change before accepting streamed Provider 429
recovery. Unmarked older Router SSE errors remain conservatively terminal.

Actual deployed settings, native Linux Sandbox execution and live Provider TPM recovery were not
exercised. Source review, hosted CI, merging, deployment and business acceptance remain separate
evidence. Keep the issue open until merged and deployed behavior is accepted.
