# Cloud workspace recovery browser verification

The actual `CloudWorkspaceRecovery` component was rendered from a production Vite bundle with the
application stylesheet, OpenTag light theme and fonts. The isolated preview used a fresh browser
context and mocked every Account status, overview and stop request. It exercised no real Cloud
allocation, deletion, storage, IM notification or external task action.

English and Simplified Chinese each passed at 320, 390, 768 and 1440 pixels:

- No page or discard-dialog horizontal overflow.
- No axe WCAG 2.0/2.1/2.2 A/AA violations in the panel or confirmation dialogs.
- Discard opens a second confirmation; opening or cancelling it issues no mutation.
- Save/release on a conversation with unknown work opens an interruption confirmation and
  cancelling it issues no mutation; unit cases also cover running and queued work.
- Escape closes the confirmation and restores keyboard focus to its original button.
- The desktop network-failure fixture issues one stop request, reads current status and waits
  for another explicit click. A later successful request releases the fixture environment.

All checks and screenshots use the same root theme attributes as the application. The normal Web
production build and typecheck also passed. This isolated check does not replace authenticated whole-app or real
GCS/native Sandbox acceptance.

See [machine-readable results](browser-check.json), the component's behavioral tests in
`apps/web/src/features/agents/cloud/cloud-workspace-recovery.test.tsx`, and the Account HTTP
contract tests in `apps/web/src/__tests__/api-cloud-workspace.test.ts`.

## Screenshots

- [Desktop, English](en-1440.png)
- [Minimum width, Simplified Chinese](zh-320.png)
- [Discard confirmation, Simplified Chinese](zh-390-discard.png)
- [Current-work interruption confirmation, Simplified Chinese](zh-390-save-confirm.png)
