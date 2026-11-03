# SQL caller repairs: broad regression and remaining lifecycle policy

Supports the [remediation ledger](../sql-caller-remediation.md) and the
[database read/write standards](../../docs/system/database-read-write-standards.md).
The branch fixes the 37 original public defects and nine simplifications, plus
AA-R1 and IM-R2. The corrected original inventory contains **52 IDs: 37 F, nine S,
six R**. LC-R1 was omitted from the initial ledger; the complete original audit
reports, in addition to the SQL-site CSV, are necessary for this accounting.
LC-R1 is now measured and actionable at the tested scale. Its supplemental
Local-stop budget/residual-work policy is proposed, not implemented or approved.

## Owning regression acceptance

| Scope | Result and boundary |
| --- | --- |
| Server unit matrix | 4,815 cases have passing coverage; 15 original skips remain. The original run was 4,811 pass / four failures / 15 skips across 258 files, with three unhandled errors from missing test ports. All four failures were fixed in their owning fixtures; the six-file, 125-case final rerun passes with no unhandled errors. |
| Native PostgreSQL matrix | All 1,316 cases are covered by the full 119-file matrix plus affected reruns. The original run was 1,305 pass / 11 failures; the four-file, 49-case rerun passes. No native case was waived or disabled. |
| Client Agent Runtime | 818 cases in 32 files pass on the host. Statements 4,914/4,914, branches 3,685/3,685, functions 853/853 and lines 4,369/4,369: all 100 percent under the existing configuration. This is local macOS evidence, not an Ubuntu CI claim. |
| Static/package checks | Server typecheck, current Server and CLI builds pass. Prior frozen install/SDK overlay and targeted Client checks remain applicable. Repository gates are recorded with this batch. |

Acceptance combines the full matrices and successful owning reruns. **The original
full commands exited nonzero and are not recorded as green commands.** Unchanged
passing cases were not rerun merely to obtain a new whole-suite exit code.

The broad runner uses verified Linux arm64 Node 24.22.1, PostgreSQL 17 containers
and all 73 migrations. It mounts the exact pinned Better Auth patch from batch 38.
The first unit runner's 832 src files matched the current host byte-for-byte, but
scripts were image baseline. This exception was detected and recorded: the fresh
scripts area was subsequently copied, its unit tests rerun, and both real operator
fault tests included in the full native matrix. CLI process tests initially lacked
the built CLI; the current CLI was built and mounted for their complete rerun.
Per-run commands, logs and source/artifact hashes remain in the workspace report.

## Fixture corrections and test discovery

Only test behavior and collection commands change in this batch:

- The disconnected RuntimeTest mock used to remain pending forever. It now uses
  the existing deferred helper, proves app.close waits after the listener closes,
  resolves the real mock Promise and awaits cleanup. Cancel and no-write assertions
  remain. The actual RuntimeTest owner already has cancellation settlement controls.
- Two echo transport fixtures implement the newly required asynchronous close port;
  neither has actual broker/stream work. No production cleanup is made optional.
- The approval registration case expected locks to remain held through an async
  socket callback. It now verifies the confirmed contract: synchronous enqueue,
  registration and stale state before callback release, then original delivery
  settlement and refusal to send a stale approval again.
- A stopped Feishu owner is rejected by its earlier activation fence, so that
  internal error expectation is corrected. Stored receipt/message counts and the
  adjacent direct inbound-receipt fence control remain.
- The unchanged public-table no-write case exceeded the default five seconds under
  the full parallel synthetic workload; it passes unchanged in 268 ms serially,
  including both public-table snapshots and actual HTTP requests. No timeout was
  raised, assertion removed or product behavior changed for it.

Unit collection now excludes all integration directories. Native collection
explicitly includes both src and scripts integration directories. Moving the
operator tests into src was rejected because composite TypeScript rootDir=src
cannot import those script entry modules. The tests stay at their original path;
no compiler-root expansion or extra production abstraction is introduced.

## LC-R1 actual scale evidence

Seven native scenarios drive actual suspendById, target selection, proof reads,
locked authority, RuntimeDomainOwner and proof revocation. Frames/results are a
controlled in-process Runtime port; this is not live provider/process throughput.

| Targets / pool / Runtime | Preparation peak | Confirmed stopped / capacity / timeout | Elapsed ms | Same-pool control ms | Remaining proofs |
| --- | ---: | --- | ---: | ---: | ---: |
| 64 / 1 / immediate result | 64 | 64 / 0 / 0 | 187 | 28 | 0 |
| 1,024 / 1 / immediate result | 1,024 | 1,024 / 0 / 0 | 2,089 | 138 | 0 |
| 4,096 / 1 / immediate result | 4,096 | 1,024 / 3,072 / 0 | 10,455 | 570 | 3,072 |
| 4,096 / 20 / immediate result | 4,096 | 1,041 / 3,055 / 0 | 3,420 | 125 | 3,055 |
| 64 / 1 / no result | 64 | 0 / 0 / 64 | 30,138 | 8 | 64 |
| 4,096 / 1 / no result | 4,096 | 0 / 3,072 / 1,024 | 37,524 | 4,870 | 4,096 |
| 4,096 / 20 / existing domain full | 4,096 | 0 / 4,096 / 0 | 4,334 | 217 | 4,096 |

Every scenario preserves the committed suspended Agent state, has no idle
transaction after settlement and leaves SQL usable. Independent-connection
controls remain healthy (about 4–16 ms in the accepted samples). Even with a full
domain, all 4,096 preparations and about 24,585 SQL statements are issued before
capacity rejects every stop. Timely results also leave thousands unconfirmed.
There is no measured global outage; the unnecessary work/partial-stop failure and
unbounded admission are real. RSS samples are noisy, not memory-limit/OOM proof.

The first four result probes seeded proof timestamps with database defaults,
which did not match official mint's JavaScript millisecond clock. Their cleanup
counts are not accepted. They were rerun with matching timestamps and an explicit
remaining-proof count equal to targets minus confirmed stops; all four pass. The
three no-result/full-domain cases never enter proof revocation and remain valid.
Raw preliminary and corrected logs/fixtures are retained without overwriting.

CR-R1 remains a measured batch cost; IM-R1 preserves whole-group terminal/requeue
atomicity; TK-R1 preserves an external complete-array API (Web already uses paged
sections). None warrants an unconfirmed contract rewrite. Private billing source
is unavailable. CI, merge, deployment and live business acceptance are outside
these local results. The complete remediation remains open for LC-R1 policy.
