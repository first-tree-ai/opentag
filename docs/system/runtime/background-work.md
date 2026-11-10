---
title: "Background work"
description: "A Run stays open while its background work is live, up to its limit; the Client keeps a per-Session ledger so the Session learns what became of that work."
---

# Background work

An Agent can start work in the background and end its turn. The Run stays open until the work ends or the Run reaches
its limit, and the model is woken with the result, on every Provider.

## When a Run ends

Each Provider adapter translates its protocol into one list of live work (`background_work_changed`). When a model turn
ends:

- The list is empty and no steered input is waiting: the Run ends.
- The list is not empty: the Run waits. The process stays up and the Run's limit keeps counting. Waiting uses no tokens.
- A failed turn ends the Run, whatever is live.

| Provider | What counts as live | How the model is woken |
| --- | --- | --- |
| Claude Code | `background_tasks_changed`, plus timers confirmed live in the process (`ScheduleWakeup`, a `CronCreate` job that is not `durable`) | Claude Code wakes itself |
| Codex | A `commandExecution` still open when its turn completes | The adapter starts a turn with the exit code and output tail. Codex reports the end on the old turn's id and does not wake the model |
| Pi | Work started with `background_bash`, a tool from OpenTag's own Pi extension, reported over `setStatus` | The extension calls `sendMessage` with `triggerTurn` |

The Provider's list alone decides whether a Run waits, not the process tree: a development server never ends, and would hold
every Run to its limit. A process a Provider cannot see holds nothing open. On Pi, one started with `&`, `nohup` or `setsid` in the `bash` tool
escapes to its own process group: the Run ends as usual, and it keeps running on Local and stops with the sandbox on
Cloud. The extension's prompt guideline tells the model to use `background_bash`.

A recurring timer that is not `durable` holds the Run until its limit: it only exists in the process. A cron firing names
no job, so it retires every one-shot job already due.

Only a result for the Run's own input can complete it. On `--resume`, Claude Code reports a result for a notice it
generated itself, with no model turn, and that never ends the Run.

## During the wait

The Run stays `running` and keeps its Session's admission slot, one of the 10 an Agent has on a Client, along with its credentials
and sandbox. Other Sessions of the Agent keep running. A new message joins it through the normal
steer path, for IM Turns and Session messages alike. No turn is active, so the adapter starts one: Claude Code takes the
input on stdin, Codex gets `turn/start` and Pi gets `prompt`.

## At the limit

The Run's existing stop applies: it is aborted, reported as `turn_timeout`, not retried, and the sender is told. Codex
keeps one App Server per Session, so a Run that ends with commands live closes it; otherwise they would run on unreported.
Closing it does not reach a process that detached with `setsid` or a double fork.

## Quiet work

Work that produces no output for 10 minutes is reported to the Session, again at 30 and 60 minutes and then less often,
restarting when output resumes. The Session decides; OpenTag stops nothing, and the Run's limit is the fallback. No signal
separates hung from healthy in either direction: a long sleep is silent, and an endless retry is not. Ten minutes is an
experience value, to be adjusted from real notices.

The signal is output only: the output file's size and modification time on Claude Code and Pi, output events on Codex.
Timers are not watched. CPU time is not read, so a silent computation gets a notice, which costs one model turn. A notice
that goes wrong is a turn the Run started by itself, so it follows the rule below.

## The ledger

No Provider can be relied on to tell a later Run what happened. Codex and Pi say nothing on resume. Claude Code says
`stopped` on resume about the previous process's task, which is false after a SIGKILL: that task survives. So the Client
keeps a ledger per Session, written from the Run's event stream: under the Client's runtime directory on Local, and beside
the Pi binding in the Session workspace on Cloud, which is what outlives the sandbox.

- `completed`, `failed` and `stopped` are facts, observed while the Provider was alive.
- A `running` entry read by a later Run becomes `unknown`, and is reported as possibly still running, to be checked.
- Claude Code's `stopped` counts only for a task the same process listed.

Every Run reads the ledger first, whatever its input, and starts with an `[openTag notice]` if there is anything to tell.
It covers a limit the last Run reached and the work it left. Entries leave once a model turn has started, so a crash
before that tells the next Run again.

A limit's kind appears only as the reason passed to `recordRunLimit`, so a token or tool-call limit adds a reason.

## Failure of a later turn

If a turn the Run started by itself fails after the input was answered (a 429 on a wake, say), the message is not run
again. The result is `completed` with `followUpFailure`, the ledger tells the next Run, and the message's sender gets
outcome `unknown` with the failure's code. An IM Turn sends no such report. A turn carrying steered input is not one of
these: it fails the Run.

## Interruption

`provider_process_exited` is recoverable, under the same rule as a daemon stop and a 429: at most two automatic retries in
a row, reset once a retry actually ran for five minutes. It retries at once, without the wait a 429 has. The retried Run
gets the continuation notice and the ledger. A new process cannot take over the old process's work, so the Session starts
it again if it still needs it. Cloud Turns do not use these automatic retries; their next Run reads the ledger.

A model CLI that fails to start (`provider_start_failed`, `not_started`) gets its one retry the same way, after its short
wait. Nothing ran, so no model turn started and the ledger is unchanged: the retry reads the same notice, and an entry
leaves only once the retried Run's model turn starts. The sender hears the outcome once, when the retry settles. A turn the
Run started by itself after answering its input is a `followUpFailure`, not a start failure, and is never retried.

## What survives a stop

Measured with the Provider process started through the Client's process wrapper:

| Signal to the wrapper's process group | Claude Code background task | Codex background command | `nohup` from a shell tool |
| --- | --- | --- | --- |
| SIGTERM, SIGINT, or stdin closed | stopped by Claude Code | stopped | survives on Claude Code and Pi |
| SIGKILL | **survives** | stopped | survives on Claude Code and Pi |

The shell tools of Claude Code and Pi run commands in their own process group, so the wrapper's signal does not reach them.
On Codex a process started with `&` or `nohup` is gone when the tool call ends, and one that detached with `setsid` or a
double fork survives everything above.
