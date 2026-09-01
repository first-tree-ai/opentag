# OpenTag Playwright E2E

This package drives the built OpenTag Server and Web application against a disposable PostgreSQL database. The suite
uses the loopback development sign-in only inside the local E2E harness, connects a temporary Computer with the built
CLI, and supplies temporary Claude Code and Feishu CLI probes. No provider credentials are required.

## Run the suite

From the repository root:

```bash
pnpm install
pnpm test:e2e
```

`test:e2e` builds every workspace first. Playwright then starts PostgreSQL with the root `docker-compose.yml`, runs
migrations and the admin bootstrap, serves the built Web app, runs the tests, writes a contact sheet to
`e2e/screenshots/index.html`, and removes its database, temporary credentials, daemon, server, and PostgreSQL
container at shutdown.

The pull-request smoke path is intentionally separate from that serial journey:

```bash
pnpm test:e2e:smoke
```

It runs read-only browser smoke flows with four workers. The responsive contract maps the four product acceptance widths
to one stable purpose each: minimum-width sign-in at 320px, touch dialog behavior at 390px, the Account layout transition
at 768px, and the bounded desktop content frame at 1440px. Each path checks page overflow and axe accessibility in
addition to its width-specific behavior. Run only this package after a build with
`pnpm --filter @opentag/e2e test:e2e:smoke` or `pnpm --filter @opentag/e2e e2e:journey`. Set `OPENTAG_E2E_CHROMIUM` only
when a specific Chromium executable is required. The default uses the Chromium binary managed by Playwright.

The generated screenshots, Playwright report, test results, authentication state, and runtime metadata are ignored by
Git. The suite captures 18 addressable pages after the retired Onboarding Lab route was removed. It does not perform
visual-regression pixel comparisons and does not commit baseline images.
