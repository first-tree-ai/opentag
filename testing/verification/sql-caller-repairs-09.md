# SQL caller repairs: Provider preparation budget

2026-11-03, remaining AG-F2 scope in the [tracker](../sql-caller-remediation.md).
The existing five-minute preparation budget starts before eligibility/requirement
SQL and also settles the admitted wait on deadline/close. The same single timer
retains the readiness fallback after dispatch returns. A ready result cannot
remove the timer while another dispatch is pending. Exact single-flight cleanup
allows a subsequent attempt; distinct Agents on one Computer remain concurrent.

Preparation state and prewarm framing move into a dedicated
ProviderCliPreparationOwner, reducing the credential reconciliation owner from
1,490 to 1,357 lines. It owns one timer per admitted operation and the current
Computer readiness fence, replacing the previous fallback map/timer. No generic
shutdown framework, new timeout layer, per-SQL timer or retry policy is added.
Late bounded SQL/socket work stays observed; signal checks after source reads
and request-gate/cancel waits prevent starting new dispatch stages. Existing
request/instance fences preserve uncertain issued requirements and readiness.
This operation budget does not change startup migration limits.

**65 distinct passing cases: two native PostgreSQL and 63 unit cases. All 65
pass in Docker.** Seven new unit cases cover prewarm and active-only send waits,
deadline/close, late old failure versus a new attempt, ready-result/remaining-send,
one timer across stages, and replaced-instance recovery. Two new native cases
block actual source SQL on an independent PostgreSQL table lock: the admitted
caller times out while that bounded SQL is still pending, other SQL works, no
late frame leaves, and the next preparation succeeds after the lock releases.
These use SQL-backed component source ports, not a full HTTP/IM-service fixture.

Initial own-package regression exposed an incorrect cross-Agent cancellation;
per-operation ownership fixed it and all 56 existing cases now pass. Subsequent
new probes needed a polling interval below their short test deadline and the
registry's exact ordered provider list. The retained failed logs identify those
fixture errors. The final readiness assertion is checked both before and after
the deadline. Final Docker runs pass all 63 Provider cases; typecheck, server
build and repository gates pass. The unchanged complexity ratchet required
separating the readiness-begin step; no exception/baseline was relaxed.

Workspace evidence: `.codex/reports/sql-caller-repairs-20261103/batch-09-*`.
AG-F2 is now repaired locally across its Runtime test, lifecycle and preparation
extensions. Rejecting an admitted wait does not join its pending SQL/transport;
IM-F3 remains open for owner drain and actual Server close order. No independent
agent review, full binary shutdown, live provider, CI, merge, deployment or private
billing acceptance is claimed.
