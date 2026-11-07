# Scheduled task IM behavior release regression

Checklist for what a conversation hears from a schedule: nothing while it works, and one Server-written message when an
occurrence fails. Run it with an authorized test Agent and test conversation on each provider; Slack and Feishu send
through different APIs, so one provider does not cover the other. Do not record message contents, IDs or logs in the
repository; keep results with the release PR or Issue.

Use a short `every` schedule (the minimum is 60 seconds) and pause or delete it after each case. "Failure message" means
a plain message from the Agent's Bot naming the task and its scheduled time, in the language of the task text, with no
error code and a clickable link that opens the schedule in Web.

## Prerequisites

- A Server and Local Computer on the release candidate, one Agent with an IM binding, and permission to stop its daemon.
- One schedule targeting a channel or DM Session, and one targeting a thread Session, on each provider.
- For a failing Run: a way to make it fail or time out, such as an unavailable model credential or a very short Agent Run
  budget.

## Cases

| ID | Case | Steps | Expected |
| --- | --- | --- | --- |
| ST-01 | Silent start and success | A schedule whose task needs no report, for several occurrences | No start, completion, or other schedule message in IM |
| ST-02 | Task result still posts | A schedule whose task asks the Agent to report something | Only the Agent's result message appears |
| ST-03 | Run failure in a chat | Make the Run fail | One failure message in the original chat, saying some operations may already have run |
| ST-04 | Run failure in a thread | Make a thread-targeted Run fail | The failure message appears inside that thread, not in the chat |
| ST-05 | Run timeout | Exceed the Run budget | A failure message saying the task hit its time limit |
| ST-06 | Repeated Run failure | Leave the failure in place for two occurrences | One failure message per occurrence |
| ST-07 | Offline Computer, first per cause | Stop the daemon across several occurrences, then restart it | One "did not run" message for the whole outage. After a delivered occurrence, a new outage posts again |
| ST-08 | Late occurrence | Stop the Server past an occurrence and its 30-second window, then start it | One "didn't run" message |
| ST-09 | Schedule turned off | End the target Session or otherwise make the target permanently invalid | One message saying the schedule stays off until resumed. Web shows no next time for it |
| ST-10 | Cancelled Run | On a Cloud Agent, stop a running scheduled Run (a Local Computer has no way to stop a running Task) | No failure message |
| ST-11 | Pause, edit, delete | Pause, edit, or delete a schedule as an occurrence is due | No failure message |
| ST-12 | Agent paused | Suspend the Agent across an occurrence | No failure message |
| ST-13 | Untrusted name | Name a schedule with provider mention or link syntax, then make it fail | The name appears as text. Nobody is mentioned, and the only disguised link is the details link |
| ST-14 | Language and link | Make a schedule with a Chinese task fail, then one with an English task; click the link in each | Each message follows its task's language, shows no error code, and its link opens the schedule. Check Slack and Feishu in the client |

Automated tests cover the deterministic decisions in `scheduled-failure-notifier.test.ts` and the provider request shapes
with mocked SDKs in `im-feedback-messenger.test.ts`. Only these cases exercise a real provider.
