# Cloud Runner execution (E3)

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

## Native isolation and cancellation

The image includes a separate, image-built `/opt/sandbox-root`. Native launches explicitly select
it: the CLI's default parent-root mount is never used. Only the per-Session `/workspace` and the
platform's read-only `/etc/resolv.conf` are bind-mounted. No host HOME, runtime state or bootstrap
credential directory is mounted. A source-owned Linux init runs in both parent and native Sandbox
and reaps adopted children.

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

## Required configuration

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
