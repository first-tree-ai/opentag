# SQL caller repairs: outbound capture and detached MCP probes

This IM-F3 component retains the original postgres-js outbound-capture query
past the existing response deadline and cancellation grace. The capture owner
also retains whole admitted captures. Credential-stack shutdown starts owner and
transport shutdown together, joins both, then closes capture; cleanup still runs
if either earlier resource fails. Confirmed provider outcomes, deadlines, retries,
SQL authorization and pool ownership do not change.

McpAuthorizationService owns whole admitted probes through their final revision-
fenced snapshot write. Its route registration starts probe closure in preClose
and joins it in onClose. This one owner covers the OAuth callback, all three
management API detached-probe sites and direct probe calls. New probes are refused
through the existing error type; accepted credentials are retained. There is no
additional timeout, queue or SQL pool.

**172 distinct Docker cases pass, including 33 native PostgreSQL cases; 187
passing executions across the eight-file matrix and two affected-file retry.**
Two new PG controls hold the actual driver result beyond deadline/grace and then
resolve or reject it: capture returns, close remains pending, the same one-slot
pool is usable and no later persistence or stopped capture begins. Native MCP
HTTP controls complete bearer writes or the real loopback OAuth callback, pause
the detached probe's SQL result, and prove app close waits for its final snapshot.
Three PGlite controls cover successful, failed and throwing admitted probes; two
stack controls verify capture drain follows transport and still runs after a
transport cleanup error. PGlite results are not counted as native PostgreSQL.

The first matrix exposed one inconsistent old test: it injected the public
UPSTREAM_UNAVAILABLE error but expected OAUTH_FAILED, although sibling tests and
the existing callback implementation preserve the public error. Only that
assertion was corrected; replacement-flow preservation is still checked. The
affected files pass retry; unchanged successful files were not repeated. Host
89-case owning checks, server typecheck and repository gates pass. Failed logs,
source snapshots and manifests remain under the local report directory.

Independent source review found no actionable regression; exact committed review at
9a6db831 also found no actionable regression. Batch 31 exact review found no new actionable defect and confirmed
its late-slot P2 closed. Cloud proof COMMIT/detach and original allocation tails,
plus actual main shutdown composition, still keep IM-F3 open. No whole Server
signal, CI, merge, deployment or private-provider acceptance is claimed.
