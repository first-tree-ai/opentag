# Agent home schedules

Supports the [Web UI contract](../../../docs/system/web/web-ui-contract.md#schedule-handoff-feedback).

Each schedule row leads with its name as a heading that opens the details. Next to it are Pause or Resume and a label
only when the schedule is not simply running (Paused, Finished). One short line underneath gives the rule in words,
the next time, and the last time. A run that did not happen says why in the reader's terms. The details add only
where the schedule posts, its zone when it differs from the reader's, one note after a failed or unconfirmed run, the
full task, and Delete.

Checked in a local sandbox with synthetic team data and four schedules: a weekday rule whose last run failed because
the computer was offline, a paused end-of-month rule, a weekly rule, and a working-hours rule with no plain-language
form. The browser ran in the schedules' own zone (Asia/Shanghai), so no zone name appears. Checked at 1440 and 390px
in Chinese, collapsed and with the failed schedule's details open, plus 768 and 320px. There is no horizontal overflow
at any width.

Before and after screenshots were reviewed from the local sandbox run and are not committed.
