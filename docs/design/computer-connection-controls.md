# Computer connection controls

Account → Computer manages the connection. Agent settings identifies the assigned computer and links here. A sole
computer opens directly; existing multi-computer accounts retain explicit selection. Do not add Agent lists or runtime
configuration to this surface.

## State and interaction

The identity, status row, description, primary action slot, and More menu keep the same layout.

| Confirmed condition | Description | Primary action |
| --- | --- | --- |
| Online | Your Agents can use this computer. | None |
| Offline | Turn on or wake this computer and check its internet connection. | Get connection help |
| Disconnected | Reconnect to let your Agents use this computer. | Reconnect |
| Read unavailable | Couldn’t check this computer’s status. | Try again |

“Status unavailable” expresses missing evidence, not another persisted connection condition. Preparing a command,
waiting for redemption, and checking status belong to the action row; they do not replace the connection badge.

- Help uses the shared onboarding instruction block, one copy action, and optional full-text expansion. The copied
  text is always complete. “Assistant requested a repair?” reveals the exceptional credential repair action.
- Reconnect authorizes the existing Computer through a targeted repair code. Closing the dialog keeps the issued
  command and polling alive. “View instructions” reopens it without generating another code. Expiry is visible on
  the card; a replacement is issued only on request. Copying is never evidence of connection.
- A confirmed online result updates the card and an open dialog. Closing returns keyboard focus to the action,
  or the card when that action has disappeared.
- More contains Disconnect and the existing Delete action. Disconnect confirmation focuses “Keep connected”; it
  cannot be dismissed during the request. A lost response requires checking status before another mutation.
  Cancel inventory reads that began before the failure, then latch uncertainty against the cache's current
  successful-read sequence. Only a later Server read can restore confidence; render-time or Server timestamps
  cannot. Keep pending repair instructions until their own Server verdict retires them. Expired or revoked
  commands both say “This command is no longer valid.”
- Delete retains its existing typed-name confirmation and refusal while any non-deleted Agent is assigned.

## Access and compatibility

Disconnect is an Account-authorized `POST /api/v1/computers/:computerId/disconnect`, protected by the existing session
and CSRF boundary. It revokes active credentials and pending repair codes and clears presence. Computer identity,
Agent bindings, configuration, and local files remain. Cloud Computers cannot be disconnected through this endpoint.

The transaction records `computers.disconnected_at`; a successful targeted repair clears it. Onboarding reset also
clears this retention marker, so reset computers do not reappear in inventory. Deletion continues to hide the row.

Inventory requests with `x-opentag-computer-access: 1` include explicitly disconnected computers and their
`disconnected` status. Other clients keep the existing active-credential inventory and online/offline vocabulary.
Transport presence and provider-readiness protocols remain unchanged.

Code issuance, redemption, reset, deletion, and disconnection serialize on the owning Account row. Redemption reads
the immutable issuer without locking, locks Account first, and then re-reads and validates the locked code. Thus an
in-flight old repair cannot revive a disconnected computer, including after a later successful reconnect. Socket
closure follows the durable commit; authentication and runtime credential checks enforce revocation independently.
