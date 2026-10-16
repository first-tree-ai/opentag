# Cloud Computer: verification and acceptance

Test and acceptance material for [Cloud Computer](../../docs/product/cloud-computer.md).

## Acceptance before exposing Cloud creation

Before exposing Cloud creation, verify concurrent Account/platform admission on PostgreSQL,
cross-Account denials, Local onboarding, IM authorization/revocation, stale-generation discard,
and mutation-success/refetch-failure behavior. Real acceptance also needs a designated IM
conversation and an authorized test repository: synthetic ingress and local Git origins cannot
establish Slack/Feishu delivery or GitHub App publication. Record source/digest, Instance identity,
archive evidence and cleanup receipts. Shared staging changes and rollback must follow their
deployment authorization; code checks alone do not authorize switching shared environments.
