---
title: "Database read/write index"
description: "Entry points for database models, queries, transactions, recovery, and validation."
---

# Database read/write index

Read the relevant context below for the path being changed.

Prefer simple designs with fewer new foreign keys and bounded single-table
reads plus Server memory computation, where business semantics stay equivalent.
Preserve existing authorization, consistency, pagination, and retention contracts;
present concrete design changes for human confirmation before implementation.

| Topic | Start here |
| --- | --- |
| Ownership and lifecycle | [Agent, Session, and Computer model](agent-session-computer-model.md) |
| Query selection and indexes | [IM delivery queries](messaging/im-delivery-claim.md); [PostgreSQL EXPLAIN](https://www.postgresql.org/docs/17/using-explain.html) |
| Transactions, read snapshots, and locks | [PostgreSQL isolation](https://www.postgresql.org/docs/17/transaction-iso.html); [locking](https://www.postgresql.org/docs/17/explicit-locking.html) |
| Claims, idempotency, and recovery | [IM delivery custody](messaging/im-delivery-claim.md); [Session collaboration](messaging/internal-session-collaboration.md) |
| External resources and persistence | [Cloud Runner execution](cloud/cloud-runner-execution.md); [Skills](capabilities/agent-skills.md) |
| Waiting, failures, and diagnostics | [Observability](../operations/observability.md); [error taxonomy](../operations/error-taxonomy.md) |
| Migration and validation workflow | [Database migrations](https://github.com/first-tree-ai/opentag/blob/main/AGENTS.md#database-migrations); [local validation](https://github.com/first-tree-ai/opentag/blob/main/DEVELOPMENT.md#local-validation) |
