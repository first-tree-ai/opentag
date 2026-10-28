# MCP OAuth authorization reuse

Supports [MCP Server integration](../../docs/system/capabilities/mcp-server-integration.md).

## Contract and coverage

| Behavior | Automated evidence |
| --- | --- |
| Ordinary catalog/URL Add selects a compatible definition, mounts and connects without another consent or token exchange | Server installation-reuse and Web installation suites |
| Oldest usable compatible root; exact configuration, scopes, client and Account boundaries; existing invalid bindings never switch roots | Server shared-authorization, installation and OAuth suites |
| Existing Agent DTO resolves credential state from the root and retains local tool/probe feedback; original page, fields, buttons and removal remain | Web MCP suites and local browser smoke |
| Configuration changes detach only the edited Agent, keeping its mount and independent revoked row; unchanged effective config and enable switches retain sharing | Server shared-authorization unit and PostgreSQL suites |
| Holder edits preserve stable root and survivor credentials; saving failure rolls back handoff, authorization and overrides together | PostgreSQL shared-authorization suite with an injected failing database trigger |
| Refresh and consent survive holder configuration changes; old network results cannot restore the edited Agent | PostgreSQL shared-authorization suite with controlled network barriers |
| Holder removal, Agent deletion/transfer and onboarding reset preserve or remove the appropriate references | PostgreSQL shared-authorization and management concurrency suites |
| One flow and refresh claim per root; browser-state cancellation preserves working credentials and cannot cancel a newer flow | Server OAuth/shared-authorization suites and real OAuth browser smoke |
| Scope changes fence old probes; unknown refresh outcome never replays a potentially consumed token | Server OAuth and PostgreSQL suites |
| Reuse lookup and Connect use JSON/CSRF contracts, never accept source IDs, and return no secret | Management HTTP, BrowserApi CSRF inventory and shared export snapshot |
| New reuse is disabled by default; existing references remain usable; legacy downgrade is blocked by references/versioned envelopes | Rollout-status and shared-authorization suites |

Tests use synthetic credentials and isolated databases. No live provider credential is recorded.

## UI and interaction boundary

The list, settings, configuration fields, removal confirmation, CSS and English/Chinese copy retain
the pre-reuse behavior. Shared auth sections, group counts, group cancellation/disconnect and
shared-edit restrictions are absent. There is no batch authentication endpoint or normalized shared
status cache. Authorization changes invalidate the existing Agent queries; local probe failures still
use the original Retry or authorization feedback. Browser-owned popup busy guards remain unchanged.

The only new connection behavior is automatic compatible installation/credential selection behind
the existing Add/Connect actions. A reused mount runs its own background capability probe. Config
changes return only the edited Agent to its original authorization entry. Definition-level API/CLI
compatibility safeguards remain in place.

## Local validation

Run the owning Web MCP and BrowserApi CSRF suites, shared contracts/public exports, MCP Server unit
suites, and relevant real PostgreSQL suites. Run the Browser Smoke project against the built Server
and Web application with retries disabled. Include catalog/URL installation, ordinary settings and
removal, failed key-to-OAuth preparation, reauthorization cancellation, and narrow layouts. Run owning
package type checks and builds separately; avoid rebuilding dependencies while test workers run.

Current local and exact-head CI results are recorded in the PR. Earlier shared-UI previews are
superseded and do not describe the delivered behavior. Local fixtures do not establish staging or
live GitHub business acceptance.

## Deployment acceptance

Apply the additive migration with `OPENTAG_MCP_OAUTH_REUSE=false`, upgrade and drain every old
Server/Worker, then enable new reuse. Turning the flag off must not disable existing references.

Staging acceptance should authorize one Agent, then use ordinary catalog or URL Add on another and
verify the same compatible definition and no additional provider consent/token exchange. Exercise
root status through existing queries, independent probes, reauthorization, current-only removal,
configuration editing with unaffected survivors, Issue/PR reads and writes, and user identity on a
code commit. Local and Cloud executions use the same Server gateway resolver.

For legacy downgrade, quiesce OAuth writes and run `pnpm --filter @opentag/server mcp:rollout-status`
with deployment database/encryption configuration. The command prints counts only and rejects
references, versioned credentials/flows or unreadable envelopes. Prefer a compatible rollback; do
not copy refresh tokens or reverse the migration.
