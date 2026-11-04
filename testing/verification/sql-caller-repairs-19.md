# SQL caller repairs: bounded metadata and Thread root reads

Batch 8a closes IM-F7/BG-F4. Thread root resolution preserves its current-context
fast path, binding/Channel/Thread/inbound scope and occurredAt/revision/ID order.
The existing transaction projects the provider-specific nonempty root and LIMIT 1,
replacing the full context array/search. No schema/index/cache or new SQL timer.

Channel reuses the existing 256-KiB streamed JSON reader and 10-second request
signal, cancels non-OK bodies and keeps last-good-target behavior. The published
[staging pointer](https://dl.opentag.build/releases/staging/latest.json) was 1,868
bytes when read on 2026-11-03; its frozen body remains in workspace evidence.
S3 LIST replaces the late 4-Mi-character parser check with a streamed 4-MiB byte
bound before UTF-8 decoding. Overflow cancels the reader with typed invalid_response;
read locks are released, existing request deadlines remain and no retry is added.
The now-redundant late character check is deleted; empty LIST behavior is retained.

**59 distinct cases pass (6 native PostgreSQL), 114 passing executions.** Docker
covers all 53 owning unit/loopback cases and all six new native Inbox cases. Seven
new streamed-body cases cover no Content-Length, ASCII/multibyte overflow,
non-OK cancellation, split UTF-8, empty LIST and subsequent normal recovery.
The actual Inbox ingests Slack/Feishu messages with 1,000 missing/empty historical
contexts plus tied root candidates. Captured actual SQL is rerun with native
EXPLAIN ANALYZE: one root row is materialized, or zero when absent. Real inherited
Thread delivery verifies time/revision/ID order and scope predicates.

Initial unit/native fixture types used the wrong target property and omitted
required tenant/operation fields. Three corrected Channel cases pass selectively.
Native negative cases initially used the Agent's all_message default, which
materializes unaddressed Threads independently of root continuity. Explicit
mention_only now tests the intended dependency; all six native cases were rerun
and pass. Initial failure logs remain. Typecheck and repository gates pass with
unchanged baselines. No historical index-work bound, OOM, full Server outage or
online storage acceptance is inferred from these scoped checks.

Evidence: `.codex/reports/sql-caller-repairs-20261103/batch-19-*`. Independent
review follows the exact commit. Final Server drain, CI, merge, deployment and
private billing remain outside this batch's acceptance.
