# Session messages between conversations

Prerequisites: a connected Computer on a release candidate and an Agent in a group chat and a direct message with
its owner, each with a Session.

## Reach and discovery

1. In the direct message, ask the Agent to run `session list --agent`.
   Expected: both chats' Sessions are listed with their conversations, the current one marked, and no ended Session.
2. Ask it to send the group's Session a message that needs no IM reply.
   Expected: `accepted`. The group's Session runs, nothing appears in either chat, and its message context names the
   source Session and conversation and the target Session and conversation. The message text says the owner asked for
   it in the direct message and what it needs back.
3. Have the group's Session pass something on to one of the direct message's internal Sessions.
   Expected: that Session sees the group's Session as the source, and the text says where the request came from.

## Sharing

1. Tell the direct message something private, then ask it to pass only a decision on to the group's Session.
   Expected: the private detail is not in the message, and the group's Session does not post it.
2. In the group, ask the Agent to act on what the owner said in the direct message.
   Expected: the Agent does not treat the group's request as the owner's instruction.

## Limits

1. Send to a Session of another Agent. Expected: `rejected` with `scope_mismatch`.
2. Send to an ended Session. Expected: `rejected` with `target_unavailable`.
3. Ask two chats' Sessions to keep confirming to each other.
   Expected: they stop instead of acknowledging forever; the Server's `session.message.cross_conversation` records
   between the two Sessions stop.
4. Make a Run fail while handling a message from another chat.
   Expected: the sender gets one notice, the failed Session gets none, and no error card appears for the message.
