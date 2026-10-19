# Account, Agent, and Computer management writes

Supports the [identity and placement model](../../docs/system/agent-session-computer-model.md)
and the [Server/Client boundary](../../docs/system/server-client-boundary.md).

## Scope and invariants

- Agent rebind acquires its existing target Computer lock before its existing owned Agent lock.
- Computer access mutations use their existing Account guard with `FOR NO KEY UPDATE`, compatible
  with ownership FK KEY SHARE. The reset's Computer-revocation phase uses that same guard; its final
  cleanup verification keeps its existing stronger lock.
- Creation/rebind add no Account lock, transaction, or successful-path query. There are no migrations,
  new FKs, new JOINs, retries, list rewrites, or changes to unbound creation/operator transfer.
- Owner predicates precede Agent row locking; lifecycle/revision checks remain inside the transaction.
- Code consumption, installation replacement, and credential rotation commit together. Socket cleanup
  happens afterward, with a 1-second wait limit and independent diagnostics. Only revoked credential
  IDs are eligible for cleanup; a delayed callback cannot close a successor using another credential.

## PostgreSQL Service concurrency regression

Run:

```sh
pnpm --filter @opentag/server exec vitest run \
  src/__tests__/integration/account-agent-computer-locks.test.ts --maxWorkers=1
```

The suite uses the checked-in full migration chain and independent PostgreSQL connections, not
PGlite. `pg_stat_activity` confirms that the second operation has reached the intended lock wait
before the barrier is released. Test-only triggers/advisory barriers hold an INSERT or owner UPDATE
before its existing FK check; they are removed afterward and are never installed by application code.

| Interleaving | Expected result |
| --- | --- |
| Targeted repair vs actual rebind back to the named Computer | Both commit |
| Targeted repair vs exact-target idempotent rebind | Both commit |
| Bound creation vs explicit disconnect | Both commit; disconnect revokes access |
| Bound creation vs delete | Creation commits; delete returns `COMPUTER_IN_USE` |
| Bound creation vs reset Computer revocation | Creation commits; reset returns `ONBOARDING_RESET_UNVERIFIED`, preserving its final verification gate |
| Rebind while another connection holds the Account `FOR UPDATE` | Rebind completes under a 500 ms statement timeout, proving it does not wait on an added Account lock |
| Unbound vs bound creation of the same name | One creation; the other gets `AGENT_NAME_CONFLICT` |
| Operator transfer vs bound creation of the same name | Transfer commits; creation gets `AGENT_NAME_CONFLICT` |
| Foreign Agent row held by another connection | Mutation/read entry points return the same 404 as a missing Agent, under a 500 ms statement timeout; rebind uses a caller-owned target |
| Owner changes while a legitimate caller waits | Mutation returns 404 with no partial write |
| Agent is deleted while a legitimate caller waits | Mutation returns 404 with no partial write |
| Agent is suspended while a legitimate caller waits | Mutation returns the expected lifecycle 409 with no partial write |

Before the lock-order/strength fix, the first five cases each reproduced a PostgreSQL `40P01` through
real Service entry points against main `9f80f340`; the other six then-present cases passed. The final
12-case suite passes after the fix. Victim selection is PostgreSQL's choice, not an asserted contract.
These are local synthetic regressions, not evidence of production incidents.

## Credential exchange and Runtime fencing

`integration/computers.test.ts` exercises the real HTTP exchange endpoint with an already registered
WebSocket and callbacks that throw synchronously, reject, or never settle:

- HTTP returns the committed new token; hanging cleanup returns after the 1-second deadline.
- The new token verifies and registers/heartbeats successfully; the old token and cached auth context
  are rejected. The hanging-callback case reuses the same installation ID to exercise credential
  revocation independently of an installation change.
- Code replay is `AUTH_CODE_CONSUMED`; there are exactly two credential rows, exactly one active.
- The old instance is cleared, an old disconnect cannot clear the new instance/connection, and a
  business frame on the deliberately unclosed old socket is rejected before the business handler.
- Cleanup failures/timeouts produce a diagnostic without exposing tokens or private cleanup metadata
  in the exchange response. A late callback rejection is observed and does not become unhandled.

`connection-registry.test.ts` additionally verifies immediate removal of routing authority before
waiting for pending registration, including a throwing socket close. Pending registration is still
drained after a close error: a late revoked credential is evicted, while a successor credential stays
registered. Outbound sends to the revoked instance fail.

## Recorded validation

Local run: 2026-10-19, Node 24.20.0, pnpm 10.12.1, PostgreSQL 17.11 with 64 migrations.
Validation applies to this PR's implementation; raw machine-specific logs stay outside the repository.

- Targeted PostgreSQL concurrency: 12 tests passed.
- Related Service/registry regression: 7 files / 141 tests passed before the final additional
  no-Account-lock case; the full suites below include that case.
- `pnpm check`, `pnpm build`, and `pnpm typecheck` passed.
- `pnpm test` passed: 691 repository-script tests and 9,965 package tests (22 existing skips).
- Full PostgreSQL integration: 59 files / 755 tests passed, including all new concurrency cases.
- Client Agent Runtime coverage: 29 files / 640 tests passed; statements, branches, functions, and
  lines each reached 100%.
- An earlier full run hit a 5-second timeout in the Client Context Tree member-memory test. Its
  isolated 7-test file and the subsequent complete default `pnpm test` run both passed without
  changing test code or timeouts.

## Cost and remaining limits

The successful management paths have the same number of transactions, queries, and locked rows as
before; the change reorders two existing locks and weakens an existing Account guard. Capturing
revoked IDs adds `RETURNING` to an existing UPDATE, with no extra round trip; the active-credential
unique index bounds that projection to at most one ID per Computer.

Existing same-Account access mutations remain serialized. Target validation now precedes Agent
validation during rebind; invalid targets return their existing Computer 404 before Agent checks.
The post-commit wait can add up to one second to exchange latency. Its deadline stops waiting; it
cannot cancel arbitrary callback code. Credential-scoped cleanup prevents that late work from
closing a newer credential's connection.

No production deployment, load test, or live Provider execution was performed. Revocation removes
Server authority; it cannot physically stop work already executing on an offline Client. Ordinary
network loss after commit can still lose a response; this change removes the avoidable callback
failure path, not network ambiguity. Unrelated lock graphs are outside this scoped regression.
