# E1 Local Pi acceptance

[简体中文](../zh-CN/testing/cloud-computer.md)

This maintained E1 harness exercises a local Pi Computer through the production Server and
CLI daemon. Run it after building the candidate to be accepted:

```bash
pnpm build
node scripts/e2e/cloud-computer.mjs local-pi
```

`node scripts/e2e/cloud-computer.mjs --help` lists prerequisites and options. Completion
requires exit code 0, all assertions passing, and successful cleanup. The artifact records
the Git SHA and dirty flag; a run on a working diff is discovery evidence, not acceptance of
a later commit or build.

## What is verified

1. Start disposable PostgreSQL with current migrations and a loopback production Server.
   Authenticate using the Server's development sign-in, issue a Computer connection code,
   and exchange it using the real CLI.
2. Start the CLI daemon, observe a registered online Computer, and require live Pi readiness.
   Create a Pi Agent and update its runtime configuration through Account APIs. A narrow
   Codex/Claude create, suspend, and delete check verifies API admission without model calls.
3. Write a random nonce into a private fixture file. Pi must read that file and write the
   exact expected output. Check actual files, generated Pi tool history, the persisted Pi
   Session binding, and the Server-recorded Turn receipt.
4. Delete the nonce-bearing fixture and output. Ask the same Session to recall the nonce,
   allowing only a write tool call. Require matching output and unchanged Pi binding.
5. Stop the Client process and start a new one using the same isolated home. Require a new
   PID and connection `instanceId`. Delete the preceding output and repeat the write-only
   recall to verify Pi persisted conversation history across the process restart.
6. Start a foreground child that records its PID and schedules a file write 15 seconds later.
   Shut down the real daemon with SIGTERM while Pi and that child are alive. Require daemon,
   Pi, and child termination within 10 seconds, then verify the late file was never created.
   Restart the Client so a pending durable receipt can be delivered; require the Server's
   recorded outcome to be `cancelled` with `errorReason=client_shutdown`.
7. Stop owned processes, delete the owned private workspace, and remove the disposable
   PostgreSQL container. Cleanup failures make the command fail.

## Failure and recovery checks

The Pi runtime regression suite also exercises incomplete model terminals, process teardown
failure, crossed Session bindings, empty resumed history, malformed RPC events, and cancellation
races. A successful run requires `agent_settled`, final assistant `stopReason=stop`, and successful
process cleanup. Length-limited output and a terminal tool call are failed runs with partial output.

A new Session can start empty. Its binding remains unmaterialized until Pi saves conversation
history. If the first Run stops before its first file exists, a later Turn reopens the same Pi UUID,
including after a Client restart. Pi starts an empty file only when that UUID has no saved history;
if history was saved before OpenTag could update the binding, it resumes that existing file.
This is recovery for later work, not automatic replay of the interrupted Turn.
Once materialized, missing or empty history fails before another prompt is submitted; OpenTag
must not silently reset a saved conversation. Restore that history or explicitly replace the Session. The binding checks Session identity and
file path, not a content checksum: partial history corruption with remaining messages is not
detected by these checks, and this increment does not implement automatic history repair.

## Requirements

- Node and pnpm versions supported by this repository, plus a successful `pnpm build`.
- Docker for a disposable `postgres:17-alpine` container, bound only to loopback.
- A real `pi` executable on PATH, compatible with the production adapter, and usable model
  credentials. The harness copies selected configuration files from `PI_CODING_AGENT_DIR`
  or `~/.pi/agent` into its private fixture. The current workspace authorizes the existing
  DeepSeek configuration for this test. Model calls consume the configured provider's quota.
- An available loopback Server port; the default is `8131`.

Pi must be supported by built Shared, Server admission, and production Client composition.
Missing admission or missing usable provider readiness fails the run.

## Product path and E1 boundary

The real CLI `computer connect` obtains the machine token. The daemon `service-run` composes
`RuntimeConnection` and `createClientRuntime` through public Client exports. The Server
assembles runtime snapshots and manages delivery custody in PostgreSQL.

E1 supplies a normalized synthetic IM event to `ImMessageInbox.ingest` using a harness-only
`tsx` helper that imports Server source. The real Server `ImDeliveryWorker` then dispatches
through `RuntimeDomainOwner` and the live runtime WebSocket. This source import belongs to
test composition only; it does not introduce a production package dependency.

Visible Sessions currently require an IM credential grant. E1 inserts an isolated Slack
installation and binding with dummy encrypted credentials, then uses the production grant
service. An E1-only `slack` executable answers version, command-surface, and `auth.test`
probes locally. Other Slack commands fail. No Slack/Feishu request or external message
is sent. Real IM ingress, authentication, and delivery acceptance remain E4 work.

Agent suspend currently refuses to stop an active Turn (`busy/active_turn`), and the Server
can report `AGENT_SESSION_STOP_FAILED` while the suspend API returns success. E1 therefore
verifies Client runtime shutdown. It does not claim per-Session UI cancellation; reliable
Server stop/status control remains an E4 limitation to resolve.

## Isolation and artifacts

The Server and Client receive an isolated HOME; OPENTAG_HOME, Pi sessions, Codex home,
Claude config, and Provider CLI state all stay inside the owned fixture. No canonical Context
Tree is configured or accessed. No real account Provider CLI files are snapshotted, changed,
or restored. Pi config is copied silently to a `0700` directory with `0600` files, then
removed during cleanup, including when PostgreSQL is intentionally kept.

The artifact directory contains:

- `summary.json`: source identity, Pi/client versions, model names, tool names, receipt IDs,
  outcomes and hashes, runtime IDs/PIDs, stop timing, assertions, and explicit substitutes.
- Redacted Server/daemon stdout and stderr logs.
- Synthetic ingress event JSON with fixture paths and instructions, without model credentials.

The summary omits conversation text and the nonce. Credentials are never intentionally
written to artifacts. Nonzero exits retain the failed phase and available sanitized evidence.

| Variable | Meaning |
| --- | --- |
| `OPENTAG_E1_ARTIFACTS` | Artifact directory; defaults to a unique temporary directory |
| `OPENTAG_E1_PORT` | Loopback Server port; default `8131` |
| `OPENTAG_E1_KEEP` | `on` keeps only the disposable PostgreSQL container; remove it manually afterward |
| `PI_CODING_AGENT_DIR` | Optional source of Pi configuration copied into the private fixture |

# E2 Cloud identities acceptance

This maintained E2 harness proves Cloud Computer and Sandbox identity against a real Server and
disposable PostgreSQL. It does not start Pi, call models, allocate GCP, or send Slack/Feishu traffic.

```bash
pnpm build
node scripts/e2e/cloud-computer.mjs cloud-identities
```

`node scripts/e2e/cloud-computer.mjs cloud-identities --help` lists requirements. Completion requires
exit code 0, every assertion passing, and successful cleanup. `summary.json` records exact Git HEAD,
dirty flag, assertions, substitutions, PID/exit evidence, and actual cleanup results. A dirty working
tree is discovery evidence, not acceptance of a later commit.

## What is verified

1. Clean database boot applies 43 migrations. A separate E1 baseline from commit
   `440dfed53c3bb22a8527cd731f82e9b9006bd9b5` through idx 41 upgrades into the current Server; a seeded
   Local Computer, machine credential, Pi Agent, and runtime config are preserved, including migration
   hash prefix.
2. Two real development sign-ins by restarting `OPENTAG_DEV_AUTH_EMAIL`, keeping common auth secrets.
   `/api/v1/me` account IDs and Cookie/CSRF are present. Unauthenticated and CSRF-free mutations are
   rejected without creating rows.
3. Concurrent Cloud ensure (`PUT /api/v1/computers/cloud`) yields one ID and one row per Account.
   Metadata is linux/x64, configured CLI version, and a nonempty stable installation UUID. Cloud rows
   have no `computer_credentials`, `current_instance_id`, `connected_at`, or `last_seen_at`.
   `x-opentag-cloud-identity: 1` lists include `kind: cloud` logical online. Old, missing, or
   readiness-v2-only headers hide Cloud and keep the legacy Local list shape. Unknown Cloud capability
   versions also keep that shape. With both capability and readiness headers, Cloud remains logically
   online while Pi is unavailable with no observation timestamp.
4. Create a Pi Cloud Agent through `POST /api/v1/agents`. Insert labelled test-only Slack
   installation/binding SQL. Concurrent Sandbox ensure (`POST /api/v1/sandboxes`) is idempotent.
   Different channels, threads, bindings, and users get distinct Sandbox/Session/URI rows. SQL checks
   `sessions → im_bindings → agents` ownership and `session_placements` Computer. Sandboxes start
   unallocated, environment generation 0, resource fields null. Extra `accountId`/`agentId` and
   malformed thread scope are rejected.
5. Foreign Account ensure/query/create/rebind is a non-disclosing refusal matching unknown-ID errors.
   No partial rows.
6. Server restart uses a new PID and recorded old exit. Authenticated Cookie jars and Cloud / Agent /
   Session / Sandbox IDs plus `storage_uri` stay the same. Changing storage prefix/version on restart
   does not overwrite existing rows. `OPENTAG_CLOUD_IDENTITIES_ENABLED=false` blocks Cloud ensure,
   known Cloud Agent create including intent replay, and new Sandbox ensure; existing reads and Local
   paths remain available.
7. Cloud Codex/Claude-Code create is rejected; runtime provider cannot be changed. Local↔Cloud rebind
   is rejected; Local→Local works; Cloud same-ID rebind is idempotent.
8. Local connect-code create/exchange/register/query and repair preserve Computer ID, rotate the
   credential, and reject the prior token. Registration uses the production runtime WebSocket. Old
   unmarked exchange and Local list shapes are preserved. Repair issuance targeting Cloud is rejected.
   A forged repair-code row and a fake Cloud machine credential are disposable negative fixtures and
   are removed. Installation collision with Cloud is rejected. Identity is not overwritten.
9. A transaction that writes duplicate Sandbox resource name+UID hits the unique constraint and rolls
   back. This is a DB-only ownership test, never GCP allocation.

## E2 boundary

E2 does not allocate compute, write storage objects, run a Runner, call a model, or deliver IM.
Those belong to E3 (Runner), E4 (real IM), and E9 (default product UI). No customer-facing UI is added
here. The disposable Postgres helper still names containers with the E1 prefix; summaries label E2.

The existing Agent setup and preparation-refresh endpoints are Local-only during E2 and return 404
for a Cloud-bound Agent. Cloud identity and Sandbox reads remain available; Cloud must not appear
offline or offer a Local repair action while its product setup flow is deferred to E9.
Sandbox creation locks the active IM binding until commit so a concurrent provider-driven disable
can terminate the newly committed Session instead of leaving it active behind a disabled binding.

| Variable | Meaning |
| --- | --- |
| `OPENTAG_E2_ARTIFACTS` | Artifact directory; defaults to a unique temporary directory |
| `OPENTAG_E2_PORT` | Loopback Server port; allocated if unset |
| `OPENTAG_CLOUD_IDENTITIES_ENABLED` | Server Cloud creation flag (`true`/`false`, default `false`) |
| `OPENTAG_CLOUD_STORAGE_BASE` | Sandbox storage prefix; fixture default `gs://opentag-e2-fixture/sandboxes` |
| `OPENTAG_CLOUD_RUNNER_VERSION` | Cloud Computer `client_version`; fixture uses `apps/cli/package.json` |

## E3 native execution

See [Cloud Runner execution](../cloud-runner-execution.md) for configuration, native Sandbox
acceptance, resource receipts, cancellation, and verified teardown. The command is
`node scripts/e2e/cloud-computer.mjs cloud-runner --help`; it creates real Cloud resources.

## E4 Cloud delivery (local composition only)

See [Cloud Runner execution](../cloud-runner-execution.md) for the E4 control, credential/model,
continuity and cancellation boundaries. There is no GCP/IM E4 harness yet. The maintained local
checks are:

```bash
pnpm build
pnpm --filter @opentag/shared test
pnpm --filter @opentag/client exec vitest run src/__tests__/cloud-journal.test.ts src/__tests__/cloud-turns.test.ts src/__tests__/cloud-turn-worker.test.ts src/__tests__/cloud-sandbox-credential-bridge.test.ts src/__tests__/runner-serve.test.ts
pnpm typecheck
```

They use real loopback WebSockets, real local child processes and disposable fixture roots, but no
native Cloud Run namespace, no real IM provider and no GCP allocation. Native cancellation/reset,
native Unix-socket mounts, connection-loss grant revocation, and IM reply acceptance therefore
remain pending real-environment evidence. E4 adds no new database tables. E5 workspace persistence is described in
[Cloud workspace persistence](../cloud-workspace-persistence.md); its live acceptance must
include release and replacement, rather than treating this E3/E4 harness as persistence evidence.
E6–E8 remain separate work.
