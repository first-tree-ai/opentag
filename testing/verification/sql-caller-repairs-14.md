# SQL caller repairs: MCP OAuth recovery

Batch 6b repairs BG-F2 and MC-F1; AG-F13 discovery amplification/budget remains
in the next batch. No schema, claim takeover, token retry or new persistent state.

Before dispatch, transient SQL/transport preparation failures release only the
matching refresh claim and preserve credential bytes/status/generation. Existing
usable tokens remain available immediately; a later ordinary worker pass recovers.
Deterministic registration/decryption failures and post-dispatch unknown outcomes
retain their previous classifications. Claim release uses the supplied executor.

Failed discovery marks only its unchanged, credentialless, unpublished pending
root as error. Failed one-time code redemption clears its exact flow and records
MCP_OAUTH_FAILED. It preserves prior usable credentials and cannot overwrite a
newer flow or concurrent revocation/configuration. No automatic code replay.

**213 distinct cases pass: 109 unit and 104 native PostgreSQL in Docker.** Ten
new native cases use actual services, PostgreSQL and a loopback OAuth server:
preparation table-lock timeout with recovery/revocation/configuration; consumed
refresh with a lost response and no replay; failed first discovery; older discovery
versus newer/already-published flows; failed redemption with/without prior usable
credentials; and late redemption failure versus a newer flow. The preparation
cases use max=1, 500 ms statement timeout and 2 s driver query timeout, and assert
zero refresh calls before dispatch. Existing management, concurrency and shared
credential suites pass.

Initial runs exposed four obsolete unit pending-state expectations and seven
native fixture expectations (the fixture counts authorization codes as well as
tokens, headers are lowercase, and discovery aggregates candidate errors). Those
assertions were corrected and rerun selectively. All initial failure logs remain;
no successful case was repeated. Typecheck and repository gates pass with unchanged
baselines. Evidence: `.codex/reports/sql-caller-repairs-20261103/batch-14-*`.

Independent reviews 1/2 cover completed batches 01–13, not this batch. No live
provider, full binary shutdown, CI, merge, deployment or private billing acceptance.
