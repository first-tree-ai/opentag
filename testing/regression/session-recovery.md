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

## Feishu system reaction projection

With an authorized Feishu test binding, verify a running task has the App's `OnIt`, terminal success removes it,
and a terminal failure replaces it with `CrossMark`. Repeated projection retains the wanted reaction without
creating another. Reactions from users and other Apps, including the same emojis, remain untouched. Include a
message with more than fifty reactions so the App's reaction is found on a later page.

Use the controlled HTTP suite `im-feedback-feishu-http.test.ts` for request counts, simultaneous emoji writes,
incomplete or looping pagination, lost write acknowledgements and cancellation. It must show that a failed writer
is joined with its sibling before returning, and that a late read after the deadline starts no mutation. The
480 ms RTT model measures the Server component, not native provider latency; record actual provider timing
separately when an authorized test deployment is available.

## Feedback queue concurrency and drain

Use the controlled worker and PostgreSQL feedback suites to queue eight independent inputs with delayed transports.
Verify at most four projections run concurrently and the eighth can start after one round of completions. Multiple
attempts for one binding/channel/native input remain sequential within a worker, while other inputs keep progressing.
Concurrent store claimants must never own the same live target claim. A stale claim cannot settle a replacement claim.

Hold a projection across several timer ticks and explicit `runOnce` calls. Verify one `ImFeedbackWorker.runPass`
start/end pair for the actual pass, including a failed pass. Fail or time out one target and verify independent targets
still settle. Block the failed target's settlement with a PostgreSQL row lock after a cooldown-storage failure, then let
its siblings finish. No fifth target may be claimed or started while the failed settlement is waiting; releasing the
lock drains all already-admitted work. Saturate the shared provider-call pool, verify an unsent card stays pending, then
release capacity and verify one send succeeds. Queue deadlines remain definitely unsent, while in-flight send deadlines
retain unknown-send reconciliation. During controlled shutdown,
verify all admitted projections settle before the worker stops and a claim returned after stop starts no provider call.
Cancel an in-flight working task and verify its working reaction is removed without creating a failure card or replaying
execution. These deterministic checks do not establish native provider latency or deployment acceptance.

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
4. Delay a Local creator's reconcile or delivery receipt, and repeat with a Cloud creator waiting for a cold start.
   The Local child's `session:message:outcome` frame returns `retry` after notice persistence, before the delayed
   receipt. Measure that frame response separately from target Runtime acceptance and the creator's callback Run.
   The child's durable report remains pending; after acceptance is recorded, a replay returns `notified` without
   delivering another notice. Do not count the frame response as Runtime receipt or business completion.
5. Repeat with an offline creator, a database failure, a lost database commit response, concurrent duplicate reports,
   and a Server restart during delivery. The report stays retryable and the same notice ID is reconciled before any
   retry; a recorded acceptance is never dispatched again. On shutdown, preparation and outcome writes drain, active
   transport cancellation is signalled, and no later reconcile or delivery is sent. Runtime route shutdown rejects
   pending receipt waits; an unconfirmed delivery stays `unknown`, and restart replay reconciles the same notice ID
   through the target's deduplication. Cloud-origin settlement acknowledgements
   retain their existing bounded, final-notification wait.

## Stopping an internal Session

Ask the visible Session to create a long-running internal Session (for example `sleep 600`), and queue a second message
to it with `opentag session send`.

- `opentag session stop <id>` from its creator answers `status=stopped execution=stopped`. The Provider process is gone
  within seconds, the queued message never runs, and the daemon does not retry anything.
- `opentag session list` no longer shows it; `opentag session list --include-stopped` shows it with a stopped time.
- `opentag session send <id>` answers `rejected` with `target_unavailable`; a repeated stop answers `alreadyStopped=true`.
- The creator gets no notice. Repeat with a grandchild stopped from the root: its creator gets one notice saying the
  child cannot be continued.
- A sibling, or the Session itself, stopping it gets `not_ancestor`.
- Stop a Session that has a running child: the output reports one descendant still running, and the child keeps running.
- With the daemon's network cut while a Run is active, the stop answers `execution=pending`; the Run ends shortly after
  the network returns. With the daemon stopped instead, the waiting message fails after restart and is not run.
- With the daemon frozen (`SIGSTOP`) while a Run is active, the stop answers `execution=pending` within 15 seconds, not a
  request timeout; the Run ends after the daemon resumes (`SIGCONT`).
- On Cloud, the same stop answers `execution=requested` and the Run settles as cancelled, without a notice.

## Background work

Needs a real Provider CLI: the Lab's scripted Claude does not start background tasks. Run steps 1 to 4 on Claude Code,
Codex and Pi (on Pi with `background_bash`).

1. Send an internal Session a message telling it to start a short background command and end its Turn. Expected: the Run
   stays `running` after the Turn ends, the Session gets the result without another message, and the record is `succeeded`
   only after that turn.
2. Send it a message while it waits. Expected: the message joins the Run and is answered at once, and the Run still waits.
3. Give it a short `maxDurationMs` and a background command that outlives it. Expected: the sender gets `timed_out`, the
   command stops, and the next message's Run starts with `[openTag notice] Your previous Run reached its duration limit`,
   naming the command.
4. Kill the Provider process (only it, not the daemon) during the wait. Expected: the message is retried with the
   continuation notice, and it names the command as possibly still running.
5. Give a Run a 20-minute `maxDurationMs` and keep it busy. Expected: about 2 minutes before the limit the Session reads
   `[openTag notice] This Run reaches its duration limit`, and the Run stops at the limit with no extra time.
6. Ask a Session to check something in 30 minutes. Expected: it creates a Schedule and no background process, and the firing
   is a new Run.
7. On Claude Code, send a message after an orphaned background task. Expected: the transcript shows the task notification
   and then the message, followed by an assistant reply, not `No response requested.`, and the record `succeeded` only
   after that reply.

## Schedules on an internal Session

1. Have an internal Session run `opentag agent self schedule create`. The result's `target` is that Session, with
   `internal: true`. Web lists it as "Internal Session" with a short ID.
2. When it fires, the message runs in that Session and nothing is posted to IM.
3. Make a scheduled Run fail. Its creator gets one Run outcome notice, and IM gets nothing.
4. Run `opentag session stop` from its creator. The schedule is off, and nothing fires afterwards.

## Steered Session messages

1. Leave `OPENTAG_RUNTIME_CREDENTIAL_MODE` unset (the default Local credential mode). While a visible Session's IM Turn
   is working, send it a Session message. Expected: the message steers into that same Turn before it ends, using the
   existing channel or thread outbox target; it does not wait to start a separate callback Run. Cover both channel and
   thread Sessions with Feishu and Slack.
2. Kill and restart the daemon while the steered message is in the Turn.
3. Expected: the Turn continues, and the message is steered into it again with the notice that it may already have been
   handled. If that Turn fails, the message fails with it and does not run again: the person gets the error card, and the
   message's sender gets a notice.
4. Repeat with explicit `proxy` credential mode and verify the same steer and outbox target. A Server that does not
   negotiate credential grant v2 must refuse visible callback delivery; missing context never invents a target.

## Parent message steered into a running child

Use a steer-capable Provider (Claude Code on a current version). A child's long task is its parent's Session message Run.

1. While the child is working, have the parent run `opentag session send <child-id>` twice with short follow-ups.
2. Expected: the follow-ups reach the running child at its next tool boundary, in order, with no new Provider Run for them;
   all messages succeed together when the Run completes.
3. Repeat, then kill and restart the daemon after the follow-ups were steered. Expected: the child resumes with the crash
   notice, the follow-ups arrive again in order, each with the notice, and the parent gets no failure notice.
4. Repeat the crash until the retries run out. Expected: the child's message fails, and the steered follow-ups fail with it:
   one notice per message to its sender, no further Run. A message queued but not yet steered runs on its own.
5. Make the child's task fail without a retry while a follow-up is steered into it. Expected: both fail with one notice each to
   the sender, and no further Run.

## Failure notice to the sender

1. Have a child send a Session message to its visible parent, and make that Run fail. Expected: the child, as the sender, gets
   one notice naming the parent's Session, and the parent's IM conversation gets no error card.
2. Have one child send a message to a sibling, and make that Run fail. Expected: the sending child gets one notice; their parent
   gets none.
3. Make a parent's task fail in its child. Expected: the parent gets exactly one notice, though it is both sender and creator.
4. Make a scheduled message fail in an internal Session. Expected: its creator gets one notice. In a visible Session: no notice.

## Not retried

- A non-recoverable failure (for example revoked provider credentials) shows its error immediately, with no retry.
- A Computer connected to an older Server that does not negotiate `runtime.sessionRecovery` keeps the previous
  behaviour after a restart: the interrupted Turn reports `turn_state_unknown`, and waiting internal Session messages
  fail with a notice to their sender instead of waiting indefinitely.
