# Release regression catalogue

Run this catalogue before every release on the dedicated regression computer. Record the exact candidate revision,
selected cases, environment, results and limitations in the release PR or Issue; keep screenshots, logs and local
configuration outside the source repository. A missing prerequisite is blocked coverage, not a passing case.
Regression defects are assigned to `yuezengwu`.

- [Web product](web-product.md): run both Core and Edge cases before a release, including both languages and the
  listed widths. Core-only runs during development are focused checks, not a completed release regression.
- [Slack messaging](slack.md): run the conversation, permission, attachment and recovery cases with an authorized
  test App and workspace. External messages, paid provider calls and environment operations require the applicable
  authorization; this catalogue does not grant it.
- [Session interruption recovery](session-recovery.md): crash, restart, timeout and rate-limit retry of visible and
  internal Session work on a Local Computer.

When an Agent adds or changes a product feature, add or update the corresponding Markdown regression cases in the
same change. Keep reusable prerequisites, steps and expected observations here. Put task plans, dated execution
history, performance results and environment configuration with the task's PR/Issue and private local artifacts.
Existing automated tests and CI continue to guard deterministic behavior alongside these release checks.
