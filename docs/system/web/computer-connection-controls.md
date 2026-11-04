---
title: "Computer connection controls"
description: "Account Computer connection surface: states, primary actions, and what stays out of it."
---

# Computer connection controls

Account → Computer manages the connection. Agent settings identifies the assigned computer and links here. A sole
computer opens directly; existing multi-computer accounts retain explicit selection. Do not add Agent lists or runtime
configuration to this surface.

Every confirmed inventory offers **Connect a new computer** here. Agent settings offers that entry
while the Agent has no Computer. A bound Agent offers repair of its existing Computer and cannot
select a replacement. The create request is consumed once and removed from the URL, so reload or
Back never issues another command. Connecting a Computer never moves an Agent. An edited Agent
with an empty Computer can still finish its initial binding.

## State and interaction

Each card shows the computer's identity, a connection status badge, and a More menu.

| Confirmed condition | Badge | Card body |
| --- | --- | --- |
| Online | Online, with no action | None |
| Offline | Offline, with “Last online …” or “No last-online record” | Restore connection |
| Disconnected | Disconnected, with “Last online …” or “No last-online record” | Restore connection |
| Read unavailable | Status unavailable | Check status |

“Status unavailable” expresses missing evidence, not another persisted connection condition. Every offline or
disconnected Local card says when it was last online, so two computers with the same name can be told apart. Without
a timestamp it says “No last-online record” (暂无在线记录), not “Never connected”: earlier versions cleared the
timestamp on every repair, so the data cannot tell a computer that never came online from one whose history was
cleared, and the page neither guesses nor pretends.

Every connect or repair command shows its code's expiry beside it. Why: a copied command is often run later, and the
expiry tells the reader why an old copy no longer works.

- A local computer that is not online shows its status badge and one **Restore connection** action. Pressing it
  opens the shared command window inline on the card and issues a targeted repair command only then; the card hides
  its badge while the window is shown, so the window's status is the only one. A **Restore connection** link that names the computer (from the Agent list, the
  Agent home, or Agent settings) arrives with that card's window already open. The copied
  text is always complete. Copying is never evidence of connection.
- While the inventory read is uncertain, the repair task is hidden and the card offers Check status instead. Cancel
  inventory reads that began before the failure, then latch uncertainty against the cache's current
  successful-read sequence. Only a later Server read can restore confidence; render-time or Server timestamps
  cannot. Keep pending repair instructions until their own Server verdict retires them.
- A confirmed online result updates the card and removes the window; keyboard focus that was inside it moves to
  the card.
- More contains Remove, which keeps its typed-name confirmation and refuses while any non-deleted Agent is assigned.
  The web surface has no Disconnect action.

## Command window

Every connect surface (this page's create and repair flows, Agent settings, and the Agent setup connect step) uses one
shared command window: an explanatory line chosen by the caller, the command with its expiry, and a single connection
status. Other parts of the page do not add a second status for the same computer while the window is shown. One
window everywhere means a reader learns the flow once and never has to reconcile two statuses that disagree.

- The explanatory line above the command says where to run it (for example “Run this in a terminal on this
  computer, or send it to your Agent there”), so each caller supplies its own. The copy action is a plain **Copy**,
  because the same text serves a terminal and an Agent.
- The window shows exactly the text that is copied: the inert Agent line and the command (see
  [Server and Client Runtime boundary](../server-client-boundary.md)). Nothing is hidden behind an expansion, because
  the copied text is short and a reader should see what they paste.
- The status speaks only about the computer's connection: waiting for it, not connected, or connected. It never says
  whether the command was used. The page cannot always know that, and it is not something the reader acts on.
- An expired command is masked in place and offers one **Refresh** action that issues a new command there. Leaving
  the dead command readable would invite copying a task that can no longer work.
- On the computer list the window opens only when asked. Opening one for every offline computer made a long page
  and left unused commands behind when several computers were offline. The Agent setup connect step is about one
  computer, so it opens the window directly.

## Access and compatibility

The Server keeps an Account-authorized `POST /api/v1/computers/:computerId/disconnect` (not offered in the web
surface), protected by the existing session and CSRF boundary. It revokes active credentials and pending repair
codes and clears presence. Computer identity, Agent bindings, configuration, and local files remain. Cloud Computers cannot be disconnected through this endpoint.

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
