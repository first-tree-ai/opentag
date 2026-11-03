# Agent home schedules

Supports the [Web UI contract](../../../docs/system/web/web-ui-contract.md#schedule-handoff-feedback).

Each schedule row leads with the schedule name as a larger heading. The heading is the disclosure that opens the
details, so the separate Show details button is gone. The state and Pause or Resume sit beside it. One short line
underneath gives the time rule in words, the next time, and the last time. Delete moves into the opened details.
The last handoff names its outcome only when it was not accepted, in the danger color. A cron expression without a
plain form (for example `0 18 28-31 * *`) is shown as written.

Checked in a local sandbox with synthetic team data and three schedules (a weekday rule whose last handoff failed, a
paused end-of-month rule, and a weekly rule). The browser ran in the schedules' own zone (Asia/Shanghai), so no zone
name appears. Checked at 1440/768/390/320px in Chinese, plus English at 1440px. Below about 400px the state and
action wrap under the name, right-aligned. There is no horizontal overflow at any width.

Before and after screenshots at each width were reviewed from the local sandbox run and are not committed.
