# Independent MCP connector review

Reviewed on 2026-10-22 against the complete uncommitted diff on `feat/mcp-connector-lifecycle`.
The review covered implementation, changed assertions, translations, documentation, shared icon exposure,
and the existing Server contract. No additional reviewer agent or external review service was used.

## Findings and resolution

One functional finding was reproduced and fixed:

- **P2: An explicit missing authorization was presented as a generic connection failure.**
  When the existing-credential Retry request returned `MCP_AUTHORIZATION_REQUIRED`, the new probe
  fallback displayed “Couldn’t connect. Try again.” and retained Retry. The Server can return this
  code before probing when the authorization is no longer active. The error mapper now preserves
  this explicit authorization refusal and the list offers Reauthorize. Generic transport/503 failures
  continue to offer Retry without discarding credentials or starting OAuth.
  The added public page regression in `mcp-list-recovery.test.tsx` failed before the fix and passed
  afterward. The same case passed through the production Web build and HTTP fixture.

The stale stylesheet comment about recovery being confined to Details was also corrected.
No outstanding blocking finding was identified within this Web-only change.

## Automated checks

- Original MCP-only review: **28 files, 372 tests passed**, including the new authorization-refusal regression.
  The latest broader run and review follow-up are recorded in `submission-validation.md` and `review-tests.txt`.
- Web TypeScript check passed.
- Web production build passed with its normal bundle budgets. Existing externalization/chunk-size
  warnings did not fail the build.
- `pnpm check` and `git diff --check` passed.
- Complete logs are archived locally; concise results are in `review-*.txt` beside this record.
- Server/PostgreSQL and runtime suites were not rerun: their code, database model, and public
  contracts are unchanged. These local checks do not establish CI status.

## Full application browser journeys

Playwright CLI drove the normal production Web build at `/agents/{agentId}/mcp`, including the
application shell, generated routing, BrowserApi request construction, response schema validation,
query invalidation, dialogs, translations, CSS, and native browser popups. A stateful loopback HTTP
fixture supplied Account, Agent, MCP, and simulated provider responses; the product was not patched
or mounted inside a component preview. The normal build's stylesheet was used directly.

Passed journeys:

- Left identity hover and click-to-manage remain intact. The recovery and removal controls are
  independent, and neither the switch nor the redundant actions menu appears.
- Remove opens confirmation before any DELETE request. Cancel/Escape make no write. A removal
  failure is retryable, and removing one Agent's shared connector preserves the other Agent's mount
  and its shared definition. Resume failure is retryable and sends only `enabled: true`.
- Network probe failure retains credentials and Retry. While checking, only the identity and disabled
  trash remain in the row. An explicit missing authorization changes the action to Reauthorize;
  its native popup completes through the shipped callback and tool probe, with one OAuth start.
- Update credentials opens the key editor and sends the replacement key through the authorization
  write, with no accidental reauthorization request.
- Custom creation failure retains the address and offers Retry. Retrying a no-auth connector mounts
  it enabled and reaches the usable result.
- Closing custom Add during OAuth leaves the same live flow in the list and management dialog.
  Cancel uses the expected flow state and removes the provisional mount. Successful authorization
  after Add closes finishes its probe before Add becomes available again.
- Discover creation failure offers Retry; closing Discover keeps the same authorization accessible
  from management. A single popup completes through the shipped callback and probe.
- A blocked popup can be opened from management after Add closes, reusing the same flow. Cancel
  then removes the provisional mount.
- Keyboard Tab reaches the trash with visible focus and the scoped tooltip. Enter opens the
  confirmation with Cancel focused; Escape restores focus and makes no write.
- English and Chinese layouts at 320, 390, 768, and 1440 px have no horizontal document overflow or
  clipped sample connector names. Mobile trash targets are at least 44 × 44 px. Both languages'
  confirmation dialogs fit at 320 px.

Captures:

- [Full application, English desktop](./full-app-en-1440.png)
- [Full application, English mobile](./full-app-en-320.png)
- [Chinese mobile confirmation](./full-app-confirm-zh-320.png)
- [Management shares Add authorization](./full-app-shared-authorization.png)
- [Keyboard focus and tooltip](./full-app-keyboard-tooltip.png)

## Limits

This verifies complete frontend browser journeys against a local HTTP fixture. It does **not**
prove a live provider consent/token exchange, production Server behavior, PostgreSQL persistence,
Agent tool execution, or deployment. Expected fixture refusals produced the deliberately tested
503/403 diagnostics; the production build reported no uncaught application exception in completed
journeys. An early fixture schema mistake was corrected before the recorded acceptance runs.

Temporary fixture sources, browser scripts, complete logs, and intermediate captures are archived
outside the checkout. The change is still local and has not been committed, pushed, or deployed.
