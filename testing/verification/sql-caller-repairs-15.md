# SQL caller repairs: bounded OAuth discovery

Batch 6c closes AG-F13. Issuers are deduplicated after the existing provider-specific
canonicalization, retain advertised order and recorded-issuer preference, and fail
clearly above four distinct candidates before any issuer request. The existing
outbound deadline wraps discovery/client resolution at 30 seconds: normal resource
metadata, issuer metadata and registration stages each already have a 10-second
request bound. Fallbacks consume that same remaining budget. No retry, semaphore,
SQL timer, schema or dependency is added.

The signal reaches metadata and registration transports. Checks after preparation
SQL and before registration prevent late work from initiating remote effects;
checks after client resolution prevent late flow publication. Deadline/cancellation
ends candidate fallback, including uncertain registration. Already-issued SQL is
observed and bounded by infrastructure timeouts. A registration already submitted
is not automatically replayed. The initial root transaction and failed-root cleanup
retain their official SQL budgets outside the discovery timer.

**254 distinct cases pass: 236 unit and 18 native PostgreSQL in Docker; 256 passing
executions.** Eight new unit cases cover deduplication/preference, oversized lists,
pre-entry and in-flight cancellation, late metadata/registration responses, and one
budget across two stages. Four new native cases drive actual AgentSelf/OAuth
services and a loopback metadata server: sixteen duplicate bad issuers cause one
request; sixteen distinct issuers cause zero issuer requests; a fourth valid issuer
still publishes a redeemable handoff; blocked registration SQL outlives an 80 ms
test discovery budget, times out under the 500 ms statement setting, and never
registers/publishes afterward. No idle transaction remains. Production stays 30 s.

The first SQL fixture locked the registration table before root INSERT, so its FK
preparation timed out before discovery. Seeding the pending root before the lock
isolates the intended preparation read; that corrected case passes selectively.
A complexity gate identified a new warning. Removing a redundant special-case
registration-error branch keeps the common failure reporting and passes the
unchanged ratchet; its existing fallback case and the strengthened multi-stage
budget test were rerun. No baseline was relaxed. Typecheck and repository gates pass.

Evidence: `.codex/reports/sql-caller-repairs-20261103/batch-15-*`. Independent
review of batch 14 found no actionable issue, without a new test/Docker rerun;
this batch is reviewed separately. No live provider, full Server shutdown, CI,
merge, deployment or private billing acceptance is claimed.
