---
title: "IM task feedback and safe recovery"
description: "Durable working reactions, terminal error cards, Account confirmations, and conservative recovery of unknown provider outcomes."
---

# IM task feedback and safe recovery

The Server owns task reactions and system error cards. The Agent still sends its final reply through the
[provider CLI](direct-provider-cli.md). This is a narrow system feedback surface, not a general hosted message API.

## Normal tasks

Eligible inputs are direct human messages delivered to visible, non-observer Sessions. Ambient observations,
internal messages, duplicate-pending copies, deleted inputs, and a Channel copy owned by a Thread do not gain
feedback merely from receipt. Dispatch-time observer roles and later Thread ownership are rechecked before
projection. Retained custody only reopens feedback for unreported work. A confirmed later completion updates an
existing expiry card, or suppresses it if it has not been sent. Ingress records a queued projection; custody acceptance requests a working reaction
on that exact native input: Slack `eyes`, Feishu `OnIt`. Heartbeats and approval waits do not change it.

A terminal success removes the working reaction without adding a normal-operation card or completion emoji.
The final reply and reaction removal are separate provider operations. A reaction repair never replays execution.
Failure removes working and adds Slack `warning` or Feishu's supported `CrossMark` failure marker; Feishu has no
native `Warning` identifier in its reaction catalogue. Only this application's designated reactions are removed.
Frozen batches retain per-input reactions but publish one failure card at the execution root. Unexecuted steered
children requeued by custody retain their existing execution authority.

## Error cards

A card stays in the original conversation or thread. It contains a sanitized cause and error code, task-effects
warning, current recovery guidance, and details link. Raw model output, exception messages, credentials, file paths,
and stack traces are excluded. Only authoritative `not_started` evidence permits the claim that no task operations
ran. All other outcomes warn that external operations may already have occurred; missing outbound capture proves
nothing about those operations.

A workspace failure pauses that Session rather than the entire Agent. New input remains queued for the Session.
Saving or discarding files does not undo messages, pull requests, or other external operations. The existing Runner
owns automatic save retries; this feedback layer adds no automatic save or task retry loop.

## Account operations

Card links open an authenticated Account page. Opening a URL and refreshing details are read-only. The page shows
the original Task link, exact Session, workspace generation, effects warning, selected operation, and the last-save boundary; when its
time cannot be verified, the page says so. The Agent detail page also exposes recovery notices when a card cannot
be delivered. Lists are owner-scoped and paginated in batches of twenty.

The final CSRF-protected POST rechecks the current Account owner, active binding and installation generation,
source-message revision, Session, placement, expiry, and allocation tuple. A five-minute signed confirmation binds
the Account, feedback revision, and operation. Discard requires a second confirmation with an explicit permanent-loss
acknowledgement, enforced by the strict HTTP schema and service admission as `permanentLossAcknowledged: true`. The placement generation must still match the feedback target even when the workspace allocation is unchanged. Concurrent save/discard requests admit one operation per revision. Cloud calls run after commit,
using the existing generation-bound sandbox service; the action is persisted before submission.

A verified save says that the environment was saved and released and will restore on the next allocation, never that
execution resumed in place. Save success requires the exact generation's sealed archive proof. An unallocated
environment alone yields an unverified release message. Unknown or restarted operations are queried, never
resubmitted automatically. The original card shows the operation result, actor, and timestamp.

A task Retry needs an immutable `not_started` terminal report or definitive never-dispatched rejection. It creates a
new delivery ID and an attempt ordinal from one through three, preserving the original report and input deadline.
Agent custody admission prevents simultaneous active attempts and rechecks queue capacity and placement. A native
Retry callback additionally authenticates the installed App and exact original sender, channel, card, and generation.
Native identity never authorizes workspace destruction. Unknown or potentially completed task effects remain
ineligible. A frozen initial batch is also ineligible: replaying only its root would omit member inputs. Its card and Account page explain this limitation and link to the original Task for review. Successful admission says "Retry queued", not "Task completed".

## Projection, unknown outcomes, and retention

`im_feedback_targets` stores source scope, desired reaction, card identity, revisions, and bounded worker claims.
`im_feedback_actions` independently stores confirmation, idempotency, and operation outcome. Existing custody remains
the only execution authority. Terminal report and feedback transitions commit together; feedback cannot make an
invalid report acceptable. Reads use a short owner-authorized snapshot. Mutation admission locks Agent custody,
Agent/binding, Session/placement/delivery, then feedback/action; no provider I/O holds database locks.

One worker processes at most eight due targets per pass with `SKIP LOCKED`, a random ninety-second claim, and the
shared provider call policy. It checks authority again before I/O and cannot settle a newer desired revision as its
own. Binding rotation fences new calls and callbacks; it cannot revoke a request already in flight.

Before a new card request, the worker persists `sending` and a stable request identity. A lost acknowledgement or
abandoned send becomes `send_unknown`. Bounded readback searches the original conversation for this Bot and feedback
identity, up to one hundred messages per page and five pages per pass, retaining a cursor. A confirmed match binds
its native ID. Multiple observed matches are a defect. Negative, inaccessible, or incomplete reads never authorize
another creation. Readback stops at the twenty-four-hour action deadline; unresolved sends become dormant without deletion or another creation. Feishu topic replies are read through the `thread` container without unsupported time-range filters ([provider contract](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/list)). Unknown sends remain in Account diagnostics with sanitized operational warnings. This deliberately
does not promise unconditional eventual delivery or exactly-once external sending. Known-message updates use that
same native ID. If completion arrives while creation is in flight, a definitely-not-applied result suppresses the new card, while a confirmed or ambiguous send retains its binding/reconciliation path. Slack rate-limit responses are classified within the call-policy boundary so they do not count toward the shared outage circuit; per-target Retry-After does not coordinate the method limit across other targets or Server processes. Old buttons cannot authorize a stale operation.

New actions expire after twenty-four hours and task retries also respect the original input deadline. Confirmed,
settled projections and actions retain ninety days of diagnostics; cleanup is bounded to one hundred records per
retention tick. Unknown sends and operations survive expiry. Referenced source deliveries/messages remain available
until their feedback is safely removed. No historical error-card backfill runs.

## Writer cutover

New Server processes stop creating Slack native thread-status projections. The old worker only drains known status
indicators; outbound capture no longer refreshes them. The old reaction notifier is disabled in the Server composition root. Its module and synthetic fixtures remain temporarily for the existing queue-policy and legacy reaction regression suites; they provide no production fallback and must not be reconnected alongside durable feedback. Old and new writers
must not overlap during rollout, and old writers must not insert deliveries after explicit retry attempts are enabled.
Coordinate this through the existing compatible release process without scaling the service to zero. The migration
alone does not establish deployment or native Slack/Feishu acceptance.
