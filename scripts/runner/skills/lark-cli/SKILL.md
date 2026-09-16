---
name: lark-cli
description: Use the catalog-pinned Lark CLI for authorized Feishu and Lark operations.
license: Apache-2.0
metadata:
  author: opentag
---

# Lark CLI

Check the installed command with `lark-cli --version`. Start with
`lark-cli --help`, then domain help such as `lark-cli im --help`; use the
selected command's help to determine its actual arguments. The managed
launcher applies the reviewed catalog's update-suppression settings.

Resolve the intended resource, recipient, and user or bot identity before an
operation. Follow pagination and inspect command responses. Messaging or
resource changes require task authorization. Authentication is supplied at
runtime; report missing scopes or authentication without printing tokens or
starting an unrequested login flow.
