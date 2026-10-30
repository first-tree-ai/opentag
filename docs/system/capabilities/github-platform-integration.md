---
title: "GitHub platform integration"
description: "Agent GitHub MCP authorization reused by Context Tree through restricted Server Git transport."
---

# GitHub platform integration

An Agent's GitHub MCP connection is its GitHub credential source. Context Tree consumes the same
OAuth access token through Server-owned adapters. It retains native Git snapshots, isolated write
sessions and restricted publication; it does not translate these operations into MCP tool calls.
Ordinary Agent GitHub tasks use MCP. They receive no managed Git/gh credential, helper, launcher,
provider binding or native GitHub socket. User-managed system Git credentials are outside this boundary.

## Identity and storage

GitHub OAuth authorization lives in `mcp_server_authorizations`. The current Agent must own an enabled
mount in its Account. Shared authorizations resolve through the existing `credential_source_id` root,
with current ownership, effective configuration and OAuth resource checks. Context Tree decrypts the
same credential under the root holder's existing AAD; it never copies tokens into another row.
Refresh tokens, OAuth callbacks and credential rotation remain owned by the MCP services and worker.

Context Tree supports the standard official `https://api.githubcopilot.com/mcp/` endpoint (also without
the trailing slash), GitHub's `https://github.com/login/oauth` issuer and a provable deployed OAuth
client. Bearer/PAT, Enterprise, proxy and alternate path endpoints are not supported by this bridge.
Names and tool snapshots do not establish provider identity or permission.

If an Agent mounts multiple standard GitHub endpoints, the oldest mount wins by `created_at`, then
`mcp_server_id`. Selection precedes authorization and enable-state checks. A disabled, expired or
unauthorized first connection does not fall through to another token. Each operation pins the chosen
mount and authentication; removing it can select another mount only for subsequent operations.

`github_connections` is inert historical storage. Context Tree never reads it, no Account GitHub
credential worker runs, and no Account OAuth flow exchanges or refreshes its tokens. Existing rows
and encryption keys remain intact. Historical GitHub-side tokens may still consume upstream quotas;
retiring local maintenance does not revoke them or the OAuth App grant.

## User experience

**Memory** remains visible in each Agent's navigation even without GitHub authorization. Users can
view saved tree selections and disconnect a tree. Existing connect/create controls report missing,
disabled or unsupported authorization in their original error area, directing users to that Agent's
ordinary Connectors. They do not open OAuth automatically or add a second authorization entry.
Account settings no longer has a separate Context Tree GitHub authorization section. Retired v1/v2
Account integration routes, including callbacks, return 410 before credential reads or writes.

Configure `OPENTAG_MCP_GITHUB_CLIENT_ID` and `OPENTAG_MCP_GITHUB_CLIENT_SECRET` and register
`<OPENTAG_PUBLIC_URL>/api/v1/mcp-servers/oauth/callback` on the existing OAuth App. The old Account
client configuration does not enable Context Tree. Users with a usable Agent MCP connection need no
new authorization. Users with only an old Account connection must connect GitHub through the normal
Agent Connector flow; there is no automatic mount or token import. GitHub sign-in is not introduced.

## Context Tree command boundary

The existing `runtime.contextTreeExecution` version 1 and `context-tree:git` service remain. Admission
requires the current Agent's GitHub MCP authorization and verifiable user-task provenance. Local
Unix command sockets, Cloud loopback bridges and pinned CLI command/flag validation remain unchanged.
Every Context child proves its live parent, Account, Agent revision, Session, Computer/control connection,
placement, task source and exact current tree selection. Ordinary executions cannot acquire its provider.

Only the trusted CLI child receives a short-lived proxy handle; the user OAuth token stays on the Server.
Git transport is restricted to the selected repository and a single non-deleting push to the selected
branch. MCP extra headers and endpoint configuration are never forwarded as GitHub API/Git routing.
`X-MCP-Readonly` also prohibits Context repository creation and publication, including receive-pack
discovery. Repository permissions, OAuth scopes, organization policy and branch protection are still
enforced by GitHub; a missing `repo` scope is not by itself classified as missing authentication.

The authority fingerprint pins mount, local/root authentication identity and revision, effective
configuration, issuer/resource/client binding and business scopes. Routine refresh generation stays
separate: current requests read the latest access token without waiting for a refresh or consent flow.
A control revision change may conservatively cancel an old command; valid new commands do not wait.
Actual mount enable changes advance the local authentication revision so disable/re-enable cannot
revive old operations. Holder handoff may invalidate old children but preserves the shared credential.

Existing data-stream revalidation checks the current MCP authority. Closing a parent closes its children.
Cancellation, deadlines and publication uncertainty retain their existing behavior; writes are not replayed
automatically. Local offline sync, non-publishing finish and abort still require v1 credential admission.
This bridge does not add credential-free local execution or operation without the OpenTag control plane.

## Settings operations and final writes

Connect/create run on the Server for Local and Cloud Agents with the same Agent MCP credential.
Repository verification retains exact branch/directory checks and the pinned CLI. Each trusted Git
invocation resolves current credentials. Repository creation obtains `/user` identity, checks authority
again before POST, and uses existing private-repository creation and initialization behavior.

Before saving a verified tree selection, the short transaction locks Account, Agent and runtime config,
then selected local/root authentication rows in ID order. It rereads the exact MCP authority with the
same transaction and commits only if both authentication and Agent/runtime revisions still match.
Authentication row locks also exclude standalone expiry/refresh-failure updates that bypass the Account
lock. Network work never holds these locks. Disconnect requires no GitHub credential.

A remote repository can be created before the final local fence fails. Preserve it and report the existing
stale/uncertain outcome; never delete it or retry with another token. GitHub 403/404 are permission
failures, not an instruction to revoke shared authentication. A single 401 does not clear the root or
refresh credential. Connector authentication state continues to come from the MCP lifecycle.

## Deployment and validation

There is no schema or runtime protocol migration. Current v1 gateway Clients and Runners remain
compatible; an old Account handle is not reinterpreted as an MCP handle. Roll out the compatible Server
and drain old Servers/workers before declaring Account token maintenance retired. Do not stop serving
or scale to zero to force rollout. Rollback to an old Server can lose Context access because old Account
tokens are no longer maintained; prefer forward repair and do not silently restart Account authorization.

Verify same-token reads, root sharing, rotation, readonly enforcement, exact selection and authorization
races with PostgreSQL, plus Local/Cloud CLI and existing Memory/Connector UI behavior. Offline fixtures
and local checks do not establish a deployed OAuth or live GitHub acceptance result.
