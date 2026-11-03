# SQL caller repairs: main integration and PR acceptance

The [remediation ledger](../sql-caller-remediation.md) covers 42 repair batches for
37 original public defects, nine simplifications and three actionable observations.
Its original audit coverage does not certify new SQL sites introduced later on main.
Private billing implementation remains unavailable.

## Source and review

- Integrated main: `e769c66b372d21be1137c7bcd144d26778daaf9e` (18 commits since the
  initial implementation base `8cb997b2abbf7785b871b1a0534e998c4d97c8d7`).
- Reviewed production source: `cb39dcb308c71f13075df4ad9d01ceab585eb192`.
- [Independent whole-branch review](sql-caller-independent-review-05.md): no
  outstanding actionable findings. The reviewer inspected source and acceptance
  logs; did not independently rerun the tests.

Integration retains inbound-receipt admission with nonblocking custody claims,
retained-report feedback creation under the existing Session-first lock order,
Task reply Session fallback within the same read snapshot, clear-only Slack status,
Feishu callback work ownership and new performance instrumentation.

Review caught a shutdown ordering defect in the first integration: feedback close
snapshotted jobs while admitted requests could still create new jobs. The final
composition joins producers and actual HTTP work first, then feedback workspace
jobs, then shared resources. No persistence contract or schema changed.

## Current validation

The real base later advanced to `01c26ad17575b67525bae3bedc857adc4466600d`: one
Web test-only commit adding four assertions. Independent delta review confirms
no production/dependency/Server-test change and a conflict-free merge. It does not
require repeating unchanged Server or Client tests.

- Docker Server unit matrix: **4,989 pass / 15 pre-existing skips**, 267 passing
  files and one pre-existing skipped file. The complete command exits zero (363.34 s).
- Docker native PostgreSQL matrix: all **1,364 cases** have accepted coverage from
  the full 122-file run and the affected three-file rerun. The full command was
  1,360 pass / four failures (442.98 s); the final affected run is **20/20 pass**
  (22.05 s). No case is disabled. The original full command remains nonzero and
  is not described as an all-green command.
- Client Agent Runtime coverage on macOS: **821 pass / 32 files**, all four
  configured coverage dimensions at 100 percent (4,926 statements, 3,686 branches,
  854 functions, 4,381 lines).
- Client Context Tree resource/recovery/session-hint/workspace-wire regression:
  **32 pass / four files**, using the refreshed pinned Context Tree package.
- `pnpm check`, Server typecheck, and current Server/Client/CLI builds pass.

Earlier batch records remain historical and are not relabeled as current
whole-suite passes. The source/artifact inputs remain unchanged throughout each
accepted run.

## Environment and fault evidence

Host dependencies were refreshed using `pnpm install --frozen-lockfile` after main
changed the manifests and lockfile. A new Linux arm64 Docker test image was built
from the same lockfile, manifests and patches: Node 24.22.1, Vitest 5.0.1,
PostgreSQL 17 and all 74 migrations. Server/Client/CLI/preset artifacts were rebuilt.
Actual Docker resolution confirms postgres 3.4.9, Better Auth/core 1.7.2 and Context
Tree 1.0.2-alpha.202611020650; all three patched core files match the accepted patch
hashes. No old dependency overlay substitutes for the current frozen install.

The new native feedback control blocks an admitted HTTP workspace action on an
actual PostgreSQL feedback-row lock, starts shutdown, then admits its detached
workspace job. The HTTP response finishes while that job remains blocked. The
pool stays open until the actual final result commits; the persisted action is
`succeeded` / `discarded`, then the pool closes. The startup control separately
checks the real composition orders feedback close after producer shutdown.
The two-file control reports 30/30 passing cases; the native shutdown case took
250 ms in the accepted targeted run.

Initial fixture failures were retained and investigated. The startup mock had
inherited a previous test's rejected worker stop; beforeEach now resets it.
The native control's idle HTTP keepalive delayed Fastify's final hooks; its client
now sends `Connection: close`. Production connection policy and SQL timeouts were
not changed to accommodate either test.

Per-run command, log and source/artifact SHA-256 manifests remain in the workspace
report directory `sql-caller-repairs-20261103` (`pr-*.log`, `*.inputs.json` and
`pr-source-environment.json`). This establishes local source and fault acceptance,
not CI, deployment, live-provider behavior or private billing acceptance.


## Native regression fixture updates

The full matrix and the unchanged three-file serial reproduction both reported
four failures. Inspection and external diagnostic fixtures identified:

- The late-root SQL observer also matched main's new single-delivery feedback scope
  query. It now captures the `ranked_thread_messages` selection specifically.
  Both providers retain the independent original-algorithm oracle, exact selected
  ID/order comparison, actual delivery comparison and large-history controls.
- Main now takes the custody advisory fence while accepting a Slack receipt, before
  ACK. The old fixture held that fence before submitting HTTP and therefore tested
  pre-ACK SQL failure instead of acknowledged Inbox overflow. The fixture now gates
  its Inbox entry on a separate real PostgreSQL advisory lock in the same four-slot
  application pool, then delegates to the real Inbox. It retains four signed ACKs,
  two actual SQL waiters, same-pool health, four durable receipts, restart/lease
  recovery to four messages/deliveries and duplicate suppression. Production receipt
  fencing is unchanged; this case does not promise ACK while that fence is blocked.
- The Cloud steer case initially exceeded its five-second test timeout. Stage
  diagnostics exercised the actual placement-lock wait and existing operation
  deadline successfully without a send, preserving pending dispatch correlation.
  The final case explicitly verifies the accepted root and turn ID before preparing
  the next attempt and passes in the complete affected rerun. Its original timeout
  is retained as a test-interleaving limitation; the added assertion alone does not
  establish a complete causal diagnosis of that timeout. Neither its injected
  400-ms operation budget nor production budgets were raised.

Only the integration fixtures changed after the reviewed production source. The
unchanged successful unit and native cases were not repeated merely to obtain a
new whole-suite zero exit. CI must still validate the actual PR head/base/attempt.


A later base check reached `e91b6557a6ce1375dc3de3f73a715f358804cab7`: four further commits affect Web code,
Web tests, e2e and documentation only. There is no Server/Client, package, lockfile
or SQL change. A fresh `git merge-tree` succeeds without conflicts; these changes
do not require repeating unchanged Server/Client checks.

The final Cloud steer fixture also races custody-entry against the current worker
pass ending. An unexpectedly earlier pass end now reports the actual root/pending
state and diagnostic instead of blindly waiting five seconds. Diagnostic SQL runs
only on that abnormal path. The unchanged 400-ms fault budget, actual placement
lock, no-send check and retained correlation assertions remain. All nine cases in
the updated file pass in `pr-steer-final-docker.log` (13.67 s). This improves failure
evidence; it does not claim to establish the earlier timeout's complete cause.
