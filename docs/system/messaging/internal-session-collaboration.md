---
title: "Internal Session collaboration"
description: "Session CLI delegation between an Agent's Sessions: proofs, scope, callbacks into visible Sessions, and delivery limits."
---

# Internal Session collaboration

openTag Agents delegate work through the CLI available inside every managed Session:

```text
opentag session create --message <task>
opentag session send <target-session-id> --message <text>
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
reuse the same ID and identical semantic input after an uncertain result. `accepted` means the target accepted the
message into its bounded FIFO, not that the task completed. On a Local Computer, a message whose target Session is
running a Turn on a steer-capable runtime is steered into that Turn instead of waiting for it to end. Runtime acceptance
is not delivery: the durable record stays `running` until that Turn ends. It becomes `succeeded` when the Turn completed;
returns to the FIFO when the provider reports that it never started the input (Claude Code `command_lifecycle`), so the
message is delivered again as its own Run; and otherwise follows the Turn, as described in
[Session messages steered into an IM Turn](#session-messages-steered-into-an-im-turn). Codex and Pi report no per-input
start, so their acknowledged steer counts as possibly started.
Steering applies only while the target is busy with a Turn the inbox does not own, such as an IM Turn: each target
Session has one serial inbox drain, and that drain awaits its own Session message Run until the Run settles and releases
admission, so a message that arrives while the target runs another Session message waits in the FIFO and then starts as
its own Run. A message also waits, re-checking about once per second, while the busy runtime is not yet `running` with an
active Run, cannot steer, or (for a visible Session) has no IM outbox context. The Cloud Runner path never steers a
Session message: it queues behind the active Turn.

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
milestone is the one self-contained final result, not a separate completion message, and a start notice already sent —
such as a scheduled task's fixed start notification — satisfies started, so the convention never adds the completion
notices scheduled-task metadata forbids. Internal Sessions never publish to IM; they report milestones to their creator
through `opentag session send` only when useful, along with questions and the final result.

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

`accepted` and `session list` describe delivery only. When an internal Session's Run ends without completing, the
Server tells the Session that created it (`created_by_session_id`):

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
  the Turn it joined: when that Turn ends without completing, the message takes this same
  terminal path (reason `session_message_steer_interrupted`), a completed Turn makes it succeed, and a message the
  provider never started returns to the FIFO with no report. Eligibility is unchanged, so a message steered into a
  visible Session's IM Turn produces no notice.
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

The notice is an ordinary SessionMessage from the child to its creator. It uses the existing authorization, lock order,
activity projection, and delivery, including the visible-Session callback rules. A visible creator's callback Run
decides what to tell the user; openTag does not forward anything to IM. The text starts with
`[openTag notice] Internal Session Run did not complete` (`SESSION_RUN_OUTCOME_NOTICE_HEADER`). A notice means the
child's done milestone, its final result sent with `opentag session send`, will not arrive on its own. It names the child,
the reported message, the outcome, and a stable reason code, never provider output. It also says that the child keeps
its context and that `opentag session send <child-session-id>` continues it. Managed instructions describe the
header so the creator knows the message comes from openTag, not from the child.

Safety rules:

- The source authority is the reporting connection: the Local Computer's current connection, or the exact Cloud Runner
  connection that settled the Run. A stale or superseded connection gets `stale_generation`.
- The reported message must be a stored SessionMessage addressed to an active internal Session that has a creator.
  Completed Runs, visible targets, ended children, and unknown messages are ignored. An ended creator rejects the
  notice through normal authorization.
- The notice ID is UUIDv5 over the child Session and reported message IDs. Report retries, Runner settlement replays,
  and concurrent reports converge on one `session_messages` row; an accepted notice is never delivered again.
- Notices only go to the creator, so they move up the creation tree and never return to the child. If the creator's
  own Run fails while handling a notice, its creator may be notified in turn, ending at the visible root.

No schema change is involved: notices reuse `session_messages` and the existing closure activity projection.

The Server stores authorized logical messages and their latest observed delivery outcome for idempotency and conflict
detection. The managed Local Runtime uses its existing bounded inbox and durable-work store, including its recovery and
retry policy; acceptance does not mean completion or exactly-once external side effects. Cloud uses the allocation and
execution boundaries described in [Cloud Context](../cloud/cloud-context.md). Agent-facing Session operations intentionally
provide no `end`; administrative lifecycle invalidation may still set the existing `sessions.ended_at` field, and it
marks the matching closure rows inactive in the same transaction through `services/sessions/session-closure.ts`.

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

## Steering parent messages into a running child

> **Planned — not yet implemented.** Tracking: #1303

A parent Session may send a message to its child at any time, and the message is steered into the child's running Turn
instead of waiting for that Turn to end. Two cases are not covered today and are what remains:

- On a Local Computer, a child running a Session message Run (normally the parent's task) does not take steered input,
  because the target's serial inbox drain is blocked on that Run; the next message waits in the FIFO.
- On Cloud, no Session message is steered; it waits for the active Turn to end.

The existing steer outcome rules (`processed`, `not_started`, `interrupted`) apply unchanged. The child still reports
completion, failure, or timeout to the parent, and the parent decides what to do next.

## Stopping a parent stops its children

> **Planned — not yet implemented.** Tracking: #1304

When a parent Session is stopped or cancelled for good — not merely idle between Turns — every internal Session it
created, recursively, is stopped as well. Today there is no Session-level stop entry point, so nothing cascades from a
parent Session. Agent suspend, delete, and transfer already stop every live Session of the Agent, internal Sessions
included; see [Agent, Session, and Computer model](../agent-session-computer-model.md#configuration-identity).

## Automatic retry before a notice

On a Local Computer a Session message running on its own gets at most 2 automatic retries after a crash, power loss,
restart, upgrade, or model HTTP 429; a retry that actually ran for at least 5 minutes resets the count. The Run's duration
limit counts actual running time across its retries and resumes. Reaching it (`turn_timeout`) and non-recoverable failures
are not retried, and the five-attempt inbox retry is gone. The retried
Run starts with the continuation notice and the original message. The creator receives the notice only when the message
finally fails, so the superior hears about a timeout directly. After a daemon restart, each interrupted Session's message
runs once the Server has prepared the Session again, before the Session's queued messages. See
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
notice. Steering
into a child's Session message Run, and Cloud, are not covered ([#1303](https://github.com/first-tree-ai/opentag/issues/1303)).
