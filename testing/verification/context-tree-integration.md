# Context Tree integration: verification and acceptance

Test and acceptance material for [Context Tree integration](../../docs/system/capabilities/context-tree-integration.md).

## Verification

Tests cover schema rejection, empty defaults, snapshot round-trips, order-independent hashes,
collisions, targeted disconnect, revision/suspension races, and publication deduplication. Runtime
coverage includes reconciliation, partial success, startup budgets, retry cooldowns, multiple writable
roots, exact Cloud grants, revoked access, version-2 partial sync, and preserved drafts.

Offline real-CLI scenarios connect multiple trees, write to an explicit alias, disconnect it, and
read/synchronize the remaining tree. Cloud tests exercise actual workspace archives and prepared
writes. Required repository checks include install, check, build, typecheck, unit tests, agent-runtime
coverage, PostgreSQL integration, and package smoke verification.
