# Account GitHub authorization preview

This fixture serves the built Web app with local mock Account and GitHub responses. It binds only to `127.0.0.1:4318`, labels every page as mock data, disables OAuth navigation, and makes no upstream requests to GitHub, a Server, or a database. The secondary GitHub settings link remains an external link. Disconnect affects only this process's mock state; restart it to restore the identity.

From the repository root:

```bash
pnpm build
node scripts/e2e/account-github-settings-preview.mjs
```

Open <http://127.0.0.1:4318/account>. Append `?scenario=empty`, `?scenario=reauthorize`, `?scenario=unavailable`, `?scenario=overview-error`, or `?scenario=repository-error` to inspect those states. Use the Account language selector for English and Chinese.

## Browser acceptance

- Before authorization, only the account authorization action appears; no repository setting or visible GitHub configuration link appears.
- Active authorization shows the identity, an adjacent View repositories control, Change account, and Disconnect. Reauthorization retains identity and account actions while hiding the viewer.
- The viewer is read-only. Filtering and refresh work; closing restores focus to View repositories. Its help holds the secondary GitHub authorization settings link and shared-scope explanation.
- Account authorization help explains shared Agent scope and organization approval/SSO. When connected, it also explains that disconnecting locally does not revoke GitHub authorization.
- Disconnect confirmation names the identity and all-Agent impact. Cancel preserves identity and restores focus; confirm returns to the authorization action. Errors remain actionable.
- Inspect 320px, 390px, 768px, and 1440px layouts in both languages for wrapping and horizontal overflow.

The real local service at `http://127.0.0.1:4177/account` redirected to `/login?next=%2Faccount` during verification on 2026-10-22. No real OAuth or disconnect mutation was performed. This mock preview does not verify real GitHub consent or provider-side revocation.

## Verification record (2026-10-22)

- Passed: `pnpm install`, `pnpm check`, `pnpm build`, and `pnpm typecheck` on Node 22.22.2 / pnpm 10.12.1.
- Passed: Account, repository discovery, profile draft protection, OAuth actions, and i18n catalog tests: 9 files / 93 tests. Three additional Web regression files passed on retry: 37 tests.
- Browser: Chinese and English, desktop and 390px mobile; unauthenticated real service redirects to login; mock empty, active, reauthorization, unavailable, overview error, and repository error states; repository dialog/help; disconnect cancel/focus restoration and mock confirmation. Screenshots use mock data.
- `pnpm test` was interrupted after unrelated failures appeared, including `cloud-turns.test.ts`, `runner-ws.test.ts`, `runner-serve.test.ts`, and `cloud-journal.test.ts`. The remaining broad scan was stopped under high host load; this command is not recorded as passing.
- `pnpm --filter @opentag/client test:agent-runtime:coverage` failed in the Pi CLI probe fixture (657 passed / 1 failed). That probe passed when rerun alone; the coverage gate is not recorded as passing.
- `pnpm test:coverage` was interrupted after its CLI and Web runs reported failures. CLI auto-update tests passed on retry (5 tests); final Account/i18n and the other reported Web regression files passed on retry as listed above. The broad coverage command is not recorded as passing. No runtime, Server, or database changes were made to address these failures.


## Independent review and follow-up validation (2026-10-22)

An independent read-only reviewer inspected the branch and ran the two affected UI files (44 tests passed). Supplementary browser review found the long English disconnect action clipped at 320px. Account action width constraints now preserve wrapping. Visible actions use **Change account / Disconnect** and their Chinese equivalents; accessible names and confirmation copy retain Account authorization context. The reviewer identified a Chinese Label in Name mismatch after shortening the visible label; the accessible name now contains the entire visible phrase, with a rendered regression test for both buttons. Final independent review has no remaining actionable findings.

- Final focused suite: 9 files / **94 tests passed**, including Account, repository discovery, profile drafts, OAuth actions, i18n catalog, and the Chinese accessible-name regression.
- Web production build passed after the copy and layout changes.
- Agent Runtime coverage rerun: **658 tests passed**, with **100% statements, branches, functions, and lines**.
- The complete `pnpm test` rerun failed in unchanged client tests: the Codex CLI probe fixture missed its marker file, and the Context Tree member-memory fixture exceeded its five-second timeout. The runtime coverage rerun covers and passes the Codex probe; the Context Tree case still timed out when retried alone. Turbo stopped the remaining package runs after the client failure. This full-suite command is not recorded as passing.
- The coverage rerun completed the Web package: **2201/2202 tests passed**, with **94.65% line coverage**. Its only failure was an unchanged Agent Soul navigation fixture; that file passed alone afterward (**4 tests**). The CLI phase reported its two unchanged auto-update fixture failures. Remaining client/Server coverage scans were stopped after these failures; the complete coverage command is not recorded as passing.
- Browser evidence uses mock data: [desktop, Chinese, 1440px](account-zh-1440.png), [mobile, English, 320px](account-en-320.png), [confirmation, 320px](disconnect-en-320.png), [390px](account-en-390.png), and [768px](account-en-768.png). Escape/cancel restores focus, and visible labels remain inside the available width.

## PR follow-up validation (2026-10-22)

- Updated the tracked GitHub Account browser smoke journeys for the new help-link location and Disconnect labels. Existing destination, security attributes, confirmation, focus, profile draft, and multilingual layout assertions remain; an unlinked-account journey was added. All **17 browser tests passed** against the built app with real local authentication and a disposable PostgreSQL database. GitHub responses remain controlled fixtures.
- Moved the unchanged mock preview to `scripts/e2e/account-github-settings-preview.mjs`, alongside existing browser preview tooling. Coverage rules and thresholds are unchanged.
- The repository's patch coverage evaluator reports **38/38 changed executable product lines covered (100%)** using freshly collected coverage from the two affected UI suites (**45 tests passed**). Remote CI remains authoritative.
- Account tests: **88 passed** across seven files. OAuth action/focus and i18n catalog checks: **8 passed** across three files. Web production build, Web typecheck, E2E typecheck, and repository checks passed.
- Independent read-only follow-up review found no actionable issue in the smoke migration, tooling move, contextual help, or translation-key consolidation.
