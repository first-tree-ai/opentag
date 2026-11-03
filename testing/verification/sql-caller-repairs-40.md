# SQL caller repairs: late-root selection without unrelated payloads

Implements the measured IM-R2 follow-up under the confirmed minimum proposal in
[the remediation ledger](../sql-caller-remediation.md), following the
[read/write standards](../../docs/system/database-read-write-standards.md).

## Evidence and minimum change

A native PostgreSQL 17 fixture stores 0, 2,000, 10,000 and 50,000 unrelated inbound
Thread messages after a direct root's occurrence time. Every message contains a
1 KiB fallback plus a 1 KiB text block. The old actual Inbox ingestion selects all
full rows before JavaScript root selection and global external-message revision
deduplication, even though none can be backfilled.

| Unrelated rows | Before returned JSON bytes | Before read / same-pool control ms | After returned rows / bytes | After read / control ms |
| --- | ---: | ---: | ---: | ---: |
| 0 | 0 | 0.54 / 3.05 | 0 / 0 | 0.94 / 2.45 |
| 2,000 | 5,366,679 | 12.30 / 28.18 | 0 / 0 | 2.08 / 2.92 |
| 10,000 | 26,846,682 | 66.50 / 146.45 | 0 / 0 | 14.40 / 29.45 |
| 50,000 | 134,366,682 | 349.18 / 614.44 | 0 / 0 | 45.47 / 47.14 |

These are single synthetic samples with the shared client, max-one pool and
existing timeouts, not latency distributions or production outage evidence.
JSON bytes are the serialized returned objects, not PostgreSQL wire bytes.
Instrumentation serialization itself adds about 235 ms in the old 50,000-row
case and is included in ingestion/control timing. The SQL read timing excludes
that serialization. The control is submitted eagerly through the same pool and
waits for transaction release; it is not parallel SQL inside that transaction.
RSS snapshots show about 126 MB growth at old row materialization versus 0.12 MB
afterward; allocator/GC noise prevents interpreting this as a memory limit.

Two windows now operate on a narrow derived selection over the **complete
original scope**: binding, Channel, inbound, non-null Thread key and occurrence
time at or after the arriving root. `row_number` preserves global revision
selection by external message ID. `first_value` orders nonempty provider roots
first, then occurrence/revision/ID descending, preserving missing-root fallback.
Only afterward does SQL filter the arriving root, rank one and nonempty Thread
key, fetch matching full rows by primary key and return the original ascending
tuple order. Existing ended-Thread, repeat, retention and overflow logic remains.
No schema/index, cap, retry, budget, isolation or ownership change is added.

An initially investigated pair of DISTINCT ON/IN subqueries produced a poor plan
without fresh statistics: about two seconds at 2,000 rows and official statement
timeouts at larger sizes. It was rejected before editing production. The chosen
single window selection is tested without manually refreshing statistics; native
EXPLAIN/BUFFERS evidence and both rejected/successful probes are retained locally.

## Validation

**155 distinct Docker cases pass, including 121 native PostgreSQL cases** across
Inbox unit, Cloud overflow, IM binding, root selection and four before/after cost
probes. Slack and Feishu compare the actual ingestion query's ordered IDs against
the independent old JavaScript selection and eight explicit expected IDs, then
verify actual ambient delivery rows. Controls cover cross-Thread revisions,
empty-Thread-key masking, missing/empty roots, changed roots, whitespace,
occurrence/revision/UUID ties, lexical revision order and excluded binding,
Channel, outbound, null-Thread and earlier-time rows. Equivalence is for messages
conforming to the existing ProviderInboundContext schema, not arbitrary corrupt
JSONB. Native cases with zero or 50,000 unrelated rows return all five matching
messages in order, create one Thread Session and leave the shared pool usable.
Existing binding tests cover ended Threads, continuity TTL, repeated input,
revision and queue overflow behavior.

The first matrix passed 153 cases and exposed two new fixture errors before the
product assertions: a cloned current Slack installation violated uniqueness, and
two same-time expected IDs were written in the wrong UUID order. A disabled
historical binding removes the unnecessary extra Agent/installation fixture; the
explicit order is corrected. Only those two cases were rerun and both pass. The
production query and other passing cases were unchanged. Failed logs are retained.

Server typecheck/build pass. Independent source review found no actionable
regression; exact-commit review and repository gates are recorded separately.
Batch 39 exact review at da000b91 found no actionable defect. Final broad Server
Docker regression and covered Client Runtime validation remain a separate gate.
