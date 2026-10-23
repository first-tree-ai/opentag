---
title: "Production alert relay"
description: "A stateless Cloud Run webhook that forwards Monitoring incidents to Feishu with SMS urgency."
---

# Production alert relay

`ops/alert-relay` is deployed independently from the Server. Cloud Monitoring posts incidents to `/monitoring` over
HTTPS with dedicated Basic Auth. The relay sends a Feishu group message and requests SMS urgency for two configured
users. Recovery sends an ordinary group message. Existing email and SMS notification channels remain independent
fallbacks. The service has no database, queue, delivery ledger, incident cache, or background worker.

## Notification behavior

GCP owns incident grouping and repeated-notification control. For selected metric-based production policies, use
`notificationPrompts: [OPENED, CLOSED]`. Do not configure a `NotificationChannelStrategy` for the relay channel, so it
receives the default initial notification rather than periodic reminders. Preserve other channels and their settings.
The relay also ignores open notifications carrying GCP's `renotify: true`; recovery messages are still forwarded.
Log-based policies support only `OPENED`; preserve their GCP `notificationRateLimit` instead of applying metric-policy
recovery settings. A rate limit bounds notices but does not promise one notice per incident.

This controls repeated reminders, not exactly-once transport. A duplicated initial webhook, lost HTTP response, or
out-of-order delivery can repeat a group message or SMS. Without stored state, the relay cannot suppress those cases,
remember a recovery, resume a partially completed delivery, or distinguish a retried initial notification. Do not add
storage or an in-memory incident cache to conceal this boundary.

The relay validates schema version 1.2, project, full condition resource name, policy allowlist, incident identity,
state, timestamps, and repeat flag. It limits bodies to 64 KiB and derives the console link from validated identity,
not an untrusted summary or supplied URL. Each request has an eight-second external-call budget. All forwarding stays
inside the request; successful processing is never acknowledged before starting a background task.

Before the first external message, token acquisition failure returns `503`. After message delivery has been attempted,
the relay returns `200` with `complete`, `failed`, or `unknown` and logs the outcome. Partial SMS acceptance ends as
`failed`, and timeouts or malformed platform results end as `unknown`. The relay does not retry either external call.
Acknowledging a failed attempt limits sender retries after a possible external effect; it does not mean the SMS was
accepted. A lost response can still cause GCP to retry. Direct relay failure monitoring and existing channels provide
the fallback. A later duplicate request is processed independently.

## Configuration and access

| Environment variable | Meaning |
| --- | --- |
| `GOOGLE_CLOUD_PROJECT` | Allowed Monitoring project |
| `ALERT_POLICY_IDS` | Comma-separated numeric policy IDs allowed to deliver |
| `FEISHU_APP_ID` | Dedicated enterprise application with bot capability |
| `FEISHU_APP_SECRET` | Secret Manager reference to that application's secret |
| `FEISHU_CHAT_ID` | Operations group containing the bot and both recipients |
| `FEISHU_USER_ID_TYPE` | `open_id`, `user_id`, or `union_id` |
| `FEISHU_URGENT_USER_IDS` | Exactly two distinct IDs valid under this application or tenant |
| `WEBHOOK_USERNAME` | Dedicated Basic Auth username |
| `WEBHOOK_PASSWORD` | Secret Manager reference to a random password of at least 32 characters |
| `SOURCE_REVISION` | Source commit used to build the deployed image |
| `PORT` | Listener port, default `8080` |

Identifiers and recipients are deployment configuration, not public repository contents. Give the Cloud Run service
account `roles/secretmanager.secretAccessor` on just these two secrets. It needs no Firestore, Cloud SQL, VM, or policy
editing permissions. Secret Manager stores runtime credentials only, never incident or delivery state. There are no
service account key files.

The Feishu app needs `im:message:send_as_bot` and the console's applicable SMS urgency permission
(`im:message.urgent:sms` or its narrower SMS send equivalent). Resolve recipient IDs under the dedicated application;
`open_id` values from another CLI application are not interchangeable. A setup-only own-chat membership read permission
can resolve the two group members without granting chat-history or phone-number access. Publish permission changes and
limit application availability to the intended members. Confirm SMS availability and quota without buying quota or
switching to calls.

Cloud Run accepts public HTTPS traffic so Monitoring can reach it. Every request except `GET /health` requires Basic
Auth; failures return `401` with `WWW-Authenticate`. Authenticated `GET /readyz` obtains a Feishu token without sending
messages. Credentials must not appear in URLs, logs, or source code. Configure matching Basic Auth in the Monitoring
notification channel.

Start with CPU 1, memory 256 MiB, min instances 0, max instances 2, concurrency 8, and request timeout 20 seconds. Node.js
24 runs the erasable TypeScript directly; the image has no npm runtime dependencies. Use only `ops/alert-relay` as the
container build context. Record the source commit, image digest, and pinned secret versions for deployment.

## Rollout and rollback

1. Run this directory's type check and tests, and build its Dockerfile. The separate Alert Relay workflow owns these
   checks. No Server, PostgreSQL, or frontend behavior changes.
2. Create the dedicated runtime identity and secrets, deploy the standalone service, and verify authentication, payload
   rejection, readiness, and deadline handling. No database API or database resources are required.
3. Send an explicitly identified test message to the group and request one SMS urgency operation for the two recipients.
   An API success proves platform acceptance; each person must separately confirm actual SMS receipt.
4. Verify Monitoring webhook authentication and real schema delivery with an isolated test signal. Do not stop production
   to test notifications. Add the channel to the readiness policy first; after the canary succeeds, add the remaining
   approved production policies. Preserve existing channels and keep disabled Server log policies disabled.
5. Monitor relay errors and service `5xx` directly through the fallback email channel. Never route the relay's own failure
   policy back to the relay.

Rollback removes the new channel from policies before reverting the Cloud Run revision. Existing notification channels
and production service operation do not depend on the relay.

Structured logs contain only operational outcome, stage, accepted count, and controlled error code. They omit incident
bodies, incident IDs, message IDs, recipient IDs, raw platform errors, tokens, and passwords. Cloud Run request logs and
platform metrics still follow the project's normal observability retention. Error events are `relay_delivery_failed`,
`relay_delivery_unknown`, and `relay_request_failed`; do not treat an HTTP `200` alone as successful delivery.
