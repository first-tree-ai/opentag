# SQL caller repairs: native Google token-exchange budget

AA-R1 is actionable because correct application drain retains the real official
OAuth callback, including its previously unbounded remote exchange. Pinned Better
Auth 1.7.2 has no built-in Google fetch/timeout/signal option. Replacing Google
with a custom provider would expand authentication maintenance, so a narrow
@better-auth/core patch preserves its built-in implementation. Its existing token
helper accepts an optional native AbortSignal; Google creates an independent
10-second signal for each code exchange. Redirect refusal, token parsing,
issuer/subject mapping and the official final transaction remain unchanged.

The signal reaches native fetch through headers and body parsing. The library's
own timeout option clears after headers and is insufficient. A complete token
result retains its normal SQL settlement despite browser disconnect/shutdown;
an uncertain one-time code is never retried. Public OpenTag flow does not accept
client-submitted ID tokens, so unreachable JWKS and refresh paths are unchanged.
No global fetch override, provider migration, schema, SQL pool or retry is added
in production. package.json, patch and lockfile stay together; a fresh install
and frozen-lockfile verification prove the installed code contains the patch.

**83 identified Docker cases pass, 40 native PostgreSQL, across the five-file
matrix and affected-case retry. Server typecheck and build pass.** New native
controls stall real loopback headers or body: each cancels around 10 seconds,
closes the actual HTTP transport, keeps SQL usable with no idle transaction,
performs one exchange and leaves no partial Account/identity/session. A fresh
flow succeeds without replaying the old code. A third case holds the official
Account insert after complete token parsing, disconnects a real HTTP client and
starts app close; close waits and the official transaction commits all three
facts. The first version of that test used events.once(close), which rejects on
the deliberately destroyed peer's ECONNRESET; the corrected close-only observer
passes without changing production or weakening the final-state assertions.

Tests forward only the fixed Google token URL to native loopback fetch. They do
not establish live Google, provider DNS/TLS or JWKS acceptance. Server/shared/
preset dependency pins and the existing postgres patch match the disposable
image. The newly installed pinned core package is overlaid read-only; three
changed SDK file hashes and the image baseline are recorded in the local SDK
manifest. Failed logs, patch/install/frozen/build logs and source snapshots are
retained. This is not a rebuilt production image or deployment claim.

Batch 37 exact review at 5d4040c4 found no actionable defect. Batch 38 independent
source review found none; exact-commit review and final broad owning checks remain.
IM-R2 still requires representative native scale/selection-equivalence evidence.
Other size/legacy observations retain their individual measured or unmeasured
limits; the remediation is not declared complete from this component alone.
