# SQL caller repairs: Account auth atomicity

2026-11-03, AA-F1/AA-F2/AA-S1 in the [tracker](../sql-caller-remediation.md).
The installed Better Auth is pinned at 1.7.2. Its official Drizzle transaction
option is enabled. Email signup's user, identity and session share that official
transaction; Google first-link user/identity writes use the official helper.
No extra pool, compensating deletion, retry or schema migration is added.

The session hook reads Account state through the transaction-aware internal
adapter from its hook context, or the root internal adapter for server issuance.
The existing suspendedAt column is mapped as internal input:false/returned:false.
Active-state checks remain; public HTTP decisions use the existing AuthServiceError
mapping, while internal issuance retains the application error. The obsolete
PostAuthenticationService, its lock/transaction/complete wrappers, composition
and export are deleted. Ordinary per-request live Account checks remain.

Google start classifies 429/5xx before its disabled-provider fallback. Only the
pinned FAILED_TO_CREATE_USER signup code additionally maps to sanitized 503;
other 4xx, malformed bodies, duplicate email, password failures and suspension
remain distinct. Account setup removes its unlocked Agent preflight, retaining
its completed fast path, Account lock, owned-active-Agent query and one timestamp.

**199 distinct passing cases: 93 unit/API and 106 native PostgreSQL in Docker.**
Eleven new native cases cover user/identity/session SQL faults, real deferred
COMMIT failure, the pinned slow-user-INSERT translation, suspended password
sign-in, Google state write failure, concurrent same-email creation, internal
field/issuance rules, first Google identity-link rollback and Account setup's
single validation/idempotent race. Email failures publish no cookies; retries
work with max=1 and leave no orphan rows or idle transaction. The Google helper
uses controlled verified identity input and a real INSERT trigger, not a live
provider/callback acceptance claim. A concurrent creation loser may receive 503;
a subsequent ordinary retry resolves as duplicate without claiming its email.

The 57 existing native auth/migration/bootstrap cases and all 38 modified
Computer/Cloud identity consumer cases pass. Initial unit scope
passed 87 and exposed a stale startup mock for the composition moved in batch 2c;
the corrected boundary mock passes selectively (actual composition remains covered
by batch 2c native tests). Five new error-category unit cases pass. The initial
native run passed 66 and failed two fixture paths: its small error handler lacked
RequestValidationError mapping, and a Google table lock blocked the preliminary
lookup rather than the intended identity INSERT. The corrected tests also assert
the pinned library refuses an injected suspension field; both pass selectively.
Initial type/lint failures and every fault log remain. No successful case repeated.

Final typecheck, server build and repository gates pass with unchanged baselines.
Workspace evidence: `.codex/reports/sql-caller-repairs-20261103/batch-13-*`.
Existing stranded Accounts require a separately reviewed data disposition: no
email/password reclamation or Account deletion was performed. No independent
agent review, full binary shutdown, live Google, CI, merge, deployment or private
billing acceptance is claimed.
