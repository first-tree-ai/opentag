# GitHub account settings: review and acceptance

Baseline: `9f80f340db562274069731887f27092b4f50b7f1`, fetched from `origin/main`. Reviewed and implemented on October 19, 2026.

This acceptance record supports the [GitHub platform integration contract](../../../docs/system/capabilities/github-platform-integration.md).

## Implemented scope

Account settings shows the personal profile, GitHub, and conditional Cloud billing in that order. The normal GitHub section has two rows: the saved identity with an account-action menu, and Repository access with a Server-owned Manage on GitHub link. There are no persistent connection-health badges, installation inventory, or refresh controls. An accessible click/tap toggle explains organization repository access. The bottom account menu still owns Computer management; MCP remains in each Agent's Connectors experience.

Change account starts explicit replacement directly. A real Server requirement adds Authorize again. An unfinished initial authorization can be started again without showing an internal pending state. Remove account requires one confirmation naming the identity and explaining the effect on all Agents, ongoing work, and the authorization/App installation retained on GitHub. Cancellation does not mutate authorization; a failed mutation remains in the dialog for retry.

## Review findings resolved

| Baseline P2 finding | Resolution and regression evidence |
| --- | --- |
| Repository discovery failure hid independent account identity and change/remove controls | Account settings requests only the management overview. The browser fixture makes discovery unavailable and verifies zero discovery requests, preserved identity, and both menu actions. |
| Disconnect submitted a destructive shared mutation immediately | A standard confirmation initially focuses Cancel. Browser checks verify zero mutations before confirmation and after cancellation, returned menu focus, exactly one confirmed mutation, and focus on its result. Component tests cover failure, retry, and duplicate submission. |
| Full-document OAuth lost unsaved display-name edits | A tab-local draft is Account-scoped and expires after 30 minutes. Restoration also requires the same confirmed name. Save, discard, consumption, and successful sign-out clear the draft. Navigation checks it again after the authorization request, so later edits are retained too. A storage failure keeps the user and edits on the page; OAuth never implicitly writes the profile. |
| Four proposed documents failed the current docs Context Tree gate | The English/Chinese [design proposal](design/account-github-navigation-plan.md) and [product research](design/integration-navigation-benchmark.md) were relocated under this testing record. The existing canonical GitHub capability page records implemented behavior. No new knowledge-base domains or translated Tree directories were added. |

The archived proposal includes follow-up ideas, such as returning to a task after authorization. Those ideas are not implemented by this change.

## Validation

- Production build: `pnpm build` passed.
- Repository checks and the English knowledge-base gate: `pnpm check` passed.
- Workspace types: `pnpm typecheck` passed.
- Browser test types: `pnpm exec tsc --project e2e/tsconfig.json --noEmit` passed.
- Targeted Web tests: 5 files, 64 passed, using the existing default deadlines. Covers account settings, account shell, GitHub management, and action focus/lifecycle.
- Locale catalog validation: 3 passed after aligning the new message keys with the repository's alphabetical ordering contract.
- Agent Runtime coverage: 29 files, 640 tests passed; statements, branches, functions, and lines each reached 100%.
- Full browser smoke suite: 84 passed, zero failures, skips, or flakes. This includes the 76 existing tests and the first eight GitHub acceptance cases.
- Final dedicated GitHub browser run: 9 passed, zero failures, skips, or flakes, including the additional Chinese desktop/320px acceptance case. Across both runs, all 85 distinct browser cases passed.

The original three browser failures were reproduced before implementation. All three passed against the built implementation. The broader first unit run encountered Account-shell deadlines during concurrent build/check work; the next run passed those cases and exposed a test assertion that did not wait for the existing Dialog exit animation. That assertion now waits for closure rather than changing product animation or global test deadlines.

### Browser boundaries

The built Web application, Server, authentication, and disposable PostgreSQL are real. Browser fixtures control GitHub management responses and the external authorization navigation. The denied OAuth round trip verifies both the retained old GitHub identity and the unsaved display name, with zero profile writes. The unavailable-deployment test uses the actual Server response. Screenshots were inspected at desktop and mobile sizes; overflow checks cover 320, 390, 768, and 1440px. Accessibility checks include the normal account view and removal dialog.

No real GitHub authorization, App installation, repository, or provider token was changed. These fixtures do not establish live provider OAuth, organization approval, private-repository access, or native Git/gh execution. Server/runtime behavior and schemas are unchanged.

## Screenshots

- [Desktop account settings](account-desktop.png)
- [Mobile account settings](account-mobile.png)
- [Removal confirmation](remove-confirmation.png)
- [Chinese desktop account settings](account-desktop-zh.png)
- [Chinese removal confirmation at 320px](remove-confirmation-zh-320.png)

Tests use Node.js 22.22.2, pnpm 10.12.1, and Playwright-managed Chromium. The browser stack uses a task-owned Compose project, database, network, and host ports, separate from existing local services. Machine-specific logs, JSON reports, traces, and videos remain outside the repository in this task's evidence directory.

Cleanup verified removal of this run's database, containers, network, volume, and HTTP listener. Existing local services were left running.
