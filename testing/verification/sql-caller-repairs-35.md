# SQL caller repairs: application request work and shutdown phases

The application now retains actual returned Promises from incoming route hooks
and handlers in one set. First-root preClose closes the next-phase admission gate
and starts observed producer shutdown without awaiting it. First-root onClose,
which runs after child route hooks, joins producer work and admitted request work,
closes billing once, then invokes the shared-resource finalizer. Main wiring is
still required; this component alone does not establish production SQL ordering.

This shared boundary covers disconnected OAuth start/callback, Slack webhook
lookup/receipt admission and direct Account Sandbox calls without new HTTP-only
owners in every service. The wrapper preserves this, arguments, returned values
and callback-style behavior, skips websocket/wsHandler routes and Reply sentinels,
and observes both Promise outcomes. The closing gate prevents a delayed parser
or previous hook from admitting a new SQL phase after request drain.

The two SQL-bearing scoped authentication hooks (Skill upload and three Runner
workspace routes) move into route options; authentication still precedes body
parsing. RuntimeWeb awaits its original verifier: the existing independent timer
still returns 504 within budget, allowing the redundant race, abort-wait helper
and duplicate rejection observer to be removed. Background/raw-deadline owners
remain necessary. CloudModel and billing preClose start and observe cleanup;
actual joins happen in onClose, so a slow task or synchronous stop failure does
not skip websocket teardown. Billing close has one application-level owner after
request work, before shared resources.

**228 individually identified Docker cases pass, including 26 native PostgreSQL
cases, with 230 passing executions in the 13-file matrix. Three existing Slack
parameter rows print the same abbreviated title, so the manifest conservatively
counts that group once. Host 204 cases, server typecheck and repository gates pass.**
Three PG controls disconnect real HTTP peers during onRequest, preHandler or
handler SQL. Close waits, SQL within the admitted phase finishes, later handlers
are gated, no tested post-disposal query occurs, and backend PID count reaches
zero. A real loopback MCP callback consumes its code once, loses its HTTP client,
then persists the accepted credential before close. Slack lookup/claim controls
prove durable handoff remains owned; RuntimeWeb returns its 504 before an original
verifier gate is released and close still waits for that verifier. Sync/callback/
async reply contracts, child shutdown dependency and kickoff/billing failures are
also covered. Initial typecheck found two unused test arguments; only their names
were corrected, with no runtime test repetition. Local logs/manifests retain all
failed and successful evidence; PGlite is not counted as native PostgreSQL.

Independent source review found no actionable regression; exact-commit review
at 429b1607 also found no actionable defect. Batch 34 exact review at 481ff05a found no actionable defect.
Actual main producer/finalizer wiring and full Server signal/fault acceptance
still keep IM-F3 open. No CI, merge, deployment or private billing implementation
coverage is claimed.
