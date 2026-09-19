# Feishu connection lifecycle

[简体中文](./zh-CN/feishu-connection-lifecycle.md)

Feishu setup keeps one durable authorization attempt on the existing IM binding. When the
registration SDK returns App credentials, the Server saves them before checking activation
requirements. An enterprise administrator may approve later: a page refresh, closed browser,
or Server restart must not discard that saved authorization.

## User experience

All 66 scopes in `FEISHU_REQUIRED_TENANT_SCOPES` remain required. There is no partial-permission
mode or subsequent capability upgrade. The existing Computer and Runtime preparation remains
a prerequisite to starting registration.

After credentials are saved, the setup page shows the remaining condition: permissions,
App availability, Runtime readiness, or a temporary upstream failure. It explains that the
user may close the page. An administrator handles any enterprise approval through Feishu;
OpenTag does not submit approvals or require the connecting user to be an administrator.

The Server checks automatically. “Check latest status” uses the same due-time and concurrency
limits; it does not create another App, bypass approval, or force repeated provider calls.
“Cancel connection” explicitly removes the pending authorization. Closing a saved-authorization
dialog preserves it. The QR stage retains its short-lived registration behavior.

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
| Setup attempt ID / intent | One current `create`, `reauthorize`, or `replace` attempt on a binding |
| Encrypted setup context | Legacy QR payload or versioned candidate credential and latest observation |
| Setup expiry | QR deadline before issuance; fixed candidate retention deadline after saving |
| Setup owner / heartbeat | QR instance ownership or a fresh, per-check candidate claim token |
| Feishu registration and platform APIs | Issue credentials and observe effective scopes / bot identity |

No approval record, administrator role, connection-flow table, retry table, candidate route,
or extra credential generation is introduced. `replace` uses the existing replacement
transaction and history.

## State and data contract

`awaiting_user` holds the QR context. Credential issuance changes it to `pending_activation`
with an encrypted candidate and no owner. An admitted check claims it as `validating`.
A recoverable result returns it to `pending_activation`; a successful activation or terminal
result clears temporary credential material. Cancel, disable and expiry also clear it.

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

### Minimal database migration

- Append `pending_activation` to `feishu_setup_state`.
- Extend `im_bindings_setup_owner_shape` for an ownerless, non-disabled Feishu candidate
  with attempt, intent, context and expiry all present.
- Preserve the previous constraint branches for legacy states, including NULL.
- Add no tables, columns or indexes and perform no customer-data backfill.

The encrypted JSON extension is still a data-contract change. PostgreSQL cannot validate
the decrypted shape; service-level schema and identity checks are required.

## Recovery and concurrency

The existing setup timer scans candidates in bounded keyset batches. It checks the saved
next-check time, uses bounded concurrency and jitter, and respects provider `Retry-After`.
Manual POST checks use the same admission. GET requests remain read-only.
Settings reads the current open attempt with GET on the existing Agent setup-attempt collection.
This uses the existing attempt DTO and Account ownership checks, independently of the active
binding: a working old connection must not hide a saved replacement. No open attempt returns 204.

An instance that cannot authenticate a saved context preserves its ciphertext and fixed deadline,
reports a bounded diagnostic, and continues scanning other rows. A later instance with the correct
key can recover it. Authenticated but malformed or identity-mismatched plaintext remains terminal;
unauthenticated data is never activated. Authorized cancellation and expiry do not require decrypting
the candidate. Key rotation must retain the old key for the candidate retention period.

Admission compares the binding, attempt, state, original ciphertext and deadline. Each
check writes a new random claim token into the existing owner field. Heartbeats, observations,
release and activation must match that token. A stale process cannot commit over a new owner,
a canceled attempt or a disabled binding. Shutdown retains saved credentials for a successor.

All 66 scopes are checked before a candidate opens a message channel. Only a ready candidate
enters existing atomic activation. Ambiguous upstream failures preserve it; a provider's
explicit invalid-secret response is distinct from a generic parameter error or disabled App.

This is a database-backed recovery loop using existing setup fields, not an exactly-once
transaction with Feishu. A crash between external credential issuance and the first database
commit can still lose the new secret. Large candidate populations also incur scan/decryption
cost because this change intentionally adds no scheduling index.

## Release and rollback boundary

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
