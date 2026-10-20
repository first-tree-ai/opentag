# GitHub account settings: review and acceptance

Baseline: `9f80f340db562274069731887f27092b4f50b7f1`, fetched from `origin/main`. Reviewed and implemented on October 19, 2026.

This acceptance record supports the [GitHub platform integration contract](../../../docs/system/capabilities/github-platform-integration.md).

## Implemented scope

Account settings shows the personal profile, GitHub, and conditional Cloud billing in that order. The normal GitHub section has two rows: the saved identity with directly visible Change/Remove actions, and Repository access with a permanent purpose description and Server-owned Configure on GitHub link. The identity leads its row without a redundant Account label. Without a saved identity, the section offers one standalone Add GitHub account button and explains the GitHub authorization step. Initial loading has a small progress indicator; unavailable deployments show setup guidance without a dummy settings row. There are no persistent connection-health badges, installation inventory, or refresh controls. An accessible click/tap toggle explains App installation/configuration, the user's own repository permissions, and conditional organization-administrator guidance. A required Reauthorize action and explanation stay inside the identity row. The bottom account menu still owns Computer management; MCP remains in each Agent's Connectors experience.

Change starts explicit replacement directly. A real Server requirement adds Reauthorize. An unfinished initial authorization can be started again without showing an internal pending state. Progress remains visible at the active control, with decorative loading icons and a readable action name describing navigation to GitHub. Starting a new action clears the previous callback outcome. Remove account requires one confirmation naming the identity and explaining the effect on all Agents, ongoing work, and the authorization/App installation retained on GitHub. Cancellation restores focus to the visible Remove button without mutating authorization; a failed mutation remains in the dialog for retry, and dismissing the dialog clears its error. Empty live regions remain available for focus recovery without occupying visual space.

## Review findings resolved

| Baseline P2 finding | Resolution and regression evidence |
| --- | --- |
| Repository discovery failure hid independent account identity and change/remove controls | Account settings requests only the management overview. The browser fixture makes discovery unavailable and verifies zero discovery requests, preserved identity, and both account actions. |
| Disconnect submitted a destructive shared mutation immediately | A standard confirmation initially focuses Cancel. Browser checks verify zero mutations before confirmation and after cancellation, focus restoration, exactly one confirmed mutation, and focus on its result. Component tests cover failure, retry, and duplicate submission. |
| Full-document OAuth lost unsaved display-name edits | A tab-local draft is Account-scoped and expires after 30 minutes. Restoration also requires the same confirmed name. Save, discard, consumption, and successful sign-out clear the draft. Navigation checks it again after the authorization request, so later edits are retained too. A storage failure keeps the user and edits on the page; OAuth never implicitly writes the profile. |
| Four proposed documents failed the current docs Context Tree gate | The English/Chinese [design proposal](design/account-github-navigation-plan.md) and [product research](design/integration-navigation-benchmark.md) were relocated under this testing record. The existing canonical GitHub capability page records implemented behavior. No new knowledge-base domains or translated Tree directories were added. |

The archived proposal includes follow-up ideas, such as returning to a task after authorization. Those ideas are not implemented by this change.

## Validation

The finalized account/repository layout passes `pnpm check`, `pnpm build`, `pnpm typecheck`, the E2E TypeScript check, and six directly affected Web suites (58 tests). Browser validation of this follow-up uses the production component and stylesheet with local API fixtures, as detailed below. The full application smoke results in the next list precede this layout follow-up; their updated specifications have been typechecked but not rerun as a full-stack suite here.

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

### State presentation audit

The isolated browser audit renders the production `GitHubIntegrationSettings` component and production stylesheet with local Browser API fixtures. It covers 18 main presentation cases, including a long account identity, in English and Chinese at 320, 390, 768, and 1440px, plus account-mismatch, expired-authorization, and rate-limit callback messages at 320 and 1440px: 156 combinations. All passed page/overlay bounds and axe WCAG checks, with no browser runtime errors. This component audit does not include the Server, authentication, or PostgreSQL.

Keyboard checks cover initial Cancel focus, Escape and focus restoration after idle confirmation, disabled cancellation during removal, and clearing a failed removal when its dialog is dismissed. Warning copy uses the existing strong text token; banner actions use the product Button adapter for accessible colors and mobile target sizes. No theme tokens or shared primitive behavior changed. [Audit summary](state-review.json).

## Screenshots

- [Current account layout, Chinese](github-active-zh.png)
- [Current account layout, English](github-active-en.png)
- [Standalone account addition](github-empty-zh.png)
- [Initial loading](github-loading-zh.png)
- [Deployment setup guidance](github-unavailable-zh.png)
- [Read failure and retry](github-read-error-zh.png)
- [Reauthorization at 320px](github-reauthorize-zh-320.png)
- [Repository guidance at 320px](github-help-zh-320.png)
- [Removal failure at 320px](github-remove-error-zh-320.png)

Earlier full-application screenshots, before the finalized row layout:

- [Desktop account settings](account-desktop.png)
- [Mobile account settings](account-mobile.png)
- [Removal confirmation](remove-confirmation.png)
- [Chinese desktop account settings](account-desktop-zh.png)
- [Chinese removal confirmation at 320px](remove-confirmation-zh-320.png)

Tests use Node.js 22.22.2, pnpm 10.12.1, and Playwright-managed Chromium. The browser stack uses a task-owned Compose project, database, network, and host ports, separate from existing local services. Machine-specific logs, JSON reports, traces, and videos remain outside the repository in this task's evidence directory.

Cleanup verified removal of this run's database, containers, network, volume, and HTTP listener. Existing local services were left running.
