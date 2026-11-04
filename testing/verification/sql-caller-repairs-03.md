# SQL caller repairs: final setup and Context authority

Continues the [remediation checklist](../sql-caller-remediation.md) from local
`9c58a50787f5d9df925707d58a5ffd4e9961ff12`, based on main `8cb997b2`.
Both recorded minimum designs were confirmed by the instruction to fix all
findings progressively. No schema, lock order, timeout, HTTP field or retention change.

| Finding | Minimal change | Native result |
| --- | --- | --- |
| AG-F3 | Carry automatic setup's expected Computer through existing token configuration into final activation. Compare it with the existing Agent read under the already-held ownership lock, before binding/installation writes. Remove the earlier unlocked placement read; retain the pre-callback current-target check. Manual/OAuth calls omit the internal expectation. | Real rebind before/during inspection rejects with 409, no binding or stored installation, and no callback dispatch. Existing manual, OAuth, provision and installation-lock cases pass. |
| AG-F5 | Check the existing signal immediately after the final SQL fence before both connect/create completed returns. | Deadline and owner close during the actual final authority query cannot save a selection. Acknowledged creation returns publication_uncertain, with exactly one create/initialize; no remote replay. |

**137 distinct passing cases: 88 native PostgreSQL in Docker and 49 host unit/API.**
Six native cases are new. Five baseline failures reproduce the current-source
defects (one setup and four Context interleavings). The repaired native run passes
18 cases; affected manual/OAuth/installation and Context authority/reset suites
pass another 70. Initial unit execution passes 48 and fails one obsolete mock
assertion that expected the removed preflight to deny before configureToken.
The ten-case selective retry passes with that test updated to assert original
Computer propagation and final admission rejection. Its changed title is counted
once; the old failed identity is not claimed to have passed unchanged. Passing
executions total 146; RED failures and skips do not inflate distinct counts.

Native tests use independent PostgreSQL connections, real AgentService rebind,
real Runtime owner/result correlation and actual MCP authority/selection SQL.
External Slack/GitHub replies are controlled; creation uses the pinned real
Context Tree initialization path. A max-one pool remains usable during external
inspection and the paused final SQL continuation. Tests do not establish live
provider or complete binary shutdown acceptance.

Environment and workspace-only evidence directory match
[batch 2a](sql-caller-repairs-02.md). Logs retain RED, initial fixture type errors,
the unit failure and selective retries. Type checking and repository gates pass;
diff review checks internal-only expectation propagation, guarded comparison,
preserved manual defaults and create uncertainty. No independent PR review,
CI, push, merge, deployment or private billing acceptance is claimed.

Eight of the 37 original defects are now repaired locally. AG-F12 and the rest
of the remediation remain open; this batch does not close lifecycle or drain gaps.
