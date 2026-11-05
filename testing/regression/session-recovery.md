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
