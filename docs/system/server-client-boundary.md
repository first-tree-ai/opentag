---
title: "Server and Client Runtime boundary"
description: "Control-plane authority, command paths, the multiplexed Client connection, readiness, and authentication constraints."
soft_links:
  - /system/agent-session-computer-model.md
  - /system/messaging/message-domains.md
  - /system/runtime/runtime-protocol.md
---

# Server and Client Runtime boundary

## Decision

The openTag Server is the authoritative control plane for Agent identity and
policy, Session identity, placement, IM facts, authorization, and global
routing. The Client Runtime is an execution node: it prepares Computers and
Workspaces, manages Provider runtimes, injects Session input, performs local
Session message routing, and exposes approved tools. Cloud Computers implement
the same Computer, Workspace, Runtime, and routing boundary through the Cloud
Runner rather than a second Session model.

Session creation and message delivery are separate operations. The Server
supports three Session operations: ensure a channel or thread Session, create an
internal Session, and end a Session. Provider start, resume, suspend, and
teardown are daemon-internal reconcile actions.

Human and script product commands call the Server API. Agent runtime tools call
in-process Client Runtime handlers. Daemon start, stop, and status use the host
service manager plus per-home ownership evidence. openTag does not introduce a
local socket or named-pipe RPC boundary between product commands and the daemon.

## Client connection

One openTag home has at most one daemon. That daemon manages the Local Computer
and multiplexes its Agents and Session Runtimes over one authenticated
WebSocket. Computer registration uses stable Computer identity; heartbeat and
silence detection describe only the current connection. Connection-instance
fencing prevents an old connection from receiving work or submitting results
after replacement. Protocol versions and capabilities are negotiated as
described in [Runtime protocol compatibility](runtime/runtime-protocol.md).

The connection carries reconcile requests and results, IM message delivery,
remote Session message relay, temporary IM credential grants, heartbeat, and
trace. Credential grant frames are secret-bearing and non-persistent: they are
handled outside ordinary logging and tracing and fenced to the current placement
and connection instance.

### Delivery and execution responsibility

Delivery responsibility is two-stage, split at the Client's acceptance:

1. Until the Client accepts an input, the Server owns its delivery. An IM
   delivery stays pending on the Server and is retried with capped backoff
   within its ingress deadline; see
   [IM delivery claim queries](messaging/im-delivery-claim.md). A Session
   message has no Server queue: an unreachable target fails visibly and the
   caller decides whether to resend; see
   [Message domains](messaging/message-domains.md#routing).
2. Once the Client accepts, the Client daemon owns execution. The Client
   persists the input, exact dispatch identity, and local Turn binding before
   reporting acceptance. The Server never dispatches accepted input again: it
   only reconciles retained custody and Turn reports after reconnect or Server
   restart, without starting a second Turn. Placement generation and
   connection-instance checks fence every acceptance and report.

[Server-to-Client delivery](messaging/server-client-delivery.md) compares the
IM, Session message, and scheduled message hand-offs stage by stage.

What the Client does with accepted work that does not complete on a Local
Computer is described next. Without the retry, or once it is spent, the
outcomes are: an IM Turn reports `cancelled / client_shutdown` for an orderly
stop, `unknown / turn_state_unknown` (`may_have_occurred`) when found starting
or running after a restart, `failed / provider_start_failed` (`not_started`)
when it never reached the Provider, and `failed / turn_timeout` for a timeout;
the Server shows the person a [failure message](messaging/im-feedback.md). A Session
message ends `failed` and its sender gets a
[Run outcome notice](messaging/internal-session-collaboration.md#run-outcome-notices).

### Delivery of completed Turn reports

The Client writes the immutable completed report into the Session binding before
submitting it to the Turn Report owner. The owner's delivery record is separate:
its failed writes retain volatile retry bookkeeping, without advancing the durable
record or sending before persistence succeeds. Initial and retry-transition write
failures use the same capped attempts, age limit and backoff as report delivery.
Exhausting that budget retains the Session's report for a later recovery reconcile.

A legal reconcile can advertise an exact retained report while the same live Turn
is reporting, including after delivery enters dead-letter. It cannot take over a
running Turn, another Turn or delivery, or a live reporting activity at a different
placement generation. Replay joins an existing in-flight report or its retry timer;
it reopens exhausted delivery only after the retained-report manifest is sent.
Confirmation records the result through the live custody owner when present, then
releases that Turn's admission and reporting activity. Disk-only recovery clears
its recovery fence instead. Cancellation of an unsent manifest starts no replay.
These paths resend the original report and never run the completed model task again.
The Server still checks current ownership, connection instance, placement and
terminal settlement before accepting a report.

With `runtime.turnReport` v6, the Server can acknowledge a report as
`superseded` after verifying that the same delivery and Turn already have a
different terminal report in the current placement. The Server preserves its
terminal result and includes its outcome in the acknowledgement. The Client
releases the exact Turn's local custody, keeps the root input receipt for
deduplication, and removes the obsolete report from replay. If the Server's
outcome is unsuccessful, the Client also removes the matching steer receipts
so the Server can deliver those inputs again. A completed outcome preserves
them. An ordinary conflict or stale placement leaves local custody fenced.

### Automatic retry of accepted work

Automatic retry of accepted work belongs to the Local Client daemon; the Server
never redelivers accepted input and only records the outcome the Client reports.
The rule ([#1301](https://github.com/first-tree-ai/opentag/issues/1301#issuecomment-6651237819)):

- A process interruption (a daemon crash or power loss, an orderly restart or
  upgrade), a model HTTP 429 (`provider_rate_limited`) and a model API that
  could not be reached (`provider_connection_failed`) share one count of at
  most 2 automatic retries. A retry that actually ran for at least 5 minutes
  resets the count (`MAX_AUTOMATIC_RETRIES`, `RETRY_RESET_AFTER_MS`); downtime,
  waiting and backoff do not count. This does not stop work that crashes the
  daemon only after running longer than that.
- `provider_connection_failed` waits as long as a 429 before its retry. It also
  covers a 403 whose body is a block page from the API's network edge (Cloudflare's
  "Attention Required!"), which Claude Code reports as a login failure: the request
  never reached the model API. A real 401 or 403 from the API is not retried.
- A model CLI that fails to start (`provider_start_failed`) before running anything
  (`executionEffects: not_started`) gets one automatic retry, in place, after about
  5 seconds (Gandy 11-10, R3). It shares the same count, so it never adds a retry
  beyond the limit of 2. A start failure that may have run something is not retried.
  A Provider that could not be made ready (for example its readiness probe passed its
  deadline on a busy Computer) ran nothing either, so it counts as a start failure, for
  an IM Turn and a Session message alike. A missing model login does not: waiting does
  not fix it.
- The Run's duration limit counts actual running time across retries and resumes.
  A resume keeps what is left of the budget. A Provider waiting in-process for a
  used-up quota window to reset is not running, so its budget stands still
  ([Quota auto-resume](runtime/quota-auto-resume.md)). Reaching the limit (`turn_timeout`)
  is not retried, and neither is any other failure.

Run time is recorded durably about once a minute while a Run works, so a crash
loses at most that much of it.

A failure that is not retried, and running out of retries, are reported as
before: an IM Turn gets its terminal report and failure message, a Session message's
sender gets its [Run outcome notice](messaging/internal-session-collaboration.md#run-outcome-notices).
While a retry is pending or running nothing is reported, so the Server shows no
failure message and sends no notice for it.

The retry continues the same Session with a continuation notice as the first
input item — `[OpenTag] Your previous turn was interrupted at <time> because
<reason> (automatic retry). Before continuing, check your history …` — then
the original input and, for an IM Turn, the messages steered into it, in their
original order. Duplicates
are acceptable: the Provider may or may not have persisted the interrupted turn.

- A 429 retries in place, in the same daemon, after about 30 seconds; a start
  failure after about 5 seconds. Its count is settled when it fails. The ingress deadline bounds only the first attempt. An IM Turn keeps its delivery and Turn identity, so
  the retry's report settles the original delivery.
- An orderly stop (`opentag daemon restart`, upgrade) does not report
  `cancelled / client_shutdown`; it records the interruption durably and leaves
  the Turn unresolved for the restarted daemon to count. A crash leaves no
  record of its own: an unresolved Turn found on restart is a crash.
- On startup the daemon counts the retry durably before anything runs, unless a
  429, a start failure, or an earlier start already counted it and that retry has not begun. So a
  restart while a counted retry waits does not count it again, and the retry keeps
  the reason it continues from. The daemon records that the retry began before it
  starts the Turn, so a Turn that crashes the daemon right away still counts. If
  that record can't be written, or the Turn has no record to update, the retry
  doesn't start and stays pending, as it does when it can't start yet. Shutdown
  stops this before the runner and waits for a write in flight, so a retry that a
  stopping daemon never ran goes back to waiting and isn't counted. When the
  retries have run out, the Turn gets its recovery report and the Session
  messages steered into it fail with it. The IM Turn's original
  input lives in a per-Session file under `data/runtime/turn-retries/`, written
  at acceptance and removed when the Turn's result is recorded. It is part of
  the acceptance boundary: when it cannot be written, the just-committed
  custody is undone and the delivery is rejected as retryable. If that undo
  cannot be confirmed either, the durable custody stands and the Turn is
  accepted without an automatic retry, so an interruption is reported through
  ordinary recovery. Every steered message is captured in the input before it
  is steered; when it cannot be (storage failure, or more than 16 steered
  messages), the steer is deferred and the Server delivers the message after
  the Turn. A retry replays only captured steers with a durable steer receipt,
  that is, the ones the Server settled with this Turn. When a Turn has captured
  steers and its Session binding is unreadable or no longer holds the Turn, the
  receipts are unknown, so no retry runs and the original failure is reported
  rather than completing without acknowledged input. An in-place retry first
  waits briefly for steers still in flight, so one acknowledged as the Run ends
  is not lost; if one does not settle in time, the failure is reported the same
  way. A Session message's
  interruption and run time are kept on its durable inbox record, updated in
  place so the inbox order survives a restart; the Server-backed durability
  adapter does not store them, so a recovered Run there resumes as a crash, gets
  its whole budget again, and its count never resets.
- Only the Server can prepare a Session for the new connection (current
  snapshot and a fresh Session CLI proof), so after connecting the daemon sends
  `session:recover` for each Session with interrupted or waiting work (see
  [Session recovery](runtime/runtime-protocol.md#session-recovery)). The Server
  moves the IM Turn's report ownership to the new connection and sends a ready
  reconcile, admitted at its send boundary only while the Agent, Session and
  placement are still live, so a concurrent Agent stop is never overtaken. The
  daemon prepares the Session around its unresolved Turn and resumes it;
  when it cannot start yet (for example admission is full), the resume stays
  pending and the daemon asks for another reconcile. Before and during the resume the Session answers the
  Server's accepted-recovery reconcile with `busy / active_turn`, which defers
  recovery without a diagnostic and is never a report.
- The daemon owns each recovery until the Session is actually prepared: after
  `scheduled` it waits for the ready reconcile, and sends the request again
  when the reconcile does not arrive. A refused reconcile, a refused request
  (for example the Session ended), a missing capability, or running out of
  attempts falls back: the IM Turn gets its `unknown / turn_state_unknown`
  recovery report and waiting Session messages fail, each with a notice to its
  sender.
- Session messages waiting for that preparation are not failures. Once the
  Turn is resumed they are steered into it in order; see
  [Session messages steered into an IM Turn](messaging/internal-session-collaboration.md#session-messages-steered-into-an-im-turn).
- An automatic upgrade does not wait for running Sessions. It installs the new
  version while they keep running and new work keeps arriving, so a failed
  install costs them nothing. It then closes admission and stops the daemon
  through the orderly stop above. That stop still finishes its durable writes
  (interruption records, inbox records, Turn reports and Session message outcome
  reports); a report not yet sent is replayed after the restart. Background
  processes a Run started are lost with it.
- An automatic upgrade waits only while the Client is registered with a Server
  that did not negotiate `runtime.sessionRecovery`, that is, one older than this
  retry. Then it closes admission and waits for protected work, and new input is
  refused with `client_busy` until the wait ends or that changes. An IM delivery
  stays pending on the Server and arrives later; a scheduled message is recorded
  as `unreachable`. A Client that is not registered does not wait: while
  disconnected nothing can be delivered, and a Client the Server rejected for its
  version can finish its work only after upgrading.
- Manual `opentag upgrade` and `opentag daemon restart` still stop the daemon
  without waiting.

Cloud is unchanged: accepted Cloud custody is never replayed automatically (see
[Cloud Runner execution](cloud/cloud-runner-execution.md)); the Cloud model proxy
retries model 429 responses within a model call.

Computer repair commits installation replacement, old credential revocation,
new credential issuance, and connect-code consumption in one transaction. The
Server then waits at most one second for connection cleanup. A cleanup failure
or timeout is logged separately and does not replace the committed exchange
response. Cleanup targets only the revoked credential IDs, so a delayed close
cannot evict a subsequent connection authenticated with another credential.

Create-code redemption is idempotent per installation. `computer connect` keeps
the home's existing installation ID for the same Server and sends its current
machine token when it has one. Under the Account and code locks (then the target
Agent, for a targeted code) the exchange locks the installation's live Computer
and classifies it:

| Installation's live Computer | Result |
| --- | --- |
| None (never seen, or deleted) | Create a new Computer (`created`). |
| Another Account's, or the presented token belongs to another Account | `COMPUTER_ACCOUNT_CONFLICT` (409). Nothing is consumed or changed. |
| Same Account, online on the same release, untargeted code, current token presented | `already_connected`: no credential rotation or reconnect, no token returned; the code is redeemed by this Computer so the issuing page reaches its connected state. |
| Same Account, otherwise (offline, disconnected, another running release, token stale or absent, targeted code) | Repair in place (`repaired`): same Computer ID, `disconnected_at` cleared, credentials rotated, code consumed. |

The connect command is one command that users and Agents can run again safely: it upgrades openTag first, then
connects, and on an already-connected computer it repairs or confirms instead of adding a duplicate. Rerunning is the
expected fix for a half-finished or broken connection, so it must never make things worse. The upgrade finishes
before connecting starts: overlapping them would save little time and add failures from a connection made by one
version while another is being installed.

- An account conflict stops without taking the computer over and offers no web action to do so. The browser that
  issued the command may be signed in to a different account than the one that owns the computer, and only the
  current owner can release it (by removing it in openTag).
- An already-connected computer still consumes the code, and both the web page and the CLI show the same plain
  “connected” result as a fresh connection. Whether anything changed is an internal detail the reader cannot act on.

The connect logic lives in the command, not in prose around it. The command checks the existing installation,
upgrades it, repairs or confirms an existing connection, and stops on conflicts, so the text the web hands out is the
command itself, led by one inert line for an Agent:

```sh
: 'openTag: connect this computer to my account. Run the next line as-is in a terminal on this computer and report its output.'
<connect command>
```

The same two lines work pasted into a terminal and pasted to an Agent, so there is one artifact to explain and test,
and a person and an Agent get the same behavior. The first line is the POSIX null command `:` rather than a `#`
comment, because macOS zsh leaves `interactive_comments` off and a pasted `#` line fails with `command not found`.
A repair command adds `--computer <id>`: the CLI stops with a plain message, before using the code, when this home is
connected to a different Computer on that Server, so no "make sure you are on the right computer" prose is needed. A
home with no connection (lost identity) may be that Computer and continues.

The request fields `machineToken` and `reportOutcome` are optional. The Server
answers `outcome` (and may omit the token) only to Clients that sent
`reportOutcome`, so older Clients keep their strict response shape; a newer
Client retries once without the optional fields when an older Server rejects them
as unknown keys, which happens before redemption. Older Clients always send a new
installation ID and therefore still create a new Computer on rerun. Repair-mode
codes keep their targeted behavior.

The local installation ID is the only identity of a Computer. While it is intact, a
rerun repairs the original Computer, subject to the Account conflict above. When it
is lost (deleted home, reinstall), a create-code rerun creates a new Computer and the
previous one stays where it is, offline, in its own Account. This holds across
Accounts too: another Account's code on a machine with no local identity creates a
new Computer in that Account, reveals nothing, and raises no conflict. The Server
does not try to recognize the physical machine: no hardware identifier is reliably
unique (cloned images share them), so a match could hand one machine's Computer to
another, while a duplicate is visible and removable. Offline cards show when each
Computer was last online so that same-named Computers can be told apart.

The committed repair clears the current instance but keeps `last_seen_at`, so the
computer list keeps saying when the computer was last online until the repaired
daemon reports in. Registration, heartbeat,
and queued Runtime business frames independently validate the active credential;
delivery and approval authority also require the current instance and connection.
Closing the old socket is cleanup, rather than the authority that revokes it.
Work already executing on an offline Client cannot be physically stopped by
Server credential revocation alone.

Runtime business-frame credential admission uses one non-locking read statement.
For Local Computers, the credential association, revocation state, Computer kind,
installation, and deletion state share that statement's snapshot. Cloud admission
reads the logical Computer and installation, then revalidates the deployment-issued
control credential through the injected authority; it has no Local credential row.
A concurrent uncommitted lifecycle change can still admit a frame against the
previous committed state. This admission does not reserve authority for later
effects. Some handler placement and connection fences read the in-memory registry,
which post-commit connection cleanup updates. A frame admitted before revocation
commits can still pass those fences and take effect afterward; they do not enforce
database credential revocation. Only some paths, such as approval insertion,
recheck database authority under a row lock. This admission check does not establish
that every handler fences later effects against revocation.
Registration and heartbeat instead recheck credentials under the Computer row lock
inside the same transaction as their writes, preserving lifecycle lock order.

## Readiness

Provider readiness, provider CLI artifact readiness, and current Integration
credential execution readiness are separate, fresh, revocable facts of the
current Computer connection instance. A connected daemon or a successful CLI
version probe is not sufficient evidence. An omitted or expired observation is
absence of evidence, never evidence that a Provider is ready.

The Server may project readiness for product status and use fresh `ready`
evidence for routing, but readiness is not durable Agent or Session state.
After a Client accepts custody, it starts or resumes only the Provider pinned by
the effective runtime snapshot; missing credentials and other start failures
settle the Turn as typed, recoverable `not_started` failures. The Client never
falls back to a different Provider.

Execution admission can race the Server's acceptance commit. If the first custody
read finds no acceptance, the fallback reads the delivery state and complete
accepted identity in one SQL snapshot. Pending or expired dispatches remain
retryable; a newly accepted delivery authorizes only its matching Turn, Session,
Agent, Computer, connection instance, and placement generation. Terminal or
mismatched custody remains invalid.

### Status state outside the Server process

> **Planned — not yet implemented.** Tracking: #1215

Server services keep no in-process state, so the Server can run as more than one instance. High-frequency state that
can be lost, such as the Computer, runtime and messaging-channel sub-statuses, goes to a TTL key-value cache (Redis,
about one minute); durable data goes to PostgreSQL. A Computer is offline after three missed heartbeats (90 seconds),
which voids its other sub-statuses, and the Agent status is derived on read rather than stored; see
[Agent status pipeline](runtime/computer-status-pipeline.md). This replaces the expiring per-connection observations
described above.

## Explicit Web runtime test

Web may let a user explicitly test the saved Agent runtime configuration by
asking the Agent's bound Computer to make one real, bounded Provider request.
The test creates no Session or Provider binding, changes no readiness
observation, and writes no durable record. The daemon validates a one-time
sentinel locally and returns only pass or a fixed sanitized failure. A pass
proves only that this invocation worked with that configuration on that
Computer; it is not an authentication or readiness claim.

## Response compatibility

The Server, the CLI, and already-open Web SPA tabs can run at different
versions. A Server release applies to everyone at once, while a CLI upgrades
only on its next connect and an open Web browser tab keeps running its loaded
bundle (polling every 30 seconds) until the user navigates or reloads. The HTTP
contract therefore follows one convention:

- The Server changes responses additively: it may add fields, but it does not
  remove, rename, or retype an existing field.
- Both the CLI client (`packages/client`) and the Web SPA (`apps/web`) ignore
  response fields they do not know through `parseResponseIgnoringUnknownKeys` in
  `@opentag/shared` (`@opentag/shared/browser`). Each response is parsed with
  the strict shared schema and, when the only problems are unrecognized keys,
  drops exactly those keys at the paths the schema reports and parses again.
  Every known field stays fully validated, so additive Server response fields do
  not break released CLIs or open browser tabs before their next navigation or
  reload. In `packages/client`, the dropped key paths (never values) go to the
  client's debug log so version skew is visible when diagnosing.
- Removing, renaming, or retyping a field, adding an enum value, or any other
  change an older client cannot read still needs version negotiation or a client
  capability header (an `x-opentag-*` request header that opts a newer client
  into the new shape). A capability header is not needed for a new field once
  the released CLIs ignore unknown fields.
- Request bodies stay strict on the Server: unknown keys sent to the Server are
  rejected.

The runtime connection negotiates capabilities in its own protocol and is
outside this convention.

## Rationale

The Server needs global authority to route across Computers and integrations,
while Provider processes and files are inherently local to execution. A single
multiplexed connection gives the Server real-time reachability without making
connection state a durable Session fact. Direct Server API commands and
in-process runtime tools avoid a second local control protocol and a second
writer of Session truth.

## Constraints

- Computer disconnect changes route availability only; it does not end or
  reassign Sessions.
- Provider credentials never enter prompts, IM messages, Session messages, or
  trace data.
- `direct` and `ambient` attention are input semantics, not credential
  authority: both visible IM Turns receive the temporary provider environment.
- Any Web admin status is timestamped trace or debug output and cannot become
  routing, placement, lifecycle, or reachability authority.
- A Computer first connects with a one-time code whose hash is stored by the
  Server and invalidated after a successful exchange.
- The Server runs checked-in database migrations before listening, holding a
  PostgreSQL advisory lock for the full migration so several Server instances
  cannot become concurrent migration writers.
