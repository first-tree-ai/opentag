# Cloud Computer product and resource controls

[简体中文](./zh-CN/cloud-computer-product.md)

Cloud is an Account-owned logical Computer. Its fixed online status does not claim that a
physical Instance or a model is ready. Agents retain the existing Agent and Session models;
each Agent Session owns one Sandbox and at most one current Instance. Cloud uses Pi, one vCPU
and 1 GiB. Creating an Agent or opening its settings does not allocate an Instance. Context Tree
is optional; existing authorized repositories are supported. Local onboarding remains available.

## Availability and status

`GET /api/v1/computers/cloud` reads deployment availability. `PUT` on the same path idempotently
ensures the caller's Computer. The existing create-Agent API binds it with `runtimeProvider=pi`.
Cloud setup uses server configuration and IM authorization; it does not wait for a Local daemon
or fabricate a provider CLI observation. Actual Session execution still requires authenticated
Runner readiness and current execution authority.

`GET /api/v1/agents/:agentId/cloud` is an Account-authorized, read-only database projection:

- Account occupancy counts tracked allocations, including resources awaiting verified deletion.
- Agent totals include IM and internal Sessions, independently of the current page.
- `limit` defaults to 20 and is bounded at 100; UUID `cursor` pages by Session ID. A `sessionId`
  filter cannot be combined with a cursor. Neither can change ownership scope.
- Processing totals represent accepted, unfinished work. A disconnected Runner makes a row's
  execution state unknown; it does not prove the process stopped. Queued and processing totals
  can overlap when a Session has both current and waiting work.
- Rows expose current lifecycle, generation, authenticated connection and safe actions. Provider
  resource names, storage addresses and raw provider diagnostics are not part of this projection.
- Mounted, visible views use the existing 30-second live query cadence, including idle views so
  externally arriving IM work is discovered. Background interval polling stays disabled.
- Queries never call GCP/GCS, start an Instance, restore a workspace or issue credentials. A
  failed query is an error, not an empty result or zero occupancy.

Task completion and environment preservation are separate facts. A completed task with a failed
workspace save remains completed. Do not infer a last-save time from an older object or claim all
local changes were saved merely because an archive exists. Task/token usage includes **IM tasks
only**; internal Session token usage is not persisted. Environment counts include both kinds.

## Resource admission

| Setting | Default | Meaning |
| --- | --- | --- |
| `OPENTAG_CLOUD_RUNNER_MAX_INSTANCES_PER_ACCOUNT` | `3` | Maximum tracked allocations per Account |
| `OPENTAG_CLOUD_RUNNER_MAX_INSTANCES` | `20` | Maximum tracked allocations in the configured platform resource scope |

Admission runs in the existing allocation path before additional physical resources are reserved.
A short PostgreSQL advisory transaction lock serializes count-and-reserve; network operations
remain outside it. Unknown creates, pending deletion and failed saves retain occupancy. Existing
allocations, same-Account reuse and cleanup do not consume another slot. Lowering a limit does not
kill existing work. These controls limit concurrency, not total model or storage spending.

At capacity, IM stays in the existing bounded reliable queue. Explicit start reports
`CLOUD_CAPACITY_EXCEEDED`. Internal child work reports a durable failure before execution rather
than waiting indefinitely while the parent holds resources. There is no additional queue, quota
table, resource pool or lifecycle state. Existing idle reclamation remains in force.

## Recovery and release

Use the existing task cancellation and Sandbox stop operations. Saving and releasing waits for
archive persistence and verified deletion. A failed save retains the allocation and enables
retry. Explicit discard requires confirmation and the captured `environmentGeneration`; stale
pages cannot discard a replacement. A timed-out mutation requires a status read, not automatic
destructive replay. Read and cleanup remain possible after an Agent or Session is stopped,
provided the Runner control service remains enabled. Save and release allocations before disabling
the entire Cloud Runner service; disabling it also removes its control endpoints. Model
unavailability does not require disabling the control service.

Account suspension retains the existing authentication denial. A suspended Account cannot use
the browser to clean up; its allocations remain counted and are handled by the existing runtime
cleanup or an operator. Agent suspension and Session completion do not suspend the Account.

## Release and acceptance

Use the [unified CLI/Runner release](./cloud-runner-release.md); no separate version service is
introduced. Verify the live Server source, Runner digest/version/source, `/readyz` target proof,
and migration hashes. A successful image build alone is not a deployed release; a failed workflow
after a write is not proof that the write did not happen. Re-read actual state before retrying.

Before exposing Cloud creation, verify concurrent Account/platform admission on PostgreSQL,
cross-Account denials, Local onboarding, IM authorization/revocation, stale-generation discard,
and mutation-success/refetch-failure behavior. Real acceptance also needs a designated IM
conversation and an authorized test repository: synthetic ingress and local Git origins cannot
establish Slack/Feishu delivery or GitHub App publication. Record source/digest, Instance identity,
archive evidence and cleanup receipts. Shared staging changes and rollback must follow their
deployment authorization; code checks alone do not authorize switching shared environments.
