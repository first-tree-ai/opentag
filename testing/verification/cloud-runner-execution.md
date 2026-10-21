# Cloud Runner execution: verification and acceptance

Test and acceptance material for [Cloud Runner execution](../../docs/system/cloud/cloud-runner-execution.md).

## Acceptance

First run the repository checks and the image's offline toolchain suite. The latter now checks
source-owned init signal forwarding and orphan cleanup without Docker's `--init` substitution.
A local Docker pass, including an emulated amd64 pass, is not native Cloud Run acceptance.

```bash
pnpm build
node scripts/e2e/cloud-computer.mjs cloud-runner --help
```

E4 has no GCP command yet. Its maintained local composition checks are:

```bash
pnpm build
pnpm --filter @opentag/shared test
pnpm --filter @opentag/client exec vitest run src/__tests__/cloud-journal.test.ts src/__tests__/cloud-turns.test.ts src/__tests__/cloud-turn-worker.test.ts src/__tests__/cloud-sandbox-credential-bridge.test.ts src/__tests__/runner-serve.test.ts
pnpm typecheck
```

These exercise the durable journal boundaries, duplicate/concurrent dispatch, deadline/grant
admission, replay and reconnect recovery, native namespace cleanup gating, provider transport
failure/cleanup and the real loopback WebSocket dispatch path with local fixtures only. They do
not prove native Cloud Run isolation, native exec transport, real GCP acceptance, or real IM
provider ingress/reply; those remain pending and must be evidenced by the Cloud harness plus a
real IM acceptance before E4 is called accepted.

The Cloud harness requires explicit project, region, digest, runtime service account, backend
origin, VPC/subnet/tag and an environment-only short-lived Cloud Admin token. It runs a disposable
PostgreSQL and real local Server. `OPENTAG_E3_PORT` fixes the loopback port if a separately approved
WSS-only proxy/tunnel is needed; the harness does not open a tunnel. `--mode real --provider deepseek
--pi-config-dir /absolute/path` filters the selected provider before transmission. Never expose
account APIs or a production database through the test endpoint.

The harness creates two distinct Session allocations, waits for both native Runners and executes
concurrent acceptance. `summary.json` records source revision, substitutions, resource names/UIDs,
results and cleanup. Every in-flight step settles before teardown. On success, failure or handled
SIGINT/SIGTERM, cloud deletion is attempted before fixture teardown; uncertain cleanup fails the
run and preserves a resource receipt for operator reconciliation. SIGKILL or host loss still
requires operator cleanup using that receipt; this harness does not wait for the Server E7 idle
sweep, and the sweep itself is covered by the unit suites above.

A final acceptance requires both local gates and real cloud proof, followed by verified deletion
of task-owned resources. Validation-only API calls prove request compatibility, not execution.

### Local evidence and live acceptance boundary

```bash
pnpm --filter @opentag/server exec vitest run src/__tests__/im-delivery-custody.test.ts src/__tests__/im-delivery-worker-cloud.test.ts
pnpm --filter @opentag/server exec vitest run src/__tests__/integration/cloud-session-concurrency.test.ts --maxWorkers=1
pnpm --filter @opentag/client exec vitest run src/__tests__/runner-workspace-wire.test.ts
```

The PostgreSQL integration suite uses actual migrations, competing Workers and loopback
WebSockets into the production delivery owner. It checks overlapping Sessions, ordered retry,
locked-head handling, cancellation and model-grant isolation, rejected cross-Session receipts and
reports, report deduplication and Agent suspension. Runner peers start from an authenticated
allocation; this fixture does not test bootstrap authentication or actual model execution.
The client suite exercises production Runner HTTP/WebSocket orchestration with local native
execution and storage doubles. These are complementary checks, not native Cloud Run acceptance.

When cloud configuration is approved, perform one combined E4–E6 acceptance on staging:

1. Record Server revision and Runner image digest. Bind two real IM conversations to the **same**
   Cloud Agent and record their distinct Session, Sandbox and Instance IDs and storage URIs.
2. Hold A in a bounded task, send a second input to A, and let B complete a short task. Record
   overlapping execution timestamps; A's second input must wait, and B's reply must reach B only.
3. Write distinct marker files and Pi conversation history. Cancel or disconnect A while B runs;
   confirm B completes and its model authority remains valid. A's own outcome must remain truthful.
4. Save and normally release each environment, then allocate replacements and continue each
   Session. Verify its own files and Pi history are restored and the other Session's data is absent.
5. Suspend the Agent and verify neither Session accepts new execution. Reconcile every outstanding
   delivery, release the task-owned environments, and verify resource deletion by name and UID.

Store timestamps, delivery/turn IDs, results and cleanup receipts without credentials. The E3
`cloud-runner` harness alone does not implement this IM/persistence acceptance; a local pass or
image publication must not be reported as its completion.

### Local evidence and acceptance boundary

```bash
pnpm --filter @opentag/server exec vitest run src/__tests__/sandbox-idle-instance-reuse.test.ts
pnpm --filter @opentag/server exec vitest run src/__tests__/runner-ws.test.ts -t "E7 physical control credential"
pnpm --filter @opentag/server exec vitest run src/__tests__/integration/sandbox-instance-reuse-race.test.ts
pnpm --filter @opentag/client exec vitest run src/__tests__/runner-workspace-wire.test.ts
```

The Server suite proves the sweep budget, unsettled-work fences, seal-failure retry, provider
absence, same-account transfer with zero create, cross-account refusal, non-reuse-capable Runner
refusal and explicit-stop suppression on real PostgreSQL transactions, including gated
interleavings (two borrowers, stop versus in-flight borrow, dispatch versus idle claim,
acceptance versus idle claim) that synchronize on real state changes rather than sleeps. The
client wire suite proves one physical Runner is rebound to a transferred Session with the same
physical UID, the borrower's archive is genuinely restored, private material is cleared only
after a recorded seal, and unsealed or failed-cleanup rebinds stay closed. These fixtures do not
exercise GCP policy re-verification or a real Instance process restart.

During GCP acceptance, record the origin Session's resource name and UID, then start a second
same-account Session while the first is idle and before its deletion. Confirm the reuse path
keeps that physical name and UID without create/PATCH and each Session restores only its own
archive. Separately, let the idle budget expire, verify provider-confirmed deletion, and restore
the original Session into a fresh Instance. Also verify a stale Session bearer cannot follow the
transfer, and explicit stop wins against an in-flight borrow or automatic release.

### Native bridge fixture port reuse regression

The native provider bridge test originally released one ephemeral port before selecting the
second. Linux can immediately reuse that port. With identical entry ports, the real helper exits
with code 2 during startup and the parent reports `The native provider bridge session closed
unexpectedly`, before the intended SIGKILL test begins. The fixture now retains both listening
reservations until both ports have been selected; production bridge behavior is unchanged.

Local validation on October 21, 2026:

- The unchanged runtime reproduced the startup error on Linux Node 24 and Node 26.12.0 using
  duplicate ports returned by the original allocator.
- With a 16-port Linux ephemeral range, the original fixture failed on iteration four. The
  corrected allocator passed 200 real helper startup/SIGKILL/shutdown cycles on Node 26.12.0.
- The complete 17-case bridge suite passed separately on Node 22.22.2, 24.15.0 and 26.12.0.
- Repository checks, workspace build and typecheck passed, including normal commit/push hooks.

The [full branch validation](https://github.com/first-tree-ai/opentag/actions/runs/39550780769)
passed all nine unit shards, PostgreSQL integration, browser smoke, runtime coverage and
compatibility/pack/container checks. Its manual full-history Secret Scan reported two historical
test-database strings outside this change, so the aggregate run failed; no scan exclusion or
policy was changed. Pull requests retain the normal change-range scan.

These local child-process and container fixtures verify transport preparation and cleanup, not
native Cloud Run isolation or a live Provider. Reproduction sources and raw logs remain in task
evidence outside the repository.
