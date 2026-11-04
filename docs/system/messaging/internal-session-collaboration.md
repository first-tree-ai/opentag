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
message into its bounded FIFO, not that the task completed.

Within each existing create/send transaction, authorization locks the source Agent, binding,
Sessions in ID order (`FOR NO KEY UPDATE`), placements in Session ID order, then Computers in ID order.
The locked rows supply the current authority checks. Only targets in the full binding, channel,
conversation-kind and thread scope enter this lock chain; foreign-scope targets are classified by
an unlocked read. Create retries first read the immutable target hint for that message and creator;
the later message lock and input-conflict checks remain authoritative. There is no automatic database retry.

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
For eligible human IM inputs, the Server owns the working reaction and terminal error-card projection, including durable cleanup and safe recovery. Visible Sessions keep normal progress silent and publish their final result through the provider CLI. Observer copies and internal Sessions do not publish IM reactions or replies for that input. See [IM feedback and recovery](im-feedback.md) for eligibility, batching, failure handling, and recovery authority.

openTag internal Sessions are distinct from Provider-native subagents. When a person explicitly requests an openTag
internal Session, the visible Session uses `opentag session create` rather than substituting a Provider-native subagent.
openTag does not otherwise impose one automatic routing policy between direct work, Provider-native subagents, and
internal Sessions.

When a SessionMessage returns to a visible channel or thread Session, that callback Run retains the visible Session's IM
authority. Credential grant v2 atomically supplies a temporary provider credential environment and a non-secret default
outbox context derived by the Server from the Session's existing conversation scope. The visible Session synthesizes and
publishes any user-facing result through the official provider CLI during that callback Run; openTag does not forward the
child's text automatically. Channel callbacks target the existing chat or channel, while thread callbacks retain the
existing thread scope. Internal targets never receive provider credentials or outbox context.

## Run outcome notices

`accepted` and `session list` describe delivery only. When an internal Session's Run ends without completing, the
Server tells the Session that created it (`created_by_session_id`):

- Local: a Run that reaches its maximum duration fails terminally with `turn_timeout` and is never rerun from scratch.
  Other permanent failures and exhausted retries are also terminal. The daemon then reports the outcome with
  `session:message:outcome`. Reports are kept in a local durable file and resent until the Server gives a final
  answer or one day passes.
- Cloud: the Runner's `session:message:settled` frame carries the failure `reason` (for example `turn_timeout`) on a
  collaboration-v3 channel. Every non-completed outcome (`failed`, `cancelled`, `unknown`) produces a notice. The
  Server makes up to three delivery attempts, 30 seconds apart.

The notice is an ordinary SessionMessage from the child to its creator. It uses the existing authorization, lock order,
activity projection, and delivery, including the visible-Session callback rules. A visible creator's callback Run
decides what to tell the user; openTag does not forward anything to IM. The text starts with
`[openTag notice] Internal Session Run did not complete` (`SESSION_RUN_OUTCOME_NOTICE_HEADER`). It names the child,
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
