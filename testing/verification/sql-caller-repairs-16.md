# SQL caller repairs: remove demonstrated redundancy

Closes AG-S3/AG-S4/AG-S5/AG-S6/DW-S1 without a schema or policy change.

- Settings reads the existing exact Agent/connection/authorization credential
  directly, retaining pre/post cancellation checks and failure mapping. The
  settings-only UUID/lease dependency is removed; Runtime lease users remain.
- Local scope skips the unused Sandbox read; Cloud retains allocation lookup/fences.
- One owner resolver returns Account and self-config opt-in. Self enforces opt-in;
  Schedule only uses ownership. Neither caches nor a new transaction are added.
- Atomic MCP create removes its second Agent check while the first eligible-Agent
  lock is held. Remaining helper callers all lock, so its unused unlocked mode is
  removed. Initial preflight and locked owner/opt-in check remain.
- Durable updates delete the unreachable payload-growth quota call/helper. Immutable
  payload, timestamp/state fences and insert/replacement quotas remain.

**225 distinct cases pass: 131 unit and 94 native PostgreSQL in Docker.** Two new
unit cases cover missing direct credentials and cancellation during a late read;
existing real MCP-root tests still refresh between Git calls. Native cases verify
Local/Cloud scope SELECT counts of 1/2, one combined owner read, MCP create's three
SELECTs and Schedule access with self-config disabled. Independent actual transfer
and opt-out writers block behind create's authority locks, commit afterward, then
prevent the old-authority create. The previous trigger that changed Agent ownership
inside create's own transaction is replaced with a barrier-only trigger and real
independent writers. Atomic mount rollback and committed-first withdrawal remain.

Initial fixtures exposed stale removed credential fields, a narrowed SQL-client
annotation, and transfer's required suspended state. Corrected cases pass selectively;
all logs remain. No successful test was repeated. Existing durable idempotency,
transition, insertion/replacement quota and Runtime credential/fence scopes pass.
Server typecheck/build and repository gates pass with unchanged baselines.

Evidence: `.codex/reports/sql-caller-repairs-20261103/batch-16-*`. Independent
review has found no actionable issue through batch 15 (source review, no separate
Docker rerun); this batch is reviewed separately. Full Server drain, live GitHub,
CI, merge, deployment and unavailable private billing remain outside this acceptance.
