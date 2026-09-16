# Platform integration foundation

OpenTag owns its GitHub App, Slack, and Feishu credentials. Cloud execution will consume a Server proxy; the integration connection and credential storage are the first implementation stage.

## Identity and storage

A GitHub connection belongs to an Account, GitHub host, and App. There is one current connection in this namespace. Revoked and superseded connections retain nonsecret history. The single `github_connections` table stores the user's encrypted access/refresh credential pair, one in-progress OAuth flow, and bounded repository/Agent configuration. Existing IM tables remain the credential store for Slack and Feishu.

GitHub user credentials establish the user's repository admission on the control plane. Git and repository operations use App installation access tokens (IATs). The Server installation-token client requests one repository and explicit permissions, validates the resulting scope, and supports revocation. It is an internal transport adapter, not an authorization decision. A caller must establish Account, Agent, repository, and execution authority before minting a token. Neither user tokens nor IATs may be returned in a management response or sent to a Sandbox.

Repository names are display metadata. Authorization uses stable repository and installation IDs. Code and Context Tree access share the connection but have separate roles and publication policies. Context Tree scopes also specify a full branch ref. Configuration writes must recheck Agent ownership and use the expected authorization version.

## Invalidating access

GitHub authorization versions and credential generations serve different purposes. Scope changes, disconnection, and loss of authorization invalidate previously issued runtime access. A successful routine user-token refresh advances only the credential generation. Refresh and OAuth completion must compare the captured identity and version; a late response cannot reactivate a disconnected connection.

Refresh token consumption is not automatically retried after an uncertain response. A claimed refresh whose outcome is unknown requires reauthorization. Periodic rechecks scan all active due connections, including connections that received no webhook. Stale recheck results cannot overwrite a newer invalidation.

The default healthy recheck interval is five minutes. Worker scans and expired OAuth cleanup use batches of at most 100 rows. An expired OAuth sweep locks its bounded candidate set before clearing or deleting rows.

IM retains its existing generation field as a conservative authorization epoch. Authorization changes advance it; observations and heartbeats do not. Slack authorization depends on both the binding and its installation. Agent suspension, restoration, and placement changes also require checking the existing Agent revision when runtime capabilities are implemented.

## Encryption rollout

Application encryption supports the existing v1 format and an authenticated v2 envelope with a key ID and caller-supplied binding context. IM remains on v1 writes by default. Deploy compatible readers everywhere before opting into v2 writes; keep all required decryption keys until their ciphertext has been migrated or removed. Reverting to a binary that only reads v1 is unsafe after v2 writes begin.

Bound contexts distinguish credential purpose, owner, and stable record identity. Changing an envelope's record, owner, purpose, key ID, or authenticated content must fail authentication. New GitHub credentials require bound encryption. Platform secrets must not be included in logs or upstream error messages.

OAuth persistence accepts synchronous credential factories. The service allocates the final connection and flow IDs before invoking encryption. Replacing a GitHub user encrypts against the newly allocated connection ID inside the same transaction; failure rolls the replacement back. Factories must not perform network I/O, and provider token exchange happens before the completion transaction.

## Subsequent stages

This foundation does not enable a user-facing GitHub connection or Cloud execution by itself. The remaining integration includes:

- Account-authenticated OAuth and management routes, the authoritative repository-admission adapter, webhook verification, and periodic recheck worker wiring.
- Account connection and Agent code/Context Tree configuration UI.
- Runtime execution authorization, short-lived proxy capabilities, Server provider adapters, and a trusted Runner relay.
- Native CLI environment injection with execution-local handles, renewal, cancellation, and cleanup.
- Trusted Git object/ref validation, Context Tree verification, and persistent publication intent/outcome records outside the Sandbox.
- Cloud control identity and process isolation so Agent processes cannot read Runner or Server credentials.

Until those components are connected and verified, this stage must not be reported as a working Cloud proxy or end-to-end GitHub/IM integration. The existing Local IM runtime contract remains supported.
