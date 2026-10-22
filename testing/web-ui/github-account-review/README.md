# GitHub account settings: review and acceptance

This is a historical acceptance record for the October 19–21 layout. The current Account authorization UI and its validation are documented in [Account GitHub authorization settings](../account-github-settings/README.md).

Baseline: `9f80f340db562274069731887f27092b4f50b7f1`, fetched from `origin/main`. Reviewed and implemented on October 19, 2026.

This acceptance record supports the [GitHub platform integration contract](../../../docs/system/capabilities/github-platform-integration.md).

## Implemented scope

Account settings keeps two independent settings: Account authorization and Repository access. Both are visible before authorization, without sequence numbers, completion checks, or health badges. The account setting offers Authorize GitHub account, or the saved identity with directly visible Change/Remove actions. Only an explicit Server requirement shows Reauthorize beside the identity. The introduction describes authorization without repeating shared Agent scope; help explains that scope. Computer remains in the account menu and MCP stays per Agent.

Repository access offers View repositories after active account authorization, alongside the always-available Configure on GitHub link. Wide layouts give the action group its natural width and align it to the account controls' right edge; narrow layouts place it below the description. The question-mark controls open anchored, nonmodal popovers without resizing the settings card. Click again, outside click, and Escape dismiss help; Escape restores trigger focus. GitHub owns installation targets, repository selection, organization policies, and administrator requests.

### Repository access viewer

The production dialog uses the Browser API and Server-owned user credential. Discovery starts only when the dialog opens, never on the main settings page. Repository rows are read-only and show full names without account duplication, selections, permission badges, or installation inventories. The list merges provider pages into 100-row batches, deduplicates by repository ID, filters only visible loaded rows, and reads ahead before offering Load more. Each interaction is bounded to ten provider pages; incomplete streams remain explicit. Closing aborts browser reads, clears results, and restores focus. Connection identity, authorization version, and lifecycle status key the viewer lifetime.

A completed empty result has no extra heading. Its paragraph suggests checking repository/account access when an installation was found, or installing/configuring the App when none was accessible. Both variants include conditional organization-administrator guidance and the same GitHub configuration link. Read failures offer retry without inferring missing installations or expired authorization. Successful earlier pages survive a failed continuation; refresh failure retains the old list with explicit stale feedback. Retry resumes a failed continuation rather than restarting or skipping pages.

The Server now attests installation enumeration truncation and skips repository requests for suspended installations. Suspended, truncated, changing, or unattested older responses cannot produce ordinary complete-empty guidance. These are data-integrity guards and quiet explanations, not new account setup statuses. The list describes discovery scope; runtime authorization remains per target/operation.

After opening configuration from the viewer, an actual leave/return triggers one fresh read while the viewer remains open. It never declares configuration success. Returning to the main settings page or focusing a closed viewer does not query discovery. The OAuth callback reports account authorization only. Specific operation limits and shared Agent scope stay in help.

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

The repository viewer passes 82 directly affected Web/component/design-contract tests, 39 Server admission and management-API tests, and 12 shared-contract tests. The current built application passes all 12 dedicated GitHub smoke tests, including 16 locale/viewport/result presentation combinations. Repository checks, the full workspace build and typecheck, and E2E TypeScript validation pass. [Viewer validation summary](repository-viewer-review.json).

The current browser run uses the built Web application, real Server, real browser authentication, and a task-owned PostgreSQL database. GitHub responses and authorization navigation remain controlled fixtures. Contrast checks wait for the existing dialog entry transition to settle; product animations and global test deadlines are unchanged. The test database, container, volume, network, and listeners are cleaned up after the run. No real GitHub grant, installation, repository, or token is changed.

The following records describe earlier account-setting iterations:

The final independent-settings layout passes six directly affected Web suites (60 tests), repository checks, the production build, workspace typechecking, and the E2E TypeScript check. Current browser validation mounts the production component and stylesheet with local API fixtures. It verifies no repository-discovery calls, including after opening configuration and returning focus. The full application smoke results below precede this final simplification; the updated specifications have been typechecked but not rerun as a full-stack suite here.

The following results are retained from the earlier full-application acceptance:

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

### Earlier full-stack browser boundaries

The built Web application, Server, authentication, and disposable PostgreSQL are real. Browser fixtures control GitHub management responses and the external authorization navigation. The denied OAuth round trip verifies both the retained old GitHub identity and the unsaved display name, with zero profile writes. The unavailable-deployment test uses the actual Server response. Screenshots were inspected at desktop and mobile sizes; overflow checks cover 320, 390, 768, and 1440px. Accessibility checks include the normal account view and removal dialog.

No real GitHub authorization, App installation, repository, or provider token was changed. These fixtures do not establish live provider OAuth, organization approval, private-repository access, or native Git/gh execution. Server/runtime behavior and schemas are unchanged.

### State presentation audit

The isolated browser audit renders the production `GitHubIntegrationSettings` component and stylesheet with local Browser API fixtures. It checks 156 presentation combinations in English/Chinese at 320, 390, 768, and 1440px, independent account/repository controls, both external-link attributes and the no-discovery boundary. Callback feedback, authorization loading, overview retry, reauthorization, help, account replacement, and removal retain accessibility and overflow checks. These cases are verification scenarios, not additional product authorization statuses. [Audit summary](state-review.json).

The subsequent alignment and popover changes pass 43 component/design-contract tests, Web and E2E typechecks, and a focused browser audit of 32 locale/viewport/scenario combinations plus two 320px touch checks. The focused audit verifies desktop action alignment, narrow-layout placement, unchanged card geometry, viewport containment, keyboard opening, all three dismissal methods, focus restoration, and zero repository-discovery calls. WCAG checks pass for the open popover in both locales at all four widths. The current account, initial-authorization, reauthorization, and help screenshots include these changes.

Keyboard checks cover initial Cancel focus, Escape and focus restoration after idle confirmation, disabled cancellation during removal, and clearing a failed removal when its dialog is dismissed. No theme tokens or shared primitive behavior changed. These component fixtures do not establish live GitHub OAuth, organization policies, App installation, repository access, or native Git/gh execution.

## Independent full-PR review

An independent `codex review` process reviewed the complete PR against the merge base of
`94947523d0b6bedcde443f8f5187f0df4619dff6` and `56f088d1d6c98f427da5d01cd73a868475a36003` on October 21, 2026.
Follow-up passes included the working-tree corrections. The final static pass verified all three corrections and
reported no remaining concrete regression or authorization issue. This is code-review evidence, not human ownership
approval or live-provider acceptance.

| Finding | Correction and regression evidence |
| --- | --- |
| Explicit repository connection-state failures left stale account controls and an unrecoverable retry loop | Re-read the authoritative overview only for missing, invalid, or changed authorization. Preserve identity when reconciliation fails, retain transient repository retry, and restore focus when the obsolete viewer closes. |
| A failed OAuth start retained a profile snapshot that could restore an abandoned edit | Clear the snapshot whenever authorization fails before document navigation; existing successful-round-trip preservation remains covered. |
| Another tab could replace the GitHub authorization between discovery pages and mix repository lists | Pin every viewer request to its connection ID and authorization version. Validate the paired query, check the credential version before opening it, and check the current authorization after the upstream read. Reject changed scopes before merging results. |

The first two findings were reproduced by three failing component regressions before correction. The pagination finding
was reproduced through the real management service and PGlite database, including an actual replacement OAuth callback
with a stubbed GitHub origin, before correction. All 176 affected tests now pass: 83 Web/component, 42 Server admission
and management API, and 51 shared contract/path tests.

The final built application passes the complete 92-case smoke project with zero failures, skips, or flakes, including
16 GitHub cases and the new authorization-recovery, abandoned-draft, and cross-account-pagination scenarios. English and
Chinese repository presentations retain desktop/mobile and accessibility checks. The separate journey project and
repository-wide unit results are recorded below and in the [final review summary](full-pr-review.json). The earlier
exploratory combined-project run is not acceptance evidence because the projects can interfere through shared setup state.

| Additional validation | Result |
| --- | --- |
| GitHub PostgreSQL integration | All 55 tests in six connection, constraints, credential-lifecycle, refresh, maintenance, and task-authority suites passed. |
| Complete journey project, one worker | 16 passed, 11 failed, and nine were blocked by an earlier serial failure. Failures include outdated MCP/navigation locators, Soul editor navigation diagnostics, a switcher accessibility check, and the local runtime test. Their test files and corresponding feature implementations are outside this PR's changes. |
| Repository-wide unit command | Failed on Client Context Tree timeouts and skill-sync timing. An isolated default-timeout retry still failed Context Tree cases; a diagnostic-only 15-second timeout passed all seven Context Tree cases. No repository timeout was changed. |
| Repository-wide PostgreSQL command | Stopped after repeated five-second migration/IM test timeouts. No migration or IM implementation changed; the six GitHub-specific suites passed separately. |

Repository checks, the workspace build/typecheck, and E2E TypeScript validation pass. Full repository regression
acceptance remains incomplete; the PR stays a draft. Raw logs, failing journey screenshots/traces, and the complete
browser JSON reports are retained in the task evidence directory rather than committed. Test containers, databases,
ports, authentication state, and runtime metadata were cleaned up without changing existing local services.

## Screenshots

- [Current account layout, Chinese](github-active-zh.png)
- [Current account layout, English](github-active-en.png)
- [Repository access, Chinese](github-repositories-zh.png)
- [Repository access at 320px](github-repositories-zh-320.png)
- [Repository access, English](github-repositories-en.png)
- [Empty result with an accessible installation](github-repositories-empty-installed-zh.png)
- [Empty result without an accessible installation at 320px](github-repositories-empty-zh-320.png)
- [Read failure and retry at 320px](github-repositories-error-zh-320.png)

Prior account-state captures, before the repository viewer was added:

- [Account authorization before an identity is saved](github-empty-zh.png)
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
