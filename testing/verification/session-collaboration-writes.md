# Session collaboration writes

Supports [Internal Session collaboration](../../docs/system/messaging/internal-session-collaboration.md).

## Scope and invariants

Create/send retain their existing transaction and business checks. Their authority locks now follow
Agent → binding → Sessions ordered by ID (`FOR NO KEY UPDATE`) → placements ordered by Session ID →
Computers ordered by ID. The selected rows supply the existing validation. The source's actual
Local/Cloud connection, placement generation, ownership and lifecycle checks remain authoritative.
No Account lock, additional successful-path locked entity, schema change or automatic retry is added.

For create retries, an unlocked lookup restricted to message ID and creator Session supplies the
immutable target hint after the Agent guard. The original later Message lock and identity checks
remain in place. Send still validates the target before message identity; create still checks message
identity before the target. Only full-scope targets enter the lock chain. An unlocked fallback keeps
the existing unavailable-before-scope-mismatch classification for foreign targets.

Creating an internal child also records activity for its creator through the existing projection
helper, in the same transaction. Retries use the original message timestamp and ID. No historical
backfill runs; an explicit matching retry can repair the creator projection for that message.
The initial task preview, child retry behavior, message-attempt fence and outcome guards are retained.
An uninvolved ancestor does not gain activity merely because a deeper descendant sends a message.

## PostgreSQL Service regression

```sh
pnpm --filter @opentag/server exec vitest run \
  src/__tests__/integration/session-collaboration-writes.test.ts --maxWorkers=1
```

The 24 cases use the full migration chain and real independent PostgreSQL connections. External
test-only row locks queue actual Service calls; `pg_stat_activity` confirms the intended waits before
the gate is released. There are no altered product queries, product hooks or fixed sleeps.

| Interleaving or invariant | Expected result |
| --- | --- |
| Opposite-direction peer sends | Both commit once |
| Peer send vs self-send, create, explicit create retry or explicit send retry | Both commit; retries advance only the existing attempt |
| Send vs same-Computer rebind, targeted repair issuance, targeted repair exchange or user binding disable | Both commit, with send ordered first; subsequent disabled-source authorization fails |
| Binding-first disable ahead of send | Disable commits; send returns `SESSION_SOURCE_UNAVAILABLE` without a cycle |
| Source placement moves while send waits | Move commits; old source proof returns `SESSION_PLACEMENT_STALE` |
| Target placement moves while send waits | Send uses the new Computer, installation and generation |
| Ordinary or scheduled dispatch admission ahead of send | Admission and send both complete |
| Target differs by binding, channel, conversation kind or thread, while its Session/placement are held elsewhere | Original `SESSION_SCOPE_MISMATCH`; no wait on those target rows |
| Invalid source proof, ended target and conflicting message ID | Original source/target/identity error precedence; no partial attempt |
| Child creation at a later time | Creator appears at the original message time in direct/recursive `since` results |
| Deeper creation, equal-time IDs and cursor pages | Uninvolved ancestor unchanged; original time/ID/Session-ID ordering |
| Older retry or outcome after newer activity | Newer activity and initial task previews unchanged; old attempt cannot overwrite the retry |
| Matching retry against a simulated missing creator projection | Creator projection repaired using original creation time |

On unmodified main `94947523d0b6bedcde443f8f5187f0df4619dff6`, the original six-case subset independently
reproduced one `40P01` in opposite-direction sends and four creator-activity failures. One protective
newer-activity case already passed. This distinguishes defect reproduction from passing post-fix
regression. Victim selection and production occurrence frequency are not asserted.

The existing Session, Cloud collaboration/concurrency, scheduled dispatch, IM and management suites
remain part of full integration validation; their implementation is outside this change.

## Query cost and limits

Authority plus existing-message SELECT counts on successful paths:

| Path | Before | After | Extra SELECTs |
| --- | --- | --- | --- |
| Send | 3 | 6 | 3 |
| New create | 2 | 7 | 5 |
| Matching create retry | 3 | 7 | 4 |

The five authority stages reuse their selected rows and inspect at most two Sessions, placements
and Computers. Create includes the additional read-only retry hint. Foreign-target fallback reads
are outside these successful-path counts. Existing same-Agent/binding serialization starts earlier;
the Session lock is weaker and remains compatible with FK `KEY SHARE`. Creator activity adds one
projection UPDATE to new create and matching retry; it can touch the creator's existing ancestor
projections, but does not rewrite the list query or aggregate subtree activity.

These local synthetic tests do not establish production incidence, capacity, a globally acyclic
lock graph, live provider delivery or actual model execution. No deployment or production operation
is part of this validation.

## Recorded validation

Local run: 2026-10-19, Node 24.20.0, pnpm 10.12.1, PostgreSQL 17.11 with 64 migrations.
Machine-specific raw logs stay outside the repository.

- Focused PostgreSQL regression: 1 file / 24 tests passed.
- Directly affected Session unit/PGlite regression: 1 file / 33 tests passed.
- `pnpm check`, `pnpm build` and `pnpm typecheck` passed.
- `pnpm test` passed: 691 repository-script tests and 9,983 package tests, with 22 existing skips.
- Client Agent Runtime coverage: 29 files / 640 tests passed; statements, branches, functions
  and lines each reached 100%.
- Full PostgreSQL integration: 61 files / 788 tests passed with the default two-worker command,
  including all 24 new cases. The full integration run followed unit/coverage completion.

## CI report-wait regression

The first remote Node 24 unit shard failed in the existing Client recovery test while its default
one-second `vi.waitFor` awaited the next Turn Report. Client product code is unchanged. A test-only
1.1-second delay in the fake connection's final-report send reproduced the same assertion failure;
this demonstrates the short-wait assumption, rather than establishing the remote runner's exact delay.

That one wait now observes the fake connection's actual frame event and returns the indexed report.
The report assertions and the enclosing test's five-second deadline remain unchanged; no product
timeout or retry policy is altered. The same delayed-send experiment passes afterward, and the
complete 15-case Client Turn file passes. The delay injection is local research only, not a fixed
sleep added to the checked-in suite.

A concurrent local revalidation also hit an existing CLI auto-update one-second wait (`installing`
instead of `blocked`). Its full five-case file and the complete CLI suite then passed unchanged.
The subsequent quiet full-repository run passed all 691 script and 9,983 package tests; no CLI code
or timeout was changed. Both failed and successful logs remain in the local evidence.
