---
title: "Feishu connection lifecycle"
description: "Durable Feishu authorization attempts, activation requirements, bot avatars, and connection recovery."
---

# Feishu connection lifecycle

Feishu setup keeps one durable authorization attempt on the existing IM binding. When the
registration SDK returns App credentials, the Server saves them before checking activation
requirements. An enterprise administrator may approve later: a page refresh, closed browser,
or Server restart must not discard that saved authorization.

## Setup QR link

The launcher URL the registration SDK returns is over a thousand characters, and a QR symbol that
encodes it is too dense for many phone cameras. When `OPENTAG_PUBLIC_URL` is public HTTPS, the
attempt's `qrUrl` is instead a short link, `<public URL>/q/<token>`, which answers with a 302 to the
launcher. Everything that reads `qrUrl` gets it: the QR code, the open-link button, and the CLI.

- **Not a new DTO field.** The attempt DTO is strict, so an installed CLI would reject an unknown
  field. Replacing the value keeps every existing client working.
- **No storage.** The token is the attempt ID followed by a truncated HMAC of it, under a subkey
  derived from the application key. Any Server instance can verify it and no column or table is
  added. It is a MAC rather than the bare attempt ID because attempt IDs appear in authenticated API
  paths and logs.
- **Lives with the attempt.** A link redirects only while its attempt is `awaiting_user`, unexpired,
  and has a live registration owner: the same conditions under which the attempt itself shows a QR
  code. It keeps working across repeat scans, because link previews and a second scan must not use it
  up. Authorization, cancellation, expiry and owner loss all end it.
- **Anonymous and bare.** A phone has no openTag session, so `GET /q/:token` takes no authentication.
  It returns the redirect or a fixed page. A forged, unknown, expired or finished token gets one 410
  page that says the same thing for all of them. A read failure gets a 503 page that says to try again,
  and that includes a saved context this instance cannot decrypt, because key-ring skew between
  instances is temporary and another instance may be able to answer. A forged
  token is refused before any database read. Responses are `no-store` and send no referrer.
- **Kept out of logs.** `sanitizeRequestUrl` redacts the token from request logs and trace attributes.
  A reverse proxy or platform access log in front of the Server can still record the path; what that
  exposes is limited to a setup code that lasts as long as the attempt.
- **Falls back when a phone cannot reach it.** A public URL that is not HTTPS, or whose host is
  loopback, a private or reserved address, a single-label name, or a private-network suffix such as
  `.local`, keeps the full launcher URL in `qrUrl`.

The avatars and `addons` in the launcher URL stay as they are. Feishu's picker needs all six avatar
addresses, and `addons` already holds the 66 scopes, events and callbacks gzipped by the SDK, so
neither can shrink without losing function, and the short link removes the need.

## Bot avatars

Registration offers six cat presets in Feishu's native picker: developer, engineer, architect,
artist, businessman, and sales. Their versioned square PNGs are served under
`/bot-avatars/v1/` on `OPENTAG_PUBLIC_URL`; this deployment URL must be publicly reachable
for Feishu to load them. Filenames are stable compatibility identifiers, so avatar responses
require cache revalidation rather than declaring the artwork immutable. PNGs remain 512 × 512.
Matching SVG files remain available: the four website cats are vectors, while architect and
businessman embed their approved raster artwork. Existing provider-uploaded Bot avatars are
separate copies and are not automatically replaced when these preset files change.

On connection or reauthorization, openTag reads the actual Bot profile and caches its name and
avatar in the binding. Optional profile failures do not block activation. Previously cached
metadata survives a failed lookup only for the same App, workspace, and Bot identity.
Existing connections acquire avatars on their next connection or reauthorization; provider-side
changes remain cached until then. openTag displays initials when the image is absent or fails to load.

The authenticated Agent avatar endpoint rechecks Account ownership, Agent status, and the current
non-disabled binding on every request. Each resource-service instance keeps a 30-minute LRU cache
of fully validated image bytes, limited to 128 entries and 16 MiB of cached image data. Each response
owns a separate copy of at most 5 MiB while it is being sent. Cache identities
include the Account, Agent, binding ID, credential generation, and exact provider URL; changing any
of them requires a new fetch. Entries expire from insertion time and are reclaimed lazily on reads
and inserts. Concurrent cold reads remain independent; errors and empty, partial, or oversized bodies never
enter the cache. Every miss retains the HTTPS destination checks, connection-time public-address
filter, redirect rejection, allowed image types, and 5 MiB response limit. Browser responses retain
their private cache policy. The cache is lost on restart and is not shared across service instances.

## User experience

All 66 scopes in `FEISHU_REQUIRED_TENANT_SCOPES` remain required. There is no partial-permission
mode or subsequent capability upgrade. The existing Computer and Runtime preparation remains
a prerequisite to starting registration.

After credentials are saved, the setup page shows the remaining condition: permissions,
App availability, Runtime readiness, or a temporary upstream failure. It explains that the
user may close the page. An administrator handles any enterprise approval through Feishu;
openTag does not submit approvals or require the connecting user to be an administrator.

The Server checks automatically. “Check latest status” uses the same due-time and concurrency
limits; it does not create another App, bypass approval, or force repeated provider calls.
“Cancel connection” explicitly removes the pending authorization and, for an attempt that never
activated, ends the binding row with it, so both channel choices return. Closing a
saved-authorization dialog preserves it. The QR stage retains its short-lived
registration behavior.

A new connection becomes usable only after full permission, identity, App and Runtime checks
and the existing activation transaction succeed. A previously healthy connection may continue
serving messages while same-App reauthorization waits. Canceling that reauthorization must
preserve its working credential and generation.

## Existing entities and ownership

| Existing data | Responsibility |
| --- | --- |
| Account / Agent | Authorization to manage a binding; Computer and Runtime prerequisites |
| `im_bindings` status and active identity | Current message route; pending credentials do not overwrite it |
| Active encrypted credential / generation | Existing credential delivery and message connection fencing |
| Setup attempt ID / intent | One current `create` or same-App `reauthorize` attempt on a binding |
| Encrypted setup context | Legacy QR payload or versioned candidate credential and latest observation |
| Setup expiry | QR deadline before issuance; fixed candidate retention deadline after saving |
| Setup owner / heartbeat | QR instance ownership or a fresh, per-check candidate claim token |
| Feishu registration and platform APIs | Issue credentials and observe effective scopes / bot identity |

No approval record, administrator role, connection-flow table, retry table, candidate route,
or extra credential generation is introduced. Configured Provider, App and Bot identities cannot
be replaced. Creation requires empty configuration; an edited empty Agent can still finish it.
Same-App reauthorization preserves identity. Disconnecting an activated binding retains its
identity history and requires a new Agent to connect a different identity. A never-activated slot
can still be cleared and creation resumed.

## State and data contract

`awaiting_user` holds the QR context. Credential issuance changes it to `pending_activation`
with an encrypted candidate and no owner. An admitted check claims it as `validating`.
A recoverable result returns it to `pending_activation`; a successful activation or terminal
result clears temporary credential material. Cancel, disable and expiry also clear it.

A terminal attempt leaves its `setup_state` on the row. When the attempt never activated the
binding, settling it also ends the row in the same transaction: `status` becomes `disabled`,
`disabled_at` is stamped, and the setup owner, context, deadline and any connection lease are
cleared. That releases the Agent's single current-binding row and the Provider and App uniqueness
entries it held (`im_bindings_agent_current_unique`, `im_bindings_feishu_app_current_unique`), so
no reader can still see a connection, the next attempt inserts a fresh row, and the other Provider
can configure. Cancel, expiry and failure all settle this way, and none of them emits the teardown
that disconnecting a live connection emits, because no credential was ever issued.

`active` bindings are exempt: the release matches only rows with no `activated_at` and no issued
credential, so a reauthorization attempt that ends terminal keeps the working connection, its
credential and its generation.

Rows a previous binary left in that shape are reconciled too, in two places. The
`0068_release_terminal_setup_slots` migration applies the same release to every existing
`provisioning` row whose setup state is already terminal, so an upgraded deployment needs no
operator action for an Agent that issue #504 already stranded. A row an older binary writes *after*
the migration ran is released by the next writer that needs the slot: the Slack configuration
transaction releases it under the lock it already holds, before its own insert. The current-binding
read guard (`currentBindingOf`) remains the belt-and-braces answer for both, and Slack's
configuration reads use it, so such a row never reports `IM_BINDING_UNBIND_REQUIRED`.

A candidate is retained for a fixed 30 days, independently of QR expiry. Repeated checks
do not extend this deadline. The retention is not a deployment setting; only tests inject a
different value. Expired or irrecoverably invalid credentials require another
authorization; a discarded secret cannot be reconstructed from the App ID or a status edit.

The candidate envelope is versioned and validated, with binding and attempt IDs checked
after decryption. It contains App ID/secret/region, save and next-check times, and only the
latest bounded reason and missing-scope list. Public DTOs contain the App ID and observation,
never the secret, ciphertext or claim token. Unknown formats are not executable candidates.

The existing credential cipher supports both v1 ciphertext and v2 with context AAD. The
candidate's embedded identity checks remain necessary with v1. This feature does not change
the global encryption write version or re-encrypt existing credentials.

### Setup observations and recovery

Agent setup reads the current binding and its setup fields from one captured binding-row snapshot.
The IM-binding/Feishu services produce the public binding, credential generation, attempt and
handoff view together; the Agent setup layer does not combine a binding read with an independent
attempt read or decode credential material. Existing Account authorization, current-binding
selection, and final Agent revalidation still apply. Public attempt reads recheck Account authority
after a confirmation read; public Agent-scoped attempt reads also recheck before returning.

An inferred terminal projection, such as QR owner loss or expiry, is confirmed by at most one
fresh complete read. Confirmation compares the binding, generation, attempt, state, owner,
heartbeat, deadline and saved context. An advanced row is projected as it now stands. If it needs
another unconfirmed terminal decision, the read is temporarily unavailable instead of reporting
a fabricated authorization failure. This adds no write, row lock, or long-running transaction.
Stored terminal outcomes remain explicit, and a healthy active route remains ready even if its
reauthorization context is temporarily unreadable.

An unexplained provisioning observation is recoverable; it does not authorize retrying registration
or disconnecting a binding. Agent setup exposes the existing observation-failed state with a
read-only refresh action. On an online Computer, the page observes that state with the existing
2-second GET cadence, bounded by 45 attempts and 90 seconds. A failed background GET keeps the
last trustworthy snapshot. At exhaustion, Check again starts a fresh read window without preparing
a Computer, checking an upstream candidate, creating another authorization, or disconnecting.
Actual authorizing, waiting-handoff and offline observations retain their existing waiting behavior.

### Paused settings reads

The current Account owner can read binding summaries, configuration, handoff observations, diagnostics, and
saved setup attempts for active or paused Agents. Deleted Agents and other Accounts are rejected. Authorization
and stored details share a read-only Repeatable Read snapshot; attempt confirmation reads repeat that check,
and public attempt reads recheck current ownership before returning. Read DTOs keep secrets, encrypted setup
context, and ownership tokens private.

Paused handoff and diagnostic reads inspect existing runtime observations without scheduling Provider CLI
preparation or credential validation. Reads do not activate or cancel a candidate, extend its retention, resume an
Agent, or call Feishu. Setup creation, explicit activation checks, cancellation, and asynchronous completion keep
their active-only admission, final mutation guards, and attempt/generation fences.

### Minimal database migration for `pending_activation`

- Append `pending_activation` to `feishu_setup_state`.
- Extend `im_bindings_setup_owner_shape` for an ownerless, non-disabled Feishu candidate
  with attempt, intent, context and expiry all present.
- Preserve the previous constraint branches for legacy states, including NULL.
- Add no tables, columns or indexes and perform no customer-data backfill.

The encrypted JSON extension is still a data-contract change. PostgreSQL cannot validate
the decrypted shape; service-level schema and identity checks are required.

### Data migration `0068_release_terminal_setup_slots`

This one does rewrite existing rows, so the "no customer-data backfill" statement above applies
only to the `pending_activation` migration. `0068` adds no table, column or index and runs a single
`UPDATE` that disables the rows described above: `provisioning`, terminal setup state, no
`activated_at`, no issued credential. It clears the setup owner, context and expiry and the
connection lease, and keeps each row's `setup_state`, `last_error_code` and
`credential_generation`. An upgraded deployment needs no operator action for an Agent that issue
#504 already stranded.

For a rollback, the update is data rather than schema: reversing the migration file does not
re-enable the rows, and a deployment that reverts the release behaviour while keeping this
migration applied still reports those Agents as disconnected, with both channel choices offered.

## Recovery and concurrency

The existing setup timer scans candidates in bounded keyset batches. It checks the saved
next-check time, uses bounded concurrency and jitter, and respects provider `Retry-After`.
Manual POST checks use the same admission. GET requests remain read-only.
Settings reads the current open attempt with GET on the existing Agent setup-attempt collection.
This uses the existing attempt DTO and Account ownership checks, independently of the active
binding: a working connection must not hide its saved same-App reauthorization. No open attempt
returns 204.
The setup binding read captures Account authority, current Agent status and either its current
binding or retained configured identity in one read-only Repeatable Read snapshot. A disconnected
identity does not require a second authorization transaction or a discarded activity read.

An instance that cannot authenticate a saved context preserves its ciphertext and fixed deadline,
reports a bounded diagnostic, and continues scanning other rows. A later instance with the correct
key can recover it. Authenticated but malformed or identity-mismatched plaintext remains terminal;
unauthenticated data is never activated. Authorized cancellation and expiry do not require decrypting
the candidate. Key rotation must retain the old key for the candidate retention period.

Admission compares the binding, attempt, state, original ciphertext and deadline. Each
check writes a new random claim token into the existing owner field. Heartbeats, observations,
release and activation must match that token. A stale process cannot commit over a new owner,
a canceled attempt or a disabled binding. Shutdown retains saved credentials for a successor.
The connection manager stop port joins its maintenance pass, admitted probes/activation,
inbound handlers and detached observation/enrichment work before clearing the final lease.
It rejects new work and stale probe results, and cannot restart while stop is in progress.

All 66 scopes are checked before a candidate opens a message channel. Only a ready candidate
enters existing atomic activation. Ambiguous upstream failures preserve it; a provider's
explicit invalid-secret response is distinct from a generic parameter error or disabled App.

This is a database-backed recovery loop using existing setup fields, not an exactly-once
transaction with Feishu. A crash between external credential issuance and the first database
commit can still lose the new secret. Large candidate populations also incur scan/decryption
cost because this change intentionally adds no scheduling index.

## Keeping active bindings connected

Channel startup observes WebSocket readiness failures throughout its lifetime, including while
outbound Bot identity is pending and after a failed or canceled call returns. Startup awaits outbound
identity before readiness, preserving outbound error precedence when both fail. Gateway errors and
rejected SDK startup retain their original cause for
connection-failure classification. A failed or canceled startup closes the WebSocket and clears
the channel identity; a late outbound success is disconnected as well. Disconnect settles pending
readiness, and late SDK errors remain handled after the caller returns. Failed channels stay closed;
the connection manager creates a fresh channel for its next attempt. Once startup succeeds, SDK
reconnecting, error and reconnected callbacks continue to report connection transitions.

Every 10 seconds each Server instance scans `active` Feishu bindings that no instance holds a
connection lease for, claims one, and opens its long connection. A failed attempt releases the
lease and waits before the next attempt on that binding: 0.5 seconds, doubling to at most 5 minutes.
The wait is kept in memory per binding and credential generation, so a reauthorized binding starts
over.

Each failure is classified (`connection-failure.ts`) by what Feishu itself answered, read only from
numeric codes, never from provider text:

- **Refused by Feishu.** The tenant token is refused for dead credentials (10015, 20002) or because
  the App is disabled or not installed (the app-unavailable codes the setup check already uses), the
  long-connection gateway rejects the App (403, 514), or a different Bot answers.
- **Not attempted.** The call's circuit is open, so Feishu was never asked.
- **Transient.** Everything else: network failures, timeouts, rate limits, and the SDK's ambiguous
  `not_connected`.

Ten consecutive refusals stop the binding. The update moves it from `active` to `error`, stores the
reason in
`last_error_code` (`FEISHU_CREDENTIAL_INVALID`, `FEISHU_APP_UNAVAILABLE`,
`FEISHU_CONNECTION_REJECTED`, or `FEISHU_BOT_IDENTITY_MISMATCH`), clears the lease, and advances the
credential generation, as a Slack reauthorization requirement does. The scan reads only `active` rows,
so nothing probes the binding again. The binding summary carries the reason as
`connectionFailure` (`credentials_rejected`, `app_unavailable`, `connection_rejected`, or
`bot_mismatch`). The Agent list and Agent page show the connection failure with one action,
**Reconnect channel**, which opens messaging settings. There one line says why the connection stopped
and what fixes it, and **Reconnect** runs the same-App reauthorization. Successful activation with
the original identity makes the binding `active` again, clears `last_error_code`, and resumes the
scan. A bot mismatch requires restoring the original Bot or creating a new Agent for another Bot.

A transient failure breaks a run of refusals, and an attempt the open circuit kept from Feishu leaves
the run as it was. Transient failures alone never stop a binding; they keep retrying at the capped
pace. Why: only Feishu's own refusal says that retrying cannot work until someone changes the App,
while an outage on the path to Feishu resolves without anyone. Stopping still waits for ten refusals,
so a short-lived refusal, for example while an administrator republishes the App, does not stop a
working Bot.

The count lives in each instance's memory, so a restart starts it over and delays the stop rather
than causing a wrong one. No column was added for it. Each attempt records the fencing epoch of its
claim; when the next claim's epoch is not the one after it, another instance claimed the binding in
between and may have connected it, so the run starts over.

Every write a maintenance attempt makes, the stop and the stored reason alike, is conditional on the
claim that made it: the binding is still `active` at the attempt's credential generation, and this
instance still holds the lease at that epoch. A result that outlived its lease or a reauthorization
updates no row and is dropped, so it cannot stop a binding another instance now holds, clear that
instance's lease, or restore a reason that reauthorization cleared.



Inbound event recovery is separate from setup recovery. Receipts persist bounded
normalized input before Inbox processing and recover it only through the current
connection holder and epoch, while retaining the original credential generation.
See [durable inbound receipt work](message-domains.md#durable-inbound-receipt-work)
for deduplication, input cleanup, deadlines, and the receipt-writer cutover boundary.

The migration alone does not make old Server binaries compatible with the new state or
payload. Use a coordinated, non-overlapping Server cutover: stop every old setup writer,
apply the migration, then start the new Server and matching Web build. This is a hard cutover,
never a rolling mixed-version operation: an old binary does not recognize `pending_activation`,
can overwrite an ownerless saved candidate with a fresh QR attempt, and cannot render the new
attempt state. Old and new Server writers must never run concurrently, whether or not new
candidates exist yet. The migration must use the normal migration
journal, snapshot and hash verification; inspect lock duration against deployment scale.

Release the matching CLI as well. Local credential mode must omit proxy capability offers unless
the proxy execution path is enabled; otherwise the Server can select a validation path the local
runtime cannot execute. Do not report the connection release complete until Server, Web and CLI
artifacts all contain their respective fixes and the installed local CLI has reconnected.

Rollback requires a build that understands the new enum and encrypted context, including
safe display, cancel and expiry handling. Do not delete the enum or migration ledger, or
clear valid customer credentials to make an old binary start. Production migration,
deployment and live administrator-approval acceptance are separate from local tests.

Existing attempts whose secrets were already discarded cannot be fixed by changing their
status to active. They require provider-backed reauthorization of the original App. A saved
new candidate can recover automatically when its real prerequisites become effective.
