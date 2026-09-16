# Platform integration foundation

OpenTag owns its GitHub App, Slack, and Feishu credentials. The Server composes integration management, execution authorization, short-lived credential capabilities, and provider proxies. A trusted Runner gives native CLI processes execution-local handles. [简体中文](./zh-CN/platform-integrations-foundation.md)

## Identity and storage

A GitHub connection belongs to an Account, GitHub host, and App. There is one current connection in this namespace. Revoked and superseded connections retain nonsecret history. The single `github_connections` table stores the user's encrypted access/refresh credential pair, one in-progress OAuth flow, and bounded repository/Agent configuration. Existing IM tables remain the credential store for Slack and Feishu.

GitHub user credentials establish the user's repository admission on the control plane. Git and repository operations use App installation access tokens (IATs). The Server installation-token client requests one repository and explicit permissions, validates the resulting scope, and supports revocation. It is an internal transport adapter, not an authorization decision. A caller must establish Account, Agent, repository, and execution authority before minting a token. Neither user tokens nor IATs may be returned in a management response or sent to a Sandbox.

Repository names are display metadata. Authorization uses stable repository and installation IDs. Code and Context Tree access share the connection but have separate roles and publication policies. Context Tree scopes also specify a full branch ref. Configuration writes must recheck Agent ownership and use the expected authorization version.

## Invalidating access

GitHub authorization versions and credential generations serve different purposes. Scope changes, disconnection, and loss of authorization invalidate previously issued runtime access. A successful routine user-token refresh advances only the credential generation. Refresh and OAuth completion must compare the captured identity and version; a late response cannot reactivate a disconnected connection.

Refresh token consumption is not automatically retried after an uncertain response. A claimed refresh whose outcome is unknown requires reauthorization. Periodic rechecks scan all active due connections, including connections that received no webhook. Stale recheck results cannot overwrite a newer invalidation.

The default healthy recheck interval is five minutes. Worker scans and expired OAuth cleanup use batches of at most 100 rows. An expired OAuth sweep locks its bounded candidate set before clearing or deleting rows.

IM retains its existing generation field as a conservative authorization epoch. Authorization changes advance it; observations and heartbeats do not. Slack authorization depends on both the binding and its installation. Agent suspension, restoration, and placement changes also invalidate execution through the existing Agent revision fence.

## Encryption rollout

Application encryption supports the existing v1 format and an authenticated v2 envelope with a key ID and caller-supplied binding context. IM remains on v1 writes by default. Deploy compatible readers everywhere before opting into v2 writes; keep all required decryption keys until their ciphertext has been migrated or removed. Reverting to a binary that only reads v1 is unsafe after v2 writes begin.

Bound contexts distinguish credential purpose, owner, and stable record identity. Changing an envelope's record, owner, purpose, key ID, or authenticated content must fail authentication. New GitHub credentials require bound encryption. Platform secrets must not be included in logs or upstream error messages.

OAuth persistence accepts synchronous credential factories. The service allocates the final connection and flow IDs before invoking encryption. Replacing a GitHub user encrypts against the newly allocated connection ID inside the same transaction; failure rolls the replacement back. Factories must not perform network I/O, and provider token exchange happens before the completion transaction.

## Management and execution

Configure the coherent GitHub App environment block in `.env.example`, including the exact OAuth callback on `OPENTAG_PUBLIC_URL`. The Account page connects or reauthorizes GitHub; Agent integrations select stable installation/repository IDs, role, access, publication mode, Context Tree branch, and owner-authored task delegation. CSRF, PKCE, App identity verification, webhook signature verification, and the maintenance worker run on the Server. A webhook advances the recheck schedule; every GitHub execution request also proves current user admission. The UI shows unavailable when the deployment has no configured App.

The two runtime capabilities are `runtime.runtimeCredential` and `runtime.providerProxy`. Opening an execution binds Account, Agent revision, accepted task source, Session placement, current Computer connection, and Cloud Sandbox generation. A guessed Session ID or unrelated IM sender is insufficient. The broker rechecks these facts before issuance, renewal, each request, and during streams.

- A Runner capability lasts 60 seconds and renews after approximately 30 seconds. At most the current and previous capability overlap. Streams require an unexpired matching capability and revalidate every five seconds.
- The data WebSocket uses a single-use 15-second ticket in its first frame. Query strings, cookies, and bearer headers cannot authenticate this endpoint. Binary chunks carry at most 64 KiB plus a four-byte stream ID, with a 1 MiB credit window per direction. Consuming bytes replenishes credit. Completion races retain outstanding-byte bounds; unknown or reused stream IDs and over-credit frames remain invalid.
- The Runner holds capabilities in memory. CLI-visible material contains only execution-local handles, a public CA, proxy addresses, and bounded repository/IM metadata. No App key, UAT, IAT, Bot Token, tenant token, or Cloud control credential enters the Sandbox.
- IM proxy operations use registered Slack/Feishu routes and enforce the current binding and execution authority within the Bot's granted resource access. The current channel/thread is reply context, not an implicit exclusive destination allowlist. Protected reads record source metadata before returning output. Writes record intent before forwarding and outcome afterward; ambiguous writes cannot be replayed automatically. JSON writes require both HTTP and explicit provider success; missing success evidence, 5xx, timeout, or receipt persistence failure leaves an unknown outcome. Upload-byte transfer has its own intent/outcome, separate from the provider's final attachment completion call.
- Local defaults to the existing IM credential mode. Set `OPENTAG_RUNTIME_CREDENTIAL_MODE=proxy` in the daemon launch environment to opt into proxy mode. Cloud requires proxy mode and never falls back to raw IM credentials.

Native command names and arguments remain `git`, `gh`, `slack api`, and `lark-cli`. The launcher supplies authentication, proxies, CA trust, configuration, renewal, and cleanup automatically. This preserves normal CLI operation within the granted repository and registered API surface. User-only OAuth commands, arbitrary provider admin operations, and commands outside the configured authority are rejected.

## Git and Context Tree

Git smart HTTP terminates at the trusted Server gateway. Reads use a bounded temporary repository snapshot. The Server stages the full receive-pack, checks the old ref, object integrity, fast-forward behavior, allowed refs and resource limits, then publishes atomically with expected-ref leases and confirms remote SHAs. IATs are scoped to one repository and explicit permissions, held only for their request, and revoked on request completion and execution closure. A revoke API response and a separately observed invalid-token response are distinct acceptance evidence.

Code writes use `refs/heads/opentag/<session-id>/code/`. Context Tree direct writes target the exact configured branch; Context Tree PR heads use `refs/heads/opentag/<session-id>/context_tree/`. Code reads cover all branches of the selected repository. Knowledge-only reads expose the configured Tree branch and that Session's work branches. Publishing Tree commits and opening/updating their PRs verifies the actual committed SHA using the pinned `@first-tree-ai/context-tree` verifier outside the Agent container. Gitlinks and symlinks are rejected except the verifier's canonical root `CLAUDE.md -> AGENTS.md` link.

The GitHub API proxy parses REST routes and GraphQL ASTs, including aliases, fragments, variables and node identities. PR mutation checks repository, Session-owned head and allowed base. Tree-only queries are constrained to the configured Tree base. There is no generic GitHub API forwarding, arbitrary Git-object write endpoint, merge permission, or branch-protection bypass.

## Deployment and persistent state

`createPlatformRuntime` is the Server assembly entry. The Server image includes Git and the pinned Tree verifier. `OPENTAG_RUNTIME_CONTROL_DIRECTORY` identifies a Server-private persistent volume (image default `/var/lib/opentag/control`; local default `.opentag-control`). Its directory must be owned by the Server user, mode 0700, and have no symlink ancestors; records are mode 0600. Keep this volume through Server recreation and back it up with the application state. Never mount it, the database, or the Server environment into a Sandbox.

`FileSessionControlStore` stores bounded source, intent, outcome and reconciliation metadata in this volume. It stores no provider payloads or credentials. File records are immutable and written with fsync; concurrent writes are serialized by the authoritative Session owner. This is one Server owner per Session, not a distributed filesystem lock or a multi-owner journal. A deployment must route each Session to its authoritative owner. Unknown write outcomes block another write to the same provider resource until the owner has checked the provider and called `reconcileWrite` with a matching Session, operation ID and intent hash. Reconciliation records the verdict and never resends the request. `removeCompletedSession` is an operator retention API: call it only after proving the Session has ended; it refuses unresolved writes.

`FileCloudControlAuthority` is a trusted deployment API for issuance, rotation, revocation and bounded expiry cleanup. Only credential hashes persist. Bind the issued credential to the existing logical Cloud Computer and installation identity, deliver it to the trusted controller, and keep it outside Agent-visible files. Rotate by issuing a replacement, reconnecting the controller, and then revoking the predecessor. Revoking an old credential does not close the replacement connection; registration, heartbeat, request and stream checks verify current control liveness.

`CloudSandboxCredentialBridge` is the Linux command boundary for the Cloud orchestrator. It creates the Relay outside the command container and mounts only a public per-execution socket directory plus the workspace. The container runs as UID 10000 with no external network, no capabilities, a read-only root, resource limits and writable temporary directories. Control loss kills the command container; an execution cannot be replayed. It requires a trusted Linux Docker controller; a macOS host socket bind is not equivalent. The bridge supports later Cloud Sandbox orchestration and does not provision a cloud service or an LLM network path itself.

## Acceptance boundaries

Local checks must include protocol/authorization tests, PostgreSQL migration and authority tests, native CLI calls through the actual Relay/proxy stack, rejection and cancellation cases, and inspection of Sandbox-visible material. Live GitHub acceptance additionally requires the configured App, installation permissions and selected test repository; OAuth/UAT admission and real PR operations must be verified separately from an IAT-only Git test. Live IM acceptance requires an explicitly selected test Bot and conversation, including authorization for any outbound test messages or files. Offline provider fixtures cannot establish real-account acceptance. Production deployment and release require their own verification.
