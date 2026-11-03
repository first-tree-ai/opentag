# Cloud evaluation baseline and evidence coverage

Date: 2026-11-03 (Asia/Taipei). Source baseline:
`df7e28969e2d2776dbb7f7e76d7c4598d806d125`.

This is the initial evaluation-framework and opt-in diagnostics milestone for
[#1108](https://github.com/first-tree-ai/opentag/issues/1108), not completion of the issue's live
telemetry, repeated optimization or user-facing latency acceptance criteria.

## Evidence levels

| Evidence | Current result | Permitted conclusion |
| --- | --- | --- |
| Source audit | [Stage map](README.md#stage-map-and-current-evidence) ties each stage to main source and existing diagnostics | Establishes measurement boundaries and missing observations, not live timings |
| Offline fixture | [Raw attempts](results-linux-arm64.json), [generated report](BASELINE.md) | Reproducible local orchestration, statistics, resource metadata and failure accounting |
| Opt-in Staging diagnostics/report code | [Implemented boundaries and manual reader](LIVE.md); local synthetic unit/loopback tests | Bounded observation and analysis implementation, not deployed log arrival or a live baseline |
| Real startup component | [Independent owner report at exact PR head](https://github.com/first-tree-ai/opentag/blob/46427ab1455630b2937d04ad00cc3f2da8ccd7c1/testing/performance/cloud-startup/REPORT.md) | Adapter/worker/locked-Pi to exact-input result under that report's control conditions |
| Real ingress/allocation/restore/outbound/checkpoint | No qualifying joined dataset collected here | No measured Cloud end-to-end baseline or deployment claim |

## Reused candidate evidence

[PR #1112](https://github.com/first-tree-ai/opentag/pull/1112), exact inspected head
`46427ab1455630b2937d04ad00cc3f2da8ccd7c1`, remains the startup owner's work. Its report records
Linux/arm64, 1 CPU / 1 GiB, 100 samples per variant/scenario and nearest-rank P50/P95.
Adapter-to-exact-input P50 improves 13–16%, and P95 improves 19–32% across its primary scenarios;
1,000 successful and eight injected-failure attempts are retained across the full experiment set.
Earlier explorations and unresolved host-mount tail behavior are kept separate in that report.

These are referenced results, not independently rerun or revalidated by this suite. They exclude
real ingress/queue, allocation, credential relay, native Sandbox transport, GCS, real IM and billing.
Do not append synthetic downstream durations, sum percentiles or multiply the stage percentage to
claim a Cloud end-to-end improvement. Do not mix its exact-input endpoint with this fixture's
receipt or report endpoints. Its implementation, deployment and Staging acceptance stay with its
existing owner. No other owner's recovery, messaging reliability or feedback candidate is changed.

## Offline baseline interpretation

The raw file retains 402 attempts: 100 per expected-success scenario, one explicit permanent
rejection and one explicit timeout. All four success cohorts pass exact-marker RPC, tool hash,
workspace restoration where applicable, child exit and checkpoint read-back checks. The generated
report gives the actual measured values, phase distributions and counters without transcription.
P99 is withheld because no cohort has 1,000 successful samples. This fixture baseline predates
the diagnostic implementation and does not measure opt-in overhead or production-code performance.

The image identity, Node/architecture, cgroup limits, kernel, module hash, first/last UTC time and
source metadata are in the raw file. `trackedDirty=true` records that the new harness had not yet
been committed on top of the baseline SHA. All measured subprocess and workspace bytes run on the
container filesystem under `--network none`, one CPU, 1 GiB resident-memory limit and PID limit 64.
This is an idle synthetic workload without imposed competitor pressure. Node subprocess overhead,
page cache, Docker Desktop storage and deliberately scripted work dominate some rows; they do not
identify a production bottleneck. No production optimization is proposed from those rankings.

The documented comparator passes the retained dataset against itself as a serialization/control
check only. Unit regressions inject slower endpoints, missing stages, failure increases, insufficient
samples and environment/workload mismatches. Neither check constitutes an A/B optimization result.

## Remaining acceptance

- The concrete [telemetry collection/report design](TELEMETRY-PROPOSAL.md) received human approval
  on 2026-11-03 and its first increment is implemented. Further collection, new destinations,
  persistence or retention changes remain outside that approval.
- A designated Staging Account/Session and explicit authorization for its exact Server/Runner/image,
  allocation, model spend, synthetic IM destination, task inputs and cleanup. No live-run,
  deployment, real-message or replay authorization exists for this suite.
- Joined clock-qualified measurements across ingress, claim/lane wait, runtime/Context Tree,
  allocation/restore, Pi/MCP, model/tool, outbound receipt, checkpoint commit and durable report ack.
- Native Cloud/amd64 cold and ready allocations, idle reclamation, consecutive/concurrent Sessions,
  schedules, resource pressure and larger/many-file workspaces, with organic failure/coverage rates.
- Repeated candidate experiments, independent review, merge/deploy decisions and actual acceptance.
  There is no new always-on report, dashboard or automation in this change. The Staging reader
  accepts only a separately authorized export on stdin and does not query an environment itself.

This milestone provides reviewable component evidence and measurement tools. It does not meet
joined Cloud measurement, repeated optimization or rollout acceptance criteria.
