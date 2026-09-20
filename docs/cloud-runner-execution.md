# Cloud Runner execution (E3–E8)

[简体中文](./zh-CN/cloud-runner-execution.md)

E3 connects an existing Agent Session's Sandbox identity to a real Cloud Run Instance and the
Cloud Run native Sandbox CLI. It is opt-in and disabled by default. Each allocation uses **one
Instance, one native Sandbox, one vCPU and 1 GiB**. The Runner remains part of Client and uses the
CLI release version. E3 adds no database migration or table.

## Boundaries

- `Computer` remains the Account's logical Cloud identity; its online state is not a physical
  Instance health indicator.
- `Agent Session` is the existing execution/session record. The IM binding and channel/thread
  identify it; it is not a new conversation model.
- `sandboxes` owns the association between that Session and the current physical allocation.
  `environment_generation`, deterministic resource name, provider UID and operation name fence
  late callbacks. `storage_uri` remains the stable persistence address.
- E3 alone does not save or restore that address. E5 adds
  [latest workspace persistence and restoration](./cloud-workspace-persistence.md), including Pi
  conversation state. IM dispatch and reliable receipts are E4; idle reclamation and same-account physical reuse are
  E7. E3 acceptance alone does not establish durable Cloud execution.

## Lifecycle and control

The existing lifecycle is `unallocated → preparing → ready → releasing → unallocated`.
The Server reserves the allocation name before cloud I/O. Competing callers reconcile the same
allocation. An uncertain create or delete retains the row's resource reference and an actionable
error code; a 404 while a create may still arrive is not proof of cleanup. The provider UID and
etag protect deletion against name reuse.

The Instance runs `opentag-runner serve`. It declares the single container port `8080`, and after
native readiness is verified the Runner listens on that **declared port by default** (an injected
`PORT` remains the explicit override), so the platform's default TCP startup probe always has a
socket even when the runtime does not provide `PORT`. The listener only accepts and immediately
ends connections — no data is read or written, and it carries no command, HTTP, or credential
surface. The control channel
remains the Runner's outbound WSS connection to `/api/v1/sandbox-runners/ws`; the Instance exposes
no parent HTTP control service. Authentication is
in the first frame, never the URL. Tokens are scoped to the current Sandbox/Session/generation/
resource name. Heartbeat acknowledgements detect a dead connection; renewed tokens stay in
parent memory for reconnection. The Server checks current ownership, placement and execution
permission before admitting work/results.

Cloud provider readiness alone does not make a Sandbox ready. The authenticated Runner must
prove native execution, tool versions, image Runner version, and filesystem/credential isolation.
A replaced socket cannot publish readiness or finish another connection's command.

The current account API exposes `GET /api/v1/sandboxes/:sandboxId/runner` and POST suffixes
`/runner/start`, `/runner/stop`, `/runner/acceptance`. Acceptance is a bounded offline or DeepSeek
fixture command, not a general task submission API. The account cookie/CSRF/ownership checks
remain in force. One acceptance may run in a Sandbox at a time.

Runner connections and pending acceptance responses are held in the owning Server process.
Use one test Server for E3; distributed routing/reliable task delivery is not established by
these endpoints. A Server restart requires Runner reconnection and does not durably replay an
in-flight acceptance request.

Bootstrap tokens are environment variables on the Instance and therefore readable to principals
with access to its configuration. Use a trusted operator project: protecting an active connection
from duplicate takeover does not prevent a privileged reader from winning the first connection.
A new connection cannot replace a live, heartbeating connection for the same allocation. Renewal
closes definitively revoked scopes; known policy-rejected allocations cannot authenticate or
renew. Readiness is an authenticated Runner self-report backed by its local probes, not remote
attestation. Readiness frame handling performs database checks only, never Cloud Admin writes.

## Native isolation and cancellation

The image includes a separate, image-built `/opt/sandbox-root`. Native launches explicitly select
it: the CLI's default parent-root mount is never used. The platform resolver is never mounted
directly: the Runner validates a bounded snapshot of `/etc/resolv.conf` bytes, writes it into a
fresh private directory outside the workspace and rootfs, and bind-mounts that copy read-only at
`/etc/resolv.conf`. The Runner mounts the per-Session `/workspace`, that resolver copy, and the
read-only E4 public bridge directory described below. No parent HOME, private runtime state or
bootstrap credential directory is mounted. A source-owned Linux init runs
in both parent and native Sandbox and reaps adopted children.

The Instance parent is privileged because the native sandbox launcher requires root: the exact
`opentag-runner serve` process runs as root under the source-owned init. Other commands invoked
through the image entrypoint (`identity`, `probe`, `skills`, `accept`, `worker`) execute as uid/gid
10000 with supplementary groups cleared through the base image's `setpriv`; when the container is already started non-root,
the entrypoint never elevates. The worker still only ever runs as a native sandbox child — the
parent never executes the user task itself, and mounts remain limited to the workspace, resolver
copy and public bridge directory described above. Native `sandbox exec` invokes the worker directly,
bypassing the image entrypoint: the current Cloud Run execution path runs as uid 0 inside the
native Sandbox, as verified in the GCP diagnostic. It does not inherit the entrypoint's uid 10000
drop. This boundary relies on the platform Sandbox and restricted mounts; it is not an additional
non-root worker boundary. Dropping native worker privileges remains a hardening follow-up.

`worker` accepts a bounded stdin document. Pi configuration is scoped to DeepSeek, rejects shell
credential indirection, and is written into a private disposable directory. Control credentials
are not forwarded to the worker. The acceptance harness verifies the local source configuration
has not changed.

Cancelling the supervisor CLI alone does not prove the sandbox process tree stopped. After every
acceptance outcome, the Runner waits for native `delete --force`, then recreates and probes the
native environment while retaining the Instance-local workspace mount. It reports completion
only after this cleanup. Reconnection waits for the same cleanup barrier. A cleanup failure
terminates the Runner with a failing status. This E3 fixture reset is not a durable Session resume
implementation.

## E4 Cloud IM delivery (opt-in; native/IM acceptance pending)

E4 delivers a normalized IM message to a Session's existing Cloud allocation over the same
authenticated Runner control channel. It is additive to E3 protocol version 1 and disabled by
default: the Server enables the Runner path only with `OPENTAG_CLOUD_RUNNER_ENABLED=true` plus the
Cloud identity configuration below, and the model path only with `OPENTAG_CLOUD_MODEL_ENABLED=true`
and an explicit allowlist. E4 adds no database table or migration; it reuses the existing
delivery, custody and durable-work records.

Control boundary: `delivery:run` (persisted Server dispatch) → the Runner journals the exact
input, input hash and allocation scope in trusted parent storage with fsync → `delivery:received`
→ Server persists durable custody → `delivery:verified` (with an execution-scoped model grant) →
the native Sandbox worker executes → `delivery:report` → `delivery:report:ack`. A `received`
entry resumes through a fresh verification; a `started` entry whose process died reports
`unknown` exactly once and is never replayed; a `reported` entry re-sends until a matching
durable acknowledgement clears it. A reopened journal under another allocation fails closed
(`scope_mismatch`) without emitting a stale frame, and a same-id/different-input re-dispatch is a
visible conflict rather than a second Turn.

The default trusted state root is `$TMPDIR/ots/<bounded-sandbox-name>` (`/tmp` in the Runner
image), keeping the real public Unix socket paths within their 100-byte limit. The input journal
rejects new entries at its 1,024-entry capacity while still allowing duplicate receipts and
acknowledgements to retire existing entries. A channel close drops queued verification grants;
the durable `received` entries require fresh verification on the replacement connection. A frame
queued on the old connection cannot authorize a new start after reconnect.
A queued Turn cancelled before it starts reports `not_started` and immediately advances the
remaining FIFO queue; it does not require a new message or availability signal.

Undispatched Cloud inputs use the existing ingress TTL and per-Session queue capacities (100
direct, 500 ambient). Expiry/overflow records an explicit terminal reason. Dispatched Cloud
inputs retain their frozen dispatch window; accepted-but-unreported custody is never pruned as
pending input. Without E5 persistence, `restore_required` rejects replacement explicitly. With E5,
replacement allocation is permitted but cannot execute before verified restoration. A stopped
environment rejects input explicitly. Transient model/Runner unavailability remains retryable within the input
deadline, with exponential delays from two seconds to a thirty-second cap using the existing
attempt counter. Cloud follow-ups wait for the current Turn and never enter the Local steering path.

Credential and model boundary: the #633 runtime-credential Relay stays in the trusted parent; the
Sandbox receives only the read-only public material (CA certificate, per-turn proxy sockets,
opaque handles, per-turn provider environment file) and never the platform master key, bootstrap
token, or raw provider credentials. Platform-supplied model access uses the proxy; the grant is pinned to
the execution and its lifetime is bounded by the runtime deadline. In E4,
credential and model grants are revoked when the Runner connection is lost (fail-closed,
connection-scoped authority). Journal recovery still preserves the actual Turn outcome and never
replays `started` work, but a transient Server or control-channel outage may fail an active
model/tool call. E4 does not promise uninterrupted model continuation and adds no grant-renewal
protocol; that remains future work if the product requires it.

The model proxy accepts a strict Pi-compatible chat-completions payload. Routing and credential
overrides are rejected, each request has at most one completion, and output budgets are capped at
65,536 tokens. If both output-budget fields are omitted, the proxy supplies `max_tokens: 65536`;
omission cannot bypass the limit. These are per-request bounds, not an aggregate spend quota.
Assistant history preserves Pi's `reasoning_content`, `reasoning`, and `reasoning_text` echoes,
plus bounded encrypted `reasoning_details` for signed tool calls. These history fields do not
relax the top-level routing or credential allowlist.

The grant registry's 4,096-entry bound protects Server state, including concurrent issuance. It
is not a per-Account execution quota or a model-spend budget. Account-level admission and fairness
remain resource-policy follow-ups; the current global limit can be consumed by one Account.

Write boundary: the durable records E4 relies on are the Server's IM delivery custody and Turn
report, plus the Runner's per-allocation input journal — not a generic provider write journal or
receipt. Provider writes proxied on behalf of a Turn follow the #634 rules: one upstream attempt
per proxied request, classified in memory as succeeded, definitely rejected, or unknown; an
unknown write surfaces as an explicit `write_outcome_unknown` and is reconciled by the task layer
instead of being replayed automatically. E4 therefore does not promise exactly-once provider
effects across a crash.

Cancellation boundary: killing the `sandbox exec` wrapper is not proof that the namespace process
tree stopped. Immediately after any non-completed Cloud Turn (cancellation, deadline, failed or
unknown execution) the Runner performs the same verified reset as E3, while the Turn occupation
is still reserved and BEFORE it publishes the terminal report: `delete --force`, relaunch, and a
fresh readiness probe. No next delivery is needed to trigger cleanup, so a stopped Session cannot
leave orphan native children behind. A reset failure publishes an honest `unknown` cleanup-failure
report instead of a safe cancellation, makes the Runner unusable, and shuts it down through the
existing failure path rather than silently reusing the namespace; E3 acceptance cannot start while
a Cloud Turn or a pending reset owns the Sandbox. A nonzero worker exit is never reported as a
completed Turn, even if its stdout claims one.
Every Runner exit marks the controller as stopping before settling its active worker. During
shutdown, the verified cleanup deletes the namespace without relaunching it, including an
authentication rejection or exhausted reconnects in legacy non-persistent mode. Persistent Runners
retain their unsaved workspace on auth rejection; allocation-scoped renewal and loss repair are
described in [workspace persistence](cloud-workspace-persistence.md).

Recovery also checks whether the Session, Agent, binding or Account has stopped authorizing work.
If a stop frame was lost during disconnection, a live Runner reporting `received` or `started`
receives cancellation again. `releasing` alone is not evidence that its result was lost; the
Server still accepts the real report while the allocation drains. The worker owns the persisted
execution deadline; the parent exec adds five seconds only as a teardown/reporting backstop.
An IM binding in `reauthorization_required` temporarily blocks new execution permission without
rejecting queued input or cancelling accepted work solely for that status. Input TTL/capacity
still apply, and existing reports remain recoverable. Restoring authorization permits normal
delivery/recovery again; Session/Agent/Account stops and allocation release still cancel work.
A connection authenticated during the pause remains ineligible for execution grants. Once a
heartbeat or recovery exchange observes restored authority, the Server asks it to reconnect
through the existing control handshake, restoring readiness and credential opens without
replacing the Instance or discarding the journal.

Continuity and secrets: Pi conversation state and the persisted provider binding live under the
Session workspace's `.opentag/pi-session` subtree, so the same Agent Session keeps its Pi
binding/history across Turns and across a native rootfs reset. Model grants and the published
provider environment are per-turn scratch files with `0600` permissions and are deleted at Turn
end; they are never part of the persisted conversation state. Production requires both real
mounted `connect.sock`/`slack.sock` proxy sockets; a loopback fallback exists only behind the
explicit local test seam and is never used by production composition.

Compatibility and rollout: the Runner requests `cloudDeliveryVersion: 1` in the auth frame; a
Cloud-enabled Server echoes the capability and the current allocation UID only for that
connection and keeps the exact legacy E3 welcome shape otherwise. A Cloud-capable welcome without
a tracked UID is treated as transient and retried. Roll out Server support first, then a pinned
E4 Runner image; a new E4 Runner is not claimed backward compatible with an older strict Server,
while E3 Runners against the new Server remain supported.

E3 renewal and acceptance results still require the active authority chain. Only negotiated E4
connections may retain a report-capable channel after that chain stops, while their exact
allocation remains current; no new execution is authorized. Temporary database validation errors
do not masquerade as revocation. Authentication facts are read before hub registration so a
heartbeat cannot precede the authentication result.

Boundary: E3 remains the native-execution acceptance path. The E4 acceptance path does not cover
GCS workspace restore (E5), concurrent multi-Turn placement (E6), idle reuse/recycling (E7), or
Context Tree synchronization (E8). Real native Cloud Run execution, real GCP acceptance, and real IM
provider ingress/reply acceptance remain pending; current evidence is local composition and
external local probes only. Do not claim E4 accepted from local results.

## Required configuration

For E4, the Server additionally requires these model settings when enabling execution:

| Server variable | Meaning |
| --- | --- |
| `OPENTAG_CLOUD_MODEL_ENABLED` | Default `false`; `true` opts into the Cloud model proxy |
| `OPENTAG_CLOUD_MODEL_UPSTREAM_BASE_URL` | Fixed HTTPS OpenAI-compatible API base URL |
| `OPENTAG_CLOUD_MODEL_MASTER_KEY` | Server-only upstream secret; never copied into the Runner image or Sandbox |
| `OPENTAG_CLOUD_MODEL_ALLOWED_MODELS` | Comma-separated model allowlist; the first is used when the Agent has no explicit model |

Keep the bounded transport defaults unless acceptance shows a need to tune them. See
[`cloud-model-config.ts`](../packages/server/src/cloud-model-config.ts) for the optional timeout,
body-size, stream-count and token-lifetime settings. This document does not provision any setting.

Cloud identities must already be enabled with `OPENTAG_CLOUD_IDENTITIES_ENABLED=true`,
`OPENTAG_CLOUD_STORAGE_BASE` and `OPENTAG_CLOUD_RUNNER_VERSION` (the image's CLI version).

| Server variable | Meaning |
| --- | --- |
| `OPENTAG_CLOUD_RUNNER_ENABLED` | `true` to enable; default `false` |
| `OPENTAG_CLOUD_RUNNER_IMAGE` | Exact registry `name@sha256:…`; tags rejected |
| `OPENTAG_CLOUD_RUNNER_PROJECT`, `…_REGION` | Dedicated configured project/region |
| `OPENTAG_CLOUD_RUNNER_SERVICE_ACCOUNT` | Minimal-permission Instance identity |
| `OPENTAG_CLOUD_RUNNER_BACKEND_ORIGIN` | Reachable HTTPS/WSS Server origin, no path/query/credentials |
| `OPENTAG_CLOUD_RUNNER_VPC_NETWORK`, `…_VPC_SUBNET` | Direct VPC attachment |
| `OPENTAG_CLOUD_RUNNER_EXECUTION_TAG` | Tag selecting provisioned execution-only firewall rules |
| `OPENTAG_CLOUD_RUNNER_API_TIMEOUT_MS` | Per-call deadline; default 30000 |
| `OPENTAG_CLOUD_RUNNER_CREATE_CONVERGE_TIMEOUT_MS` | Bounded create reconciliation; default 120000 |
| `OPENTAG_CLOUD_RUNNER_BOOTSTRAP_TOKEN_TTL_SECONDS` | Scoped token TTL; default 1800, renewed on current connections |
| `OPENTAG_CLOUD_RUNNER_ACCEPTANCE_TIMEOUT_MS` | Fixture execution deadline; default 900000 |
| `OPENTAG_CLOUD_RUNNER_GCP_ACCESS_TOKEN` | Short-lived off-GCP acceptance token; requires explicit `OPENTAG_ENV=dev` |

Hosted Server wiring obtains Cloud Admin access tokens from its attached GCE service account
metadata endpoint. It does not read local credential files or run `gcloud`; generic off-GCP ADC
is not implemented. The control-plane identity needs Instance/operation management and permission
to act as the configured runtime service account. The runtime service account must not inherit
Server privileges.

## Network prerequisites

The operator provisions Direct VPC with `ALL_TRAFFIC`, NAT for public egress, and firewall rules
scoped to the execution tag. Allow required public DNS/HTTPS/HTTP/Git transport while denying
private/special destinations and unneeded ports. The Server adapter verifies the actual NIC,
subnet, egress and tag after creation, along with image/resource/ingress/identity/port policy. It
does not provision firewall rules itself. IPv6 needs its own policy before use.

The global v2 Instance create currently has a Direct VPC representation incompatibility in the
verified us-west1 environment. Only a recognized rejected VPC-field 400 uses the equivalent
regional v1 create representation. Both paths preserve internal ingress, disabled default URL,
IAM invoker checking, no restart, sandbox launcher, the single declared container port 8080 and
Direct VPC all-traffic routing. There is
no fallback to default egress. Normal reads/deletes use v2.

VPC firewall rules alone do not establish parent-loopback or metadata isolation. Verify those
paths in the actual native environment. Git tests must use ordinary DNS/TLS, never pinned host
IPs or disabled certificate checks.

References: [native Sandbox CLI](https://docs.cloud.google.com/run/docs/reference/sandbox-cli),
[filesystem and network semantics](https://docs.cloud.google.com/run/docs/code-execution),
[Instance configuration](https://docs.cloud.google.com/run/docs/configuring/instances/sandboxes),
[conditional delete](https://docs.cloud.google.com/run/docs/reference/rest/v2/projects.locations.instances/delete).

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
admission, replay and reconnect recovery, native namespace cleanup gating, loopback-seam-free
socket handling, and the real loopback WebSocket dispatch path with local fixtures only. They do
not prove native Cloud Run isolation, native Unix-socket mounts, real GCP acceptance, or real IM
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

## E6: concurrent Cloud Sessions

One Cloud Agent can execute several **Agent Sessions** concurrently. Each Session still owns one
Sandbox and one Instance; it does not share a writable workspace or Pi history with another
Session. Cloud Computer remains the Account's logical identity, not an execution lock.

The existing IM delivery worker uses a Session lane for Cloud and an Agent lane for Local. Durable
custody follows the same boundary: a running or uncertain Cloud delivery fences its own Session;
Local custody retains the Agent-wide fence. The short PostgreSQL advisory lock still serializes
claim decisions for an Agent, ending before allocation, dispatch or execution. Committed custody
then prevents a second Worker from admitting overlapping work in the same Session.

Undispatched Cloud inputs also wait behind earlier pending inputs in the same Session, including
inputs in retry backoff or locked by another Worker. Ordering uses the existing message-history
order (`occurredAt`, provider revision, message ID). An existing claim or frozen dispatch keeps
its recovery path when an earlier provider event arrives late; an expired claim must not wait on
the same input it fences. Another Session can progress independently. Late provider events do not
reorder work that has already been claimed.

No new table, migration, execution state machine or shared workspace is introduced. The existing
worker concurrency and queue limits bound dispatch work, not the number of Cloud Instances or
active model turns. Account-level resource budgets remain separate work. Session stop and
connection loss use the existing exact Session/Sandbox/generation authority; Agent suspension
still blocks new admission across every Session.

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

### Receipt expiry and provider routing

An expired frozen dispatch that was never accepted is rejected with `dispatch_expired`; the
existing worker releases that attempt and may retry within the original message TTL. Accepted
custody instead settles through cancellation and reporting, never automatic replay. A live
connection whose allocation becomes `releasing` continues to settle receipts and reports.

The Agent environment carries scoped provider routing inputs, not global proxy/CA overrides.
Git uses host-specific proxy and CA configuration for `github.com`; ordinary HTTPS and public
GitLab access retain direct public routing and system trust. The `gh` and Slack launchers apply
the private proxy/CA only to their own processes; Feishu uses its CLI-specific settings. Raw
provider HTTP requests use a subshell that sources `$OPENTAG_PROVIDER_ENV_FILE`. The credential
proxy host allowlist remains unchanged.

Deploy this Server before the updated Runner image: workspace Runners now opt into
`renewExpired` in the strict auth frame. Renewal-only replies require a fresh handshake and use
bounded reconnect backoff; renewal authentication allows 45 seconds for the Cloud API read.

## E7: idle reclamation and same-account physical reuse

E7 recycles a quiescent Cloud environment without a second window or a warm pool. One budget —
`OPENTAG_CLOUD_RUNNER_IDLE_TIMEOUT_MS`, default 120 seconds — is measured from the last
**business** activity (`sandboxes.last_activity_at`); heartbeats never count. Inside that budget
the Instance stays `ready`, so the owning Session can continue without a save/restore. The same
budget has one consequence when nobody continues: a bounded sweep (fixed ~15 s cadence in the
existing Server process, one pass at a time) seals the workspace through the E5 path and then
deletes the Instance. Automatic deletion runs only when the deployment persists workspaces: a
legacy allocation started without persistence may hold the only copy of its state and is left to
explicit Account stop, even after Server persistence is enabled. Such Instances are skipped before
claiming, so their Session remains usable. Sweep selection rotates by `updated_at`; the idle
budget still uses only `last_activity_at`, so failing or unsupported rows cannot monopolize a batch.
There is no retention clock, no preallocated pool and no new scheduler service.

E7 requires a single Server process while Runner control ownership, busy state and readiness live
in the process-local `RunnerHub`. Database CAS alone does not make active-active Servers supported.
Shutdown drains the current sweep before closing the database.

A second, same-account Session may borrow the physical Instance on demand instead of cold
allocating. The borrower must be an `unallocated` Sandbox on the same logical Cloud Computer, and
the candidate must be `ready`, unclaimed, connected through an E7-capable Runner, with no pending
or accepted-unreported delivery and no in-flight acceptance. The sequence is durable at every
step: verify provider persistence and deployment policy before claiming, atomically claim the
candidate (execution blocked), seal through E5 and verify a fresh
GCS `saved + sealed + owner-generation` proof, then one transaction that locks both rows, clears
the origin binding first and assigns the borrower `preparing` with generation + 1 and the exact
same resource name and UID. No Cloud Run create, PATCH or configuration change happens. The
origin keeps its own stable `storage_uri` and later cold-restores from its archive; the borrower
restores its own archive. If the transfer cannot commit after sealing (including a concurrent
start that already allocated the borrower), the sealed origin follows verified deletion immediately.
It can then cold-restore from its archive; clearing a claim alone cannot reopen a sealed Runner.
An unproven save keeps the allocation for retry.

The automatic claim is the single nullable `sandboxes.idle_reclaim_at` column (migration 0046, no
new table). While it is set, execution authority is revoked, a start reports pending, and normal
ingress returns `pending` — never a terminal `environment_stopped` — so a message that arrives
during recycle or borrow is retried. Lifecycle stays `ready` while sealing; only a proven seal
moves an automatically reclaimed row to `releasing` for verified deletion. The budget clock is
always `last_activity_at`; `idle_reclaim_at` only records who owns the reclamation intent, so an
abandoned claim is retried after the row's original budget, never after a fresh window. Once a
proven seal moved a row to `releasing`, a failed or interrupted delete is retried on the next
sweep from the durable marker without waiting out another budget. A failed or unknown seal keeps
the resource binding, the claim and the existing workspace-save marker. A provider-confirmed
absent UID clears the binding; a failed read never does. An explicit Account stop clears the
marker in the same transition that precedes cloud DELETE, so a late transfer can never win.

Stale adoption uses create convergence plus four workspace transfer budgets (currently an extra
480 seconds for claim, download, checkpoint upload and native initialization; not an idle window):
a `preparing` allocation whose tracked Instance has not produced a READY Runner within that
deadline, including a connected-but-never-ready restore, is re-read from the provider. A
confirmed absent or replaced UID clears the binding; a present, ownership-verified tracked
Instance is released through the verified delete path with the automatic intent marker set, so
ingress keeps returning pending for that Session. The borrower's own archive is untouched, so its
next start restores it into a new generation instead of leaving the Sandbox `preparing` forever.

Ownership and deployment policy are checked separately: name + tracked UID + managed/environment
labels prove ownership for save, renewal and cleanup, so an already-owned Instance can still be
sealed or deleted after an image or VPC configuration change; only the borrow/eligibility path
re-applies the full execution policy.

Idle claim and dispatch acceptance share one database authority boundary: both take the Sandbox
row lock, and the claim refuses any pending/claimed dispatch or accepted-unreported custody.
Business activity is touched on dispatch, receipt, report and acceptance boundaries only; a long
silent execution is custody-busy, not idle. Automatic reclamation can never cancel active work.

### Physical control credential

Runner control authentication is separate from Session workspace authority. The Server signs a
physical **control** credential under its own audience (`opentag-cloud-runner-control`) at
creation, alongside the existing Session bootstrap token, and places it in the optional
`OPENTAG_RUNNER_CONTROL_TOKEN` Instance environment variable; older Runners ignore it. Only this
credential may resolve a Runner to a **different** current owner after a transfer: the Server
verifies the signature, resolves the unique row that currently holds `currentResourceName`,
performs a bounded provider read under the same 45-second provider-read deadline as renewal
(an ordinary handshake keeps its short deadline) proving that exact tracked UID is still present
with the original immutable birth labels (the signed control claims), and rechecks the holder row
after the read before validating that owner's authority (active for execution, exact persisted
allocation for report/seal). A stale Session bearer can never cross into another Session's authority, even
within one account. Workspace HTTP keeps accepting only the exact Session audience for the
current scope. Control renewal requires a valid signature plus the tracked UID and provider
binding; no token table or file is added. `server:credential` refreshes the current assignment's
Session token and the control credential, and the control token never enters the native Sandbox,
archives, public mounts or logs.

An E7-capable Runner negotiates `reuseVersion: 1` in the auth/welcome exchange and is registered
in the hub as reuse-capable; older E5 Runners are never asked to follow a hand-off (idle deletion
still saves them). On a changed assignment the Runner quiesces the old controller and native
child, closes credential/web execution work, discards the old workspace, private material,
public socket and completed journal only when the trusted-parent assignment marker records a
successful seal, and rebuilds a fresh journal/controller/workspace before restoring the new
Session's archive. The same assignment keeps unsaved local bytes; a missing seal proof, a
cleanup failure or an unproven credential all fail closed with no new execution. Every
negotiated physical-control attach — including a first bind with no local marker, a process
restart with local assignment state, or any changed assignment — must receive the Server's
Session credential for the current holder before the first workspace HTTP claim; the static birth
bearer is never reused for a different Session, and a credential timeout fails closed. A
disconnect while the old assignment's rebind cleanup is in flight drains the serialized
control-work tail and interrupts its credential wait, so the next connection can never race the
cleanup or publish readiness over an unsettled workspace.

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

## E8: Context Tree and Session collaboration

See [Cloud Context Tree and Session collaboration](./cloud-context.md) for current configuration,
private workspace recovery, published knowledge, managed Session CLI authority, and validation
boundaries. E8 reuses the existing Sandbox lifecycle and does not introduce another allocation model.

Rollout and rollback are a matched release: a Runner built with E8 always sends
`sessionCollaborationVersion` in its auth frame, and a pre-E8 Server's strict auth schema rejects
the unknown field. Deploy the Server first and never roll the Server back to a pre-E8 build while
E8 Runners are alive — their auth would be rejected, so they could not even report the IM custody
already journaled on them, stranding those environments until their Instances are replaced.
A Runner rollback needs the same care in the other direction: an older Runner cannot consume E8
Session collaboration frames or journal entries. The matched rollback sequence is: stop admitting
new work (pause the affected Agents), let active E8 environments drain and settle and save while
the compatible Server still serves them, and verify those Instances are terminated/removed; only
then roll back the Server and select a compatible Runner for new allocations. Replacing an
Instance is not recovery of unacknowledged Session custody: the Instance's unacknowledged
execution state — journaled receipts and settlements the Server never confirmed — dies with it
and must not be replayed, while the Session's saved workspace is restored normally on the next
allocation.
