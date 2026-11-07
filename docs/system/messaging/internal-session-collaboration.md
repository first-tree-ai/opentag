---
title: "Internal Session collaboration"
description: "Session CLI delegation between an Agent's Sessions: proofs, scope, callbacks into visible Sessions, and delivery limits."
---

# Internal Session collaboration

openTag Agents delegate work through the CLI available inside every managed Session:

```text
opentag session create --message <task>
opentag session send <target-session-id> --message <text>
opentag session stop <internal-session-id>
opentag session list
```

The current source Session is implicit. The Runtime supplies a managed proof file and the CLI reads the Server binding
from `OPENTAG_HOME/config/computer.json`; callers cannot pass an Agent or source Session identity. The proof is bound to
the current Session, placement generation, Computer connection, and Client connection. Reconciles for the same binding
reuse the same proof, including retries after a timeout or lost response. Placement, connection, Agent, or IM-binding
changes invalidate the old proof.

On Local Computers, managed command instructions use an absolute invocation from the installation running the daemon.
Portable installs use that installation's stable channel launcher; npm installs use the running Node executable and CLI
entry script. A stable Node alias is preferred when it resolves to that same executable, including Homebrew's `opt`
path; a different Node on `PATH` cannot replace it. Service installation and refresh use the same selection, independent
of same-name CLI commands on ambient `PATH`. Paths and arguments are quoted separately. Claude Code Bash allowances
and Codex command-prefix rules receive these same invocation tokens, including the npm entry script, rather than
allowing every script run by Node. A missing or inconsistent local entry is a local configuration error; daemon logs
include its path, reason, running version, and the installed Portable version when available.
Visible Session create/send commands read the current execution marker on each invocation, including when the Provider
process persists across Turns; they do not reuse an earlier Turn's inherited execution ID.

For Local Computers, all Provider processes launched by one daemon OS user currently form one trust domain. File permissions protect proof
files from other OS users and accidental exposure, but do not isolate sibling Sessions running as that same user. Until
openTag introduces per-Session OS or container isolation, the proof lets the Server validate a live Runtime binding and
removes caller-selected source flags; it is not a security boundary against a compromised sibling Session that can read
the daemon user's files.

`session create` atomically creates an internal child Session and its first message. `session send` addresses an
existing Session in the same Agent and conversation scope. Both accept an optional `--message-id` for an explicit retry;
reuse the same ID and identical semantic input after an uncertain result. A new message can use any UUID except version 5, which
is reserved for the messages the Server writes itself and is rejected with `message_id_reserved`. A retry of a message already
recorded under a version 5 ID still works. `accepted` means the target accepted the
message into its bounded FIFO, not that the task completed. On a Local Computer, a message whose target Session is
running on a steer-capable runtime is steered into the running Run instead of waiting for it to end, whether that Run is an
IM Turn or another Session message. Runtime acceptance is not delivery: the durable record stays `running` until that Turn ends. It becomes `succeeded` when the Turn completed;
returns to the FIFO when the provider reports that it never started the input (Claude Code `command_lifecycle`), so the
message is delivered again as its own Run; and otherwise follows the Turn, as described in
[Session messages steered into an IM Turn](#session-messages-steered-into-an-im-turn) and
[Session messages steered into a Session message Run](#session-messages-steered-into-a-session-message-run). Codex and Pi
report no per-input start, so their acknowledged steer counts as possibly started.
Each target Session has one serial inbox drain. The drain does not wait for a Session message Run it starts; the Run holds
the Session's admission, so the next message tries to steer into it. A message waits in the FIFO, re-checking about once
per second, while the busy runtime is not yet `running` with an active Run, cannot steer or refuses the steer, the Run
already carries 16 Session messages, or (for a visible Session) there is no IM outbox context. It starts as its own Run,
in order, once admission is released. The Cloud Runner path never steers a Session message: it queues behind the active Turn.

Within each existing create/send transaction, authorization locks the source Agent, binding,
Sessions in ID order (`FOR NO KEY UPDATE`), placements in Session ID order, then Computers in ID order.
The locked rows supply the current authority checks. Only targets in the full binding, channel,
conversation-kind and thread scope enter this lock chain; foreign-scope targets are classified by
an unlocked read. Create retries first read the immutable target hint for that message and creator;
the later message lock and input-conflict checks remain authoritative. There is no automatic database retry.

A temporary refusal returns `unreachable` with its cause as the code. `client_busy` means the Client is not admitting new
work: an upgrade is switching over, the Client is stopping, or the bounded FIFO is full. The Cloud Runner reports the same
code. `session_busy` and `agent_busy` map to their own codes, though the Local inbox does not return them today. Messages
recorded before this split keep `capacity`.

Create/send admission refusals for source authority, target availability, collaboration scope, message ID conflicts,
or an unavailable model keep their existing `rejected` response and code without an ERROR `Server diagnostic`.
An unconfirmable Cloud model catalog remains `unreachable` with `model_unavailable` and does not emit that diagnostic.
An unexpected exception still returns `unreachable` with `runtime_unavailable` and emits the fixed
`SESSION_COLLABORATION_RUNTIME_UNAVAILABLE` diagnostic without exception details or message content. HTTP responses
remain 200 for these command outcomes. Runtime assembly, Cloud dispatch, and outcome-persistence failures retain
their separate internal-error logs.

The Server does not hold or replay a refused message (decision by yuezengwu, 2026-11-05,
[#1327](https://github.com/first-tree-ai/opentag/issues/1327)). The Client keeps the upgrade switch window as small as it
can instead. A sender retries with the same `--message-id`, and the inbox evaluates that replay again rather than answering
from memory, so the message runs once admission reopens. A permanent rejection stays rejected on replay. A scheduled
message has no sender to retry it, so one refused in that window stays `unreachable` and the next occurrence is the next
chance; this is an accepted cost. The Client logs every refused Session message with its reason.

`session list` returns direct children by default, ordered by recent message activity. Pages default to 20 items and
are capped at 100; `--cursor` continues a page, `--recursive` includes descendants, `--since` filters recent activity,
and `--json` returns `{ items, nextCursor }`. There is no unbounded `--all` mode. The page returns active children
only: the closure row carries `descendant_active`, which mirrors the descendant's `ended_at`, and the activity indexes
are partial on it, so a page never reads the ordering index to discover ended descendants and discard them.
`--include-stopped` also returns ended descendants, each with its `stoppedAt`. That page does not use the partial
indexes: it sorts this ancestor's closure rows, read through the primary key, so its cost is bounded by the ancestor's
own descendants. Only such a page carries `stoppedAt`, so an older CLI's strict parsing never sees the field.

Recent activity is the latest message in which the listed Session is the source or target. Creating
an internal child therefore also updates the creator's activity projection. It does not raise the
activity of an ancestor that did not participate in that message. Ordering uses the message's
original creation time and ID, including explicit create retries; a retry or delayed receipt does
not move an older message ahead of newer activity. The task preview remains the child's initial
task, and outcome writes update only projections still referring to that message.

Internal Sessions inherit their Agent's available tools and default Runtime configuration. Local Sessions also share the
Agent workspace. Cloud Sessions have independent Sandbox workspaces and Pi histories; see
[Cloud Context Tree and Session collaboration](../cloud/cloud-context.md) for the Cloud boundaries. A creation command may
override the model, reasoning effort, or maximum Run duration. Without a duration override, an internal Session's Run
budget is the larger of 2 hours and its Agent's configured budget (30 minutes when unset), because delegated work such
as coding usually outlasts an IM reply; channel and thread Sessions keep the Agent budget. A Run that exceeds its
budget is aborted as `turn_timeout`, so managed instructions tell the creating Session to estimate the task and pass
`--max-duration-ms` with headroom, up to the 24-hour maximum. Internal Sessions do not receive IM delivery or the
temporary `OPENTAG_PROVIDER_ENV_FILE`; they report through `opentag session send`. Both visible and internal Sessions
receive role-aware managed instructions and may create further internal Sessions.

Local and Cloud use the same managed system-prompt renderer and Session context interface. Shared Session behavior is
defined once; workspace persistence, isolation, and Context Tree facts are rendered for the execution environment.
For eligible human IM inputs, the Server owns the working reaction and terminal error-card projection, including durable cleanup and safe recovery. Visible Sessions keep normal progress silent and publish their final result through the provider CLI; long-running delegated or multi-step work also posts milestone messages, described below. Observer copies and internal Sessions do not publish IM reactions or replies for that input. See [IM feedback and recovery](im-feedback.md) for eligibility, batching, failure handling, and recovery authority.

openTag internal Sessions are distinct from Provider-native subagents. When a person explicitly requests an openTag
internal Session, the visible Session uses `opentag session create` rather than substituting a Provider-native subagent.

Beyond that rule, delegation is a managed-instruction convention, not a platform routing policy. A visible Session
handles quick work directly. Work likely to take long — multi-step coding, debugging, test runs, or broad research,
roughly over 10 minutes — or work that should continue on its own goes to an internal Session created with a
`--max-duration-ms` sized to the task; the visible Session replies promptly that the work has started and publishes the
result when the child reports back. A visible Session's own Run shares one time budget, is aborted on timeout, and
holds the IM conversation until it ends. Provider-native subagents run inside that Run, are not visible in openTag,
and do not survive a daemon restart, so they remain for short, bounded side tasks within the current Run. Internal
Sessions may still delegate further.

Session collaboration can be unavailable to a visible Session — Cloud omits it when the request carries no
`sessionCollaboration` proof, and Local when it reconciles without the Session-collaboration capability or managed
Session context. The visible Session then still handles quick work directly and keeps Provider-native subagents to
short, bounded side tasks. It does long work directly in the current Run: it replies promptly that the work has started
and that the conversation stays busy until it finishes, posts milestones, and, because the Run budget still applies,
says so when the work may not fit and splits it into parts the user can request in separate messages.

For long-running delegated or multi-step work, the visible Session posts a short new IM message at each meaningful
milestone — started, key finding, blocked and needs input, done — rather than editing one message, because IM clients do
not notify on edits. Routine check-ins are not milestones, and short work stays silent until the final reply. The done
milestone is the one self-contained final result, not a separate completion message. A scheduled task's message goes to
the Agent only: its metadata forbids schedule lifecycle notices, and a run with nothing to report stays silent. openTag
reports a failed or missed occurrence itself; see [Scheduled tasks](im-feedback.md#scheduled-tasks). Internal Sessions
never publish to IM; they report milestones to their creator through `opentag session send` only when useful, along with
questions and the final result.

When a SessionMessage returns to a visible channel or thread Session, that callback Run retains the visible Session's IM
authority. Credential grant v2 atomically supplies a temporary provider credential environment and a non-secret default
outbox context derived by the Server from the Session's existing conversation scope. The visible Session synthesizes and
publishes any user-facing result through the official provider CLI during that callback Run; openTag does not forward the
child's text automatically. Channel callbacks target the existing chat or channel, while thread callbacks retain the
existing thread scope. Internal targets never receive provider credentials or outbox context.

Default Local (`legacy`) Turns retain the non-secret context from their existing credential grant after credential
materialization succeeds. Session messages steered into that live Turn use the same Server-authorized channel or thread
target without requesting another grant. Cleanup, shutdown, or cancellation withdraws that context; a failed or superseded
preparation cannot restore it. The Client never derives an outbox target from the Session message's sender or content.
Each legacy preparation returns an execution cleanup token, also recorded in its environment manifest. Materialization
and cleanup share one serial lifecycle per Session: a replacement waits for older writes and teardown, and cleanup carrying
an older token cannot remove the replacement's context or files. A Run that never prepared credentials does not perform
Session-wide cleanup. Other Sessions prepare independently.
An older grant without outbox context still leaves visible Session messages queued until the Turn ends.

## Run outcome notices

`accepted` and `session list` describe delivery only. A Session message has the same goal as an IM message: once accepted, the
Client owns retrying it, and a final failure or an unrecoverable error reaches whoever sent it, as an error card reaches the
person for an IM message. So when a message's Run ends without completing, the Server tells the message's sender, whichever
kind of Session the target is. A scheduled message has no sender: its notice goes to an internal target's creator
(`created_by_session_id`), and a visible target produces none:

- Local: a message whose Run a daemon crash, restart or upgrade interrupts, or that hits a model HTTP 429, gets at most 2
  automatic retries, as described in
  [Automatic retry of accepted work](../server-client-boundary.md#automatic-retry-of-accepted-work). The retried Run
  starts with the continuation notice and the original message. Every other failure, including `turn_timeout`, is terminal
  without a retry, and so is running out of retries (`provider_rate_limited`, or `run_interrupted` after a crash).
  After a restart, accepted messages wait without failing until the Server prepares their Session; if the Server
  refuses (for example the Session ended), they fail with that reason. The daemon then reports the outcome with
  `session:message:outcome`. Reports are kept in a local durable file and resent until the Server gives a final
  answer or one day passes. The terminal inbox record and an `outcomeReport: pending` marker are written in one
  record write; the marker becomes `published` once the report is durable in the reporter's file. On startup a
  terminal record still marked `pending` (for example after a crash between the two writes) hands its report over
  again, and the child is never rerun. Terminal records written before the marker existed carry no marker and are
  not backfilled. The Server-backed Runtime durability adapter does not store the marker. A steered message follows
  the Run it joined: when that Run ends without completing, the message takes this same terminal path (reason
  `session_message_steer_interrupted`), a completed Run makes it succeed, and a message the provider never started returns
  to the FIFO with no report. This is true of an IM Turn and a Session message Run alike, and the sender gets the notice.
  The report frame waits for notice authorization and persistence, then answers `retry` while the Server delivers
  the notice in the background to either a Local or Cloud recipient. This is a frame response, not an acknowledgement
  of Server custody, Runtime receipt, or business completion: the Local reporter remains the durable retry owner.
  Its next report receives `notified` only after the recipient's acceptance is recorded, or `ignored` after a final
  refusal. Final report acknowledgement therefore follows the reporter's existing backoff (initially 5 seconds,
  capped at 5 minutes). Slow reconcile, delivery receipts, and Cloud cold starts do not hold the inbound frame open.
  At most 16 Local outcome notices prepare or deliver concurrently; duplicates already in flight and excess reports
  answer `retry` without starting another attempt. Each delivery retains normal authority fences and target inbox
  ordering. Shutdown stops admission, signals transport cancellation and prevents late sends, then drains outstanding
  preparation and outcome writes before the database closes. Runtime route shutdown closes the Domain owner and
  rejects pending delivery waits; an unconfirmed delivery stays `unknown` rather than proving that the target never
  accepted it. After a Server or daemon restart, the reporter replays its durable report under the current connection
  with the same deterministic notice ID through the target's message deduplication. The Server's in-memory
  tasks are an optimization, not a durable delivery queue; the existing one-day reporter limit still applies.
- Cloud: the Runner's `session:message:settled` frame carries the failure `reason` (for example `turn_timeout`) on a
  collaboration-v3 channel. Every non-completed outcome (`failed`, `cancelled`, `unknown`) produces a notice. The
  Server makes up to three delivery attempts, 30 seconds apart. The notice's source authority is the settling
  connection, and `session:message:settled:ack` lets the Runner delete its journaled settlement, so the Server sends
  that ack only after the notice has a final answer (or the three attempts are spent), and only on the
  still-current connection. If the Runner detaches or the Server stops first, the settlement stays journaled; the
  Runner replays it to the next connection, which commits it as `already_recorded` and notifies again under the same
  notice ID. The wait runs outside the Runner's frame handling. Until that ack reaches the exact connection, the
  settling allocation stays in the Sandbox reclaim barrier, so idle reclamation or borrow cannot delete the journal;
  see [Cloud context](../cloud/cloud-context.md).

- Background work: Local Claude Code runs one process per Run, and the process exits when the Run ends, so background
  shells, background subagents, Monitors and in-process timers stop then. They do not survive to the next message, and
  nothing wakes the Session later. A timer counts once its `ScheduleWakeup` or `CronCreate` call succeeded, until
  `ScheduleWakeup` with `stop` or `CronDelete` removes it. A wakeup is also removed when a `command_lifecycle` with
  `wakeup_source: loop_wakeup` names its `scheduled_for`. A cron firing names no job and can come from a durable job of an
  earlier Run, so it removes nothing. The notice and report may therefore name a job that already ran, and both say the
  work may still be live. A `durable` cron job is on disk and is not counted. The result of a fired timer's own turn
  does not end the Run. Before the process exits, the Run tells the Session once which work may stop
  (`[openTag notice] This Run is about to end.`), and gets one more model turn to wait for it, redo it in the foreground,
  or tell whoever is waiting. The result after that notice ends the Run, with or without a `command_lifecycle` for it. If
  work may still be live when that turn ends, the message still `succeeded` and is not run again, and the daemon reports
  outcome `unknown` with reason `background_work_possibly_stopped` through the same report, so the message's sender gets a
  notice, including when the target is a visible Session. An IM Turn gets the same notice in the Run and sends no report. A
  message steered into that Run sends no report of its own.

The notice is an ordinary SessionMessage from the target to the recipient. A sender that is also the creator gets one notice,
since there is one recipient. It uses the existing authorization, lock order, activity projection, and delivery, including the
visible-Session callback rules. A visible recipient's callback Run decides what to tell the user; openTag does not forward
anything to IM. The text starts with `[openTag notice] Internal Session Run did not complete`
(`SESSION_RUN_OUTCOME_NOTICE_HEADER`), whichever kind of Session the target is. A notice means the target's result for that
message will not arrive on its own. It names the target, the reported message, the outcome, and a stable reason code, never
provider output. It also says that the target keeps its context and that `opentag session send <session-id>` continues it.
Managed instructions describe the header so the recipient knows the message comes from openTag, not from that Session.

Safety rules:

- The source authority is the reporting connection: the Local Computer's current connection, or the exact Cloud Runner
  connection that settled the Run. A stale or superseded connection gets `stale_generation`.
- The reported message must be a stored SessionMessage addressed to an active Session. Completed Runs, ended targets, and
  unknown messages are ignored, and so is a message with no recipient. An ended recipient rejects the notice through normal
  authorization.
- The notice ID is UUIDv5 over the target Session and reported message IDs. Report retries, Runner settlement replays,
  and concurrent reports converge on one `session_messages` row; an accepted notice is never delivered again.
- A notice never goes back to its own sender, so notices cannot bounce between two Sessions. If a Session's Run fails while
  handling a notice, that Session's creator is notified instead, so failed notices only climb the creation tree and end at the
  visible root. A message a Session sent to itself goes the same way. The header alone does not make a message a notice, so a
  message that quotes one keeps its sender: a notice's ID must derive from the Session and message it names, and that Session
  must have sent it. The ID is public and `session_messages.id` is global, so ordinary create/send cannot record a new row under a
  version 5 UUID: no Session can occupy a future notice's ID. A row recorded under such an ID before this rule still blocks that one
  notice, which is then ignored and logged.

No schema change is involved: notices reuse `session_messages` and the existing closure activity projection.

The Server stores authorized logical messages and their latest observed delivery outcome for idempotency and conflict
detection. The managed Local Runtime uses its existing bounded inbox and durable-work store, including its recovery and
retry policy; acceptance does not mean completion or exactly-once external side effects. Cloud uses the allocation and
execution boundaries described in [Cloud Context](../cloud/cloud-context.md). Agent-facing Session operations provide no
`end` for a Session's own use; `session stop` and administrative lifecycle invalidation set the existing
`sessions.ended_at` field, and each marks the matching closure rows inactive in the same transaction through
`services/sessions/session-closure.ts`.

The Local CLI transport requires `runtime.sessionCollaboration` capability version 2. Version 3 adds scheduled
origins. Version 4 adds the Client Run outcome report. The Client sends `session:message:outcome` only on a connection
that negotiated 4 or later; against an older Server it keeps the report pending (bounded) and never sends the frame.
The Server answers `unsupported_capability` to a report on a connection below version 4. An older Client never reports,
so its timed-out child produces no notice. Version checks use `>=`. Visible callback delivery also requires
`runtime.imCredentialGrant` version 2. A new Server reports `outbox_unavailable` before delivery when the target Client is
older; a new Client connected to an older Server rejects the delivery before acknowledging it so the same logical message
remains retryable. Both upgrade directions fail closed before the callback Run instead of silently removing its IM outbox.

openTag currently supports this path only with a single Server replica. Proof-authenticated Session CLI HTTP and
source/target SessionMessage Runtime delivery use that replica's transport owner (Local Computer or Cloud Runner). Ordinary multi-replica
load balancing, sticky routing, and cross-replica owner discovery, forwarding, or delivery relay are not supported;
horizontal replicas require an explicit cross-instance owner-routing design before they can be enabled.

## Steering parent messages into a running child on Cloud

> **Planned — not yet implemented.** Tracking: #1303

A parent Session may send a message to its child at any time, and the message is steered into the child's running Turn
instead of waiting for that Turn to end. A Local Computer does this today; see
[Session messages steered into a Session message Run](#session-messages-steered-into-a-session-message-run). On Cloud, no
Session message is steered yet; it waits for the active Turn to end.

The existing steer outcome rules (`processed`, `not_started`, `interrupted`) apply unchanged. The child still reports
completion, failure, or timeout to the parent, and the parent decides what to do next.

## Stopping an internal Session

`opentag session stop <id>` ends an internal Session without its cooperation: its running Run is cancelled, its pending
retries are cancelled and its queued messages are withdrawn.

- **A stop is final.** It sets `sessions.ended_at`, and nothing clears that field, so a later `session send` is rejected
  with `target_unavailable` and no stale message can wake the Session. The Session's files stay on disk; continuing its
  work takes a new Session.
- **Who may stop.** Only an ancestor in the target's creation chain, proved by a `session_descendants` row. Everyone
  else, including the target itself, a sibling, and a target that does not exist or is not internal, gets `not_ancestor`.
- **Order.** The Session ends in one transaction under the same lock order as `session send`, which is what takes away
  its authority: its proof stops authenticating, so it can no longer send or create Sessions, and no message reaches it.
  Its execution side is told after commit. A stop that is repeated answers `alreadyStopped` and tells it again.
- **What the caller learns.** `execution` says how far the stop reached: `stopped` (the Client confirmed the Run and
  queue are gone), `requested` (the Cloud Runner was sent the cancellation), `pending` (the Computer or Runner could not
  be reached, or did not answer within 15 seconds, which stays below the CLI's 30-second request timeout) or `not_interrupted` (a Client older than this behavior answered `busy`, so its Run continues without
  Session authority until it ends). `activeDescendantCount` says how many descendants keep running.
- **Notice.** A creator that called `session stop` has its answer and is not woken. When another ancestor stopped the
  child, the creator gets one SessionMessage from that ancestor, starting with the Run outcome notice header and saying
  the child cannot be continued. Its ID is a Server-derived UUIDv5 over the child, so repeats converge. It is recorded before
  the stop answers and delivered in the background; a delivery lost to a Server crash is sent again only if the stop is
  repeated. Other senders whose queued
  messages were withdrawn are not told; their next `session send` is rejected.

Local uses the existing `session:reconcile` frame with `desired: "stopped"`; there is no new frame or capability. The
frame names the internal kind so that a daemon that restarted and has not prepared the Session can still withdraw its
work. The Client aborts the Run before taking the Agent lock, because the Run's cleanup needs that lock, then runs the
normal stop. It waits only for the stopped placement's Run, read at the moment the placement is fenced, and that Run settles
only after the messages steered into it. It never waits for the inbox drain, so an older stop cannot wait for a newer placement's work. A Run waiting out a retry's backoff
ends at once, and a message steered into the stopped Run ends the same way. The Client fences the stopped placement synchronously before any of its writes, so a retry or delivery whose
write was already in flight neither starts a Run nor answers `accepted`. A provider that ignores the abort for 5 seconds has its runtime closed, which ends its process tree. The withdrawn messages reach a terminal `session_stopped` record with no retry and no Run outcome report.
The same Client behavior applies to an Agent lifecycle stop of an internal Session, which previously answered `busy`
while a Run was active; a visible Session's Turn still answers `busy`.

Past the 15 seconds the stop goes on in the background: a late Client answer is ignored apart from retiring the proof, and
another ancestor's notice to the creator is still sent. A Computer that cannot be reached misses the frame and nothing durable records that. When a Computer registers, the
Server sends a stop for up to 64 of its internal Sessions that ended in the last 24 hours, because repeating a stop is
harmless. A daemon that restarted in the meantime also has its waiting messages refused with `session_ended`. A Server
restart loses nothing, since this read is against the database. A Cloud Runner re-announces its journal when it
reconnects, and the Server answers an ended Session's entries with a cancellation.

There is no Web entry point yet.

## Schedules on an internal Session

An internal Session can create a schedule with `opentag agent self schedule create`. Every schedule pins the Session that
created it as its fixed target, and nothing in the request can name another one, so a Session can only schedule itself. A
schedule created from an internal Session before this rule keeps its visible target.

- **Delivery.** An occurrence reaches the Session as a scheduled message, through the same path as a visible target. It has no
  IM outbox: a scheduled Run reports with `opentag session send`, like any other Run of that Session.
- **Stopping.** `session stop` turns off the target's schedules in the transaction that ends it, and they can't be resumed.
  Any other end of a Session, such as a disabled binding, is found at the next occurrence, which turns the schedule off.
  The Agent's schedule commands are unchanged, so any of its Sessions can list, pause or delete a schedule, and each
  schedule shows its target Session.
- **A failed Run** notifies the target's creator, the [Run outcome notice](#run-outcome-notices) rule for a message with no
  sender. The creator can be told again on every failed occurrence, as the conversation is for a visible target.
- **A missed occurrence** that never reached the Session, including one whose target has ended, notifies nobody and logs no
  warning. It stays in the schedule's last run summary, and the Web shows it. The reason: there is no message for an
  outcome notice to name, and a child offline overnight should not wake its creator.

No schema change is involved: `agent_schedules.target_session_id` already references any Session. The API response adds
`internal` to `target.sessionKind`.

## Stopping a parent stops its children

> **Planned — not yet implemented.** Tracking: #1304

When a parent Session is stopped or cancelled for good — not merely idle between Turns — every internal Session it
created, recursively, is stopped as well. Today `session stop` ends only its target, so nothing cascades from a parent
Session and a stopped parent's descendants keep running. Agent suspend, delete, and transfer already stop every live Session of the Agent, internal Sessions
included; see [Agent, Session, and Computer model](../agent-session-computer-model.md#configuration-identity).

## Automatic retry before a notice

On a Local Computer a Session message running on its own gets at most 2 automatic retries after a crash, power loss,
restart, upgrade, or model HTTP 429; a retry that actually ran for at least 5 minutes resets the count. The Run's duration
limit counts actual running time across its retries and resumes. Reaching it (`turn_timeout`) and non-recoverable failures
are not retried, and the five-attempt inbox retry is gone. The retried Run starts with the continuation notice and the
original message. A retry after a model HTTP 429 stays in place: the Run keeps holding the Session through the backoff, so
no other work overtakes it. The sender receives the notice only when the message finally fails, so the superior hears about
a timeout directly. After a daemon restart, each interrupted Session's message runs once the Server has prepared the Session
again, before the Session's queued messages. A replay of a message the inbox still holds, including one waiting for its retry,
is answered `accepted` and changes nothing. See
[Automatic retry of accepted work](../server-client-boundary.md#automatic-retry-of-accepted-work).

### Session messages steered into an IM Turn

On a Local Computer a Session message is steered into the Session's IM Turn whenever the runtime can take it, including
that Turn's retry and the Turn resumed after a process interruption
([#1301](https://github.com/first-tree-ai/opentag/issues/1301#issuecomment-6651237819)). A steered message has no count of its own: it
shares the count of the Turn it joined, so they retry together and fail together.

- **Model HTTP 429, retried in place.** Messages already steered into the Turn join the same retry, in their original order
  among the Turn's IM steers, and stay `running`. They are not queued again. The list is kept in memory, not in the Turn's
  retry file. A message steered into that retry joins the next one the same way.
- **Crash or restart.** The Turn is resumed with the continuation notice, without its Session messages. Messages already
  steered before the interruption, then queued messages, are steered into the resumed Turn in order once it is running. A
  message that was already steered carries the continuation notice, without a specific cause, so the Agent knows it may
  have handled it already. Until then they wait in the FIFO, re-checking about once per second. If the Turn ends first, they
  run as their own Runs, in order and with a fresh count, as they do when the runtime cannot steer. If the Turn cannot be
  resumed, the existing fallback applies: the waiting messages fail.
- **Running out of retries, `turn_timeout`, or any other failure** ends the Turn, and the messages in it fail with it. When
  the count runs out at a restart, the messages steered into that Turn fail rather than run again; a message whose failure
  cannot be written yet stays queued and does not run. Queued messages run on their own.

A message stays queued and waits for the Turn to end when the runtime cannot steer or refuses the steer, when the Turn
already carries 16 Session messages, or when a visible Session has no IM outbox context.

The accepted cost is extra delivery and repeated handling around a process interruption: each retry can replay the Turn and
its messages, and work that runs at least 5 minutes between crashes is never stopped by the count. After a crash the resumed Turn may already have the steered message
in its history, and the message is delivered again; the continuation notice tells the Agent, but cannot prevent every
repeat. A message steered just before a crash, whose `running` state was not yet written, is delivered again without the
notice. Cloud is not covered ([#1303](https://github.com/first-tree-ai/opentag/issues/1303)).

### Session messages steered into a Session message Run

The same rule applies when the running Run is another Session message, normally a parent's task in its child. The Run's
own message holds the count. A message steered into the Run has no count of its own, on the steer-capable runtimes of a
Local Computer.

- **Model HTTP 429.** The retry input is the continuation notice, the Run's own message, then the steered messages in their
  original order. They stay `running`. A message that arrives during the backoff waits, then steers into the retry, and the
  next retry carries it as well. A message the provider never began goes back to its place in the FIFO instead.
- **Crash or restart.** The Run's own message is counted and runs again with the continuation notice. Messages already steered
  into it, then queued messages, steer into it in order once it is running. A message that was already steered carries the
  notice, so the Agent knows it may have handled it. If the Run ends first, they run as their own Runs, in order, and each
  one's count starts from 0.
- **Running out of retries, `turn_timeout`, or any other failure** ends the Run, and the messages steered into it fail with it.
  Each sender gets a notice, with reason `session_message_steer_interrupted`. When the count runs out at a restart, the messages
  steered into that Run fail with `run_interrupted`; queued messages run on their own.

A crash can land between the Run's terminal write and those of its messages. If the Run failed, they fail at the restart. If
it succeeded, they run again on their own with the notice: this is the same accepted cost of repeated handling.
