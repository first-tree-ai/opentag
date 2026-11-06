# Session interruption recovery release regression

Checklist for the Local Computer's automatic retries of interrupted Session work (at most 2 in a row, shared by process
interruptions and model 429). Run it against a test Agent on a
dedicated regression computer with an IM test conversation (Feishu or Slack) the Agent may reply in. Do not record
message contents, IDs or logs in the repository; keep results with the release PR or Issue.

Each case starts a Run long enough to interrupt (for example ask the Agent to run `sleep 60` and then reply "done"),
waits until the Agent is working, and then interrupts it as described. "Continues" means a new Provider Run starts in
the same Session after the daemon is back, its input begins with
`[OpenTag] Your previous turn was interrupted at … because … (automatic retry)`, and the original request follows.

## Prerequisites

- A Local Computer connected to a Server that negotiates `runtime.sessionRecovery` v1 (both on the release candidate).
- One Agent on that Computer with an IM binding, and permission to stop, kill and restart its daemon.
- For internal Sessions: a request that makes the visible Session run `opentag session create` for a long task.

## Daemon crash (power loss)

1. Start a long Run in a DM or thread, then kill the daemon process group (`kill -9` of the daemon and its children).
2. Start the daemon again.
3. Expected: within about a minute the Session continues with reason "the OpenTag daemon stopped (crash, power loss, restart, or upgrade)";
   no red "result cannot be confirmed" card appears; the working reaction stays until the retried Turn ends; the reply
   arrives once the retry completes, followed by any messages that queued meanwhile.

## Orderly restart or upgrade

1. Start a long Run, then run `opentag daemon restart` (or upgrade the client).
2. Expected: no "cancelled" outcome is reported and no error card appears; after the restart the Session continues
   with reason "the OpenTag daemon was restarted or upgraded".

## Automatic upgrade while Sessions run

1. On a portable install, start a long Run in an IM conversation and a long internal Session, then publish a newer
   channel target.
2. Expected: `opentag daemon status` does not stay in `awaiting_protected_work`. While the new version installs, a new
   IM message still gets a reply. After the restart both Sessions continue with reason "the OpenTag daemon was
   restarted or upgraded", with no error card and no creator notice. A second upgrade during the same Run also
   continues it.

## Completed report delivery failures without restarting the daemon

1. With a connected daemon, let an IM Turn complete and verify its immutable report
   exists in the Session binding. Inject failures into the separate Turn Report
   durability writes, including the first write and retry-transition writes.
2. Restore those writes within the delivery retry budget without reconnecting.
   Expected: the exact original report is delivered and acknowledged; failed writes
   never appear as committed state. Persistent failure consumes the capped retry
   budget and leaves the binding's report recoverable.
3. Exhaust report delivery into dead-letter, then restore storage/transport and
   request an ordinary recovery reconcile. Expected: the matching reporting Turn
   advertises retained custody; successful manifest delivery wakes report replay.
   Cancelling an unsent manifest sends no report. Repeated reconciles join an
   in-flight delivery instead of duplicating its send or resetting its backoff.
4. Expected: acknowledgement settles the original Turn once, releases its original
   admission reservation and reporting activity, and lets queued input proceed.
   No completed model task runs again. A running activity, mismatched Turn or
   delivery, wrong installation, stale placement, or changed live generation must
   not be taken over. Server terminal and authorization checks still apply.
5. Stop the daemon during a persistence retry. Expected: its timers stop, no late
   send occurs, and the retained Session report remains available on restart.
   If writing the Session report itself failed, do not claim a durable completed
   report or send an invented success.

## Retained report replay after reconnect

1. On the authorized test Computer, disconnect its runtime transport after a Turn finishes locally
   but before the Server records its report. Reconnect the daemon with its retained report intact.
2. Expected: a recovery reconcile may return `ready` or `stopped` with a retained report. Once the
   Server claims that exact delivery and Turn, it waits with `IM_DELIVERY_RECOVERY_REPORTING` and
   emits no `IM_DELIVERY_RECOVERY_AWAITING_REPORT` error during the gap before report arrival.
   The report settles the original Turn once, the working reaction clears, and no replacement Run starts.
3. Replay the same report again. Expected: it is acknowledged as already recorded, with no second
   settlement or additional reply. If the report arrives before recovery deferral, the terminal
   state remains intact.
4. In the controlled protocol test harness, repeat with no manifest, a mismatched dispatch, input,
   generation, Turn or result hash, and a valid retained report for another delivery. Expected:
   an unreported `ready`/`stopped` response still diagnoses the current missing report; no input is
   redispatched. Cancellation and failed reconcile completion preserve custody and still accept
   the authentic report through its normal path.

## Retries run out

1. Repeat the crash case, and kill the daemon again within a minute or so of each resume; start it again each time. Wait
   as long as you like between a kill and the next start: downtime does not count as running.
2. Expected: the first two interruptions each continue the Session. After the third, no further Run starts. The IM
   conversation shows the existing error card for the Turn (result cannot be confirmed), exactly once.
3. Let a resumed Run work for more than 5 minutes (for example `sleep 400`), then kill the daemon. Expected: the count has
   reset, so the Session continues again.

## Run timeout and model rate limit

1. Give the Agent a run budget shorter than the task (Agent settings), then send the long task.
2. Expected: when the budget expires there is no retry. The timeout error card appears once.
3. Give the Agent a budget of a few minutes, send a task that needs longer, kill the daemon about halfway through and
   start it after a while. Expected: the Session continues, and the timeout comes when the two parts of the run add up to
   the budget. The time the daemon was down does not count.
4. Where a model 429 can be provoked safely (an authorized low-limit test key), confirm the Turn retries after about 30
   seconds with reason "rate-limited the request (HTTP 429)", at most twice. Do not provoke rate limits on shared accounts.

## Internal Session

1. Ask the visible Session to delegate a long task to an internal Session, wait until the child Run is working, then
   kill and restart the daemon.
2. Expected: the child continues with the crash reason and later reports its result to the parent; the parent receives
   no "[openTag notice] Internal Session Run did not complete" notice. A third crash, each within a minute or so of the
   previous resume, produces exactly one such notice naming the failure.
3. A child whose budget expires does not retry: the parent receives one notice with outcome `timed_out`.

## Steered Session messages

1. Leave `OPENTAG_RUNTIME_CREDENTIAL_MODE` unset (the default Local credential mode). While a visible Session's IM Turn
   is working, send it a Session message. Expected: the message steers into that same Turn before it ends, using the
   existing channel or thread outbox target; it does not wait to start a separate callback Run. Cover both channel and
   thread Sessions with Feishu and Slack.
2. Kill and restart the daemon while the steered message is in the Turn.
3. Expected: the Turn continues, and the message is steered into it again with the notice that it may already have been
   handled. If that Turn fails, the message fails with it and does not run again; no creator notice follows, because the
   target is a visible Session.
4. Repeat with explicit `proxy` credential mode and verify the same steer and outbox target. A Server that does not
   negotiate credential grant v2 must refuse visible callback delivery; missing context never invents a target.

## Not retried

- A non-recoverable failure (for example revoked provider credentials) shows its error immediately, with no retry.
- A Computer connected to an older Server that does not negotiate `runtime.sessionRecovery` keeps the previous
  behaviour after a restart: the interrupted Turn reports `turn_state_unknown`, and waiting internal Session messages
  fail with a creator notice instead of waiting indefinitely.
