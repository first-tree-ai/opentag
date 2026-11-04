# Ordinary Feishu Bot guidance: source research

Research only, 2026-11-04. No product code, permissions, subscriptions, menus,
messages, schema or persistent state were changed. This records capabilities and
proposal constraints; it does not authorize implementation or automatic greetings.

## Sources and retrieval

The official document pages returned JavaScript shells to the Web extraction tool.
Their anonymous public document API returned `code: 0` and `allVisible: true`.
The endpoint and `fullPath` parameter are used by the official document frontend's
own `docSiteDocumentDetail` client. For example, the public request is
`https://open.feishu.cn/api/tools/document/detail?fullPath=%2Fserver-docs%2Fgroup%2Fchat-member%2Fevent%2Fbot-events`.
Claims below cite the corresponding canonical document, not a third-party mirror.
The previously circulated `client-docs/bot-v3/events/bot_p2p_chat_entered_v1`
path returned document-not-found; the actual modern event page is linked below.

| Primary source | What it establishes |
| --- | --- |
| [Bot overview](https://open.feishu.cn/document/client-docs/bot-v3/bot-overview) | Entry-triggered introductions and Bot menus are ordinary application-Bot capabilities; changes to app capabilities, scopes and subscriptions need publication/approval. |
| [First P2P creation event](https://open.feishu.cn/document/server-docs/group/chat-member/event/bot-events) | Legacy `p2p_chat_create` trigger, payload, scope table and long-connection examples. |
| [Bot P2P entered event](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/chat-access_event/events/bot_p2p_chat_entered) | Modern entry trigger, payload, current scope table and client/rate limits. |
| [Bot menu guide](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/bot-v3/bot-customized-menu) | P2P-only menus, three action types and console/publication steps. |
| [Bot menu event](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/application-v6/bot/events/menu) | `application.bot.menu_v6`, operator/event-key payload and field permissions. |
| [Event overview](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/event-subscription-guide/event-subscriptions) | Event identities, retries, duplicate delivery even after success, and publication. |
| [Create message](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/create) | Recipient identifiers, send permission and bounded `uuid` deduplication. |

The installed official `@larksuiteoapi/node-sdk` is 1.73.3. Its
`types/index.d.ts` contains all three event handlers and the registration addon
contract. SDK types corroborate shapes, not actual subscription enablement.
No Aily or helpdesk-specific opening-question feature is assumed here.

## Event choice and payload

| Candidate | Trigger | Identity and destination | Current event permission table |
| --- | --- | --- | --- |
| `p2p_chat_create` | First creation of a user/Bot conversation. | v1 envelope `uuid`; event `app_id`, `tenant_key`, `chat_id`, `operator` and `user`. The initiator may be the user **or the Bot**. | No base or field permission listed; supports custom/store apps. |
| `im.chat.access_event.bot_p2p_chat_entered_v1` | Entry into a Bot conversation; it is not a first-use flag. | v2 `header.event_id`, app/tenant; event `chat_id`, `operator_id`, latest visible message ID/time. | No base permission listed; `contact:user.employee_id:readonly` is needed only for the optional `user_id` field. Custom apps. |
| `application.bot.menu_v6` | A person clicks an event-type Bot menu item. | v2 event ID/app/tenant, `operator.operator_id`, `event_key`, click timestamp. **No `chat_id`** is specified. | No base permission listed. Operator name and employee user ID have optional field scopes. Custom apps. |

The legacy document includes SDK WebSocket examples despite its table's generic
Webhook label. The modern event requires client v7.18+ and may drop events above
300 events/second per Bot. Neither recent-message fields nor absence of a message
ID prove that the person has never received guidance.

**Scope conclusion:** the current specific event pages do not require adding
`im:chat.access_event.bot_p2p_chat:read` to OpenTag's global required-scope list.
The existence of that key in another permission catalog is not evidence that the
current event requires it. Using `open_id` avoids requesting optional name/user-ID
fields. Actual subscription and delivery still need a controlled platform check.

## First-use semantics are separate from event deduplication

The event overview defines v1 `uuid` and v2 `event_id` as delivery identities.
Feishu can redeliver successfully acknowledged events, and retries failed handling.
Therefore even a first-creation event needs idempotent handling.

Inference for the proposal: legacy first-creation is the closer trigger for one
initial introduction, but it must exclude Bot-initiated creation. There is no
verified backfill guarantee for relationships created before subscription. A
modern entry event can cover returning users but generates distinct events on
different entries; deduplicating each event cannot implement one greeting per
person/conversation over time. That requires an explicit durable eligibility
rule. No such new rule or state is authorized by this research.

## Discoverable help through a Bot menu

The menu guide makes this a P2P-only capability. A menu can open a link, send its
own label as a message, or push an event. Sending menu text requires client v7.22+.
An event action requires subscribing to `application.bot.menu_v6` and configuring
an `event_key`. A short Help menu is feasible; neither route is configured today.

The console workflow enables the menu, saves configuration and publishes an app
version; client visibility can lag publication by five minutes. Switchable menus
need v5.27+, while floating menus need v7.22+. The guide explicitly distinguishes
Aily-managed menus: its setup does not establish ordinary Bot configuration.

Proposal inference: a user-clicked text menu could request help through the
existing message-receive event, avoiding a new menu-event handler. It is an
intentional user request, not an unsolicited greeting. An event-type Help menu
can use the operator's application-scoped `open_id`, but cannot be treated as a
message reply carrying a source message or chat ID. Its send path needs a separate
fit check. No menu response or welcome message was sent in this investigation.

## Subscription and existing-app rollout

Current `feishu/registration.ts` declares only receive/recalled tenant events and
`card.action.trigger`; `feishu/adapter.ts` dispatches those same events/callback.
The SDK's `AppAddons` accepts scope/event/callback arrays but no menu configuration.
It documents three material limits: unknown catalog items can be silently dropped,
extra configuration depends on platform rollout, and `preset: true` layers on the
platform's base template. A declared array alone does not prove actual subscription.

The SDK can update an existing App through `RegisterAppOptions.appId`; its confirm
page displays addon differences and asks the user to reauthorize. Event/console
configuration needs publication; changing only Server code does not update each
installed App. Adding an event with no new mandatory permission is not, by itself,
evidence that every healthy binding must be forced into missing-scope reauthorization.
No registration or reauthorization operation was performed.

## Sending and unknown results

The create-message contract accepts `open_id` or `chat_id` recipients, recommends
the application's `open_id` for a user, and requires the user to be within Bot
availability. Existing `im:message` or `im:message:send_as_bot` permits sending.
Its optional `uuid` is at most 50 characters; requests sharing it can successfully
create at most one message within one hour. Different content requires a different
UUID. This is a bounded provider contract, not a permanent first-use ledger or an
exactly-once outcome guarantee after an ambiguous response.

Proposal inference: preserve a stable logical-send identity across ambiguous
transport outcomes; do not invent a fresh UUID and resend. Event-receipt deduplication,
first-greeting eligibility, and external-send settlement are different questions.
Whether OpenTag's existing infrastructure can own them is the parent task's code
audit; this source research does not extend its message or recovery schemas.

## Remaining checks before any implementation

- Verify declared subscriptions actually take effect for both new and existing Apps.
- Observe first P2P creation versus later entries in a dedicated test conversation;
  do not infer them from the current lab's already-created DM.
- Verify menu visibility, text-message behavior or event callback, and exact Bot
  destination on supported clients after publication.
- Specify handling of duplicate delivery, concurrent first triggers, process restart,
  unknown send outcomes, binding replacement and old-event replay before promising
  a one-time introduction.
- Use only the short first-DM/help proposal; no group welcome, every-entry welcome,
  repeated per-message teaching, or platform-specific suggested-prompt assumption.

Only public docs and local source were read. No UI, shared service, provider
credential, database, or acceptance environment was used.

## Repository boundary audit

Audited code: PR 1261 head `3346789e55849a3a1970dd99e92b48e4df6b833f`.
The current Web starter-request direction has been rejected; historical functional
checks and green CI do not accept that product direction. The Web reduction was subsequently authorized separately. IM options below
remain proposals; no permissions, events, menus or sending state were changed.

| Existing mechanism | Reusable boundary | What it does not establish |
| --- | --- | --- |
| [Registration](../../packages/server/src/services/im-bindings/feishu/registration.ts) and [dispatcher](../../packages/server/src/services/im-bindings/feishu/adapter.ts) | Existing app-bound connection, current generation and event dispatch infrastructure. | Source requests receive/recalled events and a card callback, not a welcome or menu handler. Platform presets may differ; actual subscription is unverified. The current in-memory deduper understands message/recall identities, not legacy first-P2P `uuid`. |
| [Receipt store](../../packages/server/src/services/im-bindings/feishu/inbound-receipt-store.ts) | Atomic `(binding, event_id)` uniqueness and attempt-based settlement patterns. | Different entry-event IDs are different receipts, not a durable "already welcomed this user" decision. An event-only claim without `work` is technically possible, but skips the work-specific holder/generation fence and does not gain recoverable input or outbound result tracking. It is not a drop-in welcome outbox. |
| [Inbound work](../../packages/server/src/services/im/inbound-work.ts) and [normalized input](../../packages/shared/src/im-message.ts) | Strict real-message payload and current connection-fenced recovery. | A chat-entry/menu event has no genuine source-message content/ID and cannot be cast into this schema. Creating synthetic user messages, Tasks or Turns would change existing data semantics. |
| [Receipt retention](../../packages/server/src/runtime/im-delivery-janitor.ts) | Bounded cleanup of settled input receipts, default 30 days; message-work recovery eligibility is seven days. | These are input lifecycle rules, not permanent per-user welcome eligibility or unknown-outbound retention. |
| [Feedback target schema](../../packages/server/src/db/schema/im-feedback.ts), [messenger](../../packages/server/src/services/im/im-feedback-messenger.ts), [worker](../../packages/server/src/services/im/im-feedback-worker.ts) | Credential-generation admission, bounded provider calls, stable send identities and conservative unknown-result patterns. | Targets require real message/Session/delivery identity. Feishu feedback replies to `inputExternalId`; first-entry events provide no such source message. Task failure state and error-card readback cannot silently become welcome-message state. |
| [Provider CLI contract](../../docs/system/messaging/direct-provider-cli.md) | Normal user-requested Agent replies through the existing Turn-scoped path. | Opening a Bot is not a user Task and does not authorize minting a fake Turn to send a greeting. |

Adding a scope to `FEISHU_REQUIRED_TENANT_SCOPES` makes an active binding missing
it fail `hasRequiredFeishuTenantScopes` and project reauthorization-required through
`needsScopeUpdate` in [the binding service](../../packages/server/src/services/im-bindings/im-binding-service.ts).
That would affect existing healthy Apps; it is unnecessary for the event base
permissions found above. Optional name/employee-ID fields must not become a reason
to request unrelated identity access. Subscription changes and any explicit
existing-App update still need their own rollout and provider confirmation.

## Bounded proposal for early presentation

1. **Web revision:** remove `StarterRequests`, its editable input/draft/copy-request
   controls and ten guidance-only catalog keys from the completion component. Keep
   readiness, matched Bot identity, a direct in-app DM action, a short manual failure
   fallback and secondary View agent. Remove the completion's Hello/first-task
   instructions. Existing identity read, late-result retirement and setup/reboard
   boundaries remain. The existing native/HTTPS handoff contract needs the
   coordinator's provider/client verification; a browser landing is not the target.
2. **Explicit IM help candidate:** a P2P Bot menu's send-text action can issue the
   real user's Help request through the existing receive/Task/Turn/reply path. It
   requires menu configuration/publication and supported clients, but not a new
   menu event or first-welcome ledger. Repeated clicks are intentional requests,
   not repeated unsolicited onboarding. The actual Help wording/response remains
   a product proposal; it has not been installed or sent.
3. **First-DM introduction candidate:** use first-P2P creation rather than every
   entry, filter Bot-initiated creation, and specify who qualifies before sending
   a short description and two text-only examples. Do not welcome groups or add
   per-message teaching. No existing-user backfill is established. This candidate
   needs the delivery decisions below; it is not released merely because the
   platform supports an event.

These are independently bounded options, not an instruction to implement all of
them. The Web revision does not require introducing an IM outbound state machine.

### Decisions required for a first-DM send

- **First means what:** specify Bot/App identity plus tenant/person/conversation,
  and whether replacing the Bot creates a new eligibility scope. Credential
  rotation must fence stale sending without silently making the person "new".
  A first-creation event can supply the trigger without an every-entry eligibility
  lookup, but it does not prove a successful previous send.
- **Concurrent/replayed input:** retain the real v1 `uuid` or v2 event ID and
  validate app/tenant/current binding and connection ownership before admission.
  Distinguish delivery deduplication from a stable logical outbound operation.
  Do not reuse a message-specific parser or bypass its fence by supplying no work.
- **I/O boundary:** any provider request runs after admission commits, outside DB
  locks, and rechecks current authority. Reuse the existing call-policy and
  credential-fencing patterns, not fabricated feedback target identities.
- **Lost acknowledgement:** provider `uuid` deduplication is limited to one hour.
  A crash or ambiguous response must not lead to a fresh UUID and blind resend.
  Decide whether this is only an at-most-one attempted optional greeting, allowing
  loss and relying on explicit Help, or whether confirmed delivery/reconciliation
  is required. The latter needs an explicit owner for send intent, native message
  identity, unknown outcome and retention. Existing input receipts do not already
  provide that guarantee. No new table is asserted to be mandatory by this audit,
  and no existing row's meaning may be changed silently to avoid design review.

## Verification scope for a subsequently chosen implementation

- Web: completion/native-link policy tests; no tutorial/input form; matched and
  stale identity; missing/unconfirmed brand fallback; exact Agent navigation;
  setup/reboard and i18n guards; Web typecheck/build for changed messages/imports;
  `pnpm check` before any commit. The coordinator presents the concept first and
  captures the revised runnable page before opening/updating delivery claims.
- Menu Help: actual configuration/publication/client visibility, one explicit
  click becoming one normal user message/Task, duplicate receive-event handling,
  useful short Help response and no send on mere entry. No new menu event is
  presumed for the send-text option.
- First-DM send, only if selected: exact first-creation versus later-entry behavior,
  user/Bot initiator, duplicate/concurrent delivery, restart and lost send ACK,
  rotation/replacement fencing, no group send and no automatic greeting backfill.
  A previously created lab DM cannot prove a first-creation trigger.
- Event/read-write/unknown-send changes require their own relevant Server unit and
  PostgreSQL integration coverage and agreed persistence semantics. New schema
  would require the repository's human-confirmed database proposal and full Server
  integration scope. None of those changes or environments were created here.

## Native-link follow-up: normative contracts, not client acceptance

This follow-up only read the same anonymous official documentation endpoint. No
URI was opened or tested. The current direction retains the supported HTTPS
AppLink while the coordinator verifies that the actual button ends in the correct
in-app DM from a non-chat starting point; these findings do not authorize replacing it.

| Normative source | Confirmed contract |
| --- | --- |
| [Feishu AppLink structure](https://open.feishu.cn/document/uYjL24iN/ucjN1UjL3YTN14yN2UTN) | Standard scheme/host are HTTPS and `applink.feishu.cn`. Outside Feishu, an AppLink webpage precedes launching the client. The documented alternate scheme is **`feishu`**, which attempts direct launch without an automatic webpage fallback on failure. Its explicit example is `feishu://applink/client/op/open`; host `applink` is supported from v5.10. |
| [Feishu: open a Bot](https://open.feishu.cn/document/uAjLw4CM/uYjL24iN/applink-protocol/supported-protocol/open-a-bot) | `/client/bot/open` opens a Bot chat window, requires its `appId`, and is supported from v3.40.0. A person outside the Bot's availability receives platform guidance. The explicit example is an HTTPS AppLink. |
| [Lark AppLink structure](https://open.larksuite.com/document/uYjL24iN/ucjN1UjL3YTN14yN2UTN) | The international host is `applink.larksuite.com`. Its documented alternate scheme is **`lark`**; the explicit example is `lark://applink.larksuite.com/client/op/open`. It attempts direct launch and does not automatically fall back to the webpage on failure. |
| [Lark: open a Bot](https://open.larksuite.com/document/uAjLw4CM/uYjL24iN/applink-protocol/supported-protocol/open-a-bot) | The Bot protocol is `https://applink.larksuite.com/client/bot/open`, with mandatory `appId`, the same v3.40.0 minimum and Bot-availability condition. |

Combining each generic scheme contract with its Bot path gives the following
**derived, untested candidates**, not exact Bot-native examples printed by the
individual Bot pages and not a recommendation to change the current button:

- Feishu: `feishu://applink/client/bot/open?appId=<verified-app-id>`.
- Lark: `lark://applink.larksuite.com/client/bot/open?appId=<verified-app-id>`.

Do not substitute the community-sample `lark://applink.feishu.cn/...` for a
normative mainland Feishu contract. Brand/domain selection must follow verified
binding identity, not the Web locale or translated provider label. The general
structure pages also describe custom/private-client selection through webpage
parameters; that is not evidence that every native protocol handler or browser
will select the intended client. Browser/system confirmation can still occur.

The remaining requirement is real destination evidence for the actual supported
button: the intended installed client, workspace and Bot private conversation.
A landing page, pre-existing open DM, app focus change or search dialog alone does
not establish that result. No native behavior or cross-brand compatibility was
validated by this research.
