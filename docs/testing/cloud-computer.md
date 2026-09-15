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
