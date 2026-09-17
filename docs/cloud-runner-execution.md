# Cloud Runner execution (E3 and E4)

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
- E3 does not save or restore that address yet. **Instance deletion loses the local workspace.**
  Durable restoration is E5; IM dispatch and reliable receipts are E4; reuse/idle recycling is
  subsequent work. Do not enable default product Cloud execution based on E3 acceptance alone.

## Lifecycle and control

The existing lifecycle is `unallocated → preparing → ready → releasing → unallocated`.
The Server reserves the allocation name before cloud I/O. Competing callers reconcile the same
allocation. An uncertain create or delete retains the row's resource reference and an actionable
error code; a 404 while a create may still arrive is not proof of cleanup. The provider UID and
etag protect deletion against name reuse.

The Instance runs `opentag-runner serve`. It declares the single container port `8080` so the
platform's default TCP startup probe has a listening socket; after native readiness is verified,
the Runner listens on that port only to accept and immediately end connections — no data is read
or written, and the listener carries no command, HTTP, or credential surface. The control channel
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

Undispatched Cloud inputs use the existing ingress TTL and per-Session queue capacities (100
direct, 500 ambient). Expiry/overflow records an explicit terminal reason. Dispatched Cloud
inputs retain their frozen dispatch window; accepted-but-unreported custody is never pruned as
pending input. `restore_required` and a stopped environment reject the input explicitly rather
than retrying forever. Transient model/Runner unavailability remains retryable within the input
deadline. Cloud follow-ups wait for the current Turn and never enter the Local steering path.

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

Recovery also checks whether the Session, Agent, binding or Account has stopped authorizing work.
If a stop frame was lost during disconnection, a live Runner reporting `received` or `started`
receives cancellation again. `releasing` alone is not evidence that its result was lost; the
Server still accepts the real report while the allocation drains. The worker owns the persisted
execution deadline; the parent exec adds five seconds only as a teardown/reporting backstop.

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

Boundary: E3 remains the native-execution acceptance path. E4 does not implement GCS workspace
restore (E5), concurrent multi-Turn placement (E6), idle reuse/recycling (E7), or Context Tree
synchronization (E8). Real native Cloud Run execution, real GCP acceptance, and real IM
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
requires operator cleanup using that receipt; no E7 background reaper is claimed here.

A final acceptance requires both local gates and real cloud proof, followed by verified deletion
of task-owned resources. Validation-only API calls prove request compatibility, not execution.
