# Session interruption recovery release regression

Checklist for the Local Computer's one automatic retry of interrupted Session work. Run it against a test Agent on a
dedicated regression computer with an IM test conversation (Feishu or Slack) the Agent may reply in. Do not record
message contents, IDs or logs in the repository; keep results with the release PR or Issue.

Each case starts a Run long enough to interrupt (for example ask the Agent to run `sleep 60` and then reply "done"),
waits until the Agent is working, and then interrupts it as described. "Continues" means a new Provider Run starts in
the same Session after the daemon is back, its input begins with
`[OpenTag] Your previous turn was interrupted at … because … (automatic retry 1/1)`, and the original request follows.

## Prerequisites

- A Local Computer connected to a Server that negotiates `runtime.sessionRecovery` v1 (both on the release candidate).
- One Agent on that Computer with an IM binding, and permission to stop, kill and restart its daemon.
- For internal Sessions: a request that makes the visible Session run `opentag session create` for a long task.

## Daemon crash (power loss)

1. Start a long Run in a DM or thread, then kill the daemon process group (`kill -9` of the daemon and its children).
2. Start the daemon again.
3. Expected: within about a minute the Session continues with reason "the OpenTag daemon stopped unexpectedly";
   no red "result cannot be confirmed" card appears; the working reaction stays until the retried Turn ends; the reply
   arrives once the retry completes, followed by any messages that queued meanwhile.

## Orderly restart or upgrade

1. Start a long Run, then run `opentag daemon restart` (or upgrade the client).
2. Expected: no "cancelled" outcome is reported and no error card appears; after the restart the Session continues
   with reason "the OpenTag daemon was restarted or upgraded".

## Second interruption is reported

1. Repeat the crash case, and kill the daemon again while the retried Run is still working; start it again.
2. Expected: no third Run starts. The IM conversation shows the existing error card for the Turn (result cannot be
   confirmed / cancelled), exactly once.

## Run timeout and model rate limit

1. Give the Agent a run budget shorter than the task (Agent settings), then send the long task.
2. Expected: when the budget expires the Session continues once in the same daemon with reason "the turn reached its
   maximum run duration"; when the retry times out as well, the timeout error card appears once.
3. Where a model 429 can be provoked safely (an authorized low-limit test key), confirm the Turn retries once after
   about 30 seconds with reason "rate-limited the request (HTTP 429)". Do not provoke rate limits on shared accounts.

## Internal Session

1. Ask the visible Session to delegate a long task to an internal Session, wait until the child Run is working, then
   kill and restart the daemon.
2. Expected: the child continues with the crash reason and later reports its result to the parent; the parent receives
   no "[openTag notice] Internal Session Run did not complete" notice. A second crash during the child's retry produces
   exactly one such notice naming the failure.
3. A child whose budget expires continues once; when the retry also times out the parent receives one notice with
   outcome `timed_out`.

## Parent message steered into a running child

Use a steer-capable Provider (Claude Code on a current version). A child's long task is its parent's Session message Run.

1. While the child is working, have the parent run `opentag session send <child-id>` twice with short follow-ups.
2. Expected: the follow-ups reach the running child at its next tool boundary, in order, with no new Provider Run for them;
   all messages succeed together when the Run completes.
3. Repeat, then kill and restart the daemon after the follow-ups were steered. Expected: the child resumes with the crash
   notice, the follow-ups arrive again in order, each with the notice, and the parent gets no failure notice.
4. Repeat the crash until the retries run out. Expected: the child's message fails, and the steered follow-ups fail with it:
   one notice per message, no further Run. A message queued but not yet steered runs on its own.

## Not retried

- A non-recoverable failure (for example revoked provider credentials) shows its error immediately, with no retry.
- A Computer connected to an older Server that does not negotiate `runtime.sessionRecovery` keeps the previous
  behaviour after a restart: the interrupted Turn reports `turn_state_unknown`, and waiting internal Session messages
  fail with a creator notice instead of waiting indefinitely.
