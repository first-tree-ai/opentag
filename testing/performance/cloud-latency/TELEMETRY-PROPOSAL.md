# Staging latency collection design

The user approved implementation of this proposal on 2026-11-03, from the version at
`bc7b526dae643602c277799cca65456e7e172507`. The approval excludes deployment, real model calls,
IM messages and task replay. The workspace/repository AGENTS still require human confirmation
for material changes to the approved read/write design. [LIVE.md](LIVE.md) records the implemented
first increment, bounds and remaining blind spots; this page retains the approved design scope.

## Proposed first increment

Limit the first implementation to explicitly enabled, controlled Staging fixture Turns. Reuse
existing Pi diagnostics and trace identifiers. Add no database table, migration, cache, queue,
protocol frame, persistent correlation ID, OTLP destination or production log-shipping change.
The Server would continue writing to its existing Pino stdout; the Runner to its existing stderr.
An opt-in `OPENTAG_CLOUD_LATENCY_DIAGNOSTICS=true` would gate the added records. Default is off.
The implemented flag also requires a valid explicit allowlist of at most 16 Session UUIDs and
`OPENTAG_ENV=staging`. Deployment and live execution remain separately authorized actions.

| Item | Proposed contract |
| --- | --- |
| Scope/authorization | Explicitly selected Staging Account/Agent/Session and fixture input only, through existing operational access. No end-user grant or new API. Existing ownership/custody checks remain authoritative |
| Correlation | Existing turnId, deliveryId/messageId, sessionId, sandboxId, environmentGeneration and allocation resourceName. Parent-owned fields cannot be replaced by child records; IDs are not proof of permission |
| Payload | module, operation, revision, phase, event, outcome, attempt, existing correlation IDs, seq, durationMs, elapsedMs, controlled errorCode; no prompts, messages, tokens, credentials, URLs, tool arguments/results or provider bodies |
| Phases | Claim/lane admission, runtime assembly, allocation wait, restore/initial-save/readiness, execution preparation/Context Tree, existing Pi phases, model first-token observation, terminal cleanup, checkpoint commit and report ack. Emit only boundaries actually observed by the owning process |
| Limits | At most 32 added records / 64 KiB per Turn per emitting process, including summary. Aggregate repeated model/tool calls into count/total/max under the same cap. An incomplete flag reports cap/drop/write failure. No unbounded per-token/per-file/per-tree events |
| Clock model | Process-local monotonic durations plus UTC and process-start clock identity. Same-observer receipts give transport-inclusive upper bounds; cross-host subtraction requires a recorded offset/error bound. No change to Runner protocol solely to carry timing |
| Writes and failures | Best-effort bounded diagnostics on existing streams, outside transaction/authorization decisions. Logging exceptions/backpressure must not extend Turn deadlines, alter acknowledgement/custody, replay uncertain work, or block report/checkpoint |
| Existing retention | Existing stdout/stderr/Docker/Cloud Logging retention and access controls, without widening them. Verify actual Staging retention and INFO availability before implementation; do not assume production WARN shipping retains phase INFO |
| Queries | Operator-selected Staging project/log/window, maximum 24 hours and bounded row/byte count, read-only export of existing approved logs. No database reads or user-content extraction. Query code and scopes are part of the follow-up review; no credentials embedded |
| Analysis | Join in process memory by exact existing allocation/Turn/attempt IDs; reject conflicts, sequence gaps and clock uncertainty. No raw-log files, workspace artifacts, new database rows or new remote destination |
| Output/retention | Aggregate day/version/cohort tables to stdout only, excluding resource IDs and raw events; no new saved operational file or retained raw dataset. If saved aggregates or longer-lived dashboard storage are desired, present that destination/access/retention separately |
| Cadence | Manually invoked report command, initially once per approved experiment/day. No new automation, scheduler or second GitHub pipeline. Scheduling requires separate explicit authorization |

## Outbound and model limits

Provider sends happen through native CLIs. This proposal does not wrap/intercept their payloads,
parse arbitrary shell output, or claim a Server terminal report proves a reply. First receipt stays
unavailable unless the controlled test obtains a redacted provider receipt from an already approved
boundary. Client-rendered latency remains unavailable without client evidence.

Similarly, Server first upstream token and worker-visible first token are different observations.
Tag native pre-input compaction separately and retain confirmed 429 retries/wait in the request
envelope. Do not create a second retry owner or grant from instrumentation. Detailed tool spans
that would require new protocol or credential handling are deferred; report them as coverage gaps.

## Verification before enabling

Review exact insertion sites and field allowlists against the selected main head; source may drift.
Test bounded event/byte counts, redaction, missing/duplicate/out-of-order spans, logging throw/EPIPE,
process loss, cross-allocation isolation and unchanged cancellation/unknown-outcome behavior.
Run focused tests and owning-package type checks; use coverage when covered Agent Runtime paths
change. Preserve the existing reliability, restore and feedback owners' interfaces and candidates.

After approval and implementation, enable only in the named Staging environment with a separate
live-run plan specifying synthetic input, model request/spend cap, IM destination, sample count,
CPU/memory settings and cleanup. Export and inspect an initial small sample before broad collection.
Permission to review or merge that code does not itself authorize deployment or real executions.

The first increment observes existing Server preparation/allocation calls and Runner occupation /
report boundaries without changing their implementations. It reuses existing Pi ends. In-process
quota bookkeeping retains at most 1,024 identities and suppresses repeat observations; it never
evicts an identity to reopen a log budget. No application data cache is introduced. The reader is
stdin-only (16 MiB / 10,000 rows, positive window at most 24 hours), with no automated query or
raw-file storage. Ingress, individual model/tool/MCP/IM timing and timeout classification remain
unavailable rather than being fabricated from the partial evidence.
