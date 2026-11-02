# Execution adapter startup: controlled local comparison

Date: 2026-11-02. Source baseline: `e4f7cb1d0ca038c13368c7be90f4e7058105a329`.

The production change replaces per-execution RSA-2048 key generation with ECDSA P-256 in
`generateExecutionCa`. The fresh certificate remains on the parent execution-open path before
native worker admission. File paths, SANs, validity, private-key permissions, authorization,
per-execution identity and trust checks retain their existing boundaries. There is no certificate
cache or additional service. The shared adapter also serves Local callers, so native CLI and
credential regressions are included.

The controlled Linux component comparison passes its declared local targets. This is **not native
Cloud acceptance or a measured user-message-to-agent improvement on a deployed Cloud instance**.
The experiment history contains rejected candidates and unresolved mount-based tail measurements;
they remain evidence and are not silently pooled into the primary dataset.

## Endpoint, environment and targets

The primary wall-clock endpoint is real production execution-adapter start → built Runner worker
→ pinned real Pi RPC process → the loopback model receives the exact random marker for this input.
This includes fresh key/certificate generation, adapter listeners, normal transport probes,
worker/stdin setup, same-Session binding/history checks, Pi readiness and prompt preflight. It ends
before fixture response generation. A spawned process or early custody receipt is not the endpoint.
The worker and adapter implementations are production code. A local byte tunnel replaces the
native Sandbox HTTP/2 transport; the credential relay, Server ingress/queue, allocation, native
namespace probes, GCS and real IM are outside the measured chain.

Both variants use Node 24.21.0, Pi 0.84.2, OpenSSL 3.0.22, Linux/arm64, a one-CPU quota and
1 GiB limit, and `--network none`. The exact fixture image/module hashes are in the result files.
The real Runner target is Linux/amd64 with its pinned image toolchain, so these timings cannot
be projected onto Cloud cold starts. Client/SDK files are copied into the container's Linux
filesystem before timing rather than loaded through Docker Desktop host-file sharing.
There are no Context Trees, MCP/web grants, paid model calls, real credentials or external messages.
The fixture uses the packaged Context Tree skills; image-only tool skills are outside this fixture.

The targets were recorded before the adapter/worker comparison and were not relaxed:

- Adapter p50: at least 75 ms and 60% lower.
- Adapter-to-exact-input p50: at least 75 ms and 7% lower in each primary scenario.
- Each scenario's p95: at most baseline × 1.05 + 20 ms.
- Every expected-success input completes once with its current marker; previous same-Session
  input remains in history. Permanent rejection and absolute-deadline classification remain exact.
- One CPU / 1 GiB, median container CPU no more than 5% higher, whole-run memory below 1 GiB.

Samples alternate which variant runs first. All attempts, first processes and injected failures
are retained. Quantiles use nearest rank. There are no trimmed outliers or p99 claims.

## Primary results

All times are milliseconds; 100 samples per variant and scenario.

| Local scenario | Before / after samples | p50 before → after | p50 saved | p95 before → after |
| --- | --- | --- | --- | --- |
| Fresh Session | 100 / 100 | 790.0 → 672.2 | 117.8 (14.9%) | 1073.1 → 734.0 |
| Consecutive same-Session input | 100 / 100 | 801.6 → 679.9 | 121.8 (15.2%) | 997.3 → 772.9 |
| Reinstalled local history files | 100 / 100 | 794.1 → 687.5 | 106.6 (13.4%) | 934.6 → 759.2 |
| Scheduled visible Channel input | 100 / 100 | 805.7 → 677.6 | 128.1 (15.9%) | 1018.9 → 728.9 |

The adapter-ready p50 falls from 121.9–132.9 ms to 4.7–4.9 ms across these scenarios. Median
container CPU for the whole deterministic task falls by about 13–15%; these counters include the
fixture and are not a Cloud billing result. The whole-run memory peaks are 927.4 MiB and
926.1 MiB, including fixture copying/page cache; neither is a per-version process RSS comparison.
No recorded memory limit or OOM event occurred. Cloud resource configuration is not changed.

[The main dataset](results-linux-staged.json) retains 804 attempts: 800 successful and four
intentionally failed inputs. Its 200 internal-target scheduled rows are exploratory and are not
used for the scheduled workload above. The corrected
[visible scheduled dataset](results-visible-schedule.json) retains another 204 attempts: 200
successful and four intentionally failed inputs. In both files, each variant's permanent HTTP 400
is `provider_request_rejected` and the stalled model is `turn_timeout`, with one model request
per input. Both entire datasets are retained, including those failures.

The independent [concurrent adapter dataset](results-adapter-concurrent.json) has 60 TLS challenges
per variant across pairs of simultaneous fresh adapters. Both variants complete every challenge.
Its p50/p95 are 222.5/433.4 ms before and 8.0/45.7 ms after. This proves this component under a
shared CPU budget; it does not establish concurrent physical Cloud Session acceptance.

## Iterations and failures retained

[Experiment summaries](results-experiments.json) retain every scenario's counts and distributions.
Complete raw records, build identities and the rejected source patch remain in the task-owned
local evidence directory; no machine operational log or credential is committed here.

1. Eager Runner command imports were measured and split lazily. Two 364-attempt rounds failed
   the initial p50/p95 targets, including restored-file regressions. All those source changes were
   reverted; command loading is not part of this change.
2. Real parent certificate generation measured 124.0 ms p50 / 330.6 ms p95 over 30 Linux samples,
   providing a specific CPU bottleneck for the small algorithm change.
3. A 244-attempt adapter/worker run through host-mounted dependency files improved p50 but failed
   fresh/scheduled p95 limits. The slow tails appear primarily in Pi `get_state`; the cause of
   the mounted-run tail variance has not been conclusively isolated. No samples were removed.
4. The measurement method was corrected to use identical bytes in the container's Linux
   filesystem and expanded to 100 samples per variant/scenario, adding CPU-throttle/memory
   counters and recoverable checkpoints. The same numeric gates pass in that environment.
5. The scheduled fixture was corrected from an internal target to a visible Channel target,
   matching fixed-Chat schedules. A separate 100-per-variant run supplies the table's scheduled
   row; the earlier internal-target data remains labelled exploratory.

The Linux-filesystem result does not erase the mounted-run failure. Native Cloud measurements
are required to resolve performance qualification in the actual target environment.

## Validation and remaining acceptance

- Final CA-only source: 163 tests passed across certificate, proxy data/Git/network scope,
  native Slack, credential-environment and Cloud-worker suites; no skipped native Slack case.
- Real Slack CLI 4.10.0 uses an isolated HOME/config, the execution CA and an authenticated
  loopback fixture. Missing/foreign CA and wrong handles fail; all message-shaped requests stay
  inside the fixture. No real IM user receives a message.
- New certificate checks cover independent keys, expected SANs, CA verification and permissions,
  and real TLS 1.2/1.3 handshakes. Existing foreign-CA/transport readiness regressions pass.
- Client typecheck, Client build, affected CLI build and repository `pnpm check` pass locally.
  Agent Runtime coverage is not required: none of its covered implementation/tests/config changes.
  CI remains a separate, required merge check.
- Four harness-entry regressions pass on Linux: the container guard prevents unguarded writes,
  fixture preparation preserves distinct build provenance and synthetic input, mismatched Pi locks
  cannot publish a complete fixture, and every concurrent rejection remains recorded without
  exposing free-text errors. The relocated adapter/worker/Pi harness also passes its local smoke.

The first CI patch gate reported 4/550 covered lines: the four product lines were covered, while
the three E2E executors had been placed in an unmeasured `testing/` source directory. The executors
now follow the repository's existing `scripts/e2e/` layout; plans and evidence stay here. A local
evaluation against that exact-head CI coverage map gives 4/4 for unchanged product source. The
80% threshold, coverage configuration and performance gates are unchanged; successor CI must
still independently pass.

No deployment, Cloud allocation, production input replay, real IM delivery or paid provider was
used. No-instance cold starts, ready Cloud Instances, real idle reclamation/restoration, Cloud
capacity/isolation, native provider-bridge behavior, actual history recovery from GCS and billed
resource duration remain unverified. The critical-path map and repeatable procedures are in
[the harness guide](README.md). The continuous startup-performance goal remains open.
