# Agent setup navigation validation

## Scope

Existing Accounts keep the account navigation rail while creating, configuring, and completing an Agent.
First-time setup remains full-screen through Account admission and reload. Creation drafts survive navigation
within the current Account session; successful creation discards only its submitted draft. Global brand navigation returns
to the Agent list in both layouts.

The first presentation checks used Vite preview with deterministic intercepted API responses. Final-build acceptance
also uses the real Server and disposable PostgreSQL databases, as detailed below. Live messaging-provider OAuth and
real model requests are not validated. See [review.md](review.md) for the complete change inventory and independent review.

## Browser acceptance

- English and Chinese creation forms pass overflow and single-main-landmark checks at 320, 390, 768, and 1440px.
- axe-core 4.13.0 reports no WCAG 2 A/AA, 2.1 AA, or 2.2 AA violations for these creation-form checks.
- Embedded creation has one Account menu and no duplicate brand header.
- Keyboard navigation from the form to All Agents and back to New Agent restores the name and runtime selection.
- The same sidebar DOM node remains mounted through creation, navigation home, return to the draft, and completion.
- First-time completion remains full-screen after admission and a document reload.
- Embedded completion retains the account navigation rail, one main landmark, and one Account menu.

## Local checks

The layout lives above the resource routes, so validation includes the complete Web test suite as well as focused
checks for the changed flows. Build and type checking cover the route-component and generated-message consumers.

- `pnpm --filter @opentag/web test src/__tests__/agent-setup-boundary.test.tsx src/__tests__/app-shell.test.tsx src/features/shell/app-shell.test.tsx`: 74 tests passed.
- `pnpm --filter @opentag/web test src/__tests__/login-session.test.tsx src/__tests__/agent-setup-boundary.test.tsx`: 59 tests passed.
- `pnpm --filter @opentag/web test src/__tests__/sign-out-escape-hatches.test.tsx src/features/error-page-sign-out.test.tsx`: 19 tests passed.
- `pnpm --filter @opentag/web test`: all 172 test files and 2169 tests passed.
- `pnpm --filter @opentag/web build`: passed.
- `pnpm --filter @opentag/web typecheck`: passed.
- `pnpm check`: passed, with existing Biome warnings.

The full 172-file run preceded the independent-review fixes. After those fixes, the final source passed:

- 62 tests across the route boundary, optional layout storage, Cloud creation, activation, and sign-out suites.
- 123 tests across exact setup, Setup Lab, and completion synchronization suites.
- Web type checking and production build, `pnpm check`, and `git diff --check`.
- Independent reviewer validation: 5/5 edge cases passed; both initial P2 findings are resolved.

No database schema or runtime implementation changed, so the PostgreSQL server integration suite and Agent Runtime
coverage were not rerun. The browser tests below do use PostgreSQL and the real Server. CI remains responsible for
its complete regression matrix; these local checks do not establish CI status.

## Real-backend browser acceptance on the final build

The isolated stack uses port 8147, PostgreSQL port 55442, Compose project `opentag-navigation-e2e-f25b`, and disposable
database `opentag_nav_e2e_f25b`. It does not reuse the existing local PostgreSQL services. Creation and navigation
requests reach the real Server and database. For pending-response cases, Playwright forwards the actual POST and
delays only delivery of its real response; it does not synthesize creation results.

Playwright CLI acceptance passed:

- First-time creation reaches the exact Agent, remains full-screen after admission, and stays full-screen on reload.
- The brand opens All Agents; a subsequent New Agent visit keeps the account rail, one main landmark, and one menu.
- An unfinished name and Claude Code selection survive home navigation while the same sidebar node remains mounted.
- Returning during a pending POST keeps Create disabled and suppresses an explicit second form submission.
- Editing draft B while A is pending preserves B across A's success and a further home/return cycle. The real Agent
  list contains exactly one A and no unsubmitted B.
- A response delivered after leaving does not force navigation. Returning with an unchanged pending draft continues
  to the exact newly created Agent. Three deliberate creations produce exactly three POSTs in this acceptance run.
- Rejecting optional layout-marker removal still allows home/New Agent navigation and server-confirmed sign-out.
- Settled 1440px and 390px screenshots each contain one sidebar and one main landmark, without page overflow.

The existing Playwright login and responsive smoke suites passed **9/9** on the final build, covering real sign-in,
registration, retry, language/keyboard behavior, and 320/390/768/1440px layout and accessibility contracts. The runner
used the existing `e2e/playwright.config.ts` with a temporary wrapper that kept the already-running isolated stack
and disabled its teardown; the original test sources were unchanged.

## Expanded journey results and remaining failures

The existing complete `e2e:journey` run exercised real API/database behavior and the repository's local CLI/provider
fixtures. It finished with **23 passed, 9 failed, and 4 not run** after the serial runtime group failed. This run
preceded the final review fixes; affected final-build behavior was revalidated above. The exact result list is in
[journey-results.txt](journey-results.txt).

| Initial failures | Evidence and disposition |
| --- | --- |
| 2 anonymous MCP rejection cases | Test waits for `Connector URL`; unchanged product source uses `Connector address`. No OAuth request is reached. |
| 2 bearer MCP rejection cases | Test waits for a `Connect` button that is absent from its current connector surface. Test/product mismatch remains outside this navigation change. |
| 1 runtime pass case; 4 following serial tests not run | Real runtime-test response is HTTP 200 with `status: failed`, `code: provider_start_failed`; runtime-options returns 503. Server/runtime sources and their harness were not changed or repaired here. |
| Dock menu Escape and Internal tools Integrations link | Both failures reproduce with the unmodified Web source at HEAD `2d24de50`, using the same installed dependencies and an isolated real backend on port 8153. Baseline targeted result: 2 failed, 2 passed. |
| 320px and 390px touch menu axe cases | Initial run reports `scrollable-region-focusable` on the menu. Both pass on the HEAD baseline and both pass when rerun alone against the final build: **2/2**. Recorded as intermittent; no claim that the original complete run is green. |

The baseline was an exported HEAD checkout with its own Web build and disposable database/Compose project
`opentag-nav-baseline-f25b` on PostgreSQL port 55443. It shared only unchanged built Server code and installed dependencies.
No unrelated connector, runtime, or account-menu implementation was changed to make this report green.

## Screenshots

After the independent review, a navigation follow-up removes the entire embedded setup header, including the
upper-right Back to agent/Set up later action. Standalone first-time setup retains its exit, and completion retains
View agent. The route-boundary and exact-setup suites pass **143/143** tests after this follow-up; Web type checking,
production build, and `pnpm check` pass. A fresh isolated real Server/PostgreSQL browser run confirms the embedded
header is absent, the rail still returns home, the standalone exit remains available, and 1440/390px layouts have one
main landmark without horizontal overflow. The real exact-setup screenshot below reflects this final header removal.

- [English desktop creation](new-agent-1440.png)
- [English mobile creation](new-agent-390.png)
- [Chinese desktop creation](new-agent-zh-1440.png)
- [Chinese mobile creation](new-agent-zh-390.png)
- [Embedded completion](embedded-completion.png)
- [First-time completion](first-time-completion.png)
- [Real-backend desktop creation](real-draft-1440.png)
- [Real-backend mobile creation](real-draft-390.png)
- [Real-backend exact Agent setup](real-exact-setup.png)
