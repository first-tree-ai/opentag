# SQL caller repairs: Client Context Tree resources

2026-11-03, AG-F7/AG-F8 in the [tracker](../sql-caller-remediation.md).
AG-F8 moves forward from the body/output batch to share validation of the same
Client CLI ownership boundary. No SQL/schema, wire contract or new timer changes.

Context Tree command close now returns one memoized Promise. Parent abort may
start cleanup before the owner awaits it; a rejection handler observes that
interval without changing the returned failure. All callers join command/relay,
listener and directory cleanup. Directory removal is still attempted if listener
close fails, and repeated callers receive the same failure.

CLI collection uses Node StringDecoder across Buffer chunks, measures raw bytes
before retaining each chunk and permanently ignores subsequent chunks after
maxBuffer overflow. It flushes the decoder on normal stream close. Existing
process-group TERM/KILL and descendant joining remain. Overflow never discards
already-issued work ownership or changes Context Tree failure classification.

**94 distinct cases pass on macOS; 27 also pass in Docker Linux (121 passing
executions).** Eight new cases cover parent-abort/repeated close, a cleanup failure
with actual directory removal, split UTF-8 through actual pipes, three exact byte
boundaries, multibyte overflow and a flooding TERM-ignoring process with a detached
descendant. Existing command/worker and Session manager tests cover cancellation,
write-session behavior and consumer cleanup. The standalone integration fixture
uses local Git repositories. No live GitHub/provider or SQL behavior is claimed.

Client typecheck, build and repository gates pass. The Agent Runtime coverage gate
was not run: neither changed file nor the new test is in that gate's explicit
implementation/test lists. Its covered Session manager consumer ran normally;
no coverage configuration or threshold changed. Workspace evidence:
`.codex/reports/sql-caller-repairs-20261103/batch-11-*`.
No independent agent review, whole-binary shutdown, CI, merge or deployment is
claimed. IM-F3/AG-F9 Server owner cleanup remains separately open.
