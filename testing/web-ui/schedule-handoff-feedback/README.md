# Schedule handoff feedback acceptance

Validated on macOS in headed Chrome against the existing production-built `AgentSchedulesSection`
preview in the isolated `fix/schedule-handoff-feedback-20261023` worktree. API reads were replaced
with synthetic schedule fixtures; there were no live schedule writes. The fixture's Online/Connected
line is illustrative, not evidence about a real Computer or Messaging connection.

## Behavior

- Collapsed rows expose the latest handoff outcome and its scheduled time independently of Enabled/Paused.
- Details retain the reason code and next scheduled time and explain the recorded handoff.
- Accepted means runtime receipt, not business completion. Unknown warns that work may already have started.
- Failed/unknown/skipped occurrences explain that the schedule will not retry them without implying a future occurrence.
- Unknown also covers a handoff still in flight; its explanation uses neutral "not confirmed yet" wording.
- Paused schedules retain the historical outcome and omit a nonexistent next trigger.
- Schedules without a handoff retain their existing empty-history behavior.
- The full task stays behind the detail read; the list does not request it.

## Browser results

Both English and Chinese passed at 320, 390, 768, and 1440 CSS pixels (1000px viewport height).
For every locale/width combination, details were opened for unreachable, unknown, accepted,
rejected, skipped, no-history, paused, and exhausted one-time fixtures. The exhausted fixture remains enabled,
has no next trigger, and retains the latest unreachable handoff without promising another occurrence.

| Check | Result |
| --- | --- |
| Collapsed and expanded page overflow | None |
| Tab then Enter expands the first schedule | Passed at all eight locale/width combinations |
| Space collapses it and updates `aria-expanded` | Passed at all eight combinations |
| Keyboard focus remains on the trigger with visible focus | Passed at all eight combinations |
| axe-core 4.13.0: wcag2a, wcag2aa, wcag21aa, wcag22aa | Zero violations in each of the eight expanded states at all eight combinations |
| State interpretation | Text labels and timestamps remain available without relying on color |
| Chinese terminology correction | Regenerated, rebuilt, and rechecked all four Chinese widths and seven states |

Screenshots:

- [Desktop collapsed list](en-1440-collapsed.png)
- [Desktop failed handoff details](en-1440-expanded.png)
- [Unknown handoff details](en-unknown-expanded.png)
- [Accepted handoff details](en-accepted-expanded.png)
- [Exhausted one-time handoff details](en-exhausted-expanded.png)
- [Chinese exhausted one-time handoff, 390px](zh-390-exhausted.png)
- [Chinese mobile details, 390px](zh-390-expanded.png)
- [Chinese minimum width with keyboard focus, 320px](zh-320-keyboard.png)

## Local checks and limits

The focused component suite passes all 17 tests, including exhausted one-time unreachable/rejected
handoffs. The original assertions first failed against the original component (11 failures), then
passed with the implementation. Review feedback corrected the skipped direction word, neutralized
unknown wording, and removed references to nonexistent future triggers.
Web type checking, Paraglide compilation, and the production Web build passed after those edits.
Repository checks run before committing the acceptance artifacts. Existing Biome warnings and Vite
shared-package browser-externalization/chunk-size warnings remain non-blocking.

The affected behavior is confined to one Web component and its messages. Server/database,
CLI, runtime coverage, and full end-to-end suites were not run for this presentation change.
This is component browser acceptance, not authenticated application-shell, screen-reader,
real scheduled-delivery, or root-cause acceptance. The schedule handoff failure remains tracked
separately in product issue #1001.
