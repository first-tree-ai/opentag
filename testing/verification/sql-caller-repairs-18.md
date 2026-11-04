# SQL caller repairs: persistent Cloud gateway routing

Batch 7b closes AG-F10. Cloud gateway hint I/O uses the existing Sandbox exec path
and stores only `{id, source}` in the archived workspace under
`.opentag/context-tree/command-sessions`. Local keeps its filesystem route. UUID,
4-KiB, schema and current-source checks remain; Cloud reads reject links/special
files and permissions are 0700/0600. No SQL schema, workflow store, execution
handle/token, arbitrary Tree fallback or automatic prepare/publication is added.
Confirmed published/unchanged/aborted sessions remove the hint; uncertain results
retain it.

Independent review found a cancellation window between confirmed CLI completion
and hint I/O. Reads still honor request cancellation; confirmed writes/removals
finish under the existing 5-second exec bound. Gateway close joins the actual
settlement. Controlled gates after real CLI prepare/abort confirm close waits and
the persisted/deleted hint remains correct after cancellation. No new timer/queue.

**283 distinct cases pass, including all 283 in Docker Linux; 587 passing executions
across host/Linux checks.** Eight new fault/continuity cases cover archived routing
with real Git push acknowledgement loss, fresh host, multiple Trees, corrupted or
oversized hints, removed/changed selection, successful unchanged/abort cleanup,
three special-file types and late cancelled reads/confirmed settlement. One case
drives actual Runner rebind wire/HTTP restore, clears host turn material, restores
only the borrower's draft/hint and publishes through the actual gateway/CLI.
The uncertain Git commit is retained; only explicit recovery invokes the next
push, with no extra commit. Existing process-tree cleanup, Cloud turns, workspace
wire, CLI archive recovery and Session runtime consumer scopes pass.

Runner protocol/HTTP/archives, child Node workers, pinned CLI and disposable Git
are real. Sandbox launch/exec use controlled ports; this is not live Native Sandbox
or provider acceptance. Agent Runtime coverage's explicit covered source/test
lists do not include these changed files; its configuration was not changed.

Initial fixtures exposed a Local routing-path regression in the test refactor and
macOS realpath aliases; those were corrected. The alias failure blocked a test
barrier, so that owned run was interrupted and its fixture removed. Tests now
observe early failure rather than waiting indefinitely for the barrier. A test
complexity warning was resolved by restoring the unchanged generic suite and
extracting a shared Cloud fixture. No complexity/size baseline was relaxed. Final
client typecheck/build and repository gates pass. Evidence:
`.codex/reports/sql-caller-repairs-20261103/batch-18-*`. CI, merge, deployment,
full Server shutdown and private billing acceptance remain outside this batch.
