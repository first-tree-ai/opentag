# Cloud response-time evaluation

This suite establishes the measurement contract and an executable offline fixture for issue #1108.
An approved, default-off [Staging diagnostic/report lane](LIVE.md) adds bounded observations on
existing log streams. Database, application cache, credential, delivery and workspace persistence
semantics remain unchanged. Read the [observability contract](../../../docs/operations/observability.md)
and [current baseline and gaps](REPORT.md) before interpreting a result.

## Endpoints and clocks

Keep these endpoints separate, with the start and completion evidence from the **same input**:

| Metric | Start | End | Interpretation |
| --- | --- | --- | --- |
| User-perceived useful response | Client send, or intended schedule time | Client renders first useful Agent response | Requires client/provider evidence; not currently measured |
| Ingress to first send receipt | Server receives inbound event | Provider confirms first useful outbound write | Excludes provider ingress transport and client rendering; send receipt is not a read receipt |
| Ingress to terminal | Same ingress | Provider settles and execution cleanup completes | Acknowledged prompt or first token is not terminal |
| Ingress to checkpoint | Same ingress | Latest workspace save is committed | Includes the save boundary; archive upload alone does not prove commit |
| Ingress to report acknowledgement | Same ingress | Runner observes durable Server report acknowledgement | Includes report transport/settlement; may occur after user-visible output |

Progress reactions, custody acknowledgements, and first model token are separate milestones. None
substitutes for useful output. Some successful Turns intentionally send no IM message: mark that
endpoint **not applicable** and retain the Turn in the cohort, rather than inventing a zero or dropping it.
The offline fixture always expects one exact-marker receipt.

Use one monotonic clock within a process. Across processes retain each clock domain, wall-clock UTC,
offset/error bound and correlation identity. Do not subtract unrelated `performance.now()` values.
Cross-machine latency is unavailable without an acceptable clock-error bound or a shared observer.
The fixture timestamps all spans and milestones in its parent process, starting after corpus setup.

## Stage map and current evidence

Source audit: main `df7e28969e2d2776dbb7f7e76d7c4598d806d125`. Paths below are repository-relative.
Stages are attribution boundaries, not a promise that the real path is serial or fully instrumented.

| Stage | Owning source and measurement boundary | Existing evidence / gap |
| --- | --- | --- |
| Ingress and queue | `packages/server/src/runtime/im-delivery-worker.ts`: inbound persistence, queued time, committed claim, lane admission | `queue_age_ms` is `max(0, now - claimed.queuedAt)` at claim, not event-received-to-worker-ready. Its callback defaults to a no-op. Preserve separate retry/attempt and Session-lane wait |
| Runtime assembly | `packages/server/src/runtime/im-delivery-cloud.ts`: runtime snapshot/model resolution; `packages/client/src/runner/cloud-turn-worker.ts`: execution setup | Frozen runtime may be reused on redispatch. Context Tree preparation actually occurs inside the worker, not entirely in Server assembly |
| Context Tree | `packages/client/src/runner/cloud-context-tree.ts`: refresh, bounded offline recovery, status resolution | Included in `worker_preparation`; no independent per-tree latency stream. Include refresh timeout and fallback in the envelope; do not count parallel trees twice |
| Sandbox allocation/readiness | `packages/server/src/services/sandboxes/sandbox-runner-service.ts`, `packages/client/src/runner/serve.ts`, `native-sandbox.ts` | Provider allocation, native probes, authentication and post-restore readiness are different boundaries; no unified latency dataset |
| Workspace restoration | `packages/client/src/runner/cloud-workspace.ts`, `serve-workspace.ts`: claim, download, validate/install, initial save, relaunch/probe | `initialize()` commits an initial save even after restoring a saved object. Download/decompression alone undercounts readiness |
| Pi and MCP startup | `packages/client/src/providers/pi/agent-runtime.ts`, `rpc-wire.ts`, `packages/client/src/pi-extensions/mcp-gateway.ts` | Pi phase diagnostics cover spawn, get_state, session_restore, prompt_acceptance. `worker_preparation` and child Pi spans overlap. MCP readiness needs separate evidence; a spawned Pi is not ready |
| Model and tools | `packages/server/src/api/cloud-model-proxy.ts`, `packages/client/src/providers/pi/agent-runtime.ts` | Request admission, upstream first token, worker-observed token, compaction and repeated tool/MCP calls need distinct spans. `await_terminal` does not isolate TTFT or tool RTT |
| IM outbound | Direct provider CLI from the Sandbox, described in `docs/system/messaging/direct-provider-cli.md` | Provider receipt is the minimum send-success proof. Existing Server tracing does not trace outbound CLI writes. No live send in this suite |
| Terminal, checkpoint and report | `packages/client/src/runner/cloud-turns.ts`, `serve-workspace.ts`, `cloud-workspace.ts` | Checkpoint quiesces writers, saves and relaunches before report construction. An immutable report is journaled after the save attempt; failure can change outcome. Server ack is another endpoint |

Canonical phase diagnostics already have bounded/redacted stderr records, version/sequence,
compaction and missing-diagnostic semantics. Reuse them; adding another stream or exporter needs the
separate [telemetry design](TELEMETRY-PROPOSAL.md) to be approved first. The first increment has
human approval and is described in [LIVE.md](LIVE.md); the table above audits its original main
baseline, not deployed behavior. Server INFO logs are not
shipped by the production WARN-and-above pipeline, so querying Cloud Logging alone cannot recover
the whole path.

## One-command offline run

The fixture logic needs only Node built-ins and a writable OS temporary directory. A host `run`
also requires Git and an intact checkout for source identity; the staged-container form instead
requires the explicit full revision and dirty-source metadata below.

```sh
node scripts/e2e/cloud-latency/benchmark.mjs run 100 > /tmp/cloud-latency-results.json
node scripts/e2e/cloud-latency/benchmark.mjs report /tmp/cloud-latency-results.json
node scripts/e2e/cloud-latency/benchmark.mjs compare /tmp/before.json /tmp/after.json
node --test scripts/__tests__/cloud-latency.test.mjs
```

Run `run 1` for a smoke, not performance qualification. The CLI rejects zero/invalid counts and
exits nonzero on unexpected fixture outcomes or a comparison regression. JSON goes to stdout;
the shell explicitly chooses the result destination. Setup uses fresh `opentag-latency-fixture-*`
temporary directories; cleanup removes only those owned directories. Nothing reads a real HOME,
workspace, Account, credentials or operational logs. The child receives an empty environment,
opens no network socket and performs no external model or IM operation.

| Fixture scenario | What is exercised | What is modeled or excluded |
| --- | --- | --- |
| `cold-empty` | New allocation directory, new Node subprocess, empty workspace, checkpoint | Directory creation is not Cloud allocation or an image cold start |
| `warm-64k` | Pre-existing allocation/workspace with 64 KiB corpus, fresh subprocess each Turn | No retained real Pi, Session history, admission or warm Cloud Sandbox |
| `restored-4m` | Read/decompress/hash/install a deterministic 4 MiB corpus, then compress/fsync/read-back checkpoint | Single-file gzip, not production tar format/validation, GCS, fencing or native relaunch |
| `mcp-64k` | Restored corpus plus explicit stub MCP tool-list and hash-tool RPC | No real gateway, SDK, extension loading, permissions or remote tools |
| `injected-rejection` / `injected-timeout` | Permanent stub rejection and a 25 ms no-reply deadline, subprocess cleanup | Failure classification check, not a measured provider outage rate |

Every successful sample follows queue timer → JSON assembly → allocation directory → optional
restore → subprocess/get_state/prompt → optional stub MCP → stub first token → hash tool → exact
receipt → process exit → checkpoint → local report assertion. These operations are a fixture
orchestration baseline, **not production implementation benchmarks**. The 2 ms queue delay is an
intentional service demand. Empty/disabled phases are observed no-op spans, not missing traces.
MCP runs after prompt admission in this simplified fixture; real extension loading can overlap
Pi startup. The fixture does not estimate those overlaps or identify a production bottleneck.

Corpus generation/precompression, scenario prepopulation, source staging and temporary-directory
removal are outside the latency boundary. OS caches are not flushed; scenario order rotates each
iteration to reduce ordering bias. First samples are retained. No outlier trimming or automatic
retry occurs. A process kill can lose the unfinished in-memory run: retain shell exit status and
do not interpret an absent/truncated JSON document as zero attempts or a successful run.

## Controlled Linux reproduction

Use an existing local Node image by immutable digest. No image pull or network setup is part of the
timed run. Set `IMAGE` to its verified image ID, `REVISION` to the checkout's full SHA, and `DIRTY`
to `true` when source differs from that SHA. `workloadSha256` independently hashes all four harness
modules, including untracked changes. The baseline records these exact values in raw metadata.

```sh
docker run --rm --network none --cpus=1 --memory=1g --pids-limit=64 \
  --env OPENTAG_LATENCY_FIXTURE_IMAGE="$IMAGE" \
  --env OPENTAG_LATENCY_FIXTURE_REVISION="$REVISION" \
  --env OPENTAG_LATENCY_FIXTURE_SOURCE_DIRTY="$DIRTY" \
  --mount type=bind,source="$PWD/scripts/e2e/cloud-latency",target=/source,readonly \
  --entrypoint node "$IMAGE" --input-type=module -e \
  'import { cpSync } from "node:fs"; cpSync("/source", "/fixture", {recursive:true}); const {main} = await import("/fixture/benchmark.mjs"); await main(["run", "100"]);' \
  > /tmp/cloud-latency-results.json
```

Harness bytes are staged onto the container filesystem before measurement. Temporary workspaces
also use that filesystem. CPU/memory quotas are observed through cgroup v2; null means unavailable,
not unconstrained proof. The container may have a separate swap allowance; `--memory=1g` limits
resident cgroup memory, not total memory plus swap. No competitor CPU/I/O pressure is imposed by
this first baseline. Linux/arm64 Docker Desktop results cannot establish native Cloud/amd64 behavior.

Parent CPU is the process CPU delta during the attempt, including failure cleanup but excluding
corpus setup and temporary-directory removal. Worker CPU is observed at orderly shutdown; it is
missing after a forced kill. Logical I/O bytes include explicit corpus/archive/receipt payloads,
not filesystem metadata, cache misses or physical-device traffic. Raw cgroup `cpu.stat`, `io.stat`,
`memory.events` and `memory.peak` bracket the whole run including setup/cleanup. CPU throttling and
I/O deltas are container-wide; `memory.peak` is cumulative and not a delta. Parent `maxRSS` excludes
child RSS. These counters are profiles, not production billing or per-stage memory allocation.

## Statistics and regression protocol

- Cohort by exact Server/Runner/image/source, environment, trigger, allocation state, workspace
  bytes/file count/compressibility, Context Tree/MCP configuration, model and resource limits.
  Keep no-instance, ready allocation, idle-reclaimed recovery, consecutive same-Session,
  concurrent Sessions and scheduled Turns separate. This fixture implements only its four local
  workload definitions above; it does not certify the full Cloud matrix.
- Retain all attempted/success/failed/timeout/incomplete counts, failure phase and observed spans.
  Timeout rate is timeout attempts / all attempts. Failure injections stay in separate named
  cohorts and are not pooled into organic failure rates. Missing trace completion is incomplete
  evidence, not automatically timeout. The fixture schema rejects missing planned attempts,
  duplicate iteration identities, nonfinite/reversed values and overlapping calls in one phase.
- Duration quantiles are conditional on successful attempts, with nearest rank `ceil(q*n)`. P50
  requires one success, P90/P95 require 100, P99 requires 1,000; smaller cohorts show unavailable.
  These are reporting floors, not statistical confidence guarantees. Do not pool daily P95s,
  average percentiles, sum phase P95s, or mix incomplete/failing duration into successful latency.
- Repeated calls are aggregated per phase per successful attempt. Missing stages report their
  missing count, not zero. Cross-phase nesting/parallelism must be treated as envelopes; endpoint
  latency is computed directly from milestones. Actual critical-path analysis needs a causal graph.
- `compare` requires identical workload hash, protocol, Node/platform/architecture, image, quota,
  scenario set, attempted sample count and execution-order policy. It rejects increased failure,
  timeout or incomplete counts, reduced success/coverage, insufficient P95 evidence, or any endpoint
  P50/P95 greater than baseline × 1.05 + 5 ms. This is a predeclared fixture regression guard,
  not a Cloud SLO, an optimization target or evidence of statistically significant improvement.
  Missing image/resource controls refuse comparison; an unconstrained host smoke is report-only.

The endpoint guard's relative allowance is `5% + 5 ms / baseline quantile`. Its fixed 5 ms term
allows about 19–33% at the small fixture endpoints and less at the larger restore endpoints.
Passing it cannot exclude a 2–3× regression in a sub-millisecond assembly/tool/IM stage: stage
rows are reported but not guarded. Declare a separate stage target before testing such a candidate.
Unexpected injection success fails `run`; when comparing archived data, changed injection outcomes
can instead produce an insufficient-samples message. Inspect the outcome rows as well as the verdict.

For the retained baseline's ingress-to-first-receipt P50, rejection requires an increase above:

| Scenario | Baseline P50 (ms) | Allowed increase (ms) | Relative allowance |
| --- | ---: | ---: | ---: |
| cold-empty | 18.73 | 5.94 | 31.7% |
| warm-64k | 18.02 | 5.90 | 32.7% |
| restored-4m | 34.29 | 6.71 | 19.6% |
| mcp-64k | 19.30 | 5.96 | 30.9% |

## Optimization and reporting loop

1. Refresh source/evidence coverage before collecting anything. Reuse a sufficient authoritative
   candidate dataset; retain its exact SHA and endpoint limitations instead of rerunning it.
2. Select a measured bottleneck and declare hypothesis, endpoint, scenario, benefit target,
   regression ceiling, correctness checks, resource budget and stopping rule **before** experiments.
3. Give each candidate one owner and an isolated branch. Change one factor; keep workload/control
   identity fixed. Alternate before/after order in paired experiments. This CLI compares completed
   batches; its rotating scenario order is not paired candidate orchestration.
4. Report stage distributions alongside overall endpoints and resource/failure profiles. Keep all
   failed/rejected experiments. A stage win without a measured overall endpoint win is a component
   result. Accepting a candidate requires its correctness, isolation and reliability tests as well.
5. Review current-head CI without rerunning remote workflows. Merge, rollout and genuine IM/model
   acceptance remain separate explicit gates. Update the versioned baseline only after checking
   the new evidence has the same boundary, workload and acceptance level.

The `report` command is the repeatable offline reporting mechanism; the [Staging reader](LIVE.md)
adds manual bounded stdin aggregation. No scheduler, second pipeline automation, live dashboard
or automatic operational query is installed. A future daily
live report must display day/version/cohort, eligible and sampled population, missing coverage,
failures/timeouts, quantiles, resource configuration, clock uncertainty and comparison verdict.
The first collection increment follows the approved linked design; deployment, real exports and
broader collection still need their own authorization and acceptance.
