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

## Offline notice

With an IM test binding on a Local Computer and permission to stop its daemon:

1. Stop the daemon and send a direct request in Chinese. Expected: no reply before sixty seconds, then within about
   seventy-five seconds one red card titled “Agent 所在电脑离线” with the body “电脑恢复后会自动处理” and no link. No
   Computer name or person is named. In a direct message the card is not a quote reply.
2. Send two more requests in the same Session. Expected: no further notice. Send one in another Session of the Agent.
   Expected: that Session gets its own single notice.
3. Open the Agent page signed in as the Agent owner. Expected: the Computer shows as offline, and its link opens the
   recovery page with the restore command.
4. Restart the daemon. Expected: the parked messages run and no "back online" message appears. Stop it again and send
   a request. Expected: one new notice for this new offline period.
5. Restart the daemon within sixty seconds of a new request. Expected: no notice.
6. Send a request to an Agent on Cloud while its Runner is unavailable. Expected: no offline notice.

## Parked-dispatch notice

A parked dispatch is hard to cause on purpose: the Computer must stay connected while its dispatch acknowledgement never
arrives (for example a daemon whose reconcile hangs) until the dispatch timeout cap is reached. With a test stack where
that can be arranged, or with a delivery row set to `pending` and `last_error_code = 'IM_DELIVERY_PARKED'` on a test
database:

1. With the Computer online, send a Chinese request in the same Session. Expected: within about seventy-five seconds
   one red card titled “排队中” with the body “前一条完成后处理”, placed like the offline notice, whose only link is its Session ID line. It names no earlier message, person or Computer. The Server log has one `IM_DELIVERY_DISPATCH_PARKED` error line.
2. Send another request in the same Session. Expected: no further notice.
3. Send a request in another Session of the Agent. Expected: no parked-dispatch notice there.
4. Stop the daemon and send another request in the first Session. Expected: no notice, because this Session already had one
   since the parked message arrived.

## Failure messages

With an IM test binding and a runtime that can be made to fail on request:

1. Send a Chinese request that fails in a direct message. Expected: one red card, not a quote reply, titled
   “Agent 运行出错” with a body that says what went wrong and ends “请重试” (a model failure reads “模型调用失败，请重试”). It shows no error code, no button, and no sentence about whether
   operations ran, and the failed reaction appears. Its last line is small grey text “Session：<full Session ID>”; clicking
   the ID opens that Session's Task page. On Slack the attachment bar is red, and no copy of the text
   shows above the card.
2. Send an English request that fails. Expected: the same card in English. Mentioning a Bot with a Chinese name
   does not change the language.
3. Repeat in a group. Expected: Feishu quotes the failed message; Slack posts in the channel, not a thread. Repeat
   inside a thread. Expected: the card is in that thread on both.
4. Make the model authentication fail. Expected: the card names the Agent’s tool, for example “Claude Code 未登录或登录已失效”
   with “请在 Agent 所在电脑登录 Claude Code” (Codex and Pi likewise), and no link. Only an Agent on the Cloud Computer
   keeps the generic “模型未登录或登录已失效” with “请在 Agent 所在电脑登录模型账号”.
   Every card here ends with the Session ID line; it is the card's only visible link.
5. Make the workspace save fail. Expected: a red card “工作区改动没能保存” with the body “请在 OpenTag 重试保存或放弃改动”, no button, and the Session ID line.
   As the Agent owner, open the failure from the Agent page and confirm a save on its details page. Expected: the card
   turns green in place and reads only 已保存, keeping the Session ID line. Repeat with Discard, which asks for the
   permanent-loss confirmation first and ends as 已放弃改动.
6. Older messages. Use the PostgreSQL feedback suite (`im-feedback.test.ts`) and the messenger suite
   (`im-feedback-messenger.test.ts`), or a test deployment upgraded from a release that sent text:
   - A target stored as `text_v1` that never sent: it is rewritten to `interactive_v1` when the send is reserved and
     is sent once as a card.
   - A text message already sent: a later status change edits it as text and posts no new message.
   - A card from before the text period: a later status change edits it in place as a current card.
   - A send whose outcome is unknown: readback binds the message (Slack by its `opentag_feedback:<id>` block ID or a
     text message's details URL, Feishu by the feedback URL) and never creates a second message.
   - Clicking a button on a card from before the text period: Slack answers without an error and does nothing; a
     Feishu Retry button shows a "no longer available" toast. Neither returns a server error.

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

For policy refusals, run the controlled HTTP and durable feedback suites with synthetic code 21001.
Verify the worker preserves the known reaction before any write, stops reaction retries for that revision,
and keeps an ambiguous partial mutation unknown. Confirm that feedback and approval SDK failures emit no
raw stdout diagnostics.

## Feedback queue concurrency and drain

Use the controlled worker and PostgreSQL feedback suites to queue eight independent inputs with delayed transports.
Verify at most four projections run concurrently and the eighth can start after one round of completions. Multiple
attempts for one binding/channel/native input remain sequential within a worker, while other inputs keep progressing.
Concurrent store claimants must never own the same live target claim. A stale claim cannot settle a replacement claim.

Hold a projection across several timer ticks and explicit `runOnce` calls. Verify one `ImFeedbackWorker.runPass`
start/end pair for the actual pass, including a failed pass. Fail or time out one target and verify independent targets
still settle. Block the failed target's settlement with a PostgreSQL row lock after a cooldown-storage failure, then let
its siblings finish. No fifth target may be claimed or started while the failed settlement is waiting; releasing the
lock drains all already-admitted work. Saturate the shared provider-call pool, verify an unsent failure message stays pending, then
release capacity and verify one send succeeds. Queue deadlines remain definitely unsent, while in-flight send deadlines
retain unknown-send reconciliation. During controlled shutdown,
verify all admitted projections settle before the worker stops and a claim returned after stop starts no provider call.
Cancel an in-flight working task and verify its working reaction is removed without creating a failure message or replaying
execution. These deterministic checks do not establish native provider latency or deployment acceptance.

## Channel Session idle compaction

Run once per Provider the release supports on a Local Computer. Send a Channel Session a message containing a codeword
and let it reply. Stop the daemon, set `lastActivityAt` in the Session's file under `runtime/channel-activity/` in the
OpenTag home to more than 8 hours ago, start the daemon, and ask for the codeword. The Turn compacts first (Claude Code
transcript `compact_boundary`, Codex `contextCompaction` item, Pi `compaction_end`), the Session and native conversation
IDs are unchanged, and the reply has the codeword. Repeat with the file set just under 8 hours ago: no compaction. A
Thread Session never compacts.

## Daemon crash (power loss)

1. Start a long Run in a DM or thread, then kill the daemon process group (`kill -9` of the daemon and its children).
2. Start the daemon again.
3. Expected: within about a minute the Session continues with reason "the OpenTag daemon stopped (crash, power loss, restart, or upgrade)";
   no "result cannot be confirmed" failure message appears; the working reaction stays until the retried Turn ends; the reply
   arrives once the retry completes, followed by any messages that queued meanwhile.

## Orderly restart or upgrade

1. Start a long Run, then run `opentag daemon restart` (or upgrade the client).
2. Expected: no "cancelled" outcome is reported and no failure message appears; after the restart the Session continues
   with reason "the OpenTag daemon was restarted or upgraded".

## Automatic upgrade while Sessions run

1. On a portable install, start a long Run in an IM conversation and a long internal Session, then publish a newer
   channel target.
2. Expected: `opentag daemon status` does not stay in `awaiting_protected_work`. While the new version installs, a new
   IM message still gets a reply. After the restart both Sessions continue with reason "the OpenTag daemon was
   restarted or upgraded", with no failure message and no creator notice. A second upgrade during the same Run also
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

## Local Session CLI proof refresh after reconnect

1. Start a Turn on the authorized Local test Computer and keep its daemon and Provider Run alive while its
   WebSocket disconnects and reconnects. While the same Turn is still active, trigger a ready reconcile for that
   Session through normal Session message dispatch.
2. Expected: the running Turn's next authorized Session CLI request succeeds after the ready reconcile completes.
   The Turn continues with its original identity, and eligible inline messages can use the active Session.
   Repeat while the Turn is reporting and check that its report can still settle.

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
5. Keep an obsolete report for a root IM Turn on a Client that negotiates Turn Report v6. Steer
   a child input into that Turn, then have the Server record a different terminal outcome of
   `unknown` before the Client can submit its report. Exercise both live custody and replay
   from disk, including a completed report retained with its input receipt. Expected: the
   Server's terminal result is preserved, the root is deduplicated, and the requeued child
   starts new work instead of being absorbed by the terminal Turn.
6. Repeat with a different Server report whose outcome is `completed`. Expected: the obsolete
   report is retired and the child keeps its steer receipt. Receipts for other Turns are
   preserved in both cases.

## Retries run out

1. Repeat the crash case, and kill the daemon again within a minute or so of each resume; start it again each time. Wait
   as long as you like between a kill and the next start: downtime does not count as running.
2. Expected: the first two interruptions each continue the Session. After the third, no further Run starts. The IM
   conversation shows the existing failure message for the Turn (result cannot be confirmed), exactly once.
3. Let a resumed Run work for more than 5 minutes (for example `sleep 400`), then kill the daemon. Expected: the count has
   reset, so the Session continues again.

## Run timeout and model rate limit

1. Give the Agent a run budget shorter than the task (Agent settings), then send the long task.
2. Expected: when the budget expires there is no retry. The timeout failure message appears once.
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

### Creator report delivery from a Local Codex child

Use a Codex App Server test double to emit completed command items for the managed `session send <creator> --message`
inside a successful child Run. Exercise these results with the existing Session collaboration connection.

1. With an accepted receipt, the creator gets the report through the normal delivery path and receives no failure notice.
2. With a rejected receipt, the creator gets one child report delivery notice with outcome `failed`. With a synthetic
   `SERVICE_UNAVAILABLE` receipt, the notice instead reports `unknown`. In both cases the child Run stays succeeded.
3. Emit repeated uncertain results followed by acceptance with the original message ID and text in the same Run. Confirm
   there is no notice. Acceptance under a different ID or with different text leaves the original outcome unresolved.
4. Replay the pending outcome after restarting the reporter. Confirm the work does not run again and the Server reuses
   the notice ID. Repeat with a v4 Server and confirm the report waits until collaboration v5 is negotiated.

## Local Pi steering during prompt startup

1. Start a Local Pi IM Turn with a controlled Pi RPC process. Hold prompt acceptance after
   `run_started` and send an IM follow-up. Confirm that the Client promptly returns
   `retry/turn_starting`, the Server keeps the follow-up queued, and Pi receives no steer.
2. Release prompt acceptance before the Turn ends. Confirm the retried follow-up joins that
   Turn once, and a repeated request returns the same accepted outcome without a second steer.
3. While a Local Pi Turn is waiting for prompt acceptance, queue two Session messages. Confirm
   they remain queued during startup and join that Turn in FIFO order once Pi accepts the prompt.

## Local IM steer receipt after the delivery deadline

1. Use a controlled Local Runtime to start an IM Turn. Send an ordered follow-up, hold its
   `im:steer:result` past the Server worker deadline, then return it before the Root Turn reports.
2. Return `steered` and replay the receipt. Confirm that the follow-up stays with the original Turn
   and the Server never delivers it as a new Turn.
3. Repeat with `turn_not_running` or `turn_starting`. Complete the Root and verify that queued
   messages run once in their original order. A receipt reporting `steer_state_unknown` keeps its
   original dispatch and must never start a new Turn for that input.
4. In each run, confirm that expiry of the Local waiter does not emit
   `IM_DELIVERY_OPERATION_LATE_SETTLE`.

## Cloud Session message steering

1. Start a child with a long-running Pi Turn. Send two distinct instructions using `session send`. Confirm that
   the child sees both in order before its Turn ends and the Runner starts only one worker. Confirm each
   message settles once after the joined Turn's checkpoint.
2. With a controlled worker that refuses steer or reports `not_started`, confirm the message runs in FIFO order
   after the child Turn. If it reports `interrupted`, confirm the failure is terminal and no second worker handles it.
3. Disconnect the control channel after a steer starts. Reconnect the same Runner and confirm that the input is
   never injected again and its settlement can be acknowledged. Replace the process without a worker receipt and
   confirm it reports unknown. An older compatible Runner still runs the messages in FIFO order.

## Stopping an internal Session

Ask the visible Session to create a long-running internal Session (for example `sleep 600`), and send a second message
to it with `opentag session send`. Confirm the message is still queued or joined to the same running Turn before stopping it.

- `opentag session stop <id>` from its creator answers `status=stopped execution=stopped`. The Provider process is gone
  within seconds, the queued message never runs, and the daemon does not retry anything.
- `opentag session list` no longer shows it; `opentag session list --include-stopped` shows it with a stopped time.
- `opentag session send <id>` answers `rejected` with `target_unavailable`; a repeated stop answers `alreadyStopped=true`.
- The creator gets no notice. Repeat with a grandchild stopped from the root: its creator gets one notice saying the
  child cannot be continued.
- A sibling, or the Session itself, stopping it gets `not_ancestor`.
- Stop a Session with running descendants two levels down: the output reports them stopped, all their Provider processes
  are gone within seconds, none of their creators gets a notice, and a sibling outside the tree keeps running.
- A parent whose Run has ended, with a child still running: the child is unaffected until the parent is stopped.
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
7. On Cloud, kill the Pi process inside the Sandbox during a Turn. Expected: the Turn continues in the same
   Sandbox with the continuation notice, and reports one result.
8. On Claude Code, send a message after an orphaned background task. Expected: the transcript shows the task notification
   and then the message, followed by an assistant reply, not `No response requested.`, and the record `succeeded` only
   after that reply.

## Approval requests in Session message Runs

Needs a real Local Claude Code Agent and a real Local Codex Agent with approvals on (the default `on-request`), and a
command outside the Agent's command rules, such as `ps -ax -o pid,command | grep -c node || echo none`.

1. On Claude Code, send a visible Session a request to create an internal Session whose message asks it to run that
   command and reply with the output. Expected: within seconds an approval card appears in that visible Session's
   conversation, naming the internal Session and the command, with the sender of your request as the approver.
2. Approve. Expected: the command runs, the child replies with its output, and the record is `succeeded`.
3. Repeat and deny. Expected: the child is told the action was declined and replies that it needs approval.
4. Repeat and leave the card alone. Expected: after 10 minutes the card shows the request expired, the child is told
   nobody answered, and the Run ends normally instead of waiting for its duration limit.
5. Repeat 1 to 3 on Codex. Expected: the same; on a decline the reason appears as an OpenTag approval notice on the
   active turn alongside the native decline.
6. Have a Schedule start the chain in a conversation with no earlier human message. Expected: no card; the request is
   declined at once and the child says the step needs approval.
7. Send the same request directly in an IM conversation (an IM Turn). Expected: the normal approval card for the
   sender, unchanged.

## Schedules on an internal Session

1. Have an internal Session run `opentag agent self schedule create`. The result's `target` is that Session, with
   `internal: true`. Web lists it as "Internal Session" with a short ID.
2. When it fires, the message runs in that Session and nothing is posted to IM.
3. Make a scheduled Run fail. Its creator gets one Run outcome notice, and IM gets nothing.
4. Run `opentag session stop` from its creator. The schedule is off, and nothing fires afterwards.

## IM messages during a pending approval

1. With a Local Codex test double, start a DM Turn and leave its approval pending. Send another DM. Confirm the
   Server retains the follow-up in its delivery queue and the Provider receives no steer for it.
2. Repeat with Approve, Deny, and Provider-side expiry. Keep the original Turn running after the approval resolves
   and confirm the queued message steers into it once, ahead of later messages. If the original Turn ends first,
   confirm the queued message runs as a new Turn.
3. Replay a steer that was already accepted before the approval. Confirm the existing receipt is returned and the
   Provider receives the message only once.

## Steered Session messages

1. Leave `OPENTAG_RUNTIME_CREDENTIAL_MODE` unset (the default Local credential mode). While a visible Session's IM Turn
   is working, send it a Session message. Expected: the message steers into that same Turn before it ends, using the
   existing channel or thread outbox target; it does not wait to start a separate callback Run. Cover both channel and
   thread Sessions with Feishu and Slack.
2. Kill and restart the daemon while the steered message is in the Turn.
3. Expected: the Turn continues. If the Agent had already answered after the message, it is not injected again (Claude Code and
   Codex). Otherwise, and always with Pi, it is steered in again with the notice that it may already have been handled. If that
   Turn fails, the message fails with it and does not run again: the person gets the failure message, and the
   message's sender gets a notice.
4. Repeat with explicit `proxy` credential mode and verify the same steer and outbox target. A Server that does not
   negotiate credential grant v2 must refuse visible callback delivery; missing context never invents a target.

## Cloud workspace restore and idle seal

Use an authorized disposable Cloud Session with persistence enabled. Keep operational approval
for stopping/replacing Instances separate from permission to run this catalogue.

1. Save a workspace containing Git state, Pi history and unpublished Context Tree drafts. Stop
   and replace its Instance through the normal release path. Expected: the replacement verifies
   and restores all saved content before readiness, advances the storage metadata fence and does
   not repack or upload the restored archive. The restore reports `extractMs` with the fingerprint
   included. The first empty workspace still saves a valid archive.
2. Run an ordinary checkpoint after a file change, then another without a change. Verify that each
   checkpoint conditionally commits an archive generation and reports `packMs` with the fingerprint
   included, and that both archives restore the expected contents.
3. Let the restored workspace become idle without a Turn, then release it. Expected: after
   quiescing writers, the Runner checks actual file contents and seals the same archive generation
   by a conditional metadata update. Restart and verify the unpublished files and history again.
4. Make a real file change through a controlled tool or background writer between checkpoint and
   idle release, including a same-length change with a restored mtime. Expected: release saves and
   restores the changed bytes instead of treating absence of Turns as proof of cleanliness.
5. In the controlled transport harness, race an older upload with a same-allocation fencing claim,
   and race a seal with a claim. Expected: generation/metageneration preconditions prevent stale
   data or seals from replacing the current state; a same-owner claim cannot reopen a sealed object.
   Make identical metadata PATCHes leave metageneration unchanged in the transport harness. Expected:
   successive unsealed claims still change metadata and fence earlier pins, including for a new seed.
   Lose an older fencing response, then let a successor claim/save before readback. Expected: the
   older request neither advances nor receives the successor's pins, including when the old PATCH
   is rejected or never commits before response loss. The successor can still seal, while an old
   upload with original pins is rejected. Restart a real Runner while the allocation
   is releasing and retry stop: it restores the same-owner object and completes the final seal.
6. Inject missing/corrupt media, failed metadata updates, lost responses, transfer timeouts and
   cancellation. Expected: only exact durable readback proves success; uncertain results retain
   local state and block execution. Retry/restart preserves the latest complete archive and never
   replays a business action. Check durable bytes and object versions, not only diagnostic logs.
   Stall the unauthenticated startup health probe separately. Expected: a healthy workspace route
   can still finish the authenticated claim and restore or save the initial empty archive.
7. Read and restore a newly written/sealed object with the fixed-point Server adapter, then write
   through that adapter and read it again with the new one. Expected: the seven custom metadata
   keys and archive bytes remain compatible in both directions; attempt hints do not block rollback.
8. In the controlled Cloud Run harness, let idle reclaim prove the workspace seal and accept DELETE.
   Keep the same UID visible through 60 seconds, then return 404 on a later due sweep. Expected:
   each due sweep makes one confirmation GET and can process other candidates. After 404, the
   old binding clears, the capacity slot is free, and a synthetic Session input can reserve the
   next generation from the same archive. A failed read or a replacement UID keeps the binding.
   A still-present UID at the six-minute deadline enters the failure cooldown.

## Parent message steered into a running child

Use a steer-capable Provider (Claude Code on a current version). A child's long task is its parent's Session message Run.

1. While the child is working, have the parent run `opentag session send <child-id>` twice with short follow-ups.
2. Expected: the follow-ups reach the running child at its next tool boundary, in order, with no new Provider Run for them;
   all messages succeed together when the Run completes.
3. Repeat, then kill and restart the daemon after the child has answered the follow-ups. Expected: the child resumes with the crash
   notice, the follow-ups are not injected again (its transcript holds each once), and the parent gets no failure notice. Check this
   with Claude Code and Codex.
   Repeat with Pi, which gives no confirmation, or kill the daemon right after a steer with Claude Code, before the model answers.
   Expected: those follow-ups arrive again in order, each with the notice.
4. Repeat the crash until the retries run out. Expected: the child's message fails, and the steered follow-ups fail with it:
   one notice per message to its sender, no further Run. A message queued but not yet steered runs on its own.
5. Make the child's task fail without a retry while a follow-up is steered into it. Expected: both fail with one notice each to
   the sender, and no further Run.

## Steers the conversation already holds

A message steered into a Run and confirmed by the Provider is not sent again in the same Provider conversation, on any path. It
still shares the Run's retries and its outcome. Use Claude Code and Codex, and count each message in the Provider transcript
(Claude Code's project JSONL, Codex's rollout). Pi gives no confirmation, so it always repeats the message with the notice.

1. **IM Turn, restart.** While an IM Turn is working, send a follow-up in the same conversation and wait until the Agent has
   answered after it. Kill and restart the daemon. Expected: the Turn continues, and the transcript holds the follow-up once.
2. **Session message, restart.** Repeat step 1 with a Session message steered into the Turn, and with one steered into a child's
   Session message Run. Expected: the same, and the Agent can still quote the message after the restart.
3. **Not confirmed.** With Claude Code, repeat steps 1 and 2 but kill the daemon right after the steer, before the model answers.
   Expected: the message arrives again with the notice, in order, and the transcript holds it once more. Codex confirms a steer
   with its answer, so a message it has not answered has not joined the Run and is delivered as a new steer, without the notice.
4. **Different conversation.** Repeat steps 1 and 2, and while the daemon is down remove the Session's runtime binding (under
   `data/runtime/session-bindings`), so the Run starts a new Provider conversation. Expected: each message arrives again in the new conversation with the notice.
5. **Model HTTP 429.** Where a 429 can be provoked safely (an authorized low-limit test key; do not provoke it on shared accounts),
   steer an IM follow-up and a Session message into a Run, let the model answer after them, then let the next request get the 429.
   Expected: the Run retries in place with the rate-limit notice, and the retry input leaves out both messages. Steer again
   into a request the 429 rejects, so the model never answers that steer. Expected: the retry input includes that message, in order.
6. **Shared outcome.** After steps 1, 2 and 5, let the Run complete. Expected: every message it carried succeeds with it, including
   those not sent again, with no notice to their senders. Then repeat and make the Run fail, or exhaust its retries. Expected: every
   message that conversation held fails with it, one notice to each sender, and no further Run.

## Failure notice to the sender

1. Have a child send a Session message to its visible parent, and make that Run fail. Expected: the child, as the sender, gets
   one notice naming the parent's Session, and the parent's IM conversation gets no failure message.
2. Have one child send a message to a sibling, and make that Run fail. Expected: the sending child gets one notice; their parent
   gets none.
3. Make a parent's task fail in its child. Expected: the parent gets exactly one notice, though it is both sender and creator.
4. Make a scheduled message fail in an internal Session. Expected: its creator gets one notice. In a visible Session: no notice.

## Not retried

- A non-recoverable failure (for example revoked provider credentials) shows its error immediately, with no retry.
- A Computer connected to an older Server that does not negotiate `runtime.sessionRecovery` keeps the previous
  behaviour after a restart: the interrupted Turn reports `turn_state_unknown`, and waiting internal Session messages
  fail with a notice to their sender instead of waiting indefinitely.

## Local scheduled hand-off after a disconnect

1. Disconnect a Local Computer before a one-time occurrence reaches the business send. Reconnect within the dispatch
   window. Expected: the original message ID reaches the Agent once and no miss is posted.
2. Keep the Computer offline through the next trigger of a repeating schedule. Expected: the old occurrence cannot send
   after that trigger, and the occurrence produces at most one final miss notice.
3. Drop the receipt after the business send. Expected: the hand-off stays unconfirmed and the Server does not resend it.
4. Fill the shared extended dispatch slots with Local retries or Cloud hand-offs. Expected: additional offline Local
   occurrences are held (or missed, for a Client older than `runtime.sessionRecovery`) without waiting for retry, while a ready Local target can still receive its occurrence.

## Held Session message delivery

1. Stop the daemon of a Computer that has an idle internal Session, and from a Session on another Computer run `opentag session send <target> --message "first"`, then the same with "second". If the Agent has only one Computer, use a schedule that targets a Session on the stopped Computer.
2. Expected: each send returns `accepted`, or the schedule shows its latest run as unconfirmed, and neither reports an error.
3. Start the daemon again.
4. Expected: within about a minute the target runs "first" and then "second", once each, or the scheduled message runs once. The sender receives no notice.
5. Hold limit (256 per target Session, 1024 per Computer, `SESSION_MESSAGE_HELD_LIMITS`). With the target daemon still stopped,
   fill the target Session's hold: send 256 messages to it with `opentag session send` (a short shell loop is enough).
   Expected: each returns `accepted`, and the Session's messages show `unknown / delivery_held`. To check the
   per-Computer limit, spread 1024 messages over several Sessions on the stopped Computer; the boundary results below are the same.
6. Direct response. Send one more message to the full Session. Expected: the CLI answers `unreachable` with
   `delivery_held_full` right away, the message is not held, and no later delivery notice arrives for it.
7. Previously accepted hand-off. Start the daemon, let the hold drain, then pause the daemon process with `kill -STOP`
   so the Computer stays connected but does not answer. The Server reads it as offline after 90 seconds of silence, so
   do the rest within that window. Send 255 messages to the target Session in parallel (for example with `xargs -P 64`);
   each answers `accepted` after its 5-second wait and becomes `delivery_held` when its attempt times out (about 30
   seconds). Then send two more at once. Expected: both answer `accepted`; the attempt that finishes first takes the last place, and the other ends
   `unreachable / delivery_held_full`. Its sender receives exactly one delivery failure notice, and later redelivery
   sweeps send no second one. Stop the paused daemon with `kill -CONT` then a normal stop before step 8.
8. Scheduled occurrence. With the hold still full, let a schedule that targets the full Session reach its trigger.
   Expected: the occurrence is a missed occurrence with `delivery_held_full`, the schedule's conversation receives exactly one
   miss message for that cause, and a second full occurrence of the same schedule posts nothing more.
9. Start the daemon again. Expected: the held messages run in order, once each, and none of the messages refused in
   steps 6 to 8 runs.
