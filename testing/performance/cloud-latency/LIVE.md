# Opt-in Staging diagnostics and read-only reports

The code implements the human-approved first collection increment. It has not been deployed or
accepted against live Staging. Real tasks, paid models and IM sends still need separate authorization.
The [offline baseline](BASELINE.md) predates this increment and does not measure logging overhead.

## Selection and bounds

Each emitting process requires `OPENTAG_ENV=staging`,
`OPENTAG_CLOUD_LATENCY_DIAGNOSTICS=true`, and `OPENTAG_CLOUD_LATENCY_SESSION_IDS` containing
one to sixteen comma-separated Session UUIDs. Invalid/absent selection or any other environment emits
no added records. `OPENTAG_REVISION` accepts only a full lowercase 40-character Git SHA, otherwise
`unknown`. Arbitrary environment text is never emitted. These settings are not forwarded through
credentials, protocol frames or into the native worker. Configure Server and selected Runner
processes only under separate deployment authorization.

Server uses existing Pino stdout (`module=im-delivery`), Runner the existing protected stderr writer
(`module=cloud-latency`); both use `operation=cloud.latency`, `version=1`. Service identities stay
`opentag-server` / `opentag-runner`. The reader normalizes the Server's owning-module wrapper.

Each observer retains at most 1,024 input/allocation identities for in-process quota bookkeeping,
then refuses further observation without affecting work admission. It never evicts identities to
reopen a log budget. Server measures only the first encountered attempt per delivery; retries are
unobserved. Runner measures the first preparation per allocation and one stream per Turn. This
ephemeral bookkeeping adds no application cache or persistence.

A stream has at most 32 records / 64 KiB, a reserved summary and a 4 KiB record bound. Caps,
unmatched phases and observed loss mark `diagnosticIncomplete`. Process/output loss can prevent
the summary; absence is incomplete evidence. Logging exceptions preserve original results/errors,
never add retry or flush waits. Cancelled and unknown outcomes remain distinct from failure.

## Implemented boundaries

| Observation | Actual boundary and qualification |
| --- | --- |
| Server `runtime_assembly` | Cloud IM dispatch preparation: frozen-input validation, reply role, runtime/model resolution; may reuse a snapshot; phase completion is not work admission |
| Server `allocation_wait` | Existing Sandbox ensure and bounded convergence call; not proof of authenticated Runner/workspace readiness |
| Runner `workspace_ready` | Existing prepare call, including quiescence, restoration, initial save and native relaunch; first preparation only; the ready fast path may be a no-op |
| Runner `worker_execution` | Existing parent's worker-start diagnostic to parent's native-exec summary; child `worker_end` is a different boundary; overlaps worker/Pi phases |
| Runner `checkpoint` | Existing occupation callback, including quiescence, save/rollback policy and native relaunch; original semantics/errors remain authoritative |
| Runner `report_ack` | First successful local report send to processed matching acknowledgement; retransmits do not reset time; current Turn/hash or message and allocation must match |
| Existing Pi phases | Unchanged `pi.diagnostic` phase-end `durationMs`, reused without another worker stream or model request |

Queue metrics keep their existing callback/logger path. Context Tree work remains within
`worker_preparation`. Separate MCP startup, model TTFT/tool RTT, outbound provider receipts and
timeout classification remain coverage gaps. No performance gain is claimed from instrumentation.

## Bounded manual report

Prepare shared exports, then pipe an authorized, ascending Staging JSON/NDJSON export to:

```sh
pnpm --filter @opentag/server exec tsx scripts/cloud-latency-report.ts \
  "$LATENCY_FROM_UTC" "$LATENCY_TO_UTC" "$LATENCY_EXPECTED_TURNS" cold "$LATENCY_SESSION_ID"
```

The positive UTC window is at most 24 hours. Expected population means intended fixture Turns,
not returned log rows. Use one controlled cohort per invocation: `cold`, `warm`, `restored`, `mcp`,
`scheduled`, `concurrent` or exploratory `mixed`. Keep image/revision, workload and CPU/memory
controls in the approved experiment plan; this reader cannot verify them and issues no live
regression verdict. Input/project/access selection remains the operator's responsibility.

Input is capped at 16 MiB / 10,000 rows. It accepts export arrays, NDJSON, direct records,
Cloud Logging `jsonPayload` and Docker `log` wrappers. Pi records require an export timestamp.
The program has no network client, credentials, database connection, raw-file reader or writer.
It aggregates in memory and writes only anonymous cohort aggregates to stdout. Resource IDs,
messages, errors and payloads are not copied into the report. Oversized/invalid input exits nonzero
with a fixed message without echoing source text or arguments.

Reports retain declared/observed/completed/failed/cancelled/unknown/missing/incomplete counts and
malformed input, duplicate Pi records, sequence/clock gaps, missing starts/summaries, allocation
conflicts and outcome conflicts. Missing phases are absent, not zero. Process clocks are never
joined. Phase totals include completed phases in failed Turns; they are component measurements,
not successful-Turn end-to-end quantiles. Pi ends remain standalone component evidence.

Nearest-rank P50/P90/P95/P99 use 1/100/100/1,000 measurement floors. `worker_observation_to_ack`
requires a complete successful same-clock parent observation with worker execution and matching
report ack; report-only recovery cannot invent it. User/ingress end-to-end latency and timeout
rate stay explicitly unavailable without the missing evidence. No scheduler, dashboard storage,
exporter or retention change is installed. Invoke manually for an approved experiment/day.
