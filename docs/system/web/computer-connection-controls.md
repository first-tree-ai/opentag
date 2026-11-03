---
title: "Computer connection controls"
description: "Account Computer connection surface: states, primary actions, and what stays out of it."
---

# Computer connection controls

Account → Computer manages the connection. Agent settings identifies the assigned computer and links here. A sole
computer opens directly; existing multi-computer accounts retain explicit selection. Do not add Agent lists or runtime
configuration to this surface.

Every confirmed inventory offers **Connect a new computer** here. Agent settings offers the same entry next to an
assigned Local computer or an existing choice; it opens this page and starts the one shared create flow. That request
is consumed once and removed from the URL, so reload or Back never issues another command. Connecting a computer
never moves an Agent; choosing it for an Agent stays an explicit step in Agent settings.

## State and interaction

Each card shows the computer's identity, a connection status badge, and a More menu.

| Confirmed condition | Badge | Card body |
| --- | --- | --- |
| Online | Online, with no action | None |
| Offline | Offline, with when it was last online | Inline repair task for this computer |
| Disconnected | Disconnected | Inline repair task for this computer |
| Read unavailable | Status unavailable | Check status |

“Status unavailable” expresses missing evidence, not another persisted connection condition.

Every connect or repair command shows its code's expiry beside it. Why: a copied command is often run later, and the
expiry tells the reader why an old copy no longer works.

- A local computer that is not online shows its repair task inline, issued automatically with a targeted repair
  code: the shared instruction block, one copy action, optional full-text expansion, and the code's expiry. The
  copied text is always complete. Copying is never evidence of connection.
- While the inventory read is uncertain, the repair task is hidden and the card offers Check status instead. Cancel
  inventory reads that began before the failure, then latch uncertainty against the cache's current
  successful-read sequence. Only a later Server read can restore confidence; render-time or Server timestamps
  cannot. Keep pending repair instructions until their own Server verdict retires them.
- A confirmed online result updates the card and removes the repair task; keyboard focus that was inside it moves to
  the card.
- More contains Remove, which keeps its typed-name confirmation and refuses while any non-deleted Agent is assigned.
  The web surface has no Disconnect action.

## Access and compatibility

The Server keeps an Account-authorized `POST /api/v1/computers/:computerId/disconnect` (not offered in the web
surface), protected by the existing session and CSRF boundary. It revokes active credentials and pending repair codes and clears presence. Computer identity,
Agent bindings, configuration, and local files remain. Cloud Computers cannot be disconnected through this endpoint.

The transaction records `computers.disconnected_at`; a successful targeted repair clears it, and so does a create
code redeemed from the same installation, which repairs that Computer in place instead of adding one (see
[Server and Client Runtime boundary](../server-client-boundary.md)). Onboarding reset also
clears this retention marker, so reset computers do not reappear in inventory. Deletion continues to hide the row.

Inventory requests with `x-opentag-computer-access: 1` include explicitly disconnected computers and their
`disconnected` status. Other clients keep the existing active-credential inventory and online/offline vocabulary.
Transport presence and provider-readiness protocols remain unchanged.

Code issuance, redemption, reset, deletion, and disconnection serialize on the owning Account row. Redemption reads
the immutable issuer without locking, locks Account first, and then re-reads and validates the locked code. Thus an
in-flight old repair cannot revive a disconnected computer, including after a later successful reconnect. Socket
closure follows the durable commit; authentication and runtime credential checks enforce revocation independently.
