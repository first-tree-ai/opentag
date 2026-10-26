---
title: "GitHub platform integration"
description: "Account OAuth credentials for Context Tree, per-Agent GitHub MCP, and credential lifetimes."
---

# GitHub platform integration

GitHub tasks in an Agent use its ordinary MCP connector. Account settings retain the existing OAuth App and authorization for Context Tree settings, synchronization, and publication. Ordinary executions receive no managed GitHub provider binding, handle, token environment, Git credential helper, Git/gh launcher, or native GitHub socket. Installed system Git/gh and user-managed credentials are outside this managed-access boundary.

## Identity and storage

A GitHub connection belongs to an Account and GitHub host, with one current OAuth connection. The nullable `oauth_client_id` identifies the configured OAuth App; the retained `app_id` identifies historical GitHub App rows. New OAuth rows have no `app_id`. The single `github_connections` table stores the encrypted access/refresh pair and one in-progress OAuth flow. Revoked and superseded rows retain identity and history. Historical repository JSON stays inert and absent from status DTOs. Existing IM tables retain Slack and Feishu credentials.

The one-time forward migration adds `oauth_client_id`, makes `app_id` nullable and updates old current App rows to revoked while clearing credentials, flows and worker claims. It preserves row IDs, original App IDs and historical data; it neither renames existing fields nor deletes rows. A shape constraint prevents old App rows from becoming current again. All users reconnect through the new OAuth flow, creating new connection IDs. Migration failure before commit rolls back atomically. After commit, recovery keeps the OAuth schema and repairs the new version; an old App binary cannot restore the cleared bindings. Stop old Servers/workers and drain in-flight GitHub work before applying the migration. Do not automatically replay writes or revoke existing GitHub grants/installations as part of this cutover.

The Account credential stays on the Server. Context Tree Git transports use short-lived execution-local handles; no OAuth token is copied into MCP authorization storage. GitHub MCP uses the ordinary per-Agent mount and authorization in `mcp_server_authorizations`. Reusing the same OAuth App does not make these authorizations interchangeable or let Account disconnect revoke an Agent's separate MCP authorization.

## Invalidating access

GitHub authorization versions and credential generations serve different purposes. Scope changes, disconnection, and loss of authorization invalidate previously issued runtime access. A successful routine user-token refresh advances only the credential generation. Refresh and OAuth completion must compare the captured identity and version; a late response cannot reactivate a disconnected connection.

Refresh token consumption is not automatically retried after an uncertain response. A claimed refresh whose outcome is unknown requires reauthorization. A local credential-envelope failure is not an unknown outcome: nothing was sent to GitHub, so the claim releases untouched and the credential survives for a later retry. A periodic recheck that finds the access token already expired defers with a transient outcome; the refresh pass owns expiry recovery, and the expected 401 never clears a recoverable refresh credential. A credential-invalid response arriving at or after the access token's expiry defers the same way. A successful client-authenticated refresh persists the sealed rotated pair before any independent identity check; a later transient recheck failure retains that pair and schedules another check without replaying the consumed refresh token. A successful refresh also advances the recheck generation — never the authorization version — so a verdict minted against the old credential can never land on the new pair while runtime grants stay alive. Periodic rechecks scan all active due connections, without relying on App webhooks. Stale recheck results cannot overwrite a newer invalidation.

Periodic rechecks use `GET /user` with the access token and verify `X-OAuth-Scopes` for the required `repo` grant. They consume the user's API budget. Missing or malformed scope evidence is transient; an explicit missing `repo` scope or a user identity mismatch requires reauthorization. Client-authenticated check-token calls are reserved for OAuth callbacks to establish client ownership once. The default healthy recheck interval is five minutes. Worker scans and expired OAuth cleanup use batches of at most 100 rows. An expired OAuth sweep locks its bounded candidate set before clearing their flow fields in place without deleting rows.

IM retains its existing generation field as a conservative authorization epoch. Authorization changes advance it; observations and heartbeats do not. Slack authorization depends on both the binding and its installation. Agent suspension, restoration, and placement changes also invalidate execution through the existing Agent revision fence.

## Encryption rollout

Application encryption supports the existing v1 format and an authenticated v2 envelope with a key ID and caller-supplied binding context. IM remains on v1 writes by default. Deploy compatible readers everywhere before opting into v2 writes; keep all required decryption keys until their ciphertext has been migrated or removed. Reverting to a binary that only reads v1 is unsafe after v2 writes begin.

Bound contexts distinguish credential purpose, owner, and stable record identity. Changing an envelope's record, owner, purpose, key ID, or authenticated content must fail authentication. New GitHub credentials require bound encryption. Platform secrets must not be included in logs or upstream error messages.

OAuth persistence accepts synchronous credential factories. The service allocates the final connection and flow IDs before invoking encryption. Replacing a GitHub user encrypts against the newly allocated connection ID inside the same transaction; failure rolls the replacement back. Factories must not perform network I/O, and provider token exchange happens before the completion transaction.

## Management and execution

Configure `OPENTAG_GITHUB_OAUTH_CLIENT_ID` and `OPENTAG_GITHUB_OAUTH_CLIENT_SECRET` from the same OAuth App. Nonempty retired `OPENTAG_GITHUB_APP_*` variables produce a startup warning listing names only; they never enable the integration. Register the exact `${OPENTAG_PUBLIC_URL}/api/v2/integrations/github/oauth/callback` callback. Enable expiring user tokens; authorization uses PKCE and requests `repo offline_access`. A token response without access expiry, refresh token or refresh expiry is rejected. The Server verifies client ownership, scope and user identity before accepting a credential. Retired `/api/v1/integrations/github` routes, including callback, webhook and disconnect, return 410 before business writes. Old App events cannot mutate new OAuth connections. Native GitHub management lives in Account settings, after the personal profile and before conditional Cloud billing. Computer management remains in the account menu. Agent Connectors manage MCP mounts; there is no account-level connector directory or cross-Agent credential inventory.

Keep the OAuth Client ID stable for a database that has current OAuth connections. Replacing the OAuth App against those existing bindings is unsupported: reads and workers select the configured client, while current-connection uniqueness spans the Account and host. After changing the Client ID, the overview cannot see an old-client binding, Connect can return `GITHUB_CONNECTION_CONFLICT` (409), and Disconnect under the new client does not clear that binding. There is no automatic cross-client replacement, startup cleanup or data migration for this scenario. Any future App replacement needs a separately designed data transition before changing the deployment configuration. Rotating the secret of the same OAuth App, refreshing user tokens, or changing Server/Sandbox machines and IPs does not change the stored client identity. Independent databases have independent bindings. This limitation is separate from the supported one-time GitHub App-to-OAuth cutover above.

Account settings label this connection “Context Tree GitHub”. They show the authorized identity, replacement, reauthorization, disconnect, and a read-only repository viewer. The description directs Agent GitHub tasks to per-Agent MCP connectors. Disconnect confirmation describes the impact on Context Tree. Disconnect clears OpenTag credentials and invalidates managed Context Tree access without revoking the GitHub grant.

Repository discovery remains display-only, bounded and fenced by connection ID and authorization version. It reports repositories available through this OAuth credential; it is not an Agent MCP repository allowlist. Account replacement retains the old credential until successful completion. Unsaved profile drafts and OAuth round-trip behavior are unchanged.

## Context Tree command boundary

A parent execution can receive the nonsecret `context-tree:git` service only after negotiating `runtime.contextTreeExecution` version 1, requesting the service, selecting at least one Context Tree, and passing current Account GitHub admission. This service alone provides no GitHub credential. Missing authorization leaves Context Tree unavailable and invalidates the managed read cache.

The trusted Local Daemon or Cloud Runner exposes a per-execution command gateway. It accepts only `sync`, `write prepare`, `write finish`, and `write abort` with a bounded set of flags. It pins the managed project path, current configured tree, repository and branch. It does not accept shell commands, executable paths, arbitrary Git arguments or HTTP requests. Read-only CLI operations remain local.

For each command, the trusted host opens a short-lived `context-tree` child execution. The Server checks its live parent, account, Agent revision, Session, Computer, connection, placement, task source, Sandbox allocation and authoritative tree selection. Only the child receives a GitHub binding. Its provider adapter allows Git transport on the selected repository and a single non-deleting push to the selected branch. Ordinary execution acquisition and previously issued ordinary GitHub handles are denied even if a caller retains old material. Parent closure closes its children; credential and selection checks continue during streaming.

Local Agents receive an execution-private Unix command socket. A reused Provider Runtime reconfigures each new execution, and the CLI reads the current endpoint from the stable Session manifest on every invocation. Cloud Agents receive a fixed loopback command endpoint routed through the Runner's enumerated HTTP/2 bridge. Neither receives the child's GitHub environment. The trusted CLI child alone uses the temporary Git handle, proxy and CA. Commands serialize, have a deadline, and stop on caller cancellation or execution loss. Cloud cancellation enumerates and terminates detached Git descendants before reporting completion. Publication is not replayed automatically after uncertainty; unpublished work is retained.

A nonsecret routing hint containing the write-session ID and selected tree is retained in private Client/Runner state so a later execution can finish the same isolated write. It is not authorization or an operation-result ledger. Every use still requires a live authorized parent and current selection. Published or aborted sessions remove their hint. Losing a hint fails closed and preserves workspace edits. Existing Context Tree workspace snapshots and write sessions retain their own lifecycle.

Context Tree settings create/connect/verify remain Server operations using the current Account authorization. GitHub OAuth permissions, organization policy and branch rules continue to apply. No database migration, token conversion, or cross-Agent MCP credential sharing is introduced.

## Deployment and validation

Deploy the compatible Server reader before Clients and Runner images emit the new service and child-execution fields. Older peers retain their IM and MCP services but receive no new native GitHub authority. Context Tree requires the new command gateway on the trusted Client/Runner; an old peer must upgrade to regain managed Context Tree synchronization. Existing OAuth configuration, ciphertext and refresh workers remain in place. Do not stop serving or scale down to force rollout.

Legacy low-level Git/gh transport utilities and offline transport regressions remain available for underlying compatibility. Their manufactured internal authorizations do not represent an ordinary Agent grant. Product acceptance must verify both ordinary-Agent credential absence and Context Tree sync/write continuity on Local and Cloud. An offline fixture does not establish deployed identity or live GitHub acceptance.

## Credential lifetimes

Ordinary execution and MCP/Web lifetimes retain their existing limits. Context Tree command executions have a maximum lifetime of two minutes and cannot outlive their parent. Closing an execution never revokes the Account OAuth token.
