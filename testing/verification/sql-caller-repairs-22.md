# SQL caller repairs: cascading execution resource reclamation

Batch 5b's AG-F9 portion subscribes the credential owner to the existing registry
close event. The event centrally revokes capabilities, proxy tickets and MCP/Web
bearers for every closed execution, including recursively closed children and
registry expiry. Equivalent direct-ID cleanup and its misleading comment are
removed. The existing composition's URL-handle listener remains. No new store,
sweeper, capacity, TTL, authorization path or asynchronous cleanup is introduced.

**42 distinct unit cases pass on host and Docker Linux.** Five new real-registry /
real-store cases cover parent close, explicit child close, expiry, exact connection
loss and owner close. Stores are limited to two records; repeated parent/child
cycles recover all capacity immediately, without waiting for expiry. Child-only
close preserves the parent's records until its own close. MCP/Web token stores
are checked alongside capabilities and tickets.

Test fixture options initially repeated store fallbacks; the parameterized close
case also exceeded the existing cognitive-complexity gate. Stores now destructure
one optional bundle and each close action is a small named function. Host cases
pass after that simplification. Baselines were not changed. There are 210 passing
executions across the owning checks and justified fixture refinements; logs remain.
Typecheck and repository gates pass. Evidence:
`.codex/reports/sql-caller-repairs-20261103/batch-22-*`.

This batch verifies immediate registry-event cleanup. Joining already-admitted
asynchronous owner/connection work and retaining listeners until that drain is
complete belongs to the remaining IM-F3 shutdown composition, not this component
acceptance. No native SQL behavior changed here. Independent review follows the
exact commit; full Server shutdown, CI, deployment and private billing remain
outside this batch.
