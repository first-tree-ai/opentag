# Slack connection dialog verification

The existing Slack flow now has connection-test, troubleshooting, credential-update, and connection-details views within
one dialog. This verification covers the web presentation and its existing management contracts.

## Reference and evidence

The visual sources are the four approved generated mockups from the design discussion. Their filenames identify the
source artifacts; the browser screenshots below are included in this repository:

| View | Source filename | Browser screenshot |
| --- | --- | --- |
| Connection test | `exec-2624f5f0-8701-4b08-a3bd-1627809de703.png` | [Desktop](01-connection-test.jpg) |
| Troubleshooting | `exec-59107247-44b6-4c10-9235-02370be75ba1.png` | [Desktop](02-troubleshooting.jpg) |
| Credentials | `exec-b6fd0544-dcef-4284-91c9-83780fa1d80f.png` | [Desktop](03-credentials.jpg) |
| Connection details | `exec-c5dc8eda-fa67-43b7-b2d6-fa4a327b4dfa.png` | [Desktop](04-connection-details.jpg) |

Browser evidence uses the production build at `/internal/agent-setup` with the existing in-memory Lab adapter.
Desktop screenshots use a 1440 × 1024 CSS viewport and 1440 × 1024 image pixels. Generated references are 1487 × 1058
pixels without a specified CSS density; compare the modal structure and content, rather than treating the raster
background or its inferred font size as exact CSS measurements. No images were stretched or modified for comparison.

Phone checks use a 390 × 844 CSS viewport and image pixels: [connection test](06-mobile-test.jpg) and
[connection details](05-mobile-details.jpg) and [troubleshooting](07-mobile-troubleshooting.jpg). Measured document width was 390px and dialog width/scroll width were both
358px: no horizontal overflow. All four views were also checked at 320px and 768px; dialog widths/scroll widths
matched at 288px and 576px respectively, with no document overflow. Long details remain vertically scrollable.
Temporary viewport overrides were reset. This browser pass used English; both locale catalogs are covered by automated guards.

## Visual review

Each source and its corresponding implementation were inspected together. The credential field, disabled Save button,
and details values were also inspected in their readable full-resolution views; separate crops were unnecessary.

- **Typography:** preserve the application's Manrope font, semantic `Text` headings using the existing 20px section token, and existing 14px control/body scale.
- **Spacing:** use a 576px desktop dialog, 32px desktop padding, consistent section gaps, and simple separators.
- **Colors:** retain OpenTag's semantic tokens, teal primary action, blue text links, and neutral disabled Save action.
- **Assets:** use the supplied Slack mark and existing Phosphor icons; show the real bot avatar when available and the
  Slack mark otherwise. The generated decorative avatar is intentionally not a new product asset.
- **Copy:** show the recipient once, name Slack as the destination, explain the waiting state, and label all copied values.

Intentional simplifications retain the common dialog's Back icon, focus handling, backdrop, and top alignment. The
standalone Finish automatic setup section is omitted. A single **Retry automatic setup** action sits inside message-delivery
troubleshooting, alongside manual event settings. It is restricted to saved, unverified custom Apps on Local Computers
that do not require credential reauthorization. Credentials and details remain separate views. Copy
controls operate on individual values; a redundant bulk-copy footer is omitted. Required events are labeled as required,
not as verified live Slack configuration. The preparing description says the connection is verified, without promising
that every signed observation was a test message. Blocked handoffs instead say **Check your agent** and explain that
attention is needed; only `preparing_cli` and `checking_credentials` use preparing copy.

## Fixes checked

1. The base dialog's 384px width wrapped desktop titles prematurely. The scoped width override now renders at 576px.
2. Focusing the whole content region scrolled the heading away. Navigation now focuses the heading; polling does not
   repeatedly move focus.
3. The shared primary button's decorative layer made disabled saving appear active. Empty forms now use the secondary
   variant with neutral disabled styling; populated forms use the primary variant.

## Interaction and automated checks

Browser checks exercised connection test → troubleshooting → credentials → Cancel → troubleshooting → details → Back.
The contextual retry returned to the pending connection test using the synthetic adapter, including at phone size.
Typing an unsaved synthetic token enabled Save and hid the disabled-save hint; clearing it restored both disabled Save
and the hint. Earlier checks exercised Request URL copying, Copied status, and keyboard Tab navigation. No real Slack
installation, credential update, or message was sent. Current production-preview console review returned no warnings or errors.
Page identity, nonblank rendering, absence of framework overlays, screenshots, and interaction checks passed using the
in-app browser’s CUA APIs.

Focused Vitest checks cover exact App/Team links, one recipient, navigation, credential clearing on Back/Cancel and Agent
changes, token visibility, empty-save gating, unchanged-credential omission, save deduplication, lost-response recovery,
clipboard success/failure, official OAuth restrictions, and identity/runtime readiness gates.

- `pnpm --filter @opentag/web test` passed: 178 files, 2,262 tests. The full web scope includes the naming, i18n catalog,
  Kumo, real messaging-page, auto-connect, onboarding, and custom-dialog regression tests identified during review.
  The custom-dialog suite now has 31 tests, including close/reopen callback recovery using only `action: connect`,
  busy-state navigation locks, callback-failure retries, Cloud/OAuth/revoked-credential restrictions, and blocked/preparing copy.
- Web typecheck passed after regenerating translations.
- Production web build passed, including bundle budgets. Existing externalized `node:crypto` and chunk-size warnings
  remain; the dev server's shared-package `node:crypto` runtime failure required using the production preview for QA.
- `pnpm check` passed, including the complexity ratchet and Context Tree verification.
- Server/database suites and the full repository regression matrix were not run because changes are confined to web
  presentation, translations, tests, and setup documentation. CI still owns the complete regression matrix.

Live Slack navigation, assistive-technology announcements, and native Slack-client handoff require separate acceptance.

final result: passed
