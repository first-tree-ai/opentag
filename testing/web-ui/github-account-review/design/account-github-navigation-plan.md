> Archived design material, relocated from the former docs/design layout. See the [acceptance record](../README.md) for implemented scope and verification. Follow-up proposals, including Task recovery, are not shipped behavior.

# Account settings and native GitHub access

Status: proposed UI and interaction plan, October 14, 2026; reviewed October 19 to remove unnecessary connection terminology and status displays. The user has confirmed the two scope exclusions below; the remaining detailed interactions are proposals for review. Product code has not been changed for this plan.

## Scope and rationale

- Do not add an account-level, first-level Connectors entry.
- Do not aggregate all Agents' credentials into a global inventory.
- Keep Computer management in the bottom account menu.
- Keep existing MCP connections in the Agent's Connectors experience.
- Treat the current native GitHub integration as a specific account-owned code-access capability. Use the name **GitHub** rather than inventing Applications and services, Integrations, or Shared connectors navigation.

The separation follows what users configure and what changes affect. MCP mounts configure tools for an Agent. Native GitHub authorizes account-owned code access used by eligible Agent tasks. The UI need not teach the implementation protocols, nor establish a permanent rule for every future integration.

## Inspected implementation baseline

The latest review uses locally available `origin/main` revision `900ffead` (`fix(client): keep Local gh cache in execution temporary storage (#916)`). The working checkout is older; this plan used `git show origin/main:<path>` rather than treating checkout files as current.

- `apps/web/src/features/shell/account-menu.tsx` offers Computers, Account, optional Internal tools, and Sign out.
- `apps/web/src/features/account/account-page.tsx` includes personal settings, conditionally enabled Cloud billing, and `GitHubIntegrationSettings`.
- `apps/web/src/features/account/github-integration-settings.tsx` provides availability, connection states, authorization intents, disconnect, and installation discovery.
- `apps/web/src/features/mcp/mcp-page.tsx` manages MCP definitions and Agent mounts. GitHub is not part of this page.
- `apps/web/src/routes/_authenticated/_resources/_shell/agents.$agentId.integrations.tsx` redirects historical Agent integration links to `/account`.
- `packages/shared/src/github-management.ts` exposes availability, status, create/reauthorize/replace, installation metadata, and paginated repository discovery. Its installation DTO has no administrator-approval-pending field.
- `packages/server/src/api/github-integrations.ts` redirects OAuth to fixed local account or legacy Agent surfaces. There is no current Task return surface.
- `packages/server/src/services/github-proxy/github-provider-adapter.ts` uses connected-user credentials for native Git and gh operations. The proposed UI does not alter this runtime authorization policy.
- `github-management-service.ts` delegates removal to `github-connection-service.ts`, which clears local secrets and invalidates local authorization. This action does not call GitHub to revoke the provider grant or uninstall the App. The label must describe removal from OpenTag, not provider-wide revocation.

## User tasks and terminology

Users manage a GitHub identity and repository permissions. They do not maintain a continuously monitored GitHub session. Their recurring questions are: which GitHub account will be used, where can repository access be changed, and how can that account be changed or removed?

Use **Authorize GitHub**, **GitHub account**, **Repository permissions**, **Change account**, and **Remove account**. Do not replace "Account connected" with a permanent "Authorized", "Healthy", or "Ready" badge: displaying the saved identity is sufficient. Successful authorization does not establish current access to every repository or operation.

Keep the persisted pending/active/reauthorization_required/revoked/superseded lifecycle for security and concurrency. These internal states are not a user-facing status taxonomy. Show an additional message only when it explains an actual operation or a concrete action the user needs to take.

## Navigation and page structure

```text
Agent navigation
  Overview / Tasks / Instructions / Memory / Skills / Connectors / Usage
  Connectors = the existing MCP management experience

Bottom account menu
  Computers
  Account settings
  Internal tools [only when currently offered]
  ----------------
  Sign out

Account settings (/account)
  Personal settings
  GitHub
  Cloud credits [only when the server reports enabled]
```

Keep current destinations and historical redirects. There is no new `/integrations` hub, account Connectors page, or GitHub item in MCP discovery. A global page uses the existing compact rail; an Agent page uses the full Agent sidebar. Do not carry a selected Agent's navigation into account settings.

The full sidebar trigger already displays the user name, so its menu shows actions without a duplicate profile block. The compact rail's avatar-only menu may show one noninteractive identity block containing the name and secondary email. Neither identity field is a menu action.

## Account settings

Use one content column with an approximately 740px maximum width. Preserve existing app tokens: a warm page canvas, opaque white SettingsList surfaces, subtle separators, and the existing purple action color. Avoid a settings sub-navigation and card nesting.

### Personal settings

- Display name: editable; show Cancel and Save only after a change.
- Email: read-only secondary text.
- Language: existing locale selector and behavior.
- Preserve current successful-save/failed-refresh behavior: retain the confirmed saved value and offer a refresh retry instead of repeating the save.
- GitHub controls must not reset unsaved profile edits. When an external authorization navigation would discard edits, preserve a local draft or explicitly resolve the edits before departure; do not silently lose them.

### GitHub section

The heading is **GitHub**, at the same section level as Personal settings, immediately after it. Supporting copy: “Shared by all your Agents.” This communicates the scope without repeating the account and code-task labels. Show the saved login without a status badge or green indicator.

The ordinary configured view has two rows in one SettingsList:

1. Account: `@login`, and More anchored to that identity row.
2. Repository permissions: **Manage on GitHub**, opening GitHub in a new tab with an external-link icon.

Use the existing SettingsList/SettingsRow layout and value-column alignment across Personal settings and GitHub. Keep the section heading outside the list and use one grouped list surface; do not add another bordered card around the section. Use the existing section heading scale, 14px row text, and roughly 64–68px single-line desktop rows rather than an oversized integration card. Mobile stacks labels and values with sufficient touch targets.

The current DTO contains a GitHub login but no avatar URL. Use the login as the identity; do not fabricate a colored initial avatar resembling the OpenTag profile. A future verified GitHub avatar can be added if it makes recognition easier, without adding another account status.

More contains Change account and Remove account. Those labels inherit the GitHub row context. Offer Reauthorize only when the server reports that authorization needs user intervention. Removal uses destructive styling only in its menu and confirmation. Do not place the menu in the section header, where its scope could be mistaken for repository permissions.

Place optional repository guidance beside Repository permissions through a labeled help control. Clicking or tapping reveals guidance in that row; it is not a separate, permanent company-repository FAQ below the section. Keep essential actions visible without hover. Use the app's existing DropdownMenu, Popover/Collapsible, and Dialog components with portals where needed so SettingsList overflow does not clip overlays.

Manage on GitHub uses the existing server-owned installation redirect. Do not synthesize GitHub URLs from installation IDs or promise a direct per-installation destination that the API does not provide. Do not mirror the installation list, repository count, or permission health dashboard in ordinary account settings. Users choose the owning account/organization and repositories on GitHub.

Repository discovery is a snapshot, not runtime authorization. Remove the permanent Refresh control: it implies a health check without establishing task permissions. When discovery is needed for a specific task, refresh silently after returning from GitHub and verify access during the supported task continuation. A failed read must not erase the separately loaded saved identity. Offer Retry next to an actual failed operation, respecting rate-limit guidance. Where discovery is paginated or truncated, do not present a partial result as an exhaustive total.

Cloud credits remain a conditional section after GitHub. Its recharge and usage actions stay inside that section; preserve the current dedicated usage destination. Do not add a default account-menu billing entry.

## Authorization and repository permission flows

### First authorization

1. When no GitHub identity has been saved, show a short explanation and Authorize GitHub. Do not add a Disconnected or Not authorized badge. A code task reaches this same section.
2. Call the existing authorization-start API with create intent. The server supplies the authorization URL, state, PKCE, and expiry.
3. Navigate to GitHub in the current tab, preserving safe local return context and profile draft when relevant. The authorization button does not need the new-tab/external-link indicator used by repository management.
4. The callback returns to account settings. Re-fetch the account authorization and show the saved identity. Any brief completion feedback describes this operation only, not permanent connection health.
5. Keep Manage on GitHub available for repository permission setup or changes. For a known task access failure, name the target repository and explain the required action; an empty discovery result alone does not require an account-level warning.
6. On return, refresh task-relevant metadata automatically. Return to the original task through its supported continuation flow; the account page does not declare the task's permissions ready.

Explain identity authorization and repository selection when the user needs those instructions, rather than requiring everyone to understand two permanent setup states. Cancelling or expiring an unfinished flow returns to the prior view with a brief retryable outcome. A pending database row is not a durable "Continue connection" product mode; starting again uses a fresh server-authorized flow.

### Company repositories

Explain that the App is installed or configured in the account or organization that owns the target repository. A user must also have the required GitHub access. Organization owners and, where permitted, repository administrators can install/configure Apps; members may need to request installation under the organization's policy. An existing organization installation does not require an additional personal installation solely to reach organization repositories. [GitHub installation requirements](https://docs.github.com/en/apps/using-github-apps/installing-a-github-app-from-a-third-party), [Organization installation requests](https://docs.github.com/en/apps/using-github-apps/requesting-a-github-app-from-your-organization-owner)

Provide a short optional “Company repository access” explanation. When an operation cannot access a known target, name that target and explain the possible account or App permission changes. Do not infer missing access from an incomplete list, or invent a persistent Waiting for administrator state from an empty discovery result.

### Reauthorization and replacement

Reauthorization uses the existing reauthorize intent and restores the same identity. Change account uses explicit replace intent and starts the GitHub authorization flow directly, without an extra preliminary confirmation. The section description already identifies the shared scope, and the current implementation retains the old credential until replacement completes. Preserve the existing identity when authorization is cancelled or fails; changing the menu selection alone must not remove it.

Remove account requires one standard modal Dialog, not an additional card appended beneath settings. Name the exact login and explain that all Agents will lose subsequent native GitHub access through this saved authorization and ongoing code tasks may be affected. A secondary sentence states that OpenTag only removes its saved authorization; GitHub-side authorization and App installations remain. Use Cancel and Remove account, with the latter as the destructive action. Do not call this "Revoke GitHub authorization", because the current endpoint clears local authorization rather than revoking the provider grant. It does not detach MCP mounts or undo completed GitHub operations. After successful removal, return to the Authorize GitHub view without a Disconnected badge.

## Task-context entry and return

Do not add a permanent GitHub control to every Agent overview or MCP list. Show a compact task action only when a native GitHub operation reports an actionable access problem.

When no identity has been saved, use “Authorize GitHub to access first-tree-ai/opentag.” When the specific operation reports insufficient repository access, use “Cannot read first-tree-ai/opentag. Check repository permissions on GitHub.” Do not ask everyone to repeat OAuth. An account authorization action takes the user to `/account`, focuses the GitHub section, and carries validated source context; repository management may open the existing server-owned GitHub destination directly. Account settings shows “Return to task: Fix login failure.”

Use the same account settings section; do not create an Agent-owned GitHub settings form. For messaging-origin tasks, a recovery link can open this surface in the web app and must preserve the originating Agent/Task context after login.

The existing OAuth callback cannot return directly to a Task. The smallest extension is safe frontend return context around the fixed account callback:

- Store only versioned account/source Agent/source Task identifiers, authorization intent, and expiry in tab-local session storage; never store secrets or arbitrary redirect URLs.
- Validate the source route with typed helpers, check current account ownership/access, and expire context using the relevant authorization lifecycle. Clear it on logout/account changes and after completion or cancellation.
- Once the callback is verified and fresh server state loaded, restore the source-return affordance. Keep the user in the GitHub section if repository access still needs attention.
- If context is missing or stale, the callback remains on ordinary account settings.

Authorization completion does not automatically replay an interrupted push or PR creation. Return to the existing task continuation flow. Where the task is failed rather than resumably blocked, say so and use its existing supported continuation mechanism. Do not imply a working Pause/Resume protocol where none exists.

## Rendering and recovery rules

The ordinary settings view contains saved facts and management actions. Do not expose a lifecycle badge, installation-health summary, or status checklist.

- While loading saved identity, reserve the row and use a small loading placeholder. Do not flash the authorization CTA before loading finishes.
- If the server explicitly requires reauthorization, retain the known login and add “GitHub authorization needs to be renewed” with Reauthorize. Remove the message after verified recovery; do not also add an identity badge.
- A failed task operation names the repository and operation, with the appropriate permission-management action. A suspended installation is explained only where that installation affects the task. Repository discovery alone must not make unsupported access claims.
- Cancellation, expiry, request failures, and concurrent changes produce contextual, retryable operation feedback. Preserve any still-valid prior identity. A temporary GitHub request failure is not account removal or authorization expiry.
- Deployment availability is a capability gate, not a user-managed GitHub status. If unavailable, provide one concise deployment explanation without a status badge or unusable authorization control.

Classify failures from bounded public error codes, not arbitrary upstream text. Ownership, provenance, or runtime-policy failures are not repaired by blindly repeating OAuth. These rules cover internal lifecycle cases without requiring users to learn their names.

## Responsive behavior and accessibility

- Desktop: existing 240px Agent sidebar, 72px global rail, approximately 740px account content; 28px page title, 14px primary copy, and existing compact control sizing.
- Mobile: use the existing compact header; stack profile labels/controls and repository actions. Keep editable controls at least 16px text and touch targets approximately 44px.
- Keep surfaces opaque. Put More menus and confirmations above the content. Focus returns to the trigger after dismissal, and results use status/alert announcements.
- When the task shortcut opens the account page, scroll to and programmatically focus the GitHub section. Keep a visible return action and browser-back behavior.

## Implementation boundaries and acceptance

Refactor the account GitHub body and installation actions; keep routes thin, generate routes normally, and use shared/browser public exports and `m.*()` copy. Preserve legacy integration redirects. Runtime authorization, credential storage, and Agent MCP identity ownership are outside this UI proposal.

The task recovery action, frontend OAuth return context, and independent loading of identity versus task-specific repository discovery are UI work. The current API already supports account authorization intents, local removal, installation navigation, and discovery. Provider-side grant revocation, verified administrator approval, or automatic task resumption would require separate contracts and are not part of this plan.

Acceptance covers:

1. The account menu contains no new Connectors, Integrations, or billing item; Computers remains available.
2. Neither the Agent MCP list nor MCP discovery receives the native GitHub integration.
3. One account GitHub section is used from both ordinary settings and task recovery.
4. Ordinary settings show identity and permission-management actions without Connected/Authorized/Ready badges, repository counts, installation inventory, or permanent Refresh. Internal lifecycle cases produce only relevant action feedback; repository discovery failure does not erase the saved identity.
5. Cancelling replacement preserves the existing identity; removal affects the correct OpenTag account, leaves MCP mounts and GitHub App installations unchanged, and does not claim to revoke the GitHub-side grant.
6. Source Task return survives OAuth in the same tab, rejects stale/cross-account/arbitrary destinations, and does not replay writes.
7. Profile edits and confirmed-save/failed-refresh behavior remain correct while GitHub UI changes.
8. Keyboard, screen-reader, and 320/390/768/1024/1440px layouts are verified.
9. GitHub shares the account page's section hierarchy, grouped-list styling, and value-column alignment. Repository help is local to its row; account actions remain local to the identity. Change account has no preliminary confirmation, while removal uses one correctly scoped modal with focus restoration.

Run directly affected account, GitHub, shell, MCP, and return-context tests during implementation. Full repository gates apply before a pull request, as specified by AGENTS.md. This proposal and its mockups are not an implementation or evidence that the new Task recovery flow already exists.
