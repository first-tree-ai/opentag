# MCP connector lifecycle validation

Validated on 2026-10-22. This change is limited to the Web MCP management list, its copy, and documentation. GitHub, Server APIs, database schemas, and CLI enable/disable behavior are unchanged.

## Behavior

- New Web installations continue to mount enabled through the existing attach flow. Authorization and successful discovery remain necessary when applicable.
- Abnormal rows expose one contextual Authorize, Reauthorize, Update credentials, or Retry action. OAuth and connection retries start directly; key updates open the existing editor. No restoration button appears during actual authorization or connection work; the right side contains only a disabled trash icon.
- Custom Add shares its OAuth session with management and the list. Closing the form keeps the same flow visible and cancelable. Creation/attachment failures and tool-read request failures are not mislabeled as OAuth failures.
- The identity opens settings. Remove is a persistent gray trash icon with a neutral hover background, danger-colored hover/focus feedback and the shared keyboard outline, a shared “Remove from this Agent” Tooltip, and a connector-specific accessible name; the list has no switch or duplicate Details menu.
- Existing disabled mounts display Disabled and Resume. They are never enabled automatically.
- Resume sends only `enabled: true`, retains credentials, and reveals the actual authorization or probe feedback. A failed request stays retryable. Focus returns to the identity when the focused Resume button disappears, without taking focus away from an opened settings dialog.
- Remove retains confirmation, cancellation, duplicate-request protection, neighboring-row focus restoration, and preservation of definitions used by other Agents. Disabled mounts can be removed without enabling them.

## Local checks

- `pnpm --filter @opentag/web test src/features/mcp`: 28 files, 372 tests passed. This includes the new cross-dialog authorization, creation failure, direct recovery, pending-control, and cancellation cases.
- Shared design-system controls were also covered by the earlier focused run (4 files, 53 tests passed); the recovery implementation does not change that seam.
- Web type check, production build with the normal bundle budgets, and `pnpm check` passed.
- Server and PostgreSQL integration tests were not run because this change does not modify their behavior or contracts.

## Browser verification

Playwright used a production-bundled component fixture mounting the real McpPage, query hooks, settings/removal dialogs, design-system controls, generated translations, and application CSS. API methods were stubbed with deterministic stateful responses. The recovery verification also used a same-origin simulated OAuth provider in a real popup, exercising the actual BroadcastChannel return path without an external account. Final responsive screenshots load the current module stylesheet after the production fixture styles. This is component browser verification, not a live provider OAuth or Server end-to-end acceptance run. Temporary fixture sources were removed from the checkout after validation.

Both English and Chinese were checked at 320, 390, 768, and 1440 px. No horizontal document overflow was observed. At narrow content widths, rows with a recovery action place the action and trash icon together below the identity, aligned to the right. This avoids squeezing names and reasons behind long English button labels. Rows with only the trash icon retain their two-column layout. Browser checks verify sample names are not truncated, in addition to checking document overflow.

Browser journeys verified successful resumption, expired-authorization feedback after resumption, failure followed by retry, confirmation before removal, cancellation without detaching, removal followed by neighboring-control focus restoration, and the 320 px confirmation layout. The removal icon was also verified with mouse hover and keyboard focus: both show the scoped tooltip and danger-colored icon over a neutral background. The idle icon remains gray. At 320 px its shared button retains a 44 px touch target.

- [English list, 1440 px](./list-en-1440.png)
- [Chinese list, 320 px](./list-zh-320.png)
- [Chinese removal confirmation, 320 px](./remove-zh-320.png)

- [Removal hover and tooltip, English](./remove-hover-en.png)

## Recovery flow captures

- [Recovery actions, Chinese desktop](./recovery-zh-1440.png)
- [Recovery actions, Chinese 320 px](./recovery-zh-320.png)
- [Recovery actions, English 320 px](./recovery-en-320.png)
- [Checking connection with only a disabled trash icon](./checking-zh-1440.png)
- [The same authorization in management after closing Add](./shared-authorization-en-1440.png)
- [Creation failure retains the form and offers Retry](./add-failure-en-1440.png)

## Independent review and full application follow-up

The subsequent review found and fixed one authorization-error classification issue. The complete
production Web browser journeys and their boundaries are recorded in [Independent review](./independent-review.md).

## Removal alignment

The removal button, confirmation actions, and focus return now follow the Skill list recipe in
[PR 988 alignment](./988-alignment.md). Its captures supersede the earlier removal-state screenshots.

## Submission checks

[Validation after synchronizing main](./submission-validation.md) records the 393-test run and the
repository MCP browser suites, including the two corrected selectors and targeted reruns.
