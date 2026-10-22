# Account GitHub authorization preview

This fixture serves the built Web app with local mock Account and GitHub responses. It binds only to `127.0.0.1:4318`, labels every page as mock data, disables OAuth navigation, and makes no upstream requests to GitHub, a Server, or a database. The secondary GitHub settings link remains an external link. Disconnect affects only this process's mock state; restart it to restore the identity.

From the repository root:

```bash
pnpm build
node testing/web-ui/account-github-settings/preview.mjs
```

Open <http://127.0.0.1:4318/account>. Append `?scenario=empty`, `?scenario=reauthorize`, `?scenario=unavailable`, `?scenario=overview-error`, or `?scenario=repository-error` to inspect those states. Use the Account language selector for English and Chinese.

## Browser acceptance

- Before authorization, only the account authorization action appears; no repository setting or visible GitHub configuration link appears.
- Active authorization shows the identity, an adjacent View repositories control, Change, and Disconnect account authorization. Reauthorization retains identity and account actions while hiding the viewer.
- The viewer is read-only. Filtering and refresh work; closing restores focus to View repositories. Its help holds the secondary GitHub authorization settings link and shared-scope explanation.
- Account authorization help explains shared Agent scope, organization approval/SSO, and that disconnecting locally does not revoke GitHub authorization.
- Disconnect confirmation names the identity and all-Agent impact. Cancel preserves identity and restores focus; confirm returns to the authorization action. Errors remain actionable.
- Inspect desktop and 390px mobile layouts in both languages for wrapping and horizontal overflow.

The real local service at `http://127.0.0.1:4177/account` redirected to `/login?next=%2Faccount` during verification on 2026-10-22. No real OAuth or disconnect mutation was performed. This mock preview does not verify real GitHub consent or provider-side revocation.

## Verification record (2026-10-22)

- Passed: `pnpm install`, `pnpm check`, `pnpm build`, and `pnpm typecheck` on Node 22.22.2 / pnpm 10.12.1.
- Passed: Account, repository discovery, profile draft protection, OAuth actions, and i18n catalog tests: 9 files / 93 tests. Three additional Web regression files passed on retry: 37 tests.
- Browser: Chinese and English, desktop and 390px mobile; unauthenticated real service redirects to login; mock empty, active, reauthorization, unavailable, overview error, and repository error states; repository dialog/help; disconnect cancel/focus restoration and mock confirmation. Screenshots use mock data.
- `pnpm test` was interrupted after unrelated failures appeared, including `cloud-turns.test.ts`, `runner-ws.test.ts`, `runner-serve.test.ts`, and `cloud-journal.test.ts`. The remaining broad scan was stopped under high host load; this command is not recorded as passing.
- `pnpm --filter @opentag/client test:agent-runtime:coverage` failed in the Pi CLI probe fixture (657 passed / 1 failed). That probe passed when rerun alone; the coverage gate is not recorded as passing.
- `pnpm test:coverage` was interrupted after its CLI and Web runs reported failures. CLI auto-update tests passed on retry (5 tests); final Account/i18n and the other reported Web regression files passed on retry as listed above. The broad coverage command is not recorded as passing. No runtime, Server, or database changes were made to address these failures.
