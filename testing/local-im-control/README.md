# Exclusive local IM acceptance control

This optional macOS/Linux harness supports the existing local-source workflow in
[DEVELOPMENT.md](../../DEVELOPMENT.md#stop-and-restart) and the
[database migration standards](../../docs/system/database-read-write-standards.md#migrations).
It controls only its own foreground Server and daemon processes. It does not run Docker, install a service,
reset an installation, bind an Agent, alter credentials, or migrate the database.

## State, source, and configuration

Use Python 3.10+ and the repository's supported Node/pnpm toolchain. Keep these three locations separate:

- **Source:** dedicated clean Git worktrees outside automatically recycled directories. Each candidate has its own
  worktree, dependencies and build outputs. Keep the worktrees locked with `git worktree lock`; this prevents pruning,
  not edits. Do not check out or rebuild a worktree while its processes are running.
- **State:** one private persistent `state_dir` for receipts, `runtime.json`, and local logs. It is separate from legacy
  PID records. Never delete state to bypass an ownership refusal. Logs stay outside the repository.
- **Configuration:** a private external JSON file based on [config.example.json](config.example.json). Use absolute paths,
  the existing `home_dir` (the current `OPENTAG_HOME`), and the existing environment file by reference. No secret values
  belong in JSON, command arguments, or a PR. The parser accepts literal `KEY=value` assignments, including quoted values;
  it does not execute shell expressions or accept `export` statements. The environment file must remain available.

`database_source` is the operator's explicit assertion of the source revision already applied to this database,
verified through the separately approved database procedure. The harness does not query the database to establish that
assertion. It hashes Git trees for `packages/server/drizzle`, `packages/server/src/db/schema`, and
`packages/server/src/db/migrate.ts`. Every candidate and recorded running source must match that fingerprint.
A missing input or any difference is refused before stopping either process. Equal trees are a narrow gate, not a
claim of data compatibility for arbitrary application changes. Server startup always receives
`OPENTAG_AUTO_MIGRATE=false`; existing Server migration verification still has to pass.

The default build command is `pnpm exec turbo run build --force`. Before building, the harness deletes the seven
known package/app `dist` directories, invalidates the previous receipt, and refuses to rebuild a running source.
A successful command, a clean matching full SHA, nonempty outputs, both process entries, and an SHA-256 fingerprint of
all output files are required for a new random build ID. `select` rechecks these facts. This proves an observed build
and unchanged outputs, rather than inferring a build from HEAD. It is not an independently reproducible build or
an audit of arbitrary ignored files, installed dependencies, or external edits. Install from the committed lockfile
before building; do not mutate these inputs during acceptance. `build_command` is an optional trusted argv override
for offline tests; omit it for normal use.

Before switching, the configured home must already contain version 3 Computer credentials whose `computer.serverUrl`
matches the acceptance URL. This matters because the daemon uses its stored credential URL rather than treating
`OPENTAG_SERVER_URL` as a binding override. Credentials are only read for this check and are never printed or rewritten.

Processes are recorded separately with the actual candidate SHA, build ID, source, argv, UID, PID, and start time.
Before any stop, every recorded live process must match the current UID, exact command and recorded start time;
a reused or unrelated PID refuses the whole operation. There is no substring ownership check or forced kill.
The Server receives `OPENTAG_BUILD_REVISION` from the receipt. `select` requires `/readyz` to return HTTP 200 and the
matching `x-opentag-revision` header before starting the daemon. `status` repeats that cross-check. This header alone
is not build proof; it supplements the output fingerprint and process identity.

## Adopt an existing instance

The instance coordinator performs these steps. Do not run them from a parallel task.

1. Preserve the existing database, home, connections, credentials, environment file, Compose project and ports.
   Review the current process commands and PID records without dumping environment contents. Verify the database's
   source revision. If an upgrade is needed, obtain the separate migration authorization and execute that procedure;
   this harness neither upgrades nor downgrades it. Never relabel an old database as a newer source to pass the gate.
2. Prepare candidate worktrees from full reviewed SHAs. Retain a persistent path for the verified database source too;
   it can be candidate A's repository because the fingerprint reads the specified Git commit, not its checkout.

   ```bash
   git worktree add --detach "$IM_SOURCE_A" "$IM_SHA_A"
   git worktree lock --reason 'Local IM acceptance; retain source and build identity' "$IM_SOURCE_A"
   git worktree add --detach "$IM_SOURCE_B" "$IM_SHA_B"
   git worktree lock --reason 'Local IM acceptance; retain source and build identity' "$IM_SOURCE_B"
   pnpm --dir "$IM_SOURCE_A" install --frozen-lockfile
   pnpm --dir "$IM_SOURCE_B" install --frozen-lockfile
   ```

   Run only the missing preparation steps for worktrees already created by the coordinator.
3. Copy the reviewed `control.py` to a stable private tools directory outside both candidate worktrees. Make a private
   config from the example, replacing every placeholder, including the numeric HTTP port and verified database SHA.
   Keep the same `state_dir`, `home_dir`, config and tool copy for every operator. Set private file/directory permissions.
4. Open the new controller's session in a dedicated terminal and keep it open throughout adoption and acceptance:

   ```bash
   python3 "$IM_CONTROLLER" --config "$IM_CONFIG" session
   ```

   A session owns `home_dir/.im-acceptance.lock` continuously across builds, commands and manual IM interaction.
   A second session using the same canonical home, even with another state directory, is refused. Never remove the lock
   file: that would replace its inode and defeat exclusion. `status` reports the live kernel reservation and its owner.
   EOF, `exit`, or process termination releases the reservation; Server and daemon remain running and identifiable.
   Do not pipe commands and then leave the reservation released during manual acceptance.
5. While the old instance still runs, use the session's `build SOURCE FULL_SHA` command for each new candidate.
   Build failure leaves the old processes alone. `plan SOURCE FULL_SHA` verifies receipt, schema and ownership; when
   legacy processes still own the port it refuses with an address-in-use error. Resolve any schema/build refusal first.
6. Within this reserved adoption window, stop the legacy daemon and Server gracefully with the reviewed old controller.
   Its `stop` may also stop PostgreSQL: restart only the same existing Compose project's database with its existing
   configuration/volume and port mapping. Do not run old `up`, `restart` or `rebuild` against an upgraded database.
   Complete any separately authorized database upgrade under this reservation, before selecting a candidate.
   The config must already declare the verified resulting database source; do not change config while a session is open.
   If the resulting source differs, exit and reacquire with the corrected config before further commands.
7. Disable the legacy mutation entry **before** selecting a candidate. The old controller does not honor this lock,
   and Git worktree locks do not prevent launches. Replace its private `control.py` with a deny shim such as:

   ```python
   #!/usr/bin/env python3
   import sys
   print("Legacy IM control retired. Use the exclusive acceptance controller session.", file=sys.stderr)
   sys.exit(1)
   ```

   Keep a private backup for inspection only. Verify old wrapper calls to `up`, `restart`, `rebuild`, `daemon`, and `stop`
   now return nonzero without spawning anything. Use the new `status` command for inspection. A human can still bypass
   cooperative locking with direct process launches; do not use legacy launchers, CLI service commands or another home
   pointing at the same database during the session. The harness does not claim OS-wide exclusion over arbitrary commands.
8. In the still-open session, enter actual paths and SHAs (these are commands to the controller, not shell expansions):

   ```text
   plan /absolute/persistent/source-a FULL_40_CHARACTER_SHA_A
   select /absolute/persistent/source-a FULL_40_CHARACTER_SHA_A
   status
   ```

   Both process rows must show the expected SHA, build ID, source and argv, `running: true`, and `verified: true`.
   The Server must also show the matching `ready_revision`. Unknown port listeners are refused, never adopted or killed.
   Logs are private `state_dir/server.log`, `daemon.log` and `build.log`. A failed startup is recorded per role; no automatic
   rollback is attempted. Inspect status and logs, then use `stop` for the owned processes before retrying.

## Two-candidate acceptance

Keep the same session open. After candidate A's checks, enter `select SOURCE_B FULL_SHA_B`, inspect `status`, and repeat
real IM checks. Optionally select A again for comparison. `stop` gracefully stops only the two owned processes and leaves
PostgreSQL and all data intact. `exit` releases the session without stopping them. A later session with the same config
and state can inspect/stop them. A config change with existing runtime records is refused; stop under the original
config first, preserve the records, and coordinate a new state/config explicitly rather than editing ownership records.

Real IM acceptance is the coordinator's serialized step: confirm the expected Server revision and daemon command,
send an authorized Feishu test message, observe a single expected response and connected existing Agent, switch to B,
and repeat. Confirm existing connection/account/computer identity and local history survive. Capture redacted results
in `testing/`; do not publish credentials, logs or private message content. Offline tests do not complete this acceptance.

## Offline verification

```bash
node --test scripts/__tests__/local-im-control.test.mjs
```

This runs disposable Git repositories/worktrees, fake build output and small local Node processes on ephemeral ports.
It checks whole-session exclusion, wrong/reused PID refusal before stopping another role, dirty/abbreviated candidate
refusal, stale/failed build refusal, migration and schema differences before stop, unknown listener refusal, real
candidate switching, mismatched daemon credential targets, readiness revision mismatch, runtime persistence, and graceful shutdown. It uses no PostgreSQL,
provider API, real home, real environment file or existing IM process.

## Candidate validation record

Offline validation on macOS with Node 22.22.2 and Python 3.14:

- `node --test scripts/__tests__/local-im-control.test.mjs`: passed; all 14 isolated Python scenarios ran successfully.
- `pnpm check`: passed, including migration drift and Context Tree verification; existing repository warnings remain.
- `git diff --check`: passed.

The focused offline scope covers only an optional acceptance harness and its repository-script test, with no product
code or schema changes. The fake build/process path exercises the controller's writes, launches, shutdowns and ownership
checks directly. Normal pre-push hooks subsequently passed format, lint, `pnpm check`, and `pnpm typecheck`, including the
dependency builds selected by Turbo. Agent Runtime coverage and PostgreSQL integration tests were not run because their
implementation and database behavior are unchanged.

The coordinator subsequently adopted the reviewed controller and completed the first candidate's real Feishu DM,
memory and file checks. See the [redacted live acceptance record](live-acceptance.md) for the exact running revision,
results and remaining second-candidate acceptance. The implementation task did not operate the shared instance; adoption
and live observations belong to the coordinator. CI's complete regression matrix remains separate from this evidence.
