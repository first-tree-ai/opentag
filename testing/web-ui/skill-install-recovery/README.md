# Skill installation recovery acceptance

## Observed journey and change

A user previews and selects two Skills. One installs and the other fails. The previous report offers only
Done, disables the source input and loses the source when reopened. Four English/Chinese desktop/mobile
App-fixture cases record that behavior in `skills-partial-before.json` and the before screenshots.

Review failed skills now preserves the source and explicitly re-previews it. Only previously failed
names still installable in the new preview are selected, including single-candidate refreshes. A new
unrelated sole candidate is unchecked and cannot be installed until the user makes a fresh explicit
choice. Ordinary first previews retain their single-candidate convenience. Installed, unavailable or missing names are
excluded. Installation still requires another user confirmation and uses the new fingerprints. The
report receives focus, and reviewing returns focus to the retained source. Read retry retains that
source and selection; editing the source clears the previous selection. No automatic install/overwrite
is introduced. Existing successful completion and skipped-name handling remain.

## Verification

- Skills feature suites: 10 files / 138 tests passed, including three added recovery cases.
- Current focused installer/catalog/Kumo contract run: 3 files / 35 tests passed, including both
  sole-original-failed and sole-new-unrelated recovery candidates. The 138-test full feature run above
  describes the parent revision; these two regressions extend its installer coverage.
- Web typecheck and build passed; existing browser-externalization and chunk-size warnings remain.
- `after.json`: English/Chinese x 320/390/768/1440px: eight complete partial-install, explicit re-preview,
  fresh failed-only selection and explicit successful-install flows. Reports and refreshed previews fit,
  focus is restored, exactly two explicit install requests occur, and the second contains only the
  failed name with its v2 fingerprint. No unintended business API calls occurred.
- `single-recovery.json`: eight additional English/Chinese four-width flows confirm an unrelated
  unique fresh candidate stays unchecked with Install disabled. Space makes a new explicit selection;
  only the subsequent confirm installs that name with its v2 fingerprint.
- Raw same-origin `/favicon.ico` observations are retained and excluded only from business-API
  assertions. An initial driver failed on these asset observations; no product regression was inferred.
- Two scoped WCAG A/AA/2.1 AA axe scans reported no automatic violations.
- Initial new-test failures used an incorrect singular button label and treated the shared Checkbox
  root as a native button; corrected to the existing plural-label contract and aria-disabled semantics.
  The before-driver also initially used an incorrect row accessible name; its correction is retained
  in the result. These were verification-code issues, not passing product checks.

## Evidence and limits

Captures mount the production App, router, shell and components with synthetic API responses.
No actual Skill source, object storage, Agent runtime or external repository was modified. The Skills
source at the before capture was unchanged between its base and this worktree's main base 77daad29.
These results do not establish live storage/runtime acceptance, complete accessibility or green CI.

- `skills-partial-before-{en,zh}-{390,1440}.png`: original partial-result dead end.
- `skills-partial-after-{en-1440,zh-390}.png`: explicit recovery action.
- `skills-review-after-{en-1440,zh-390}.png`: retained source and refreshed failed-only selection.

- `skills-unrelated-single-{en-1440,zh-390}.png`: refreshed single unrelated candidate, unchecked
  and requiring an explicit new choice. After screenshots were refreshed on the current code.
