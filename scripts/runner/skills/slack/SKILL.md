---
name: slack
description: Use the catalog-pinned Slack CLI to discover and perform authorized Slack API operations.
license: Apache-2.0
metadata:
  author: opentag
---

# Slack CLI

Check the installed command with `slack --version`. Discover the API surface
with `slack api --help`, then consult the selected subcommand help before
constructing a request. The managed launcher applies the reviewed catalog's
update-suppression settings.

Resolve the intended workspace, channel, and message before acting. Follow
pagination when reading history. Sending messages, replies, or reactions
requires task authorization; check the returned destination and message
reference after a write. Authentication is supplied at runtime. Do not print
tokens or treat the installed CLI as proof of an authenticated Slack session.
